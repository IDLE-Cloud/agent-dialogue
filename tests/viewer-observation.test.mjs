import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservationRequest, exportObservation, acceptObservation } from '../lib/viewer/observation.mjs';
import { projectSources } from '../lib/viewer/projection.mjs';
import { fixtureIDs } from './fixtures/viewer-fixture.mjs';
import { payloadHash, verifyObject } from '../lib/node-identity.mjs';
import { makeObservationFixture, addOtherSealedRoom, deepFreeze, framePrefix, submitPrefix, readFrame, writeFrame, resignFrame, observationTestNode } from './fixtures/viewer-observation-fixture.mjs';

const encoded = value => JSON.stringify(value);
const exportFixture = () => {
  const fixture = makeObservationFixture();
  return { ...fixture, envelope: exportObservation(fixture.source, fixture.request) };
};
const mutateEnvelope = change => {
  const { request, envelope } = exportFixture(); change(envelope);
  assert.throws(() => acceptObservation(envelope, request));
};

test('observation request is a bounded exact node and immutable room manifest contract', () => {
  const { request } = makeObservationFixture();
  assert.deepEqual(validateObservationRequest(deepFreeze(request)), request);
  const many = structuredClone(request);
  many.rooms = Array.from({ length: 16 }, (_, i) => ({ ...request.rooms[0], id: `r_10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }));
  assert.deepEqual(validateObservationRequest(many), many);
});

test('request rejects unsupported versions, wildcard scope, duplicate rooms, excess scope and unknown fields', () => {
  const { request } = makeObservationFixture();
  for (const mutate of [
    r => { r.version = 2; }, r => { r.type = 'send'; }, r => { r.rooms = []; }, r => { r.rooms = '*'; },
    r => { r.rooms.push(structuredClone(r.rooms[0])); }, r => { r.rooms = Array(17).fill(r.rooms[0]); },
    r => { r.all = true; }, r => { r.rooms[0].name = 'do not select by name'; },
    r => { r.rooms[0].id = '*'; }, r => { r.rooms[0].revision = 0; }, r => { r.rooms[0].revision = 1.5; },
    r => { r.rooms[0].manifestHash = 'A'.repeat(64); }, r => { r.expectedNodeId = 'n_' + 'f'.repeat(63); },
  ]) {
    const candidate = structuredClone(request); mutate(candidate);
    assert.throws(() => validateObservationRequest(candidate));
  }
});

test('request nonce is exactly 32 lowercase hex characters including no trailing newline', () => {
  const { request } = makeObservationFixture();
  for (const nonce of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'a'.repeat(32) + '\n', 42, null]) {
    assert.throws(() => validateObservationRequest({ ...request, requestId: nonce }));
  }
});

test('export and acceptance preserve selected signed dialogue with fixed neutral source identity', () => {
  const { request, envelope } = exportFixture();
  assert.deepEqual(Object.keys(envelope).sort(), ['requestId', 'source', 'type', 'version']);
  assert.equal(envelope.type, 'viewer-observation'); assert.equal(envelope.version, 1); assert.equal(envelope.requestId, request.requestId);
  const source = acceptObservation(envelope, request);
  assert.deepEqual(source, envelope.source);
  assert.equal(source.id, 'remote'); assert.equal(source.label, 'Remote observation'); assert.equal(source.available, true); assert.equal(source.error, null);
  assert.match(source.generation, /^[a-f0-9]{32}$/);
  assert.equal(new Date(source.observedAt).toISOString(), source.observedAt);
  assert.deepEqual(Object.keys(source.store.rooms), [fixtureIDs.room]);
  assert.deepEqual(source.events.map(row => row.id), [40, 42, 44]);
});

test('public node ID is cryptographically tied to key and pinned expected node before export', () => {
  for (const change of [
    f => { f.request.expectedNodeId = 'n_' + 'f'.repeat(64); },
    f => { f.source.node.nodeId = 'n_' + 'f'.repeat(64); f.request.expectedNodeId = f.source.node.nodeId; },
    f => { f.source.node.publicKey = observationTestNode(22, 'Synthetic workstation').publicKey; },
  ]) {
    const f = makeObservationFixture(); change(f);
    assert.throws(() => exportObservation(f.source, f.request));
  }
});

test('unavailable sources and absent or mismatched requested room manifests fail closed with generic errors', () => {
  for (const change of [
    f => { f.source.available = false; f.source.error = '/PRIVATE_SOURCE_PATH/PASSWORD'; },
    f => { delete f.source.store.rooms[fixtureIDs.room]; },
    f => { f.source.store.rooms[fixtureIDs.room].revision++; },
    f => { f.source.store.rooms[fixtureIDs.room].manifestHash = 'b'.repeat(64); },
  ]) {
    const f = makeObservationFixture(); change(f);
    assert.throws(() => exportObservation(f.source, f.request), error => !String(error).includes('PRIVATE_SOURCE_PATH') && !String(error).includes('PASSWORD'));
  }
});

test('manifest pin is recomputed from room members and owner instead of trusting stored hash', () => {
  for (const change of [
    room => { room.members[0].bindingId = fixtureIDs.carol; },
    room => { room.members[0].revision = 2; },
    room => { room.ownerNodeId = 'n_' + 'f'.repeat(64); },
    room => { room.name = 'A different immutable manifest'; },
  ]) {
    const f = makeObservationFixture(); change(f.source.store.rooms[fixtureIDs.room]);
    assert.throws(() => exportObservation(f.source, f.request));
  }
});

test('export excludes unselected sealed rooms, legacy rooms and raw hcom even when thread names match', () => {
  const f = makeObservationFixture(); addOtherSealedRoom(f.source);
  f.source.events.push({ id: 95, type: 'message', timestamp: '2026-10-18T00:00:07.000Z', data: { thread: fixtureIDs.room, from: 'raw-agent', text: 'RAW_HCOM_SECRET' } });
  f.source.events.find(row => row.id === 50).data.text += 'LEGACY_PRIVATE_BODY';
  const exported = exportObservation(f.source, f.request), json = encoded(exported);
  for (const marker of ['UNSELECTED_ROOM_SECRET', 'UNSELECTED_BODY_SECRET', 'RAW_HCOM_SECRET', 'LEGACY_PRIVATE_BODY', 'synthetic-session-carol', fixtureIDs.carol, fixtureIDs.legacyRoom]) assert.ok(!json.includes(marker), marker);
  assert.deepEqual(exported.source.events.map(row => row.id), [40, 42, 44]);
});

test('source control objects are reconstructed without paths, credentials, unrelated sessions or worker cursors', () => {
  const f = makeObservationFixture(), a = f.source.store.bindings.alice;
  Object.assign(f.source, { path: '/SOURCE_PATH_SECRET', cache: 'SOURCE_CACHE_SECRET' });
  Object.assign(f.source.node, { privateKey: 'NODE_PRIVATE_KEY_SECRET' });
  Object.assign(a, { directory: '/DIRECTORY_SECRET', projectId: 'PROJECT_ID_SECRET', serviceId: 'SERVICE_ID_SECRET', origin: 'https://ORIGIN_PASSWORD@host' });
  f.source.store.bindings.unrelated = { id: 'b_20000000-0000-4000-8000-000000000099', alias: 'unrelated', nodeId: a.nodeId, revision: 1, sessionId: 'UNRELATED_SESSION_SECRET' };
  f.source.store.peers.unrelated = { nodeId: 'n_' + 'f'.repeat(64), name: 'UNRELATED_PEER_SECRET', publicKey: 'UNRELATED_PEER_KEY_SECRET', transport: { password: 'SSH_SECRET' } };
  Object.assign(f.source.workers[0], { cursor: 123456, token: 'WORKER_TOKEN_SECRET', error: '/WORKER_ERROR_SECRET', pid: 999 });
  f.source.diagnostics.push({ code: 'source-error', message: '/DIAGNOSTIC_PATH_SECRET' });
  const exported = exportObservation(f.source, f.request), json = encoded(exported);
  for (const marker of ['SOURCE_PATH_SECRET', 'SOURCE_CACHE_SECRET', 'NODE_PRIVATE_KEY_SECRET', 'DIRECTORY_SECRET', 'PROJECT_ID_SECRET', 'SERVICE_ID_SECRET', 'ORIGIN_PASSWORD', 'UNRELATED_SESSION_SECRET', 'UNRELATED_PEER_SECRET', 'UNRELATED_PEER_KEY_SECRET', 'SSH_SECRET', 'WORKER_TOKEN_SECRET', 'WORKER_ERROR_SECRET', 'DIAGNOSTIC_PATH_SECRET']) assert.ok(!json.includes(marker), marker);
  assert.equal(Object.hasOwn(exported.source.workers[0], 'cursor'), false);
  assert.equal(exported.source.store.bindings.alice.sessionId, 'synthetic-session-alice');
});

test('queued request and exact forwarded target remain linked after export with scope-limited receipts', () => {
  const f = makeObservationFixture();
  f.source.workers[0].receipts[90] = { status: 'admitted', inputId: 'UNSELECTED_RECEIPT_SECRET', sessionId: 'UNSELECTED_SESSION_SECRET' };
  const exported = exportObservation(f.source, f.request), source = acceptObservation(exported, f.request), snapshot = projectSources([source]);
  assert.deepEqual(Object.keys(source.workers[0].receipts), ['40']);
  const q = snapshot.messages.find(message => message.evidence.some(item => item.messageId === fixtureIDs.question));
  assert.equal(snapshot.messages.length, 2); assert.equal(q.kind, 'message');
  assert.ok(q.evidence.some(item => item.type === 'submission'));
  assert.ok(q.evidence.some(item => item.type === 'forwarded-receipt' && item.resultEventId === 42));
  assert.ok(!encoded(exported).includes('UNSELECTED_RECEIPT_SECRET'));
  assert.ok(!encoded(exported).includes('UNSELECTED_SESSION_SECRET'));
});

test('queued requests preserve their historical expected session and strip unknown wrapper fields', () => {
  const f = makeObservationFixture(), queued = f.source.events.find(row => row.id === 40), payload = JSON.parse(queued.data.text.slice(submitPrefix.length));
  payload.internal = { credential: 'QUEUED_WRAPPER_SECRET' };
  queued.data.text = submitPrefix + JSON.stringify(payload);
  f.source.store.bindings.bob.sessionId = 'synthetic-current-replacement-session';
  const exported = exportObservation(f.source, f.request), projected = JSON.parse(exported.source.events.find(row => row.id === 40).data.text.slice(submitPrefix.length));
  assert.equal(projected.expectedSession, 'synthetic-session-bob');
  assert.equal(Object.hasOwn(projected, 'internal'), false);
  assert.ok(!encoded(exported).includes('QUEUED_WRAPPER_SECRET'));
  const injected = structuredClone(exported), event = injected.source.events.find(row => row.id === 40), body = JSON.parse(event.data.text.slice(submitPrefix.length));
  body.internal = 'QUEUED_RECEIVER_SECRET'; event.data.text = submitPrefix + JSON.stringify(body);
  assert.throws(() => acceptObservation(injected, f.request));
});

test('queued requests with selected room but incorrect membership or destination revision fail closed', () => {
  for (const change of [body => { body.fromBindingId = fixtureIDs.carol; }, body => { body.toRevision = 2; }, body => { body.room = fixtureIDs.legacyRoom; }]) {
    const f = makeObservationFixture(), event = f.source.events.find(row => row.id === 40), body = JSON.parse(event.data.text.slice(submitPrefix.length));
    change(body); event.data.text = submitPrefix + JSON.stringify(body);
    assert.throws(() => exportObservation(f.source, f.request));
  }
});

test('forwarded receipts cannot export an event ID or message ID from outside the selected scope', () => {
  const f = makeObservationFixture(); addOtherSealedRoom(f.source);
  f.source.workers[0].receipts[40].result = { event_id: 90, messageId: 'm_30000000-0000-4000-8000-000000000099', status: 'remote-stored', remoteEventId: 991919 };
  const exported = exportObservation(f.source, f.request), json = encoded(exported);
  assert.ok(!json.includes('991919'));
  assert.ok(!json.includes('m_30000000-0000-4000-8000-000000000099'));
  assert.equal(Object.hasOwn(exported.source.workers[0]?.receipts || {}, '40'), false);
});

test('unselected inbox and outbox rows are removed even if they claim a selected room', () => {
  const f = makeObservationFixture();
  f.source.store.outbox['m_30000000-0000-4000-8000-000000000099'] = { roomId: fixtureIDs.room, eventId: 999, payloadHash: 'c'.repeat(64), status: 'queued', fromActor: 'UNSELECTED_OUTBOX_SECRET' };
  f.source.store.inbox['m_30000000-0000-4000-8000-000000000098'] = { roomId: fixtureIDs.room, eventId: 998, payloadHash: 'd'.repeat(64), status: 'native-admitted', inputId: 'UNSELECTED_INBOX_SECRET', sessionId: 'PRIVATE_NATIVE_SESSION' };
  const exported = exportObservation(f.source, f.request), json = encoded(exported);
  assert.deepEqual(Object.keys(exported.source.store.outbox), [fixtureIDs.question]);
  assert.deepEqual(Object.keys(exported.source.store.inbox), [fixtureIDs.reply]);
  for (const marker of ['UNSELECTED_OUTBOX_SECRET', 'UNSELECTED_INBOX_SECRET', 'PRIVATE_NATIVE_SESSION']) assert.ok(!json.includes(marker));
});

test('frame wrappers and ledger metadata are whitelisted deeply while preserving signed payload bytes semantically', () => {
  const f = makeObservationFixture(), event = f.source.events.find(row => row.id === 42), frame = readFrame(event), signed = structuredClone(frame.wireEnvelope);
  Object.assign(frame, { extra: { password: 'FRAME_WRAPPER_SECRET' } });
  frame.wireEnvelope.internal = { secret: 'ENVELOPE_WRAPPER_SECRET' }; writeFrame(event, frame);
  event.data.secret = { password: 'LEDGER_DATA_SECRET' }; event.internal = 'LEDGER_EVENT_SECRET';
  const exported = exportObservation(f.source, f.request), result = readFrame(exported.source.events.find(row => row.id === 42));
  assert.deepEqual(result.wireEnvelope, signed);
  assert.deepEqual(verifyObject(result.wireEnvelope, f.source.node.publicKey), signed.payload);
  for (const marker of ['FRAME_WRAPPER_SECRET', 'ENVELOPE_WRAPPER_SECRET', 'LEDGER_DATA_SECRET', 'LEDGER_EVENT_SECRET']) assert.ok(!encoded(exported).includes(marker));
});

test('selected protocol records fail the whole observation on mismatched thread, pinned members or signed frame fields', () => {
  for (const change of [
    event => { event.data.thread = fixtureIDs.legacyRoom; },
    event => { const frame = readFrame(event); frame.fromBindingId = fixtureIDs.carol; writeFrame(event, frame); },
    event => { const frame = readFrame(event); frame.toRevision = 2; writeFrame(event, frame); },
    event => { const frame = readFrame(event); frame.text = 'PRIVATE_WRAPPER_MISMATCH'; writeFrame(event, frame); },
    event => resignFrame(event, frame => { frame.wireEnvelope.payload.manifestHash = 'b'.repeat(64); }),
    event => resignFrame(event, frame => { frame.wireEnvelope.payload.from.bindingId = fixtureIDs.carol; frame.fromBindingId = fixtureIDs.carol; }),
  ]) {
    const f = makeObservationFixture(), event = f.source.events.find(row => row.id === 42); change(event);
    assert.throws(() => exportObservation(f.source, f.request));
  }
});

test('malformed selected protocol or invalid signed payloads fail closed without putting raw bodies in errors', () => {
  for (const change of [
    event => { event.data.text = framePrefix + '{"password":"MALFORMED_BODY_SECRET"'; },
    event => { const frame = readFrame(event); frame.wireEnvelope.payload.password = 'SIGNED_UNKNOWN_SECRET'; writeFrame(event, frame); },
    event => { const frame = readFrame(event); frame.wireEnvelope.signature = 'PRIVATE_INVALID_SIGNATURE'; writeFrame(event, frame); },
  ]) {
    const f = makeObservationFixture(); change(f.source.events.find(row => row.id === 42));
    assert.throws(() => exportObservation(f.source, f.request), error =>
      ['MALFORMED_BODY_SECRET', 'SIGNED_UNKNOWN_SECRET', 'PRIVATE_INVALID_SIGNATURE'].every(marker => !String(error).includes(marker)));
  }
});

test('operator frames are scoped to a participating room node and cannot impersonate a third node', () => {
  const f = makeObservationFixture(), event = f.source.events.find(row => row.id === 42);
  resignFrame(event, frame => {
    frame.from = 'operator'; frame.fromBindingId = 'operator'; frame.fromRevision = 1;
    frame.wireEnvelope.payload.from = { nodeId: f.source.node.nodeId, bindingId: 'operator', revision: 1, alias: 'operator' };
  });
  assert.ok(exportObservation(f.source, f.request).source.events.some(row => row.id === 42));
  resignFrame(event, frame => { frame.wireEnvelope.payload.from.nodeId = observationTestNode(33, 'Unrelated node').nodeId; }, observationTestNode(33, 'Unrelated node'));
  assert.throws(() => exportObservation(f.source, f.request));
});

test('export and accept do not mutate frozen snapshots, requests or envelope objects', () => {
  const { source, request } = makeObservationFixture(), before = structuredClone({ source, request });
  const envelope = exportObservation(deepFreeze(source), deepFreeze(request));
  const expected = structuredClone(envelope); acceptObservation(deepFreeze(envelope), request);
  assert.deepEqual({ source, request }, before); assert.deepEqual(envelope, expected);
});

test('receiver rejects replay, substituted node and unsupported envelope version or type', () => {
  for (const change of [
    envelope => { envelope.requestId = 'f'.repeat(32); }, envelope => { envelope.version = 2; },
    envelope => { envelope.type = 'viewer-observe'; }, envelope => { envelope.source.node = makeObservationFixture(1).source.node; },
  ]) mutateEnvelope(change);
});

test('receiver rejects out-of-scope rooms and raw, legacy or unselected event injection', () => {
  for (const change of [
    envelope => { envelope.source.store.rooms[fixtureIDs.legacyRoom] = makeObservationFixture().source.store.rooms[fixtureIDs.legacyRoom]; },
    envelope => { envelope.source.events.push(structuredClone(makeObservationFixture().source.events.find(row => row.id === 50))); },
    envelope => { envelope.source.events.push({ id: 99, type: 'message', data: { thread: fixtureIDs.room, text: 'PRIVATE_RAW_INJECTION' } }); },
    envelope => { const f = makeObservationFixture(); addOtherSealedRoom(f.source); envelope.source.events.push(f.source.events.find(row => row.id === 90)); },
  ]) mutateEnvelope(change);
});

test('receiver rejects added secret fields at every DTO level instead of silently accepting broader data', () => {
  for (const change of [
    e => { e.privateKey = 'TOP_LEVEL_SECRET'; }, e => { e.source.path = '/SOURCE_PATH_SECRET'; },
    e => { e.source.node.privateKey = 'NODE_SECRET'; }, e => { e.source.store.bindings.alice.directory = '/BINDING_SECRET'; },
    e => { e.source.store.peers[e.source.node.nodeId] = { ...e.source.node, transport: { password: 'SSH_SECRET' } }; },
    e => { e.source.events[0].data.internal = { token: 'EVENT_SECRET' }; }, e => { e.source.workers[0].token = 'WORKER_SECRET'; },
    e => { const frame = readFrame(e.source.events.find(row => row.id === 42)); frame.secret = 'FRAME_SECRET'; writeFrame(e.source.events.find(row => row.id === 42), frame); },
  ]) mutateEnvelope(change);
});

test('receiver rejects source availability, generation, timestamp, identity and diagnostic substitutions', () => {
  for (const change of [
    e => { e.source.available = false; }, e => { e.source.generation = 'unbounded-generation'; },
    e => { e.source.observedAt = '2026-10-18'; }, e => { e.source.id = 'source-local'; }, e => { e.source.label = '/PRIVATE_REMOTE_PATH'; },
    e => { e.source.error = '/PRIVATE_ERROR'; }, e => { e.source.diagnostics.push({ code: 'x', message: '/PRIVATE_DIAGNOSTIC' }); },
  ]) mutateEnvelope(change);
});

test('receiver rejects oversized observation bytes, more than 20000 events and truncated envelopes', () => {
  mutateEnvelope(e => { e.source.events[0].data.text = 'x'.repeat(16 * 1024 * 1024); });
  mutateEnvelope(e => { e.source.events = Array.from({ length: 20001 }, (_, i) => ({ ...e.source.events[1], id: i + 1 })); });
  const { envelope, request } = exportFixture();
  for (const key of ['source', 'requestId', 'type', 'version']) {
    const candidate = structuredClone(envelope); delete candidate[key]; assert.throws(() => acceptObservation(candidate, request));
  }
});

test('cross-source signed copies still deduplicate, verify signatures and associate replies after independent scoped collection', () => {
  const exports = [0, 1].map(index => {
    const f = makeObservationFixture(index), source = acceptObservation(exportObservation(f.source, f.request), f.request);
    source.id = `observed-${index}`; source.label = `Remote ${index}`; return source;
  });
  const snapshot = projectSources(exports);
  assert.equal(snapshot.messages.length, 2);
  const question = snapshot.messages.find(m => m.evidence.some(e => e.messageId === fixtureIDs.question));
  const reply = snapshot.messages.find(m => m.evidence.some(e => e.messageId === fixtureIDs.reply));
  assert.deepEqual(question.sourceIds, ['observed-0', 'observed-1']);
  assert.ok(question.evidence.filter(e => e.type === 'ledger').every(e => e.signature === 'verified'));
  assert.equal(reply.replyTo.id, question.id);
  assert.ok(question.statuses.includes('forwarded')); assert.ok(question.statuses.includes('native-admitted'));
  assert.equal(payloadHash(readFrame(exports[0].events.find(e => e.id === 42)).wireEnvelope.payload), exports[0].store.outbox[fixtureIDs.question].payloadHash);
});
