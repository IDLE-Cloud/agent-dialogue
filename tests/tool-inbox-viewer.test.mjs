import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { projectSources } from '../lib/viewer/projection.mjs';
import { readSource } from '../lib/viewer/readers/local.mjs';
import { exportObservation, acceptObservation } from '../lib/viewer/observation.mjs';
import { fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';
import { createViewer } from '../lib/viewer/server.mjs';
import { ViewerModel } from '../lib/viewer/stream.mjs';
import { makeObservationFixture, addOtherSealedRoom } from './fixtures/viewer-observation-fixture.mjs';
import { fixtureIDs } from './fixtures/viewer-fixture.mjs';

function fixture() {
  const result = makeObservationFixture(1), { source } = result;
  source.store.bindings.bob.harness = 'zcode-tools';
  source.store.inbox[fixtureIDs.question].status = 'stored';
  delete source.store.inbox[fixtureIDs.question].inputId;
  delete source.store.inbox[fixtureIDs.question].sessionId;
  source.workers[0].receipts[42] = { status: 'tool-available', sessionId: 'synthetic-session-bob', globalMessageId: fixtureIDs.question, at: '2026-10-19T00:00:01.000Z' };
  const key = `${fixtureIDs.bob}:42`;
  source.store.toolReads = { [key]: { bindingId: fixtureIDs.bob, bindingRevision: 1, sessionId: 'synthetic-session-bob', eventId: 42, roomId: fixtureIDs.room,
    globalMessageId: fixtureIDs.question, status: 'tool-read', at: '2026-10-19T00:00:02.000Z' } };
  return { ...result, key };
}
const question = projected => projected.messages.find(message => message.evidence.some(row => row.messageId === fixtureIDs.question));

test('tool availability and exact-session MCP reads stay distinct from native input admission and model completion', () => {
  const { source } = fixture(), before = structuredClone(source), message = question(projectSources([source]));
  assert.ok(message.statuses.includes('tool-available'));
  assert.ok(message.statuses.includes('tool-read'));
  assert.ok(!message.statuses.includes('native-admitted'));
  assert.ok(!message.statuses.some(status => ['running', 'completed', 'unknown'].includes(status)));
  const available = message.evidence.find(row => row.status === 'tool-available'), read = message.evidence.find(row => row.status === 'tool-read');
  assert.equal(available.type, 'worker-receipt'); assert.equal(read.type, 'tool-inbox-read');
  for (const evidence of [available, read]) {
    assert.equal(evidence.bindingId, fixtureIDs.bob); assert.equal(evidence.sessionId, 'synthetic-session-bob');
    assert.equal(Object.hasOwn(evidence, 'inputId'), false);
  }
  assert.match(read.detail, /不证明.*原生.*输入/);
  assert.deepEqual(source, before);
});

test('tool-read evidence requires exact event, binding generation, owner, session, room and wire identity', () => {
  for (const mutate of [
    row => { row.bindingId = fixtureIDs.alice; }, row => { row.bindingRevision = 2; }, row => { row.sessionId = 'wrong-session'; },
    row => { row.eventId = 43; }, row => { row.roomId = fixtureIDs.legacyRoom; }, row => { row.globalMessageId = fixtureIDs.reply; },
    row => { row.status = 'admitted'; }, row => { row.at = 'invalid'; }, row => { delete row.sessionId; }, row => { delete row.globalMessageId; },
  ]) {
    const { source, key } = fixture(); mutate(source.store.toolReads[key]);
    assert.ok(!question(projectSources([source])).statuses.includes('tool-read'));
  }
  for (const mutate of [
    source => { const key = `${fixtureIDs.bob}:42`; source.store.toolReads.badKey = source.store.toolReads[key]; delete source.store.toolReads[key]; },
    source => { source.store.bindings.bob.revision = 2; }, source => { source.store.bindings.bob.nodeId = source.store.bindings.alice.nodeId; },
    source => { source.store.bindings.bob.harness = 'opencode-v2'; }, source => { source.store.bindings.bob.remote = true; },
  ]) {
    const { source } = fixture(); mutate(source);
    assert.ok(!question(projectSources([source])).statuses.includes('tool-read'));
  }
});

test('tool availability rejects missing/mismatched native identity and cannot be upgraded by injecting an input ID', () => {
  for (const mutate of [
    row => { delete row.sessionId; }, row => { row.sessionId = 'other'; }, row => { row.globalMessageId = fixtureIDs.reply; },
    row => { delete row.globalMessageId; }, row => { row.at = 'invalid'; }, row => { row.inputId = 'not-native-evidence'; },
  ]) {
    const { source } = fixture(); mutate(source.workers[0].receipts[42]); source.store.toolReads = {};
    const message = question(projectSources([source]));
    assert.ok(!message.statuses.includes('tool-available')); assert.ok(!message.statuses.includes('native-admitted'));
  }
});

test('tool-only harness cannot claim native-admitted through stale worker or inbox fields', () => {
  const { source, request } = fixture();
  source.workers[0].receipts[42] = { status: 'admitted', inputId: 'invented-native-input', sessionId: 'synthetic-session-bob' };
  Object.assign(source.store.inbox[fixtureIDs.question], { status: 'native-admitted', inputId: 'invented-native-input', sessionId: 'synthetic-session-bob' });
  assert.ok(!question(projectSources([source])).statuses.includes('native-admitted'));
  const observed = acceptObservation(exportObservation(source, request), request);
  assert.equal(observed.workers[0].receipts[42], undefined);
  assert.equal(observed.store.inbox[fixtureIDs.question], undefined);
  assert.ok(!question(projectSources([observed])).statuses.includes('native-admitted'));
});

test('unsigned local event evidence omits global message IDs and remains scoped to its recipient', () => {
  const { sources } = fixture(), source = sources[0], binding = source.store.bindings.dave;
  Object.assign(binding, { harness: 'zcode-tools', nodeId: source.node.nodeId });
  source.workers.push({ bindingId: binding.id, receipts: { 50: { status: 'tool-available', sessionId: binding.sessionId, at: '2026-10-19T00:00:01.000Z' } } });
  source.store.toolReads = { [`${binding.id}:50`]: { bindingId: binding.id, bindingRevision: binding.revision, sessionId: binding.sessionId, eventId: 50,
    roomId: fixtureIDs.legacyRoom, status: 'tool-read', at: '2026-10-19T00:00:02.000Z' } };
  const message = projectSources([source]).messages.find(row => row.text.startsWith('Can we inspect'));
  assert.ok(message.statuses.includes('tool-available')); assert.ok(message.statuses.includes('tool-read'));
  for (const row of message.evidence.filter(row => ['tool-available', 'tool-read'].includes(row.status))) assert.equal(Object.hasOwn(row, 'globalMessageId'), false);
});

test('scoped SSH observations preserve only selected-room, exact-session tool evidence and reject DTO extras', async () => {
  const { source, request, key } = fixture(); addOtherSealedRoom(source);
  source.store.toolReads[`${fixtureIDs.bob}:90`] = { ...source.store.toolReads[key], eventId: 90, roomId: 'r_10000000-0000-4000-8000-000000000099', globalMessageId: 'm_30000000-0000-4000-8000-000000000099' };
  Object.assign(source.store.toolReads[key], { token: 'READ_TOKEN_SECRET', text: 'READ_BODY_SECRET', requestMeta: { token: 'META_SECRET' } });
  source.workers[0].receipts[42].token = 'AVAILABLE_TOKEN_SECRET';
  const envelope = exportObservation(source, request), accepted = acceptObservation(envelope, request);
  assert.deepEqual(Object.keys(accepted.store.toolReads), [key]);
  assert.equal(accepted.workers[0].receipts[42].status, 'tool-available');
  assert.ok(question(projectSources([accepted])).statuses.includes('tool-read'));
  for (const sentinel of ['UNSELECTED_BODY_SECRET', 'READ_TOKEN_SECRET', 'READ_BODY_SECRET', 'META_SECRET', 'AVAILABLE_TOKEN_SECRET']) assert.equal(JSON.stringify(envelope).includes(sentinel), false);
  const malicious = structuredClone(envelope); malicious.source.store.toolReads[key].token = 'UNEXPECTED';
  assert.throws(() => acceptObservation(malicious, request), /Invalid viewer observation/);
  const spec = { kind: 'ssh', id: 'remote-zcode', label: 'ZCode', destination: 'fixture-server', executable: '/tools/node', cli: '/tools/cli.mjs', stateDir: '/private/state', expectedNodeId: request.expectedNodeId, rooms: request.rooms };
  const fetched = await fetchSshObservation(spec, { requestId: request.requestId, runner: async () => ({ code: 0, stdout: JSON.stringify(envelope) }) });
  assert.equal(fetched.id, 'remote-zcode'); assert.equal(fetched.store.toolReads[key].status, 'tool-read');
});

test('local read whitelists tool evidence without changing ledger, cursor or private metadata', async t => {
  const { source, key } = fixture(), path = await mkdtemp(join(tmpdir(), 'agent-dialogue-tool-viewer-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'dialogue'));
  const db = new DatabaseSync(join(path, 'hcom.db'));
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, instance TEXT, data TEXT)');
  for (const event of source.events) db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.id, event.timestamp, event.type, 'fixture', JSON.stringify(event.data));
  db.close();
  const paths = [join(path, 'hcom.db'), join(path, 'dialogue', 'node.json'), join(path, 'dialogue', 'store.json'), join(path, 'dialogue', `${fixtureIDs.bob}.worker.json`)];
  source.store.toolReads[key].token = 'PRIVATE_READ_TOKEN'; source.store.toolReads[key].text = 'PRIVATE_READ_BODY';
  await writeFile(paths[1], JSON.stringify(source.node)); await writeFile(paths[2], JSON.stringify(source.store)); await writeFile(paths[3], JSON.stringify(source.workers[0]));
  const hashes = async () => Promise.all(paths.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
  const before = await hashes(), observed = await readSource({ id: source.id, label: source.label, path });
  assert.equal(observed.available, true); assert.equal(observed.store.toolReads[key].status, 'tool-read');
  assert.equal(JSON.stringify(observed).includes('PRIVATE_READ_'), false);
  assert.ok(question(projectSources([observed])).statuses.includes('tool-read'));
  assert.deepEqual(await hashes(), before);
});

test('viewer API can filter both tool states while native-admitted filter remains empty', async t => {
  const { source } = fixture();
  const viewer = await createViewer({ sources: [{ id: source.id, label: source.label, path: '/fixture' }], reader: async () => source, projector: projectSources, pollMs: 60000 });
  t.after(() => viewer.close());
  const response = await fetch(viewer.url, { redirect: 'manual' }), cookie = response.headers.get('set-cookie').split(';')[0];
  const message = question(viewer.model.projection);
  for (const status of ['tool-available', 'tool-read', 'native-admitted']) {
    const result = await fetch(`${viewer.origin}/api/messages?${new URLSearchParams({ room: message.roomId, status })}`, { headers: { cookie } });
    const body = await result.json(); assert.equal(result.status, 200);
    assert.equal(body.messages.length, status === 'native-admitted' ? 0 : 1);
  }
  const app = await (await fetch(`${viewer.origin}/app.js`, { headers: { cookie } })).text();
  assert.match(app, /'tool-available': '工具可读取'/); assert.match(app, /'tool-read': '工具已读取'/);
  assert.match(app, /工具调用返回.*不证明.*模型/);
});

test('a tool-read-only update refreshes live projection without adding or changing ledger events', async () => {
  const { source, key } = fixture(), read = source.store.toolReads[key]; source.store.toolReads = {};
  const events = structuredClone(source.events);
  const model = new ViewerModel([{ id: source.id, label: source.label, path: '/fixture' }], { reader: async () => structuredClone(source), projector: projectSources });
  try {
    await model.refresh(); const before = model.revision;
    assert.ok(!question(model.projection).statuses.includes('tool-read'));
    source.store.toolReads[key] = read;
    await model.refresh();
    assert.notEqual(model.revision, before); assert.equal(model.replay(before)[0].type, 'change');
    assert.ok(question(model.projection).statuses.includes('tool-read'));
    assert.deepEqual(source.events, events);
  } finally { await model.close(); }
});
