import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from './private-files.mjs';
import { renameImmutable } from './atomic-rename.mjs';
import { FORWARDING_PHASES, validateForwardings } from './forwarding-record.mjs';
import { validateMcpSends } from './mcp-send-record.mjs';
import { NATIVE_PHASES, validateNativeIntents } from './native-record.mjs';

const FRAME_PREFIX = 'agent-dialogue/1\n';
const CONTROL_STORE_LIMIT = 16 * 1024 * 1024;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}$/;
const FRAME_KEYS = ['version', 'room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text', 'replyTo'];
const CONTROL_COMPAT = Object.freeze({});

function fail(message) { throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${label} must be a non-empty string.`);
  return value;
}
function controlDirectory(context) {
  return join(nonempty(context?.stateDir, 'context.stateDir'), 'dialogue');
}
function freshStore() { return { version: 1, bindings: {}, rooms: {} }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;
const LIFECYCLE_KEYS = ['version', 'bindingRevision', 'desired', 'generation', 'changeNonce', 'changedAt', 'reason'];
export function validateStore(store) {
  const invalid = () => fail('Invalid dialogue control store.');
  if (!object(store) || ![1, 2, 3, 4].includes(store.version) || !object(store.bindings) || !object(store.rooms)) invalid();
  if (store.version === 1 && Object.hasOwn(store, 'lifecycle')) invalid();
  if ([2, 3, 4].includes(store.version)) {
    if (!object(store.lifecycle)) invalid();
    for (const [id, row] of Object.entries(store.lifecycle)) {
      const binding = Object.values(store.bindings).find(value => value?.id === id);
      if (!binding || !object(row) || Object.keys(row).length !== LIFECYCLE_KEYS.length || !LIFECYCLE_KEYS.every(key => Object.hasOwn(row, key)) || row.version !== 1 || row.bindingRevision !== binding.revision || !Number.isSafeInteger(row.bindingRevision) || row.bindingRevision < 1 || !['enabled', 'paused'].includes(row.desired) || !Number.isSafeInteger(row.generation) || row.generation < 1 || !UUID.test(row.changeNonce || '') || typeof row.changedAt !== 'string' || !Number.isFinite(Date.parse(row.changedAt)) || new Date(row.changedAt).toISOString() !== row.changedAt || !['operator-pause', 'operator-resume'].includes(row.reason)) invalid();
    }
  }
  if ([3, 4].includes(store.version)) {
    validateForwardings(store.forwardings);
    if (Object.hasOwn(store, 'mcpSends')) validateMcpSends(store.mcpSends);
  }
  if (store.version === 4) validateNativeIntents(store.nativeIntents);
  if (Object.hasOwn(store, 'workerLaunches') && !object(store.workerLaunches)) invalid();
  return store;
}

/** Only aggregate recorded phases; provenance, IDs, nonces and text stay private. */
export function summarizeForwardings(store, { bindingId } = {}) {
  if (![3, 4].includes(store?.version)) return null;
  validateForwardings(store.forwardings);
  const rows = Object.values(store.forwardings).filter(row => bindingId === undefined || row.bindingId === bindingId);
  const phases = Object.fromEntries(FORWARDING_PHASES.map(phase => [phase, 0]));
  for (const row of rows) phases[row.phase]++;
  return { version: 1, total: rows.length, phases, unrecognized: 0 };
}

/** Closed aggregate only. Native IDs, prompt hashes and checkpoints stay private. */
export function summarizeNativeIntents(store, { bindingId } = {}) {
  if (store?.version !== 4) return null;
  validateNativeIntents(store.nativeIntents);
  const rows = Object.values(store.nativeIntents).filter(row => bindingId === undefined || row.bindingId === bindingId);
  const phases = Object.fromEntries(NATIVE_PHASES.map(phase => [phase, 0]));
  for (const row of rows) phases[row.phase]++;
  return { version: 1, total: rows.length, phases, unrecognized: 0 };
}

/** Read control metadata only. hcom remains the authoritative message body store. */
export async function readStore(context) {
  const path = join(controlDirectory(context), 'store.json'), limit = CONTROL_STORE_LIMIT;
  for (let attempt = 0; attempt < 16; attempt++) {
    let before;
    try { before = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT' && attempt === 0) return freshStore(); if (error.code === 'ENOENT') continue; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 0n || before.size > BigInt(limit)) fail('Invalid dialogue control store.');
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size < 0n || info.size > BigInt(limit)) fail('Invalid dialogue control store.');
      // Without NOFOLLOW (notably Windows), only read the regular inode whose
      // path was inspected. A legitimate intervening rename is retried boundedly.
      if (!constants.O_NOFOLLOW && (before.dev !== info.dev || before.ino !== info.ino)) continue;
      const data = Buffer.alloc(Number(info.size) + 1); let count = 0;
      while (count < data.length) {
        const part = await handle.read(data, count, data.length - count, null);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (BigInt(count) !== info.size || after.size !== info.size || after.mtimeNs !== info.mtimeNs) fail('Dialogue control store changed during reading.');
      // withStore publishes immutable files by rename. The pathname may now
      // name another valid generation; this opened inode remains a safe snapshot.
      const bytes = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, count));
      return validateStore(JSON.parse(bytes));
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    finally { if (handle) await handle.close(); }
  }
  fail('Dialogue control store changed repeatedly before opening a safe snapshot.');
}

function coded(code, message) { return Object.assign(new Error(message), { code }); }
async function privateDirectory(path, { create = false, strict = true } = {}) {
  let created = false;
  if (create) {
    try { created = (await mkdir(path, { recursive: true, mode: 0o700 })) !== undefined; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw coded('INVALID_LOCK_PATH', 'Dialogue lock parent must be a private regular directory.');
  if (process.platform === 'win32') {
    // Never repair existing permissions. A freshly created directory can be
    // provisioned before lock data is written; existing parents are inspected.
    if (created) await protectWindowsPrivatePath(path, { directory: true });
    else if (strict) await inspectWindowsPrivatePath(path, { directory: true });
  } else {
    if (strict && (info.mode & 0o077) !== 0) throw coded('INVALID_LOCK_PATH', 'Dialogue lock parent must be private (0700).');
  }
}

export async function assertPrivateControlDirectory(context) { await privateDirectory(controlDirectory(context)); }

/** Private atomic directory lock. Uncertain/stale owners are never removed. */
export async function withOwnedDirectoryLock(context, { name, role, binding, timeoutMs = 0 }, fn, capability) {
  const strict = capability !== CONTROL_COMPAT;
  if (typeof name !== 'string' || !/^(?:\.lock|b_[0-9a-f-]+\.dispatch\.lock)$/.test(name) || !['control', 'dispatch'].includes(role) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw coded('INVALID_LOCK_OPTIONS', 'Invalid dialogue lock options.');
  const dir = controlDirectory(context);
  let exists = true;
  try { await lstat(dir); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  await privateDirectory(dir, { create: !exists, strict });
  const lock = join(dir, name), ownerPath = join(lock, 'owner.json'), deadline = Date.now() + timeoutMs;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw coded(role === 'dispatch' ? 'DISPATCH_BUSY' : 'CONTROL_BUSY', role === 'dispatch' ? 'Binding dispatch is busy; stale locks require explicit recovery.' : `Dialogue control store is busy: ${lock}. A stale lock requires explicit recovery.`);
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  // A failure while provisioning retains the empty directory as evidence.
  if (strict && process.platform === 'win32') await protectWindowsPrivatePath(lock, { directory: true });
  const info = await lstat(lock, { bigint: true }), nonce = randomUUID();
  const owner = { version: 1, role, pid: process.pid, nonce, createdAt: new Date().toISOString(), ...(binding ? { bindingId: binding.id, bindingRevision: binding.revision } : {}) };
  const handle = await open(ownerPath, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { return await fn(owner); }
  finally {
    let owned = false;
    try {
      const current = await lstat(lock, { bigint: true }), ownerInfo = await lstat(ownerPath, { bigint: true });
      if (!current.isSymbolicLink() && current.isDirectory() && current.dev === info.dev && current.ino === info.ino && ownerInfo.isFile() && !ownerInfo.isSymbolicLink() && ownerInfo.size < 16384n) {
        const recorded = JSON.parse(await readFile(ownerPath, 'utf8'));
        owned = recorded.nonce === nonce && recorded.pid === process.pid && recorded.role === role;
      }
    } catch {}
    if (!owned) throw coded('LOCK_OWNERSHIP_CHANGED', 'Dialogue lock ownership changed; lock evidence was retained.');
    await rm(lock, { recursive: true });
  }
}

/** Fail closed on a concurrent or stale lock; never guess that another writer died. */
export async function withStore(context, fn) {
  const dir = controlDirectory(context);
  return await withOwnedDirectoryLock(context, { name: '.lock', role: 'control' }, async () => {
  const temporary = join(dir, `.store-${randomUUID()}.tmp`);
  let publicationStarted = false;
  try {
    const store = await readStore(context);
    const originalVersion = store.version;
    // A v1 writer retains its original compatibility contract. Feature-bearing
    // v2/v3/v4 state requires fresh private-parent evidence on every transaction.
    if ([2, 3, 4].includes(store.version)) {
      await assertPrivateControlDirectory(context);
      if (process.platform === 'win32') await protectWindowsPrivatePath(join(dir, '.lock'), { directory: true });
    }
    const value = await fn(store);
    validateStore(store);
    if ([2, 3, 4].includes(store.version) && ![2, 3, 4].includes(originalVersion)) {
      await assertPrivateControlDirectory(context);
      if (process.platform === 'win32') await protectWindowsPrivatePath(join(dir, '.lock'), { directory: true });
    }
    const serialized = `${JSON.stringify(store, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > CONTROL_STORE_LIMIT) throw coded('CONTROL_STORE_TOO_LARGE', 'Dialogue control store exceeds the supported UTF-8 byte limit; the original store was preserved.');
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(temporary, 0o600);
    publicationStarted = true;
    await renameImmutable(temporary, join(dir, 'store.json'));
    return value;
  } finally {
    // Failed publication retains the exact immutable candidate for inspection.
    // Cleanup before publication affects only this transaction's own temp.
    if (!publicationStarted) await rm(temporary, { force: true });
  }
  }, CONTROL_COMPAT);
}

export function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) fail('Alias must start with a lowercase letter and contain 1–40 lowercase letters, digits, underscores or hyphens.');
  return alias;
}

export function resolveBinding(store, alias) {
  validateAlias(alias);
  if (!Object.hasOwn(store.bindings, alias) || !store.bindings[alias]?.active) fail(`Unknown or inactive binding: ${alias}.`);
  return store.bindings[alias];
}

export function createBinding(store, input) {
  const alias = validateAlias(input?.alias);
  if (alias === 'operator') fail('operator is reserved for explicit user messages.');
  if (Object.hasOwn(store.bindings, alias)) fail(`Binding alias already exists: ${alias}.`);
  const native = {};
  for (const key of ['harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin']) native[key] = nonempty(input[key], key);
  for (const binding of Object.values(store.bindings)) {
    if (binding.active && binding.harness === native.harness && binding.serviceId === native.serviceId && binding.sessionId === native.sessionId) {
      fail(`Native session is already bound as ${binding.alias}.`);
    }
  }
  const binding = { alias, id: `b_${randomUUID()}`, revision: 1, ...native, hcomName: `d${randomBytes(6).toString('hex')}`, active: true };
  store.bindings[alias] = binding;
  return binding;
}

export function createRoom(store, { name, members } = {}) {
  nonempty(name, 'Room name');
  if (!Array.isArray(members) || members.length < 2 || new Set(members).size !== members.length) fail('A room requires at least two distinct binding aliases.');
  const pins = members.map(alias => {
    const binding = resolveBinding(store, alias);
    return { alias: binding.alias, bindingId: binding.id, revision: binding.revision };
  });
  const room = { id: `r_${randomUUID()}`, name, members: pins };
  store.rooms[room.id] = room;
  return room;
}

export function resolveRoom(store, id) {
  nonempty(id, 'Room ID');
  if (!Object.hasOwn(store.rooms, id) || store.rooms[id]?.id !== id) fail(`Unknown room ID: ${id}. Use the exact room ID, not its display name.`);
  return store.rooms[id];
}

function resolvePinned(store, room, alias) {
  const binding = resolveBinding(store, alias);
  const pin = room.members.find(member => member.alias === alias);
  if (!pin) fail(`Binding ${alias} is not a member of room ${room.id}.`);
  if (binding.id !== pin.bindingId || binding.revision !== pin.revision) fail(`Stale room binding for ${alias}; explicit room membership update is required.`);
  return binding;
}

export function validateRoute(store, { room: roomId, from, to, expectedSession, replyTo } = {}) {
  const room = resolveRoom(store, roomId);
  const source = from === 'operator' ? { alias: 'operator', id: 'operator', revision: 1 } : resolvePinned(store, room, from);
  const destination = resolvePinned(store, room, to);
  if (source.alias === destination.alias) fail('Source and destination must be distinct participants.');
  if (expectedSession !== undefined && expectedSession !== destination.sessionId) fail(`Expected session does not match binding ${to}.`);
  if (replyTo !== undefined && replyTo !== null) nonempty(replyTo, 'replyTo');
  return { room, from: source, to: destination };
}

function validateFrame(frame) {
  if (!object(frame)) fail('Invalid dialogue frame: expected an object.');
  for (const key of FRAME_KEYS) if (!Object.hasOwn(frame, key)) fail(`Invalid dialogue frame: missing ${key}.`);
  if (frame.version !== 1) fail('Unsupported dialogue frame version.');
  nonempty(frame.room, 'Frame room');
  validateAlias(frame.from); validateAlias(frame.to);
  nonempty(frame.fromBindingId, 'Frame source binding ID');
  nonempty(frame.toBindingId, 'Frame destination binding ID');
  for (const key of ['fromRevision', 'toRevision']) {
    if (!Number.isSafeInteger(frame[key]) || frame[key] < 1) fail(`Invalid dialogue frame ${key}.`);
  }
  nonempty(frame.text, 'Frame text');
  if (frame.replyTo !== null) nonempty(frame.replyTo, 'Frame replyTo');
  return frame;
}

export function encodeFrame(payload) { return FRAME_PREFIX + JSON.stringify(validateFrame(payload)); }

export function decodeFrame(text) {
  if (typeof text !== 'string' || !text.startsWith(FRAME_PREFIX)) fail('Unframed hcom message: expected agent-dialogue/1 protocol.');
  let frame;
  try { frame = JSON.parse(text.slice(FRAME_PREFIX.length)); }
  catch { fail('Invalid dialogue frame JSON.'); }
  return validateFrame(frame);
}

/** Run immediately before submitting text to the exact native session. */
export function validateIncoming(store, binding, frame) {
  validateFrame(frame);
  const route = validateRoute(store, { room: frame.room, from: frame.from, to: frame.to, replyTo: frame.replyTo });
  const identityFields = ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId', 'remote'];
  if (!binding || identityFields.some(key => binding[key] !== route.to[key])) {
    fail('Incoming frame is for a different or stale destination binding.');
  }
  if (frame.fromBindingId !== route.from.id || frame.fromRevision !== route.from.revision || frame.toBindingId !== route.to.id || frame.toRevision !== route.to.revision) {
    fail('Incoming frame has stale or mismatched binding IDs/revisions.');
  }
  return route;
}
