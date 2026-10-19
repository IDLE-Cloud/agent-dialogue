import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspect } from '../lib/inspect.mjs';
import { readSource } from '../lib/viewer/readers/local.mjs';
import { projectSources } from '../lib/viewer/projection.mjs';
import { acceptObservation, exportObservation } from '../lib/viewer/observation.mjs';
import { ViewerModel } from '../lib/viewer/stream.mjs';
import { makeObservationFixture } from './fixtures/viewer-observation-fixture.mjs';
import { fixtureIDs } from './fixtures/viewer-fixture.mjs';

const changedAt = '2026-10-19T08:00:00.000Z';
const lifecycle = (binding, desired = 'paused') => ({ version: 1, bindingRevision: binding.revision, desired, generation: 3,
  changeNonce: randomUUID(), changedAt, reason: desired === 'paused' ? 'operator-pause' : 'operator-resume' });
const publicLifecycle = row => ({ bindingRevision: row.bindingRevision, desired: row.desired, generation: row.generation, changedAt: row.changedAt });
const codes = report => report.checks.map(row => row.code);

async function inspectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lifecycle-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { PATH: '' } };
  await mkdir(join(context.stateDir, 'dialogue'), { recursive: true, mode: 0o700 });
  const binding = { alias: 'selected', id: `b_${randomUUID()}`, revision: 1, harness: 'opencode-v2', sessionId: 'ses_selected', projectId: 'project-selected', directory: join(root, 'project'), serviceId: 'service-selected', origin: 'http://127.0.0.1:4567', hcomName: 'd012345678901', active: true };
  const store = { version: 2, bindings: { selected: binding }, rooms: {}, lifecycle: { [binding.id]: lifecycle(binding) } };
  const path = join(context.stateDir, 'dialogue', 'store.json');
  const save = () => writeFile(path, JSON.stringify(store), { mode: 0o600 });
  await save();
  return { root, context, binding, store, path, save };
}

async function viewerFixture(t, source) {
  const path = await mkdtemp(join(tmpdir(), 'ad-lifecycle-viewer-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'dialogue'));
  const db = new DatabaseSync(join(path, 'hcom.db'));
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, instance TEXT, data TEXT)');
  for (const event of source.events) db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.id, event.timestamp, event.type, 'fixture', JSON.stringify(event.data));
  db.close();
  const storePath = join(path, 'dialogue', 'store.json');
  await writeFile(join(path, 'dialogue', 'node.json'), JSON.stringify(source.node));
  await writeFile(storePath, JSON.stringify(source.store));
  for (const worker of source.workers) await writeFile(join(path, 'dialogue', `${worker.bindingId}.worker.json`), JSON.stringify(worker));
  const hashes = async () => Promise.all([join(path, 'hcom.db'), storePath, ...source.workers.map(worker => join(path, 'dialogue', `${worker.bindingId}.worker.json`))].map(async name => createHash('sha256').update(await readFile(name)).digest('hex')));
  return { path, storePath, hashes };
}

function observedFixture() {
  const f = makeObservationFixture(1), binding = f.source.store.bindings.bob;
  f.source.store.version = 2;
  f.source.store.lifecycle = { [binding.id]: lifecycle(binding) };
  f.source.workers[0].status = 'paused';
  return { ...f, binding, row: f.source.store.lifecycle[binding.id] };
}

test('inspect reads a paused v2 binding as active metadata without writing, native calls or claiming detach', async t => {
  const f = await inspectFixture(t), before = await readFile(f.path);
  const report = await inspect(f.context, { binding: f.binding.alias }, { nativeFactory: () => assert.fail('metadata inspection must not contact native service') });
  assert.equal(report.exitCode, 0); assert.equal(report.overall, 'ready-local');
  assert.equal(report.bindings[0].active, true);
  assert.deepEqual(report.bindings[0].lifecycle, publicLifecycle(f.store.lifecycle[f.binding.id]));
  assert.equal(JSON.stringify(report).includes(f.store.lifecycle[f.binding.id].changeNonce), false);
  assert.ok(codes(report).includes('BINDING_PAUSED')); assert.ok(!codes(report).includes('BINDING_DETACHED'));
  assert.equal(report.effects.sourceWrites, false); assert.equal(report.effects.nativeContact, false);
  assert.deepEqual(await readFile(f.path), before);
});

test('inspect v2 missing lifecycle row is enabled and v1 stays readable without silently migrating', async t => {
  const f = await inspectFixture(t);
  for (const version of [2, 1]) {
    f.store.version = version; if (version === 2) f.store.lifecycle = {}; else delete f.store.lifecycle; await f.save();
    const before = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.exitCode, 0); assert.ok(!codes(report).includes('BINDING_PAUSED'));
    assert.deepEqual(await readFile(f.path), before);
  }
});

test('inspect rejects unknown v3 and mismatched lifecycle pins without copying secrets or changing state', async t => {
  const f = await inspectFixture(t);
  for (const change of [() => { f.store.version = 3; }, () => { f.store.version = 2; f.store.lifecycle[f.binding.id].bindingRevision = 2; }]) {
    change(); f.store.lifecycle[f.binding.id].token = 'LIFECYCLE_PRIVATE_SECRET'; await f.save();
    const before = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.exitCode, 1); assert.equal(report.overall, 'blocked');
    assert.ok(codes(report).some(code => ['STORE_SCHEMA_UNSUPPORTED', 'LIFECYCLE_INVALID'].includes(code)));
    assert.equal(JSON.stringify(report).includes('LIFECYCLE_PRIVATE_SECRET'), false); assert.deepEqual(await readFile(f.path), before);
  }
});

test('inspect lifecycle validation shares writer rules for malformed generation, nonce, desired, date and reason', async t => {
  const f = await inspectFixture(t);
  for (const [key, value] of [['version', 2], ['generation', 0], ['changeNonce', 'NONCE_PRIVATE_SECRET'], ['desired', 'UNKNOWN_PRIVATE_SECRET'], ['changedAt', '2026-10-19'], ['reason', 'REASON_PRIVATE_SECRET']]) {
    f.store.lifecycle[f.binding.id] = { ...lifecycle(f.binding), [key]: value }; await f.save();
    const before = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('LIFECYCLE_INVALID'));
    for (const secret of ['NONCE_PRIVATE_SECRET', 'UNKNOWN_PRIVATE_SECRET', 'REASON_PRIVATE_SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test('unfinished worker reservations stay needs-review without exposing token, PID or source error', async t => {
  const f = await inspectFixture(t);
  for (const phase of ['launching', 'needs-review', 'stop-requested']) {
    f.store.workerLaunches = { [f.binding.id]: { version: 1, bindingRevision: 1, phase, token: randomUUID(), pid: 573829106, error: 'LAUNCH_ERROR_PRIVATE_SECRET' } }; await f.save();
    const before = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('WORKER_LAUNCH_PENDING'));
    for (const secret of [f.store.workerLaunches[f.binding.id].token, 'LAUNCH_ERROR_PRIVATE_SECRET', '573829106']) assert.equal(JSON.stringify(report).includes(secret), false);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test('dispatch lock presence and unsafe dispatch lock paths require review without exposing or removing owners', async t => {
  const f = await inspectFixture(t), path = join(f.context.stateDir, 'dialogue', `${f.binding.id}.dispatch.lock`);
  await mkdir(path); await writeFile(join(path, 'owner.json'), JSON.stringify({ nonce: 'DISPATCH_NONCE_PRIVATE_SECRET', token: 'DISPATCH_TOKEN_PRIVATE_SECRET' }));
  const before = await readFile(join(path, 'owner.json')), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('DISPATCH_LOCK_PRESENT'));
  for (const secret of ['DISPATCH_NONCE_PRIVATE_SECRET', 'DISPATCH_TOKEN_PRIVATE_SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await readFile(join(path, 'owner.json')), before);
  await rm(path, { recursive: true }); await writeFile(path, 'DISPATCH_FILE_PRIVATE_SECRET');
  const unsafe = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(unsafe.overall, 'needs-review'); assert.ok(codes(unsafe).some(code => ['STATE_UNSAFE_PATH', 'DISPATCH_LOCK_UNREADABLE'].includes(code)));
  assert.equal(await readFile(path, 'utf8'), 'DISPATCH_FILE_PRIVATE_SECRET'); assert.equal(JSON.stringify(unsafe).includes('DISPATCH_FILE_PRIVATE_SECRET'), false);
});

test('malformed ready launch reservations never become valid ownership evidence', async t => {
  const f = await inspectFixture(t);
  for (const change of [row => { row.version = 2; }, row => { row.token = 'TOKEN_PRIVATE_SECRET'; }, row => { row.token += '\n'; }, row => { row.bindingRevision = 2; }, row => { row.phase = 'PHASE_PRIVATE_SECRET'; }, row => { row.pid = 0; }]) {
    const row = { version: 1, bindingRevision: 1, token: randomUUID(), phase: 'ready', pid: 573829106 }; change(row);
    f.store.workerLaunches = { [f.binding.id]: row }; await f.save(); const before = await readFile(f.path);
    const report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('WORKER_LAUNCH_INVALID'));
    for (const secret of ['TOKEN_PRIVATE_SECRET', 'PHASE_PRIVATE_SECRET', '573829106']) assert.equal(JSON.stringify(report).includes(secret), false);
    assert.deepEqual(await readFile(f.path), before);
  }
  for (const row of [null, false, 0, { version: 1, bindingRevision: 1, phase: 'ready', token: { toString: 'TOKEN_PRIVATE_SECRET' } }]) {
    f.store.workerLaunches = { [f.binding.id]: row }; await f.save(); const before = await readFile(f.path);
    const report = await inspect(f.context, { binding: f.binding.alias });
    assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('WORKER_LAUNCH_INVALID'));
    assert.equal(JSON.stringify(report).includes('TOKEN_PRIVATE_SECRET'), false); assert.deepEqual(await readFile(f.path), before);
  }
});

test('paused runtime and pending remain observable without treating pause as admission, error or clearance', async t => {
  const f = await inspectFixture(t), pending = { eventId: 17, inputId: 'msg_original', bindingRevision: 1, status: 'submitting' };
  const path = join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.json`);
  await writeFile(path, JSON.stringify({ status: 'paused', cursor: 12, pending, receipts: {}, lifecycleProtocol: 1, token: 'WORKER_PRIVATE_SECRET' }));
  const before = await readFile(path), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('NATIVE_PENDING'));
  assert.ok(!codes(report).some(code => ['WORKER_RUNTIME_INVALID', 'WORKER_REPORTED_ERROR'].includes(code)));
  assert.equal(JSON.stringify(report).includes('WORKER_PRIVATE_SECRET'), false); assert.deepEqual(await readFile(path), before);
});

test('local viewer reads v2 lifecycle through an allowlist and preserves exact source bytes', async t => {
  const f = observedFixture(); Object.assign(f.row, { token: 'LIFECYCLE_TOKEN_SECRET', text: 'LIFECYCLE_BODY_SECRET' });
  const disk = await viewerFixture(t, f.source), before = await disk.hashes();
  const source = await readSource({ id: f.source.id, label: f.source.label, path: disk.path });
  assert.equal(source.available, true); assert.equal(source.store.version, 2);
  assert.deepEqual(source.store.lifecycle[f.binding.id], publicLifecycle(f.row));
  assert.equal(JSON.stringify(source).includes('LIFECYCLE_TOKEN_SECRET'), false); assert.equal(JSON.stringify(source).includes(f.row.changeNonce), false);
  assert.equal(source.workers[0].status, 'paused'); assert.deepEqual(await disk.hashes(), before);
});

test('local viewer rejects unknown v3 instead of showing a guessed v2 pause or losing the diagnostic', async t => {
  const f = observedFixture(); f.source.store.version = 3; const disk = await viewerFixture(t, f.source), before = await disk.hashes();
  const source = await readSource({ id: f.source.id, label: f.source.label, path: disk.path });
  assert.ok(source.diagnostics.some(row => row.code === 'invalid-store'));
  assert.equal(Object.keys(source.store.bindings).length, 0); assert.deepEqual(await disk.hashes(), before);
});

test('local viewer cannot upgrade malformed private lifecycle metadata into a valid public pause', async t => {
  const f = observedFixture(); f.row.changeNonce = 'not-a-valid-nonce'; const disk = await viewerFixture(t, f.source), before = await disk.hashes();
  const source = await readSource({ id: f.source.id, label: f.source.label, path: disk.path });
  assert.ok(source.diagnostics.some(row => row.code === 'invalid-store')); assert.equal(Object.keys(source.store.bindings).length, 0);
  assert.deepEqual(await disk.hashes(), before);
});

test('scoped SSH v2 observation preserves owned pause but filters lifecycle nonce, unselected bindings and worker tokens', () => {
  const f = observedFixture(); Object.assign(f.row, { token: 'LIFECYCLE_TOKEN_SECRET', text: 'LIFECYCLE_BODY_SECRET' });
  const foreignId = `b_${randomUUID()}`; f.source.store.lifecycle[foreignId] = { ...f.row, text: 'UNSELECTED_LIFECYCLE_SECRET' };
  f.source.workers[0].token = 'WORKER_TOKEN_SECRET';
  const envelope = exportObservation(f.source, f.request), accepted = acceptObservation(envelope, f.request);
  assert.equal(accepted.store.version, 2); assert.deepEqual(Object.keys(accepted.store.lifecycle), [f.binding.id]);
  assert.deepEqual(accepted.store.lifecycle[f.binding.id], publicLifecycle(f.row)); assert.equal(accepted.workers[0].status, 'paused');
  for (const secret of ['LIFECYCLE_TOKEN_SECRET', 'LIFECYCLE_BODY_SECRET', 'UNSELECTED_LIFECYCLE_SECRET', 'WORKER_TOKEN_SECRET', f.row.changeNonce]) assert.equal(JSON.stringify(envelope).includes(secret), false);
  const tampered = structuredClone(envelope); tampered.source.store.lifecycle[f.binding.id].changeNonce = 'DO_NOT_ACCEPT';
  assert.throws(() => acceptObservation(tampered, f.request), /Invalid viewer observation/);
});

test('SSH observation never asserts lifecycle for peer copies and rejects unknown versions', () => {
  const f = observedFixture(), peer = f.source.store.bindings.alice;
  f.source.store.lifecycle[peer.id] = lifecycle(peer);
  const accepted = acceptObservation(exportObservation(f.source, f.request), f.request);
  assert.equal(accepted.store.lifecycle[peer.id], undefined);
  f.source.store.version = 3; assert.throws(() => exportObservation(f.source, f.request), /Invalid viewer observation/);
});

test('SSH source rejects malformed private lifecycle pins and received public fields remain closed', () => {
  const f = observedFixture(); f.row.changeNonce = 'malformed-private-evidence';
  assert.throws(() => exportObservation(f.source, f.request), /Invalid viewer observation/);
  f.row.changeNonce = randomUUID(); const envelope = exportObservation(f.source, f.request);
  for (const [key, value] of [['bindingRevision', 2], ['desired', 'unknown'], ['generation', 0], ['changedAt', '2026-10-19'], ['reason', 'operator-pause']]) {
    const tampered = structuredClone(envelope); tampered.source.store.lifecycle[f.binding.id][key] = value;
    assert.throws(() => acceptObservation(tampered, f.request), /Invalid viewer observation/);
  }
});

test('viewer projection attaches paused metadata only to owner identity, preserves active and leaves message evidence unchanged', () => {
  const f = observedFixture(), legacy = structuredClone(f.source); legacy.store.version = 1; delete legacy.store.lifecycle;
  const old = projectSources([legacy]), projection = projectSources([f.source]);
  const participant = projection.rooms.find(room => room.roomId === fixtureIDs.room).participants.find(row => row.bindingId === f.binding.id);
  assert.equal(participant.active, true); assert.deepEqual(participant.lifecycle, publicLifecycle(f.row));
  assert.equal(projection.sources[0].workers[0].status, 'paused');
  assert.deepEqual(projection.messages.map(row => ({ id: row.id, statuses: row.statuses, evidence: row.evidence })), old.messages.map(row => ({ id: row.id, statuses: row.statuses, evidence: row.evidence })));
  const peer = projection.rooms.find(room => room.roomId === fixtureIDs.room).participants.find(row => row.alias === 'alice');
  assert.equal(peer.lifecycle, null);
});

test('owner pause survives peer metadata merge without being interpreted as an inactive binding', () => {
  const f = observedFixture(), peerSource = structuredClone(f.sources[0]);
  peerSource.store.version = 2; peerSource.store.lifecycle = { [f.binding.id]: { ...f.row, desired: 'enabled' } };
  const projection = projectSources([peerSource, f.source]);
  const participant = projection.rooms.find(room => room.roomId === fixtureIDs.room).participants.find(row => row.bindingId === f.binding.id);
  assert.equal(participant.active, true); assert.equal(participant.lifecycle.desired, 'paused');
});

test('lifecycle-only metadata changes refresh the viewer without adding ledger events or message statuses', async () => {
  const f = observedFixture(), events = structuredClone(f.source.events);
  const model = new ViewerModel([{ id: f.source.id, label: f.source.label, path: '/fixture' }], { reader: async () => structuredClone(f.source), projector: projectSources });
  try {
    await model.refresh(); const before = model.revision, messages = model.projection.messages;
    f.row.desired = 'enabled'; f.row.generation++; f.row.changedAt = '2026-10-19T08:00:01.000Z';
    await model.refresh(); assert.notEqual(model.revision, before); assert.equal(model.replay(before)[0].type, 'change');
    assert.deepEqual(model.projection.messages.map(row => row.statuses), messages.map(row => row.statuses)); assert.deepEqual(f.source.events, events);
  } finally { await model.close(); }
});
