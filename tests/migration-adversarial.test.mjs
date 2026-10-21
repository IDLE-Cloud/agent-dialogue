import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, readStore, withOwnedDirectoryLock, withStore } from '../lib/bridge-store.mjs';
import { hcom } from '../lib/bridge.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from '../lib/private-files.mjs';
import * as migration from '../lib/migration.mjs';

// Only fixture totals are larger on Windows. Production ACL/PID deadlines stay unchanged.
const budget = { timeout: process.platform === 'win32' ? 900000 : 30000 };
const interrupted = stage => Object.assign(new Error('Owned migration checkpoint interruption: ' + stage), { code: 'FIXTURE_INTERRUPTED' });
let reportedInitialOwners = false;

async function fixture(t, { version = 3, mutate } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-adversarial-'));
  if (process.platform === 'win32') await protectWindowsPrivatePath(root, { directory: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPackage = join(root, 'old package'), newPackage = join(root, 'new package'), selectedNode = join(root, 'synthetic Node artifact');
  for (const path of ['bin', 'lib', 'config', 'web/viewer']) await mkdir(join(oldPackage, path), { recursive: true, mode: 0o700 });
  await writeFile(join(oldPackage, 'package.json'), JSON.stringify({ name: '@idle-cloud/agent-dialogue', version: '0.3.0', type: 'module', bin: { 'agent-dialogue': 'bin/agent-dialogue.mjs' } }), { mode: 0o644 });
  for (const name of ['agent-dialogue', 'bridge-worker']) await writeFile(join(oldPackage, 'bin', name + '.mjs'), 'throw Error("Synthetic installation must never execute");\n', { mode: 0o755 });
  await writeFile(join(oldPackage, 'lib', 'fixture.mjs'), 'export const synthetic = true;\n', { mode: 0o644 });
  await writeFile(join(oldPackage, 'config', 'hcom.lock.json'), JSON.stringify({ version: '0.7.30', assets: { [`${process.platform}-${process.arch}`]: { sha256: 'a'.repeat(64) } } }), { mode: 0o644 });
  await writeFile(join(oldPackage, 'web', 'viewer', 'index.html'), '<!doctype html><title>Owned fixture</title>\n', { mode: 0o644 });
  await writeFile(selectedNode, 'Synthetic artifact for hashing only; must never execute.\n', { mode: 0o755 });
  await cp(oldPackage, newPackage, { recursive: true });
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', PATH: '' } };
  await mkdir(context.stateDir, { mode: 0o700 });
  const reportInitialOwners = process.platform === 'win32' && !reportedInitialOwners;
  if (reportInitialOwners) {
    const inherited = await inspectWindowsPrivatePath(context.stateDir, { directory: true });
    t.diagnostic(JSON.stringify({ fixture: 'new-state-before-provisioning', ownerSid: inherited.ownerSid, currentUserSid: inherited.currentUserSid, ownerMatchesCurrentUser: inherited.ownerSid === inherited.currentUserSid }));
    reportedInitialOwners = true;
  }
  if (process.platform === 'win32') await protectWindowsPrivatePath(context.stateDir, { directory: true });
  await mkdir(context.cacheDir, { mode: 0o700 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(context.cacheDir, { directory: true });
  const node = await loadOrCreateNode(context); await initializeEmbedded(context);
  let binding, peer, room;
  await withStore(context, store => {
    store.version = version; store.lifecycle = {};
    if (version >= 3) store.forwardings = {};
    if (version === 4) store.nativeIntents = {};
    const make = alias => { const b = createBinding(store, { alias, harness: 'opencode-v1', sessionId: 'ses_' + alias, projectId: 'owned-migration-fixture', directory: root, serviceId: 'owned-fake-service', origin: 'http://127.0.0.1:1' }); b.nodeId = node.nodeId; return b; };
    binding = make('selected'); peer = make('peer'); room = createRoom(store, { name: 'Owned migration fixture', members: [binding.alias, peer.alias] });
    for (const b of [binding, peer]) store.lifecycle[b.id] = { version: 1, bindingRevision: b.revision, desired: 'paused', generation: 1, changeNonce: randomUUID(), changedAt: '2026-10-20T00:00:00.000Z', reason: 'operator-pause' };
    mutate?.(store, binding);
  });
  for (const b of [binding, peer]) await hcom(context, ['start', '--name', b.hcomName]);
  const storePath = join(context.stateDir, 'dialogue', 'store.json');
  const privateWrite = async (path, bytes, { fresh = false } = {}) => {
    await writeFile(path, bytes, { mode: 0o600, ...(fresh ? { flag: 'wx' } : {}) });
    if (fresh && process.platform === 'win32') await protectWindowsPrivatePath(path);
  };
  const history = join(context.stateDir, 'historical.note'); await privateWrite(history, 'Retain this complete original fixture note.\n', { fresh: true });
  const provisionFixtureFiles = async ({ diagnostic = false } = {}) => {
    if (process.platform !== 'win32') return;
    // These exact files were created by this fixture. This is setup before its
    // first snapshot, never normalization of an existing production state.
    for (const relative of ['dialogue/node.json', 'dialogue/store.json', 'hcom.db', 'hcom.db-wal', 'hcom.db-shm', 'hcom.db-journal']) {
      const path = join(context.stateDir, relative);
      try { await lstat(path); }
      catch (error) { if (error.code === 'ENOENT' && relative.startsWith('hcom.db-')) continue; throw error; }
      if (diagnostic) {
        const inherited = await inspectWindowsPrivatePath(path);
        t.diagnostic(JSON.stringify({ fixture: 'new-file-before-provisioning', path: relative, ownerSid: inherited.ownerSid, currentUserSid: inherited.currentUserSid, ownerMatchesCurrentUser: inherited.ownerSid === inherited.currentUserSid }));
      }
      await protectWindowsPrivatePath(path);
    }
  };
  await provisionFixtureFiles({ diagnostic: reportInitialOwners });
  const args = { fromPackage: oldPackage, fromNode: selectedNode }, bundle = join(root, 'private workflow bundle');
  // Installation identity is synthetic test scope. No installed CLI or model is executed.
  const options = { installationOptions: { sources: { packageRoot: newPackage, nodePath: selectedNode } } };
  let sourceProvisioningClosed = false;
  const prepare = async extra => {
    // A test can add its synthetic stopped runtime through withStore during
    // setup, replacing store.json. Provision that exact new fixture inode once;
    // close this seam before prepare can create any snapshot or checkpoint.
    if (!sourceProvisioningClosed) { sourceProvisioningClosed = true; await provisionFixtureFiles(); }
    return migration.prepareMigration(context, { ...args, bundle, offline: true }, { ...options, ...extra });
  };
  const apply = extra => migration.applyMigration(context, { bundle, offline: true }, { ...options, ...extra });
  const rollback = extra => migration.rollbackMigration(context, { bundle, offline: true }, { ...options, ...extra });
  const verify = () => migration.verifyMigration(context, { bundle }, options);
  const status = () => migration.migrationStatus(context, { bundle });
  const accept = extra => migration.acceptMigration(context, { bundle, offline: true }, { ...options, ...extra });
  return { root, context, node, binding, peer, room, storePath, history, args, bundle, newPackage, options, prepare, apply, rollback, verify, status, accept, privateWrite };
}

test('default migration plan preserves source bytes, identity, namespace and store inode without acquiring control', budget, async t => {
  const f = await fixture(t), before = await readFile(f.storePath), info = await lstat(f.storePath, { bigint: true }), names = await readdir(join(f.context.stateDir, 'dialogue'));
  const result = await migration.planMigration(f.context, f.args, f.options);
  assert.equal(result.rollbackEligible, true);
  assert.deepEqual(await readFile(f.storePath), before);
  const after = await lstat(f.storePath, { bigint: true });
  for (const key of ['ino', 'dev', 'mtimeNs', 'ctimeNs', 'mode']) assert.equal(after[key], info[key], key);
  assert.deepEqual(await readdir(join(f.context.stateDir, 'dialogue')), names);
  assert.equal(JSON.stringify(result).includes(f.root), false, 'Public summary must omit private installation/state paths.');
});

test('a plan observing an existing unassigned control lock cannot report the source ready for migration', budget, async t => {
  const f = await fixture(t), original = await readFile(f.storePath);
  await withOwnedDirectoryLock(f.context, { name: '.lock', role: 'control' }, async () => {
    const result = await migration.planMigration(f.context, f.args, f.options);
    assert.equal(result.status, 'needs-review');
    assert.deepEqual(await readFile(f.storePath), original);
    assert.equal((await lstat(join(f.context.stateDir, 'dialogue', '.lock'))).isDirectory(), true);
  });
});

test('allowed rollback restores the complete original noncanonical store bytes rather than reserializing its JSON', budget, async t => {
  const f = await fixture(t), original = '\r\n' + JSON.stringify(await readStore(f.context), null, '\t') + '\r\n';
  await f.privateWrite(f.storePath, original); const identity = await readFile(join(f.context.stateDir, 'dialogue', 'node.json')), database = await readFile(join(f.context.stateDir, 'hcom.db'));
  await f.prepare(); await f.apply(); assert.equal((await readStore(f.context)).version, 4); await f.verify();
  await f.rollback(); assert.equal(await readFile(f.storePath, 'utf8'), original);
  assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', 'node.json')), identity);
  assert.deepEqual(await readFile(join(f.context.stateDir, 'hcom.db')), database);
});

test('historical legacy MCP preparing and unknown outbox independently seal rollback while preserving upgrade data', budget, async t => {
  for (const field of ['mcpSends', 'outbox']) {
    const f = await fixture(t, { mutate: (store, b) => { store[field] = field === 'mcpSends' ? { historical: { bindingId: b.id, bindingRevision: b.revision, roomId: 'legacy-room', requestKey: 'legacy-key', payloadHash: 'a'.repeat(64), status: 'preparing', at: '2026-10-20T00:00:00.000Z' } } : { historical: { status: 'unknown' } }; } });
    const original = structuredClone((await readStore(f.context))[field]);
    assert.equal((await f.prepare()).rollbackEligible, false, field); await f.apply();
    assert.deepEqual((await readStore(f.context))[field], original);
    const before = await readFile(f.storePath); await assert.rejects(f.rollback()); assert.deepEqual(await readFile(f.storePath), before);
    assert.equal((await f.status()).rollbackEligible, false);
  }
});

for (const field of ['pending', 'nativePending', 'outgoingPending']) {
  test(`stopped runtime ${field} independently seals rollback and is never silently cleared by migration`, budget, async t => {
    const started = performance.now();
    const stage = name => t.diagnostic(JSON.stringify({ scenario: `stopped-runtime-${field}`, stage: name, elapsedMs: Math.round(performance.now() - started) }));
    stage('setup-start');
    const f = await fixture(t), token = randomUUID(), pid = 912346;
    // Synthetic confirmed-dead seam: no OS worker is created at this PID.
    await withStore(f.context, store => { store.workerLaunches = { [f.binding.id]: { version: 1, bindingRevision: f.binding.revision, token, pid, phase: 'stopped' } }; });
    const runtime = { pid, token, lifecycleProtocol: 1, status: 'stopped', cursor: 0, receipts: {}, [field]: { eventId: 17, inputId: 'msg_legacy_unknown', status: 'prepared' } }, path = join(f.context.stateDir, 'dialogue', f.binding.id + '.worker.json');
    await f.privateWrite(path, JSON.stringify(runtime), { fresh: true });
    const options = { probe: async () => 'confirmed-dead' };
    stage('setup-complete');
    stage('prepare-start');
    const prepared = await f.prepare(options);
    stage('prepare-complete');
    assert.equal(prepared.rollbackEligible, false, field);
    stage('apply-start');
    await f.apply(options);
    stage('apply-complete');
    assert.deepEqual(JSON.parse(await readFile(path)), runtime);
    stage('negative-rollback-start');
    await assert.rejects(f.rollback(options));
    stage('negative-rollback-complete');
  });
}

test('a newly stored ledger message after prepare prevents apply without deleting or replacing its evidence', budget, async t => {
  const f = await fixture(t); await f.prepare();
  await hcom(f.context, ['send', '--json', '--from', 'fixture-operator', '@' + f.binding.hcomName, '--thread', f.room.id, '--intent', 'inform', '--', 'A genuinely new owned embedded event after snapshot.']);
  const store = await readFile(f.storePath), db = await readFile(join(f.context.stateDir, 'hcom.db'));
  await assert.rejects(f.apply()); assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(join(f.context.stateDir, 'hcom.db')), db);
});

test('drift after the apply checkpoint is refused before the store publication side effect', budget, async t => {
  const f = await fixture(t); await f.prepare(); const original = await readFile(f.storePath), late = join(f.context.stateDir, 'late-evidence.txt');
  await assert.rejects(f.apply({ checkpointHook: async stage => { if (stage === 'apply-prepared') await f.privateWrite(late, 'Keep this late producer evidence.\n', { fresh: true }); } }));
  assert.deepEqual(await readFile(f.storePath), original); assert.equal(await readFile(late, 'utf8'), 'Keep this late producer evidence.\n');
});

test('journal drift at apply-prepared cannot authorize publishing the source store', budget, async t => {
  const f = await fixture(t); await f.prepare(); const before = await readFile(f.storePath);
  await assert.rejects(f.apply({ checkpointHook: async stage => {
    if (stage !== 'apply-prepared') return;
    const path = join(f.bundle, 'journal.json'), value = JSON.parse(await readFile(path)); value.unexpected = 'A concurrent checkpoint replacement.'; await f.privateWrite(path, JSON.stringify(value));
  } }));
  assert.deepEqual(await readFile(f.storePath), before);
});

test('a previously confirmed-dead synthetic owner becoming unknown at apply admission prevents publication', budget, async t => {
  const f = await fixture(t), token = randomUUID(), pid = 912346; let evidence = 'confirmed-dead';
  // This is an explicit synthetic probe transition, not a real OS PID observation.
  await withStore(f.context, store => { store.workerLaunches = { [f.binding.id]: { version: 1, bindingRevision: f.binding.revision, token, pid, phase: 'stopped' } }; });
  await f.privateWrite(join(f.context.stateDir, 'dialogue', f.binding.id + '.worker.json'), JSON.stringify({ pid, token, lifecycleProtocol: 1, status: 'stopped', cursor: 0, receipts: {} }), { fresh: true });
  const probe = async () => evidence; await f.prepare({ probe }); const before = await readFile(f.storePath);
  await assert.rejects(f.apply({ probe, checkpointHook: async stage => { if (stage === 'apply-prepared') evidence = 'unknown'; } }));
  assert.deepEqual(await readFile(f.storePath), before);
});

test('changes after store publication cannot be adopted into a new legitimate postmanifest', budget, async t => {
  const f = await fixture(t); await f.prepare(); const late = join(f.context.stateDir, 'late-received-message.txt');
  await assert.rejects(f.apply({ checkpointHook: async stage => { if (stage === 'store-published') await f.privateWrite(late, 'Do not legitimize this new source entry.\n', { fresh: true }); } }));
  const after = await readFile(f.storePath); await assert.rejects(f.rollback()); assert.deepEqual(await readFile(f.storePath), after);
  assert.equal(await readFile(late, 'utf8'), 'Do not legitimize this new source entry.\n');
});

test('an installation changed after store publication cannot be certified as an applied migration', budget, async t => {
  const f = await fixture(t); await f.prepare();
  await assert.rejects(f.apply({ checkpointHook: async stage => { if (stage === 'store-published') await writeFile(join(f.newPackage, 'lib', 'fixture.mjs'), 'export const unreviewed = true;\n'); } }));
  assert.equal((await f.status()).phase, 'apply-prepared');
});

test('a different source store after rollback checkpoint is retained instead of overwritten with the old snapshot', budget, async t => {
  const f = await fixture(t); await f.prepare(); await f.apply(); let changed;
  await assert.rejects(f.rollback({ checkpointHook: async stage => {
    if (stage !== 'rollback-prepared') return;
    changed = JSON.stringify({ ...(await readStore(f.context)), newOperatorEvidence: 'Retain a third image.' }); await f.privateWrite(f.storePath, changed);
  } }));
  assert.equal(await readFile(f.storePath, 'utf8'), changed);
});

test('lost responses after apply and rollback store publication converge using exact images with no extra effects', budget, async t => {
  const f = await fixture(t), original = await readFile(f.storePath); await f.prepare();
  await assert.rejects(f.apply({ checkpointHook: async stage => { if (stage === 'store-published') throw interrupted(stage); } }));
  const applied = await readFile(f.storePath); assert.equal((await readStore(f.context)).version, 4);
  await f.apply(); assert.deepEqual(await readFile(f.storePath), applied);
  await assert.rejects(f.rollback({ checkpointHook: async stage => { if (stage === 'rollback-store-published') throw interrupted(stage); } }));
  assert.deepEqual(await readFile(f.storePath), original); await f.rollback(); assert.deepEqual(await readFile(f.storePath), original);
});

test('accept permanently closes rollback even if its source postimage has not changed and the response is lost', budget, async t => {
  const f = await fixture(t); await f.prepare(); await f.apply(); const before = await readFile(f.storePath);
  await assert.rejects(f.accept({ checkpointHook: async stage => { if (stage === 'accepted') throw interrupted(stage); } }));
  await assert.rejects(f.rollback()); assert.deepEqual(await readFile(f.storePath), before); assert.equal((await f.status()).rollbackEligible, false);
});

test('modified external journal and corrupted backup blobs cannot authorize a source rollback', budget, async t => {
  for (const target of ['journal', 'blob']) {
    const f = await fixture(t); await f.prepare(); await f.apply(); const before = await readFile(f.storePath);
    if (target === 'journal') {
      const path = join(f.bundle, 'journal.json'), value = JSON.parse(await readFile(path)); value.unexpected = 'A closed journal must reject this field.'; await f.privateWrite(path, JSON.stringify(value));
    } else {
      const dir = join(f.bundle, 'snapshot', 'blobs'), [name] = await readdir(dir); await f.privateWrite(join(dir, name), 'Corrupted original backup body.\n');
    }
    await assert.rejects(f.verify()); await assert.rejects(f.rollback()); assert.deepEqual(await readFile(f.storePath), before);
  }
});
