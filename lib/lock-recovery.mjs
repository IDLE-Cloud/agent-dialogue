import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { validateStore, resolveBinding } from './bridge-store.mjs';
import { lifecycleState } from './lifecycle.mjs';
import { nodePublic, payloadHash } from './node-identity.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from './private-files.mjs';
import { renameImmutable } from './atomic-rename.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const BINDING = /^b_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/;
const ROOT_FIELDS = ['dev', 'ino', 'mode', 'uid'];
const DIR_FIELDS = [...ROOT_FIELDS, 'mtimeNs', 'ctimeNs'];
const FILE_FIELDS = [...DIR_FIELDS, 'size'];
const PLAN_KEYS = ['version', 'id', 'createdAt', 'stateHash', 'rootIdentity', 'nodeHash', 'storeHash', 'spaceHash', 'selection', 'target'];
const RECOVERY_NAME = '.lock-recovery.lock';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positive = value => Number.isSafeInteger(value) && value > 1;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coded = (code, message = 'Lock recovery evidence is unavailable or changed; preserve all original evidence.') => Object.assign(new Error(message), { code });
const fail = code => { throw coded(code); };
const same = (a, b) => payloadHash(a) === payloadHash(b);
const identity = (info, fields) => Object.fromEntries(fields.map(key => [key, info[key].toString()]));
const identical = (a, b, fields) => fields.every(key => a[key] === b[key]);
const validIdentity = (value, fields) => exact(value, fields) && fields.every(key => typeof value[key] === 'string' && /^(?:0|[1-9][0-9]{0,39})(?![\s\S])/.test(value[key]));
function validOwner(owner, role, binding) {
  const keys = ['version', 'role', 'pid', 'nonce', 'createdAt', ...(role === 'dispatch' ? ['bindingId', 'bindingRevision'] : [])];
  return exact(owner, keys) && owner.version === 1 && owner.role === role && positive(owner.pid) && matches(UUID, owner.nonce) && iso(owner.createdAt) && (role !== 'dispatch' || matches(BINDING, owner.bindingId) && Number.isSafeInteger(owner.bindingRevision) && owner.bindingRevision > 0 && (!binding || owner.bindingId === binding.id && owner.bindingRevision === binding.revision));
}

/** C/D nonces are not worker argv tokens. A currently existing PID is live,
 * irrespective of its command. Only ESRCH proves absence; never send a signal. */
export async function pidEvidence(pid, { killImpl = process.kill.bind(process) } = {}) {
  if (!positive(pid) || typeof killImpl !== 'function') return 'unknown';
  try { killImpl(pid, 0); return 'live'; }
  catch (error) { return error.code === 'ESRCH' ? 'confirmed-dead' : 'unknown'; }
}
async function probeDead(pid, probe) {
  let evidence; try { evidence = await probe(pid); } catch { evidence = 'unknown'; }
  if (evidence !== 'confirmed-dead') fail(evidence === 'live' ? 'LOCK_PRODUCER_LIVE' : 'LOCK_PRODUCER_UNKNOWN');
}
async function privacy(path, info, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('LOCK_PATH_INVALID');
  if (process.platform === 'win32') await inspectWindowsPrivatePath(path, { directory });
  else if ((info.mode & 0o077n) !== 0n || process.getuid && info.uid !== BigInt(process.getuid())) fail('LOCK_PATH_NOT_PRIVATE');
}
async function privateDirectory(path, { create = false } = {}) {
  if (create) {
    let created = false;
    try { await mkdir(path, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created && process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true });
  }
  const info = await lstat(path, { bigint: true }); await privacy(path, info, true); return info;
}
async function regular(path, limit) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 0n || before.size > BigInt(limit)) fail('LOCK_FILE_INVALID');
  await privacy(path, before, false);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !identical(before, info, FILE_FIELDS)) fail('LOCK_EVIDENCE_CHANGED');
    const buffer = Buffer.alloc(Number(info.size) + 1); let count = 0;
    while (count < buffer.length) { const part = await handle.read(buffer, count, buffer.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (BigInt(count) !== info.size || !current.isFile() || current.isSymbolicLink() || !identical(info, after, FILE_FIELDS) || !identical(info, current, FILE_FIELDS)) fail('LOCK_EVIDENCE_CHANGED');
    const bytes = Buffer.from(buffer.subarray(0, count));
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('LOCK_FILE_INVALID'); }
    return { bytes, value, identity: identity(info, FILE_FIELDS) };
  } finally { await handle.close(); }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function roots(context) {
  if (typeof context?.stateDir !== 'string' || !isAbsolute(context.stateDir) || /[\x00-\x1f\x7f]/.test(context.stateDir)) fail('LOCK_CONTEXT_INVALID');
  await privateDirectory(context.stateDir);
  const directory = join(context.stateDir, 'dialogue'), info = await privateDirectory(directory);
  return { directory, rootIdentity: identity(info, ROOT_FIELDS), stateHash: hash(Buffer.from(await realpath(context.stateDir))) };
}
function normalizedSelection(store, selected) {
  if (!object(selected) || !['control', 'dispatch', 'worker', 'scheduler'].includes(selected.role) || !exact(selected, selected.role === 'control' ? ['role'] : ['role', 'alias'])) fail('LOCK_SELECTION_INVALID');
  if (selected.role === 'control') return { role: 'control', alias: null, bindingId: null, bindingRevision: null };
  if (!matches(ALIAS, selected.alias)) fail('LOCK_SELECTION_INVALID');
  const binding = resolveBinding(store, selected.alias); if (binding.remote || !matches(BINDING, binding.id)) fail('LOCK_SELECTION_INVALID');
  return { role: selected.role, alias: binding.alias, bindingId: binding.id, bindingRevision: binding.revision };
}
const lockName = selected => selected.role === 'control' ? '.lock' : `${selected.bindingId}.dispatch.lock`;
function bindingFor(store, id) { return Object.values(store.bindings).find(binding => binding?.id === id && !binding.remote); }
async function lockSnapshot(directory, name, role, binding) {
  const path = join(directory, name), before = await privateDirectory(path);
  if ((await readdir(path)).sort().join('\n') !== 'owner.json') fail('LOCK_OWNER_INVALID');
  const owner = await regular(join(path, 'owner.json'), 16384);
  if (!validOwner(owner.value, role, binding)) fail('LOCK_OWNER_INVALID');
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !identical(before, after, DIR_FIELDS)) fail('LOCK_EVIDENCE_CHANGED');
  return { name, identity: identity(after, DIR_FIELDS), ownerIdentity: owner.identity, ownerHash: hash(owner.bytes), owner: owner.value };
}
async function baseSnapshot(context, root) {
  const source = await regular(join(root.directory, 'store.json'), 16 * 1024 * 1024), store = validateStore(source.value);
  if (![3, 4].includes(store.version)) fail('LOCK_UPGRADE_REQUIRED');
  const node = await regular(join(root.directory, 'node.json'), 16384); nodePublic(node.value);
  return { store, storeHash: hash(source.bytes), nodeHash: hash(node.bytes), nodeId: node.value.nodeId };
}
/** Offline is still an operator assertion. This independently refuses every
 * known producer; R is deliberately not presented as a normal writer fence. */
async function spaceSnapshot(context, root, selected, probe, { ownRecovery = false } = {}) {
  const base = await baseSnapshot(context, root), store = base.store;
  const current = normalizedSelection(store, selected.role === 'control' ? { role: selected.role } : { role: selected.role, alias: selected.alias });
  if (!same(current, selected)) fail('LOCK_EVIDENCE_CHANGED');
  const affected = selected.role === 'control' ? Object.values(store.bindings).filter(binding => binding?.active && !binding.remote) : [resolveBinding(store, selected.alias)];
  for (const binding of affected) if (binding.nodeId !== base.nodeId || lifecycleState(store, binding).desired !== 'paused') fail('LOCK_PAUSE_REQUIRED');
  const names = (await readdir(root.directory)).sort(); if (names.length > 2048) fail('LOCK_SPACE_INCOMPLETE');
  if (!ownRecovery && names.includes(RECOVERY_NAME)) fail('RECOVERY_BUSY');
  if (names.some(name => /^b_[0-9a-f-]+\.worker\.lock$/.test(name))) fail('LOCK_WORKER_NEEDS_REVIEW');
  if (names.includes('windows-workers')) {
    await privateDirectory(join(root.directory, 'windows-workers'));
    const scheduled = await readdir(join(root.directory, 'windows-workers'));
    if (scheduled.length > 2048 || scheduled.some(name => name.endsWith('.launch.json'))) fail('LOCK_SCHEDULER_NEEDS_REVIEW');
  }
  const locks = [];
  for (const name of names) {
    const match = /^(b_[0-9a-f-]+)\.dispatch\.lock$/.exec(name);
    if (name !== '.lock' && !match) continue;
    const binding = match ? bindingFor(store, match[1]) : null;
    if (match && (!binding || !matches(BINDING, binding.id))) fail('LOCK_OWNER_INVALID');
    const snapshot = await lockSnapshot(root.directory, name, match ? 'dispatch' : 'control', binding);
    await probeDead(snapshot.owner.pid, probe); locks.push(snapshot);
  }
  const workers = [];
  for (const name of names) {
    const match = /^(b_[0-9a-f-]+)\.worker\.json$/.exec(name); if (!match) continue;
    const binding = bindingFor(store, match[1]); if (!binding) fail('LOCK_WORKER_NEEDS_REVIEW');
    const runtime = await regular(join(root.directory, name), 16 * 1024 * 1024), state = runtime.value, launch = store.workerLaunches?.[binding.id];
    if (!object(state) || !positive(state.pid) || !matches(UUID, state.token) || !['stopped', 'error'].includes(state.status) || !launch || launch.pid !== state.pid || launch.token !== state.token) fail('LOCK_WORKER_NEEDS_REVIEW');
    await probeDead(state.pid, probe); workers.push({ name, hash: hash(runtime.bytes) });
  }
  for (const [id, launch] of Object.entries(store.workerLaunches || {})) {
    const binding = bindingFor(store, id);
    if (!binding || !exact(launch, ['version', 'bindingRevision', 'token', 'phase', 'pid']) || launch.version !== 1 || launch.bindingRevision !== binding.revision || !matches(UUID, launch.token) || launch.phase !== 'stopped' || !positive(launch.pid)) fail('LOCK_WORKER_NEEDS_REVIEW');
    await probeDead(launch.pid, probe);
  }
  const final = await baseSnapshot(context, root);
  if (final.storeHash !== base.storeHash || final.nodeHash !== base.nodeHash) fail('LOCK_EVIDENCE_CHANGED');
  return { ...base, selected: current, locks, spaceHash: hash(Buffer.from(JSON.stringify({ locks, workers, launches: store.workerLaunches || {} }))) };
}

export function validateLockRetirementPlan(plan) {
  const invalid = () => fail('LOCK_PLAN_INVALID');
  if (!exact(plan, PLAN_KEYS) || plan.version !== 1 || !matches(UUID, plan.id) || !iso(plan.createdAt) || !['stateHash', 'nodeHash', 'storeHash', 'spaceHash'].every(key => matches(HASH, plan[key])) || !validIdentity(plan.rootIdentity, ROOT_FIELDS)) invalid();
  const s = plan.selection;
  if (!exact(s, ['role', 'alias', 'bindingId', 'bindingRevision']) || !['control', 'dispatch'].includes(s.role)) invalid();
  if (s.role === 'control' ? s.alias !== null || s.bindingId !== null || s.bindingRevision !== null : !matches(ALIAS, s.alias) || !matches(BINDING, s.bindingId) || !Number.isSafeInteger(s.bindingRevision) || s.bindingRevision < 1) invalid();
  const target = plan.target;
  if (!exact(target, ['name', 'identity', 'ownerIdentity', 'ownerHash', 'owner']) || target.name !== lockName(s) || !validIdentity(target.identity, DIR_FIELDS) || !validIdentity(target.ownerIdentity, FILE_FIELDS) || !matches(HASH, target.ownerHash) || !validOwner(target.owner, s.role, s.role === 'dispatch' ? { id: s.bindingId, revision: s.bindingRevision } : undefined)) invalid();
  return plan;
}
export async function readLockRetirementPlan(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) fail('LOCK_PLAN_INVALID');
  try { return validateLockRetirementPlan((await regular(path, 128 * 1024)).value); }
  catch (error) { if (error.code === 'LOCK_PLAN_INVALID') throw error; throw coded('LOCK_PLAN_INVALID', 'The selected private lock plan cannot be safely read.'); }
}

/** Entirely read-only, including the missing/unconfigured/error paths. The
 * caller may explicitly save plan as a private file; report is safe to print. */
export async function planLockRetirement(context, selected, { probe = pidEvidence } = {}) {
  const report = { version: 1, status: 'needs-review', selection: { role: ['control', 'dispatch', 'worker', 'scheduler'].includes(selected?.role) ? selected.role : 'invalid', ...(typeof selected?.alias === 'string' && matches(ALIAS, selected.alias) ? { alias: selected.alias } : {}) }, reasons: [], effects: { sourceWrites: false, pidQueries: false, nativeContact: false, sshContact: false } };
  try {
    if (typeof probe !== 'function') fail('LOCK_OPTIONS_INVALID');
    const root = await roots(context), base = await baseSnapshot(context, root), selection = normalizedSelection(base.store, selected);
    if (['worker', 'scheduler'].includes(selection.role)) fail(selection.role === 'worker' ? 'LOCK_WORKER_NEEDS_REVIEW' : 'LOCK_SCHEDULER_NEEDS_REVIEW');
    const source = await spaceSnapshot(context, root, selection, async pid => { report.effects.pidQueries = true; return await probe(pid); }), target = source.locks.find(lock => lock.name === lockName(selection));
    if (!target) fail('LOCK_NOT_FOUND');
    const plan = validateLockRetirementPlan({ version: 1, id: randomUUID(), createdAt: new Date().toISOString(), stateHash: root.stateHash, rootIdentity: root.rootIdentity, nodeHash: source.nodeHash, storeHash: source.storeHash, spaceHash: source.spaceHash, selection, target });
    report.status = 'ready'; return { report, plan };
  } catch (error) {
    report.reasons = [typeof error.code === 'string' && /^(?:LOCK_|RECOVERY_BUSY)/.test(error.code) ? error.code : 'LOCK_EVIDENCE_UNAVAILABLE'];
    return { report, plan: null };
  }
}
async function withRecovery(root, fn) {
  const path = join(root.directory, RECOVERY_NAME);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('RECOVERY_BUSY'); throw error; }
  if (process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true });
  const owner = { version: 1, role: 'recovery', pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const ownerPath = join(path, 'owner.json'), handle = await open(ownerPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(owner) + '\n'); await handle.sync(); } finally { await handle.close(); }
  if (process.platform === 'win32') await protectWindowsPrivatePath(ownerPath);
  const owned = await lockSnapshot(root.directory, RECOVERY_NAME, 'recovery');
  try { return await fn(); }
  finally {
    const current = await lockSnapshot(root.directory, RECOVERY_NAME, 'recovery');
    if (!same(current, owned)) fail('LOCK_RECOVERY_OWNER_CHANGED');
    await unlink(ownerPath); await rmdir(path);
  }
}
async function publish(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  if (process.platform === 'win32') await protectWindowsPrivatePath(temporary);
  // A failed publication deliberately preserves its exact immutable temp.
  await renameImmutable(temporary, path);
}
function validateCheckpoint(value, plan) {
  if (!exact(value, ['version', 'id', 'planHash', 'plan', 'phase', 'at', 'quarantineName']) || value.version !== 1 || value.id !== plan.id || value.planHash !== payloadHash(plan) || !same(value.plan, plan) || !['prepared', 'retired'].includes(value.phase) || !iso(value.at) || value.quarantineName !== `${plan.id}.lock`) fail('LOCK_CHECKPOINT_INVALID');
  return value;
}
function requireRoot(root, plan) { if (root.stateHash !== plan.stateHash || !same(root.rootIdentity, plan.rootIdentity)) fail('LOCK_EVIDENCE_CHANGED'); }
function requireBase(source, plan) { if (source.nodeHash !== plan.nodeHash || source.storeHash !== plan.storeHash) fail('LOCK_EVIDENCE_CHANGED'); }
function sameQuarantine(actual, plan) {
  // Directory rename may update ctime. It must preserve this exact inode,
  // permissions, owner file inode and complete owner bytes.
  return ROOT_FIELDS.every(key => actual.identity[key] === plan.target.identity[key]) && same(actual.ownerIdentity, plan.target.ownerIdentity) && actual.ownerHash === plan.target.ownerHash && same(actual.owner, plan.target.owner);
}

/** Explicit administrative retirement, not a writer-fencing transaction. The
 * operator must first quiesce every writer. No normal C/D helper is entered.
 * Portable directory rename has no compare-and-swap primitive: use one private
 * unique destination under R, revalidate immediately before/after, and retain
 * unknown outcomes. Never roll back over a new owner at the original path. */
export async function retireLock(context, input, options = {}) {
  try { return await retireSelected(context, input, options); }
  catch (error) {
    if (typeof error.code === 'string' && /^(?:LOCK_|RECOVERY_BUSY|OFFLINE_REQUIRED)/.test(error.code)) throw error;
    // Hooks are internal deterministic-test seams, never accepted by the CLI.
    if (options.checkpointHook && error.code === 'FIXTURE_INTERRUPTED') throw error;
    throw coded('LOCK_EVIDENCE_UNAVAILABLE');
  }
}
async function retireSelected(context, input, { offline, probe = pidEvidence, checkpointHook, renameImpl = rename } = {}) {
  if (offline !== true) throw coded('OFFLINE_REQUIRED', 'Lock retirement requires an explicit all-writers-offline declaration.');
  const plan = structuredClone(validateLockRetirementPlan(input));
  if (typeof probe !== 'function' || typeof renameImpl !== 'function' || checkpointHook !== undefined && typeof checkpointHook !== 'function') fail('LOCK_OPTIONS_INVALID');
  const root = await roots(context); requireRoot(root, plan);
  return withRecovery(root, async () => {
    requireRoot(await roots(context), plan);
    const administrative = join(root.directory, 'lock-recovery'); await privateDirectory(administrative, { create: true });
    const checkpoints = join(administrative, 'checkpoints'), quarantine = join(administrative, 'quarantine');
    await privateDirectory(checkpoints, { create: true }); const quarantineInfo = await privateDirectory(quarantine, { create: true });
    if (quarantineInfo.dev.toString() !== plan.target.identity.dev) fail('LOCK_QUARANTINE_VOLUME_CHANGED');
    const checkpointPath = join(checkpoints, `${plan.id}.json`), destination = join(quarantine, `${plan.id}.lock`), original = join(root.directory, plan.target.name);
    let checkpoint = await exists(checkpointPath) ? validateCheckpoint((await regular(checkpointPath, 128 * 1024)).value, plan) : null;
    const requireCheckpoint = async () => {
      const current = validateCheckpoint((await regular(checkpointPath, 128 * 1024)).value, plan);
      if (!same(current, checkpoint)) fail('LOCK_CHECKPOINT_INVALID');
    };
    if (await exists(destination)) {
      if (!checkpoint) fail('LOCK_CHECKPOINT_INVALID');
      const actual = await lockSnapshot(quarantine, `${plan.id}.lock`, plan.selection.role, plan.selection.role === 'dispatch' ? { id: plan.selection.bindingId, revision: plan.selection.bindingRevision } : null);
      if (!sameQuarantine(actual, plan)) fail('LOCK_QUARANTINE_CHANGED');
      const source = await spaceSnapshot(context, root, plan.selection, probe, { ownRecovery: true }); requireBase(source, plan);
      if (checkpoint.phase !== 'retired') { await requireCheckpoint(); checkpoint.phase = 'retired'; await publish(checkpointPath, checkpoint); }
      return { version: 1, status: 'already-retired', planId: plan.id, originalPathPreserved: await exists(original), controlStoreChanged: false, resumed: false };
    }
    if (checkpoint?.phase === 'retired') fail('LOCK_QUARANTINE_CHANGED');
    const verifyOriginal = async () => {
      requireRoot(await roots(context), plan);
      const source = await spaceSnapshot(context, root, plan.selection, probe, { ownRecovery: true }); requireBase(source, plan);
      const target = source.locks.find(lock => lock.name === plan.target.name);
      if (source.spaceHash !== plan.spaceHash || !target || !same(target, plan.target)) fail('LOCK_EVIDENCE_CHANGED');
    };
    await verifyOriginal();
    if (!checkpoint) {
      checkpoint = { version: 1, id: plan.id, planHash: payloadHash(plan), plan, phase: 'prepared', at: new Date().toISOString(), quarantineName: `${plan.id}.lock` };
      await publish(checkpointPath, checkpoint);
    }
    await checkpointHook?.('checkpoint-persisted');
    await verifyOriginal();
    await requireCheckpoint();
    if (await exists(destination)) fail('LOCK_QUARANTINE_CHANGED');
    try { await renameImpl(original, destination); }
    catch { throw Object.assign(coded('LOCK_RENAME_UNCONFIRMED'), { uncertain: true }); }
    const actual = await lockSnapshot(quarantine, `${plan.id}.lock`, plan.selection.role, plan.selection.role === 'dispatch' ? { id: plan.selection.bindingId, revision: plan.selection.bindingRevision } : null);
    if (!sameQuarantine(actual, plan)) fail('LOCK_QUARANTINE_CHANGED');
    await checkpointHook?.('quarantined');
    await requireCheckpoint();
    checkpoint.phase = 'retired'; await publish(checkpointPath, checkpoint);
    return { version: 1, status: 'retired', planId: plan.id, originalPathPreserved: await exists(original), controlStoreChanged: false, resumed: false };
  });
}
