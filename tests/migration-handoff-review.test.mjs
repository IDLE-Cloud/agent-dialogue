import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, readStore, withStore } from '../lib/bridge-store.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { applyMigration, prepareMigration, rollbackMigration, planMigration, verifyMigration } from '../lib/migration.mjs';

const budget = { timeout: process.platform === 'win32' ? 300000 : 20000 };
let reportedInitialStateOwner = false;
async function fixture(t, { version = 3 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-handoff-'));
  if (process.platform === 'win32') await protectWindowsPrivatePath(root, { directory: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = join(root, 'old prefix'), to = join(root, 'new prefix'), nodePath = join(root, 'Node artifact');
  for (const name of ['bin', 'lib', 'config', 'web/viewer']) await mkdir(join(from, name), { recursive: true });
  await writeFile(join(from, 'package.json'), JSON.stringify({ name: '@idle-cloud/agent-dialogue', version: '0.3.0', type: 'module', bin: { 'agent-dialogue': 'bin/agent-dialogue.mjs' } }));
  for (const name of ['agent-dialogue', 'bridge-worker']) await writeFile(join(from, 'bin', name + '.mjs'), 'throw Error("never execute synthetic installation");\n', { mode: 0o755 });
  await writeFile(join(from, 'lib/fixture.mjs'), 'export const fixture = true;\n');
  await writeFile(join(from, 'config/hcom.lock.json'), '{"version":"0.7.30"}\n');
  await writeFile(join(from, 'web/viewer/index.html'), '<!doctype html><title>fixture</title>\n');
  await cp(from, to, { recursive: true });
  await writeFile(nodePath, 'Synthetic artifact only; never execute.\n', { mode: 0o755 });
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded' };
  await mkdir(context.stateDir, { mode: 0o700 });
  if (process.platform === 'win32') {
    if (!reportedInitialStateOwner) {
      const inherited = await inspectWindowsPrivatePath(context.stateDir, { directory: true });
      t.diagnostic(JSON.stringify({ fixture: 'new-handoff-state-before-provisioning', ownerSid: inherited.ownerSid, currentUserSid: inherited.currentUserSid, ownerMatchesCurrentUser: inherited.ownerSid === inherited.currentUserSid }));
      reportedInitialStateOwner = true;
    }
    // Only this new fixture is provisioned. Migration itself must continue to
    // refuse a preexisting source whose owner is not the exact current SID.
    await protectWindowsPrivatePath(context.stateDir, { directory: true });
  }
  const node = await loadOrCreateNode(context);
  if (process.platform === 'win32') {
    await protectWindowsPrivatePath(join(context.stateDir, 'dialogue'), { directory: true });
    await protectWindowsPrivatePath(join(context.stateDir, 'dialogue/node.json'));
  }
  await initializeEmbedded(context);
  if (process.platform === 'win32') for (const name of ['hcom.db', 'hcom.db-wal', 'hcom.db-shm', 'hcom.db-journal']) {
    const path = join(context.stateDir, name);
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await protectWindowsPrivatePath(path);
  }
  let binding;
  const token = randomUUID(), pid = 987654;
  await withStore(context, store => {
    store.version = version; store.lifecycle = {};
    if (version >= 3) store.forwardings = {};
    if (version === 4) store.nativeIntents = {};
    binding = createBinding(store, { alias: 'selected', harness: 'opencode-v2', sessionId: 'ses_owned_fixture', projectId: 'fixture', directory: root, serviceId: 'fixture', origin: 'http://127.0.0.1:1' }); binding.nodeId = node.nodeId;
    store.lifecycle[binding.id] = { version: 1, bindingRevision: binding.revision, desired: 'paused', generation: 1, changeNonce: randomUUID(), changedAt: '2026-10-20T00:00:00.000Z', reason: 'operator-pause' };
    store.workerLaunches = { [binding.id]: { version: 1, bindingRevision: binding.revision, token, phase: 'stopped', pid } };
  });
  if (process.platform === 'win32') await protectWindowsPrivatePath(join(context.stateDir, 'dialogue/store.json'));
  const privateWrite = async (path, bytes, { fresh = false } = {}) => {
    await writeFile(path, bytes, { mode: 0o600 });
    if (fresh && process.platform === 'win32') await protectWindowsPrivatePath(path);
  };
  const runtimePath = join(context.stateDir, 'dialogue', binding.id + '.worker.json');
  await privateWrite(runtimePath, JSON.stringify({ lifecycleProtocol: 1, status: 'stopped', pid, token, cursor: 0, receipts: {} }) + '\n', { fresh: true });
  // Synthetic confirmed-dead probe only: these tests never start an OS worker.
  const options = { probe: async () => 'confirmed-dead', installationOptions: { sources: { packageRoot: to, nodePath } } };
  const bundle = join(root, 'private bundle'), storePath = join(context.stateDir, 'dialogue/store.json'), journalPath = join(bundle, 'journal.json');
  const prepare = extra => prepareMigration(context, { fromPackage: from, fromNode: nodePath, bundle, offline: true }, { ...options, ...extra });
  const apply = extra => applyMigration(context, { bundle, offline: true }, { ...options, ...extra });
  const rollback = extra => rollbackMigration(context, { bundle, offline: true }, { ...options, ...extra });
  return { root, from, to, nodePath, context, binding, token, pid, runtimePath, options, bundle, storePath, journalPath, privateWrite, prepare, apply, rollback };
}
async function gateImmutableWrite(t, predicate, afterWrite) {
  const probe = await open(new URL(import.meta.url), 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.writeFile; await probe.close(); let fired = false;
  t.mock.method(prototype, 'writeFile', async function (bytes, ...args) {
    const result = await original.call(this, bytes, ...args); let value;
    try { value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); } catch {}
    if (!fired && predicate(value)) { fired = true; await afterWrite(); }
    return result;
  });
  return () => fired;
}

test('raw journal changed while its next immutable candidate is written is retained rather than overwritten', budget, async t => {
  const f = await fixture(t); await f.prepare(); const original = await readFile(f.storePath), third = Buffer.concat([await readFile(f.journalPath), Buffer.from(' \n')]);
  const fired = await gateImmutableWrite(t, value => value?.phase === 'apply-prepared', () => f.privateWrite(f.journalPath, third));
  await assert.rejects(f.apply()); assert.equal(fired(), true);
  assert.deepEqual(await readFile(f.journalPath), third); assert.deepEqual(await readFile(f.storePath), original);
});

test('source store changed while the apply candidate is written is retained as a third image', budget, async t => {
  const f = await fixture(t); await f.prepare(); const third = Buffer.from(JSON.stringify({ ...(await readStore(f.context)), operatorEvidence: 'Retain this third image.' }) + '\n');
  const fired = await gateImmutableWrite(t, value => value?.version === 4 && value?.bindings?.selected, () => f.privateWrite(f.storePath, third));
  await assert.rejects(f.apply()); assert.equal(fired(), true); assert.deepEqual(await readFile(f.storePath), third);
});

test('prepare does not overwrite a foreign journal that appears before its first journal publication', budget, async t => {
  const f = await fixture(t), before = await readFile(f.storePath), foreign = Buffer.from('Retain foreign private journal evidence.\n');
  await assert.rejects(f.prepare({ checkpointHook: async stage => { if (stage === 'backup-complete') await f.privateWrite(f.journalPath, foreign, { fresh: true }); } }));
  assert.deepEqual(await readFile(f.storePath), before); assert.deepEqual(await readFile(f.journalPath), foreign);
});

test('a control lock outside the migration operation cannot produce a ready offline plan', budget, async t => {
  const f = await fixture(t), lock = join(f.context.stateDir, 'dialogue/.lock'); await mkdir(lock, { mode: 0o700 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(lock, { directory: true });
  const owner = JSON.stringify({ version: 1, role: 'control', pid: process.pid, nonce: randomUUID(), createdAt: '2026-10-20T00:00:00.000Z' }) + '\n';
  await f.privateWrite(join(lock, 'owner.json'), owner, { fresh: true });
  const result = await planMigration(f.context, { fromPackage: f.from, fromNode: f.nodePath }, f.options);
  assert.equal(result.status, 'needs-review'); assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), owner);
});

test('losing the exact recovery owner before publication retains the store preimage and replacement owner evidence', budget, async t => {
  const f = await fixture(t); await f.prepare(); const before = await readFile(f.storePath), ownerPath = join(f.bundle, '.operation.lock/owner.json'); let replacement;
  await assert.rejects(f.apply({ checkpointHook: async stage => {
    if (stage !== 'apply-prepared') return;
    replacement = JSON.stringify({ ...JSON.parse(await readFile(ownerPath)), nonce: randomUUID() }) + '\n'; await f.privateWrite(ownerPath, replacement);
  } }));
  assert.deepEqual(await readFile(f.storePath), before); assert.equal(await readFile(ownerPath, 'utf8'), replacement);
});

for (const target of ['old runtime', 'new runtime', 'Node artifact']) {
  test(`handoff refuses ${target} replacement after prepare without publishing a store delta`, budget, async t => {
    const f = await fixture(t); await f.prepare(); const before = await readFile(f.storePath), selected = target === 'Node artifact' ? f.nodePath : join(target === 'old runtime' ? f.from : f.to, 'lib/fixture.mjs');
    const replacement = selected + '.new'; await copyFile(selected, replacement); await rename(replacement, selected);
    await assert.rejects(f.apply()); assert.deepEqual(await readFile(f.storePath), before);
  });
}

test('schema-only apply and rollback preserve stopped launch tokens and runtime bytes exactly', budget, async t => {
  const f = await fixture(t), before = await readFile(f.storePath), runtime = await readFile(f.runtimePath), launch = (await readStore(f.context)).workerLaunches;
  await f.prepare(); await f.apply(); assert.equal((await readStore(f.context)).version, 4);
  assert.deepEqual((await readStore(f.context)).workerLaunches, launch); assert.deepEqual(await readFile(f.runtimePath), runtime);
  await f.rollback(); assert.deepEqual(await readFile(f.storePath), before); assert.deepEqual(await readFile(f.runtimePath), runtime);
  assert.deepEqual((await readStore(f.context)).workerLaunches, launch);
});

test('a new worker generation cannot be replaced by the older stopped launch token through rollback', budget, async t => {
  const f = await fixture(t); await f.prepare(); await f.apply();
  const nextToken = randomUUID(), nextPid = f.pid + 1;
  await withStore(f.context, store => { store.workerLaunches[f.binding.id] = { version: 1, bindingRevision: f.binding.revision, token: nextToken, phase: 'stopped', pid: nextPid }; });
  await f.privateWrite(f.runtimePath, JSON.stringify({ lifecycleProtocol: 1, status: 'stopped', pid: nextPid, token: nextToken, cursor: 1, receipts: {} }) + '\n');
  const beforeStore = await readFile(f.storePath), beforeRuntime = await readFile(f.runtimePath);
  await assert.rejects(f.rollback()); assert.deepEqual(await readFile(f.storePath), beforeStore); assert.deepEqual(await readFile(f.runtimePath), beforeRuntime);
  assert.equal((await readStore(f.context)).workerLaunches[f.binding.id].token, nextToken);
});

test('schema 2 migration can restore the exact original noncanonical bytes and stopped owner token', budget, async t => {
  const f = await fixture(t, { version: 2 }), raw = Buffer.from('\r\n' + JSON.stringify(await readStore(f.context), null, '\t') + '\r\n');
  await f.privateWrite(f.storePath, raw); await f.prepare(); await f.apply();
  const upgraded = await readStore(f.context); assert.equal(upgraded.version, 4); assert.deepEqual(upgraded.forwardings, {}); assert.deepEqual(upgraded.nativeIntents, {});
  assert.equal(upgraded.workerLaunches[f.binding.id].token, f.token);
  await f.rollback(); assert.deepEqual(await readFile(f.storePath), raw); assert.equal((await readStore(f.context)).version, 2);
});

test('schema 4 maintenance apply and rollback do not replace or rewrite the store inode or bytes', budget, async t => {
  const f = await fixture(t, { version: 4 }), raw = await readFile(f.storePath), before = await lstat(f.storePath, { bigint: true });
  await f.prepare(); await f.apply();
  for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid']) assert.equal((await lstat(f.storePath, { bigint: true }))[key], before[key], `apply ${key}`);
  assert.deepEqual(await readFile(f.storePath), raw); await f.rollback();
  for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid']) assert.equal((await lstat(f.storePath, { bigint: true }))[key], before[key], `rollback ${key}`);
  assert.deepEqual(await readFile(f.storePath), raw);
});

for (const stage of ['apply-prepared', 'store-published', 'rollback-prepared', 'rollback-store-published']) {
  test(`read-only verify recognizes the exact interrupted ${stage} image without completing it`, budget, async t => {
    const f = await fixture(t); await f.prepare();
    const rollback = stage.startsWith('rollback'); if (rollback) await f.apply();
    const hook = async value => { if (value === stage) throw Object.assign(new Error('Owned fixture checkpoint interruption.'), { code: 'FIXTURE_INTERRUPTED' }); };
    await assert.rejects((rollback ? f.rollback : f.apply)({ checkpointHook: hook }), { code: 'FIXTURE_INTERRUPTED' });
    const beforeStore = await readFile(f.storePath), beforeJournal = await readFile(f.journalPath), before = await lstat(f.storePath, { bigint: true });
    const result = await verifyMigration(f.context, { bundle: f.bundle }, f.options);
    assert.equal(result.status, 'verified'); assert.equal(result.reason, 'exact-maintenance-image'); assert.equal(result.phase, rollback ? 'rollback-prepared' : 'apply-prepared');
    assert.deepEqual(await readFile(f.storePath), beforeStore); assert.deepEqual(await readFile(f.journalPath), beforeJournal);
    for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs']) assert.equal((await lstat(f.storePath, { bigint: true }))[key], before[key]);
  });
}
