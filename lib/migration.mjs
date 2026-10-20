import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readStore, validateStore, withOwnedDirectoryLock } from './bridge-store.mjs';
import { lifecycleState, prepareControlUpgrade } from './lifecycle.mjs';
import { assertOfflineWorkers, processEvidence, workerRuntimeSnapshot } from './bridge.mjs';
import { renameImmutable } from './atomic-rename.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from './private-files.mjs';
import { scanStateFiles, writeBackupBlobs, verifyBackupBlobs, readBackupBlob, validateBackupLedger, prepareMigrationCandidateMetadata } from './migration-files.mjs';
import { captureMigrationInstallations, assertMigrationInstallationsUnchanged, validateMigrationInstallations } from './migration-installation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = x => structuredClone(x);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;
const STORE = 'dialogue/store.json';
const MAX_JOURNAL = 32 * 1024 * 1024, MAX_STORE = 16 * 1024 * 1024;
const PHASES = ['prepared', 'apply-prepared', 'applied', 'rollback-prepared', 'rolled-back', 'accepted'];
const JOURNAL_KEYS = ['version', 'id', 'createdAt', 'platform', 'bundleIdentity', 'installations', 'sourceSchema', 'targetSchema', 'backupManifestHash', 'preStoreHash', 'postStoreHash', 'rollbackEligible', 'rollbackReasons', 'phase', 'applyTemporaryName', 'rollbackTemporaryName', 'postManifest', 'restoredManifest'];
const fail = (code = 'MIGRATION_NEEDS_REVIEW') => { throw Object.assign(new Error('Migration evidence is absent, unsupported or changed; preserve both installations, the backup and current state for review.'), { code }); };
const offline = value => { if (value !== true) fail('MIGRATION_OFFLINE_REQUIRED'); };
const pathValue = value => {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('MIGRATION_SELECTION_INVALID');
  return resolve(value);
};
const inside = (a, b) => { const r = relative(b, a); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const ident = info => Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid'].map(k => [k, info[k].toString()]));
const publicationIdentity = info => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].map(k => [k, BigInt(info[k])]));

async function privateDirectory(path, { create = false } = {}) {
  if (create) { await mkdir(path, { mode: 0o700 }); if (process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true }); }
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
  if (process.platform === 'win32') await inspectWindowsPrivatePath(path, { directory: true });
  else if ((info.mode & 0o077n) !== 0n || process.getuid && info.uid !== BigInt(process.getuid())) fail();
  return ident(info);
}
async function regularBytes(path, limit, { expectedHash, privateFile = true, observation = false } = {}) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) fail();
  if (privateFile) {
    if (process.platform === 'win32') await inspectWindowsPrivatePath(path);
    else if ((before.mode & 0o077n) !== 0n || process.getuid && before.uid !== BigInt(process.getuid())) fail();
  }
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const first = await fd.stat({ bigint: true }), keys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'];
    if (!first.isFile() || keys.some(k => first[k] !== before[k])) fail();
    const bytes = Buffer.alloc(Number(first.size) + 1); let count = 0;
    while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    const after = await fd.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (BigInt(count) !== first.size || keys.some(k => first[k] !== after[k] || first[k] !== current[k]) || current.isSymbolicLink()) fail();
    const result = bytes.subarray(0, count); if (expectedHash && hash(result) !== expectedHash) fail();
    return observation ? { bytes: Buffer.from(result), identity: publicationIdentity(first) } : Buffer.from(result);
  } finally { await fd.close(); }
}
function json(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); } }
async function writeImmutable(path, bytes, mode = 0o600) {
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  if (process.platform === 'win32') await protectWindowsPrivatePath(path);
  else await chmod(path, mode);
}
async function journalWrite(bundle, value, previous = null, assertRecovery = async () => {}) {
  const path = join(bundle, 'journal.json');
  let expectedDestination = null;
  if (previous) {
    const observed = await regularBytes(path, MAX_JOURNAL, { expectedHash: previous, observation: true });
    expectedDestination = observed.identity;
  } else {
    try { await lstat(path); fail('MIGRATION_JOURNAL_CHANGED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > MAX_JOURNAL) fail('MIGRATION_CAPACITY');
  const temporary = join(bundle, '.journal-' + randomUUID() + '.tmp');
  await assertRecovery(); await writeImmutable(temporary, bytes);
  const candidate = await regularBytes(temporary, MAX_JOURNAL, { expectedHash: hash(bytes), observation: true });
  await assertRecovery();
  await renameImmutable(temporary, path, { expectedDestination, expectedSource: candidate.identity });
  return hash(bytes);
}
async function withRecovery(bundle, fn) {
  await privateDirectory(bundle);
  const path = join(bundle, '.operation.lock'), nonce = randomUUID();
  try { await privateDirectory(path, { create: true }); } catch (error) { if (error.code === 'EEXIST') fail('MIGRATION_BUSY'); throw error; }
  const identity = ident(await lstat(path, { bigint: true }));
  const owner = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, nonce }) + '\n');
  await writeImmutable(join(path, 'owner.json'), owner);
  const assertRecovery = async () => {
    if (!same(identity, ident(await lstat(path, { bigint: true }))) || !same((await readdir(path)).sort(), ['owner.json']) || hash(await regularBytes(join(path, 'owner.json'), 1024)) !== hash(owner)) fail('MIGRATION_RECOVERY_OWNER_CHANGED');
  };
  try { await assertRecovery(); return await fn(assertRecovery); }
  finally {
    await assertRecovery();
    await unlink(join(path, 'owner.json')); await rmdir(path);
  }
}
async function withControl(context, fn) {
  return withOwnedDirectoryLock(context, { name: '.lock', role: 'control' }, fn);
}
function sourceEntry(manifest) {
  const row = manifest.entries.find(row => row.path === STORE && row.kind === 'file');
  if (!row || BigInt(row.size) > BigInt(MAX_STORE)) fail(); return row;
}
function ledgerMetadata(manifest) {
  const database = manifest.entries.find(row => row.path === 'hcom.db' && row.kind === 'file');
  const journal = manifest.entries.find(row => row.path === 'hcom.db-journal');
  if (!database || BigInt(database.size) < 100n || journal && (journal.kind !== 'file' || BigInt(journal.size) > 0n)) fail('MIGRATION_LEDGER_NEEDS_REVIEW');
}
function onlyStoreDelta(before, after, expectedBytes) {
  if (!same(Object.keys(before).sort(), Object.keys(after || {}).sort())) return false;
  const except = m => ({ ...m, entries: m.entries.filter(row => row.path !== STORE), totalBytes: 0 });
  if (!same(except(before), except(after))) return false;
  const a = sourceEntry(before), b = sourceEntry(after);
  if (!same(Object.keys(a).sort(), Object.keys(b).sort()) || b.sha256 !== hash(expectedBytes) || b.size !== String(expectedBytes.length) || b.mode !== a.mode || b.uid !== a.uid || b.gid !== a.gid || b.aclHash !== a.aclHash || b.nlink !== '1') return false;
  return after.totalBytes === before.totalBytes - Number(a.size) + expectedBytes.length;
}
function candidateBytes(original) {
  const source = validateStore(json(original)), candidate = prepareControlUpgrade(source, 4);
  return source.version === 4 ? Buffer.from(original) : Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
}
async function knownQuiescent(context, store, options = {}) {
  if (![2, 3, 4].includes(store.version)) fail('MIGRATION_SCHEMA_UNSUPPORTED');
  for (const binding of Object.values(store.bindings)) if (binding?.active && !binding.remote && lifecycleState(store, binding).desired !== 'paused') fail('MIGRATION_PAUSE_REQUIRED');
  const names = await readdir(join(context.stateDir, 'dialogue'));
  for (const name of names) {
    if (name.endsWith('.lock') && (name !== '.lock' || !options.ownedControl) || name.endsWith('.worker.json') && !/^b_[0-9a-f-]{36}\.worker\.json$/.test(name)) fail('MIGRATION_NOT_QUIESCENT');
  }
  const runtimes = new Map();
  for (const name of names.filter(name => name.endsWith('.worker.json'))) {
    const id = name.slice(0, -'.worker.json'.length), binding = Object.values(store.bindings).find(b => b?.id === id);
    if (!binding || binding.remote) fail('MIGRATION_NOT_QUIESCENT');
    const { state } = await workerRuntimeSnapshot(context, id), launch = store.workerLaunches?.[id];
    if (state.lifecycleProtocol !== 1 || !['stopped', 'error'].includes(state.status) || !exact(launch, ['version', 'bindingRevision', 'token', 'phase', 'pid']) || launch.version !== 1 || launch.phase !== 'stopped' || launch.pid !== state.pid || launch.token !== state.token || launch.bindingRevision !== binding.revision || !UUID.test(state.token || '')) fail('MIGRATION_NOT_QUIESCENT');
    runtimes.set(id, state);
  }
  for (const [id, launch] of Object.entries(store.workerLaunches || {})) if (!runtimes.has(id) || launch.phase !== 'stopped') fail('MIGRATION_NOT_QUIESCENT');
  await assertOfflineWorkers(context, store, { probe: options.probe || processEvidence });
  return runtimes;
}
function rollbackEligibility(store, runtimes) {
  const reasons = new Set();
  for (const state of runtimes.values()) {
    if (state.pending) reasons.add('native-pending');
    if (state.nativePending) reasons.add('native-output-pending');
    if (state.outgoingPending) reasons.add('outgoing-pending');
    if (state.error || state.status === 'error') reasons.add('worker-error');
  }
  for (const [name, final] of [['mcpSends', 'queued'], ['outbox', 'remote-stored'], ['inbox', 'native-admitted']]) {
    if (Object.values(store[name] || {}).some(row => row?.status !== final)) reasons.add(name + '-unfinished');
  }
  for (const [name, final] of [['forwardings', 'forwarded'], ['nativeIntents', 'admitted']]) {
    if (Object.values(store[name] || {}).some(row => row?.phase !== final || row?.recovery?.phase === 'runtime-prepared')) reasons.add(name + '-unfinished');
  }
  return [...reasons].sort();
}
function summary(journal, extra = {}) {
  return { version: 1, migrationId: journal.id, phase: journal.phase, sourceSchema: journal.sourceSchema, targetSchema: 4, backend: journal.installations.namespace.backend, rollbackEligible: journal.rollbackEligible && !['accepted', 'rolled-back'].includes(journal.phase), rollbackReasons: clone(journal.rollbackReasons), resumed: false, ...extra };
}
function validateJournal(journal) {
  if (!exact(journal, JOURNAL_KEYS) || journal.version !== 1 || !UUID.test(journal.id || '') || journal.platform !== process.platform || ![2, 3, 4].includes(journal.sourceSchema) || journal.targetSchema !== 4 || !PHASES.includes(journal.phase) || !['backupManifestHash', 'preStoreHash', 'postStoreHash'].every(k => HASH.test(journal[k] || '')) || typeof journal.rollbackEligible !== 'boolean' || !Array.isArray(journal.rollbackReasons) || journal.rollbackReasons.some(r => !['native-pending', 'native-output-pending', 'outgoing-pending', 'worker-error', 'mcpSends-unfinished', 'outbox-unfinished', 'inbox-unfinished', 'forwardings-unfinished', 'nativeIntents-unfinished'].includes(r)) || !same([...new Set(journal.rollbackReasons)].sort(), journal.rollbackReasons)) fail();
  if (!Number.isFinite(Date.parse(journal.createdAt)) || new Date(journal.createdAt).toISOString() !== journal.createdAt) fail();
  if (journal.applyTemporaryName !== '.store-apply-' + journal.id + '.tmp' || journal.rollbackTemporaryName !== '.store-rollback-' + journal.id + '.tmp') fail();
  if (!exact(journal.bundleIdentity, ['dev', 'ino', 'mode', 'uid', 'gid']) || Object.values(journal.bundleIdentity).some(v => typeof v !== 'string' || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(v))) fail();
  if (journal.phase === 'prepared' && (journal.postManifest !== null || journal.restoredManifest !== null) || ['applied', 'rollback-prepared', 'accepted', 'rolled-back'].includes(journal.phase) && !object(journal.postManifest) || journal.phase === 'rolled-back' && !object(journal.restoredManifest) || journal.phase !== 'rolled-back' && journal.restoredManifest !== null) fail();
  validateMigrationInstallations(journal.installations); return journal;
}
async function readJournal(bundle) {
  const identity = await privateDirectory(bundle), bytes = await regularBytes(join(bundle, 'journal.json'), MAX_JOURNAL), journal = validateJournal(json(bytes));
  if (!same(identity, journal.bundleIdentity)) fail();
  return { journal, journalHash: hash(bytes) };
}
async function originalEvidence(bundle, journal) {
  const backup = await verifyBackupBlobs(join(bundle, 'snapshot'), { expectedManifestHash: journal.backupManifestHash });
  const entry = sourceEntry(backup.manifest);
  if (entry.sha256 !== journal.preStoreHash) fail();
  const original = await readBackupBlob(join(bundle, 'snapshot'), journal.preStoreHash, { expectedManifestHash: journal.backupManifestHash });
  const source = validateStore(json(original)), candidate = candidateBytes(original);
  if (source.version !== journal.sourceSchema || hash(candidate) !== journal.postStoreHash || !journal.installations.compatibility.sourceSchemas.includes(source.version)) fail();
  const runtimes = new Map();
  for (const row of backup.manifest.entries.filter(row => /^dialogue\/b_[0-9a-f-]{36}\.worker\.json$/.test(row.path))) {
    const bytes = await readBackupBlob(join(bundle, 'snapshot'), row.sha256, { expectedManifestHash: journal.backupManifestHash });
    runtimes.set(row.path, json(bytes));
  }
  const reasons = rollbackEligibility(source, runtimes);
  if (!same(reasons, journal.rollbackReasons) || journal.rollbackEligible !== (reasons.length === 0)) fail();
  if (journal.postManifest && !onlyStoreDelta(backup.manifest, journal.postManifest, candidate)) fail();
  if (journal.restoredManifest && !onlyStoreDelta(journal.postManifest, journal.restoredManifest, original)) fail();
  return { backup, original, candidate };
}
async function bundleSelection(value) {
  const selected = pathValue(value), parent = await realpath(dirname(selected));
  return join(parent, basename(selected));
}
function ensureBundleNamespace(bundle, installations) {
  for (const path of [installations.from.packageRoot, installations.to.packageRoot, installations.namespace.state.canonicalPath, installations.namespace.cache.canonicalPath]) if (inside(bundle, path) || inside(path, bundle)) fail('MIGRATION_PATH_OVERLAP');
}
async function currentEvidence(context, bundle, options) {
  const record = await readJournal(bundle);
  ensureBundleNamespace(bundle, record.journal.installations);
  await assertMigrationInstallationsUnchanged(context, record.journal.installations, options.installationOptions);
  const evidence = await originalEvidence(bundle, record.journal);
  return { ...record, ...evidence };
}

/** Read-only planning still independently queries known PID ownership. */
export async function planMigration(context, selection, options = {}) {
  let queries = 0;
  try {
    const installations = await captureMigrationInstallations(context, selection, options.installationOptions);
    const before = await scanStateFiles(context), store = await readStore(context);
    if (!installations.compatibility.sourceSchemas.includes(store.version)) fail('MIGRATION_SCHEMA_UNSUPPORTED');
    const runtimes = await knownQuiescent(context, store, { probe: async (...args) => { queries++; return (options.probe || processEvidence)(...args); } });
    const after = await scanStateFiles(context);
    if (!same(before, after)) fail();
    ledgerMetadata(before.manifest);
    const reasons = rollbackEligibility(store, runtimes);
    return { status: 'ready', phase: 'planned', sourceSchema: store.version, targetSchema: 4, backend: context.ledgerBackend, files: before.manifest.fileCount, bytes: before.manifest.totalBytes, ledgerValidation: 'not-probed', rollbackEligible: reasons.length === 0, rollbackReasons: reasons, effects: { sourceWrites: false, processQueries: queries, nativeContact: false, sshContact: false } };
  } catch (error) {
    const reason = ['MIGRATION_PAUSE_REQUIRED', 'MIGRATION_SCHEMA_UNSUPPORTED', 'MIGRATION_NOT_QUIESCENT'].includes(error.code) ? error.code : 'MIGRATION_NEEDS_REVIEW';
    return { status: 'needs-review', reason, effects: { sourceWrites: false, processQueries: queries, nativeContact: false, sshContact: false } };
  }
}
export async function prepareMigration(context, { bundle: selected, offline: declared, ...selection }, options = {}) {
  offline(declared);
  const installations = await captureMigrationInstallations(context, selection, options.installationOptions);
  const bundle = await bundleSelection(selected); ensureBundleNamespace(bundle, installations);
  await privateDirectory(dirname(bundle));
  const sourceDevice = (await lstat(context.stateDir, { bigint: true })).dev, destinationDevice = (await lstat(dirname(bundle), { bigint: true })).dev;
  if (sourceDevice !== destinationDevice) fail('MIGRATION_SAME_VOLUME_REQUIRED');
  await privateDirectory(bundle, { create: true });
  return withRecovery(bundle, assertRecovery => withControl(context, async owner => {
    await assertMigrationInstallationsUnchanged(context, installations, options.installationOptions);
    const store = await readStore(context);
    if (!installations.compatibility.sourceSchemas.includes(store.version)) fail('MIGRATION_SCHEMA_UNSUPPORTED');
    const runtimes = await knownQuiescent(context, store, { ...options, ownedControl: owner }), before = await scanStateFiles(context, { ownedControl: owner });
    ledgerMetadata(before.manifest);
    const original = await regularBytes(join(context.stateDir, STORE), MAX_STORE, { expectedHash: sourceEntry(before.manifest).sha256, privateFile: false });
    if (!same(json(original), store)) fail();
    const candidate = candidateBytes(original);
    const backup = await writeBackupBlobs(context, join(bundle, 'snapshot'), { expected: before, ownedControl: owner });
    await validateBackupLedger(join(bundle, 'snapshot'), { expectedManifestHash: backup.manifestHash, backend: context.ledgerBackend });
    await options.checkpointHook?.('backup-complete');
    await assertMigrationInstallationsUnchanged(context, installations, options.installationOptions);
    await knownQuiescent(context, await readStore(context), { ...options, ownedControl: owner });
    if (!same(before, await scanStateFiles(context, { ownedControl: owner }))) fail();
    const id = randomUUID(), reasons = rollbackEligibility(store, runtimes);
    const journal = { version: 1, id, createdAt: new Date().toISOString(), platform: process.platform, bundleIdentity: await privateDirectory(bundle), installations, sourceSchema: store.version, targetSchema: 4, backupManifestHash: backup.manifestHash, preStoreHash: hash(original), postStoreHash: hash(candidate), rollbackEligible: reasons.length === 0, rollbackReasons: reasons, phase: 'prepared', applyTemporaryName: '.store-apply-' + id + '.tmp', rollbackTemporaryName: '.store-rollback-' + id + '.tmp', postManifest: null, restoredManifest: null };
    validateJournal(journal); await journalWrite(bundle, journal, null, assertRecovery);
    return summary(journal, { sourceChanged: false });
  }));
}
export async function migrationStatus(context, { bundle: selected }) {
  const bundle = await bundleSelection(selected), { journal } = await readJournal(bundle);
  if (resolve(context.stateDir) !== journal.installations.namespace.state.path || context.ledgerBackend !== journal.installations.namespace.backend || resolve(context.cacheDir) !== journal.installations.namespace.cache.path) fail();
  return summary(journal);
}
export async function verifyMigration(context, { bundle: selected }, options = {}) {
  const bundle = await bundleSelection(selected), { journal, backup, original, candidate } = await currentEvidence(context, bundle, options), current = await scanStateFiles(context);
  const expected = journal.phase === 'prepared' ? backup.manifest : journal.phase === 'rolled-back' ? journal.restoredManifest : journal.postManifest;
  const matches = journal.phase === 'apply-prepared' ? same(current.manifest, backup.manifest) || onlyStoreDelta(backup.manifest, current.manifest, candidate)
    : journal.phase === 'rollback-prepared' ? same(current.manifest, journal.postManifest) || onlyStoreDelta(journal.postManifest, current.manifest, original)
    : same(current.manifest, expected);
  return summary(journal, { status: matches ? 'verified' : 'needs-review', reason: matches ? 'exact-maintenance-image' : 'state-changed', sourceChanged: false });
}

/** A fixed candidate lives beside the private bundle, on the same volume as
 * state. Failure retains it; retries never replace a contradictory candidate. */
export async function publishMigrationStore(context, { bytes, mode, temporaryName, expectedStore, beforePublish = async () => {} }) {
  if (!expectedStore) fail('MIGRATION_PUBLICATION_PREIMAGE_REQUIRED');
  let exists = true;
  try { await lstat(temporaryName); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) {
    if (hash(await regularBytes(temporaryName, MAX_STORE, { privateFile: false })) !== hash(bytes)) fail('MIGRATION_CANDIDATE_CHANGED');
    const info = await lstat(temporaryName, { bigint: true });
    if (process.platform !== 'win32' && Number(info.mode & 0o777n) !== mode) fail();
  } else await writeImmutable(temporaryName, bytes, mode);
  const metadata = await prepareMigrationCandidateMetadata(join(context.stateDir, STORE), temporaryName, expectedStore, { newlyCreated: !exists });
  if (metadata.sha256 !== hash(bytes)) fail('MIGRATION_CANDIDATE_CHANGED');
  await beforePublish();
  await renameImmutable(temporaryName, join(context.stateDir, STORE), { expectedDestination: publicationIdentity(expectedStore), expectedSource: publicationIdentity(metadata) });
}
async function mutate(context, selected, options, action) {
  offline(selected.offline);
  const bundle = await bundleSelection(selected.bundle);
  // Reject a different/missing source namespace before the C helper could
  // provision any control directory. The complete proof is repeated under C.
  await currentEvidence(context, bundle, options);
  return withRecovery(bundle, assertRecovery => withControl(context, async owner => {
    const evidence = await currentEvidence(context, bundle, options);
    await knownQuiescent(context, await readStore(context), { ...options, ownedControl: owner });
    const current = await scanStateFiles(context, { ownedControl: owner });
    return action({ ...evidence, bundle, owner, current, assertRecovery });
  }));
}
async function publicationGate(context, evidence, options, expectedJournal) {
  await evidence.assertRecovery();
  await assertMigrationInstallationsUnchanged(context, evidence.journal.installations, options.installationOptions);
  if (!same(evidence.current, await scanStateFiles(context, { ownedControl: evidence.owner }))) fail();
  await knownQuiescent(context, await readStore(context), { ...options, ownedControl: evidence.owner });
  if (hash(await regularBytes(join(evidence.bundle, 'journal.json'), MAX_JOURNAL)) !== expectedJournal) fail('MIGRATION_JOURNAL_CHANGED');
  await evidence.assertRecovery();
}
export async function applyMigration(context, selected, options = {}) {
  return mutate(context, selected, options, async evidence => {
    const { journal, backup, candidate, bundle, owner } = evidence; let expectedJournal = evidence.journalHash;
    if (journal.phase === 'applied') { if (!same(evidence.current.manifest, journal.postManifest)) fail(); return summary(journal, { sourceChanged: false }); }
    if (!['prepared', 'apply-prepared'].includes(journal.phase)) fail('MIGRATION_PHASE_INVALID');
    const pre = same(evidence.current.manifest, backup.manifest);
    const post = journal.phase === 'apply-prepared' && onlyStoreDelta(backup.manifest, evidence.current.manifest, candidate);
    if (!pre && !post) fail();
    if (journal.phase === 'prepared') {
      journal.phase = 'apply-prepared'; expectedJournal = await journalWrite(bundle, journal, expectedJournal, evidence.assertRecovery);
    }
    await options.checkpointHook?.('apply-prepared');
    await publicationGate(context, evidence, options, expectedJournal);
    if (pre && journal.preStoreHash !== journal.postStoreHash) {
      await (options.publishStore || publishMigrationStore)(context, { bytes: candidate, mode: Number(BigInt(sourceEntry(backup.manifest).mode) & 0o777n), temporaryName: join(bundle, journal.applyTemporaryName), expectedStore: sourceEntry(evidence.current.manifest), beforePublish: () => publicationGate(context, evidence, options, expectedJournal), direction: 'apply' });
    }
    await options.checkpointHook?.('store-published');
    const after = await scanStateFiles(context, { ownedControl: owner });
    if (!onlyStoreDelta(backup.manifest, after.manifest, candidate)) fail();
    await knownQuiescent(context, await readStore(context), { ...options, ownedControl: owner });
    await assertMigrationInstallationsUnchanged(context, journal.installations, options.installationOptions);
    journal.postManifest = after.manifest; journal.phase = 'applied';
    await journalWrite(bundle, journal, expectedJournal, evidence.assertRecovery); await options.checkpointHook?.('applied');
    return summary(journal, { sourceChanged: pre && journal.preStoreHash !== journal.postStoreHash });
  });
}
export async function acceptMigration(context, selected, options = {}) {
  return mutate(context, selected, options, async evidence => {
    const { journal, bundle } = evidence;
    if (!['applied', 'accepted'].includes(journal.phase) || !same(evidence.current.manifest, journal.postManifest)) fail('MIGRATION_PHASE_INVALID');
    if (journal.phase === 'accepted') return summary(journal, { sourceChanged: false });
    await publicationGate(context, evidence, options, evidence.journalHash);
    journal.phase = 'accepted'; await journalWrite(bundle, journal, evidence.journalHash, evidence.assertRecovery);
    await options.checkpointHook?.('accepted');
    return summary(journal, { sourceChanged: false });
  });
}
export async function rollbackMigration(context, selected, options = {}) {
  return mutate(context, selected, options, async evidence => {
    const { journal, original, bundle, owner } = evidence; let expectedJournal = evidence.journalHash;
    if (journal.phase === 'rolled-back') { if (!same(evidence.current.manifest, journal.restoredManifest)) fail(); return summary(journal, { sourceChanged: false }); }
    if (!journal.rollbackEligible || !['applied', 'rollback-prepared'].includes(journal.phase)) fail('MIGRATION_ROLLBACK_CLOSED');
    const pre = same(evidence.current.manifest, journal.postManifest), post = journal.phase === 'rollback-prepared' && onlyStoreDelta(journal.postManifest, evidence.current.manifest, original);
    if (!pre && !post) fail();
    if (journal.phase === 'applied') {
      journal.phase = 'rollback-prepared'; expectedJournal = await journalWrite(bundle, journal, expectedJournal, evidence.assertRecovery);
    }
    await options.checkpointHook?.('rollback-prepared');
    await publicationGate(context, evidence, options, expectedJournal);
    if (pre && journal.preStoreHash !== journal.postStoreHash) {
      await (options.publishStore || publishMigrationStore)(context, { bytes: original, mode: Number(BigInt(sourceEntry(evidence.backup.manifest).mode) & 0o777n), temporaryName: join(bundle, journal.rollbackTemporaryName), expectedStore: sourceEntry(evidence.current.manifest), beforePublish: () => publicationGate(context, evidence, options, expectedJournal), direction: 'rollback' });
    }
    await options.checkpointHook?.('rollback-store-published');
    const after = await scanStateFiles(context, { ownedControl: owner });
    if (!onlyStoreDelta(journal.postManifest, after.manifest, original)) fail();
    await knownQuiescent(context, await readStore(context), { ...options, ownedControl: owner });
    await assertMigrationInstallationsUnchanged(context, journal.installations, options.installationOptions);
    journal.phase = 'rolled-back'; journal.restoredManifest = after.manifest;
    await journalWrite(bundle, journal, expectedJournal, evidence.assertRecovery);
    return summary(journal, { sourceChanged: pre && journal.preStoreHash !== journal.postStoreHash });
  });
}
