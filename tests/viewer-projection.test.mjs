import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSources } from '../lib/viewer/projection.mjs';
import { encodeFrame } from '../lib/bridge-store.mjs';
import { makeSources, makeLargeSources, fixtureIDs } from './fixtures/viewer-fixture.mjs';

const wireText = event => JSON.parse(event.data.text.slice('agent-dialogue/1\n'.length));
const question = snapshot => snapshot.messages.find(message => message.evidence.some(item => item.messageId === fixtureIDs.question));
const formal = (snapshot, text) => snapshot.messages.find(message => message.text.includes(text));
const setFrame = (event, change) => { const frame = wireText(event); change(frame); event.data.text = encodeFrame(frame); };

test('wire copies merge by exact signed payload; queued request collapses via source receipt, preserving all evidence', () => {
  const sources = makeSources(), before = structuredClone(sources), snapshot = projectSources(sources), q = question(snapshot);
  assert.equal(snapshot.messages.length, 4);
  assert.equal(snapshot.rooms.length, 2);
  assert.equal(q.kind, 'message');
  assert.deepEqual(q.sourceIds, ['source-alpha', 'source-beta']);
  assert.deepEqual(q.statuses, ['queued', 'ledger-stored', 'forwarded', 'remote-stored', 'native-admitted', 'reply-linked']);
  assert.equal(q.evidence.filter(item => item.type === 'ledger').length, 2);
  assert.equal(q.evidence.filter(item => item.type === 'submission').length, 1);
  assert.equal(q.evidence.find(item => item.type === 'forwarded-receipt').resultEventId, 42);
  assert.equal(q.evidence.find(item => item.type === 'ledger').signature, 'verified');
  assert.equal(q.from.harness, 'codex-app-server');
  assert.equal(q.to.harness, 'opencode-v2');
  const reply = formal(snapshot, 'The peer inbox');
  assert.equal(reply.replyTo.id, q.id);
  assert.equal(reply.replyTo.missing, false);
  assert.ok(snapshot.messages.indexOf(q) < snapshot.messages.indexOf(reply));
  assert.deepEqual(sources, before, 'projection must not mutate snapshots');
});

test('local references are source scoped and detached historical bindings preserve success', () => {
  const sources = makeSources(), snapshot = projectSources(sources);
  const parent = formal(snapshot, 'Can we inspect'), reply = formal(snapshot, 'Yes. Registration');
  assert.equal(reply.replyTo.id, parent.id);
  assert.equal(parent.from.active, false);
  assert.equal(parent.from.sessionId, 'synthetic-session-carol');
  assert.ok(parent.statuses.includes('ledger-stored'));
  assert.ok(!parent.statuses.includes('rejected'));
  const other = structuredClone(sources[0]); other.id = 'source-other'; other.label = 'Same room name'; other.events = structuredClone(sources[0].events.slice(3));
  const combined = projectSources([...sources, other]);
  assert.equal(combined.rooms.filter(room => room.name === 'Legacy local review').length, 2);
  const otherReply = combined.messages.find(message => message.sourceIds.includes('source-other') && message.replyTo);
  assert.notEqual(otherReply.replyTo.id, parent.id);
});

test('no body/time/alias matching: absent receipt keeps queue separate, duplicate q IDs remain anomalous', () => {
  const sources = makeSources(); sources[0].workers = [];
  const snapshot = projectSources(sources);
  assert.equal(snapshot.messages.length, 5);
  assert.equal(snapshot.messages.filter(message => message.kind === 'submission').length, 1);
  const duplicate = structuredClone(sources[0].events[0]); duplicate.id = 41; sources[0].events.push(duplicate);
  const duplicates = projectSources(sources).messages.filter(message => message.kind === 'submission');
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every(message => message.issues.includes('duplicate-submission-id')));
});

test('queue mapping requires the same source event, owner binding, submission ID and exact payload pins', () => {
  for (const change of [
    sources => { sources[0].workers[0].bindingId = fixtureIDs.bob; },
    sources => { sources[0].workers[0].receipts[40].submissionId = 'q_wrong'; },
    sources => { sources[0].workers[0].receipts[40].result.event_id = 43; },
    sources => { setFrame(sources[0].events[1], frame => { frame.text = 'Wrong payload'; frame.wireEnvelope.payload.text = frame.text; }); },
    sources => { sources[0].workers[0].receipts[40].result.messageId = fixtureIDs.reply; },
  ]) {
    const sources = makeSources(); change(sources);
    const snapshot = projectSources(sources);
    assert.equal(snapshot.messages.filter(message => message.kind === 'submission').length, 1);
  }
});

test('same wire candidate with payload, room or signature conflicts never silently merges', () => {
  for (const change of [
    frame => { frame.text = 'Conflicting body'; frame.wireEnvelope.payload.text = frame.text; },
    frame => { frame.room = fixtureIDs.legacyRoom; frame.wireEnvelope.payload.roomId = frame.room; },
    frame => { frame.toRevision = 2; frame.wireEnvelope.payload.to.revision = 2; },
    frame => { frame.wireEnvelope.signature = Buffer.alloc(64).toString('base64'); },
  ]) {
    const sources = makeSources(); setFrame(sources[1].events[0], change);
    const snapshot = projectSources(sources), variants = snapshot.messages.filter(message => message.evidence.some(item => item.messageId === fixtureIDs.question));
    assert.equal(variants.length, 2);
    assert.ok(variants.every(message => message.statuses.includes('conflict') && message.issues.includes('wire-message-conflict')));
    assert.notEqual(variants[0].id, variants[1].id);
  }
});

test('late receipts enrich stable messages; failed or missing readers do not erase prior confirmation', () => {
  const sources = makeSources(); delete sources[1].store.inbox[fixtureIDs.question]; sources[1].workers = [];
  const first = question(projectSources(sources));
  assert.ok(!first.statuses.includes('native-admitted'));
  sources[1].workers = [{ bindingId: fixtureIDs.bob, status: 'error', error: 'PRIVATE_EXCEPTION', receipts: { 42: { status: 'admitted', inputId: 'stable-input', sessionId: 'synthetic-session-bob', at: '2026-10-18T00:01:00.000Z' } } }];
  sources[0].available = false; sources[0].error = '/private/path/PASSWORD';
  const next = projectSources(sources), changed = question(next);
  assert.equal(first.id, changed.id);
  assert.ok(changed.statuses.includes('remote-stored'));
  assert.ok(changed.statuses.includes('native-admitted'));
  assert.equal(next.sources[0].error, 'source-read-failed');
  assert.ok(!JSON.stringify(next).includes('PRIVATE_EXCEPTION'));
  assert.ok(!JSON.stringify(next).includes('PASSWORD'));
});

test('reply references require room and reversed endpoint pins; missing parent stays explicit', () => {
  const absent = makeSources(); absent[0].events = absent[0].events.filter(event => event.id !== 42); absent[1].events = absent[1].events.filter(event => event.id !== 42);
  const missing = formal(projectSources(absent), 'The peer inbox');
  assert.equal(missing.replyTo.id, null);
  assert.equal(missing.replyTo.reason, 'not-collected');
  const wrong = makeSources();
  for (const source of wrong) for (const event of source.events) if (event.data.text.startsWith('agent-dialogue/1\n') && wireText(event).globalMessageId === fixtureIDs.reply) {
    setFrame(event, frame => {
      [frame.from, frame.to] = [frame.to, frame.from]; [frame.fromBindingId, frame.toBindingId] = [frame.toBindingId, frame.fromBindingId];
      [frame.wireEnvelope.payload.from, frame.wireEnvelope.payload.to] = [frame.wireEnvelope.payload.to, frame.wireEnvelope.payload.from];
    });
  }
  const bad = formal(projectSources(wrong), 'The peer inbox');
  assert.equal(bad.replyTo.id, null);
  assert.equal(bad.replyTo.reason, 'room-or-participant-mismatch');
});

test('bad record is localized; secret-adjacent fields and native execution claims are omitted', () => {
  const sources = makeSources();
  sources[0].node.privateKey = 'PRIVATE_KEY_SECRET';
  sources[0].store.bindings.alice.origin = 'https://PASSWORD@host';
  sources[0].store.bindings.alice.directory = '/PRIVATE_PATH';
  sources[0].store.peers.secret = { transport: { password: 'SSH_PASSWORD' } };
  sources[0].workers[0].token = 'WORKER_TOKEN';
  sources[0].events.push({ id: 99, type: 'message', timestamp: 'bad', data: { thread: fixtureIDs.room, text: 'agent-dialogue/1\n{ "token": "RAW_WRAPPER_SECRET" ' } });
  const snapshot = projectSources(sources), json = JSON.stringify(snapshot);
  assert.equal(snapshot.messages.filter(message => message.kind === 'malformed').length, 1);
  for (const value of ['PRIVATE_KEY_SECRET', 'PASSWORD', 'PRIVATE_PATH', 'SSH_PASSWORD', 'WORKER_TOKEN', 'RAW_WRAPPER_SECRET']) assert.ok(!json.includes(value), value);
  assert.ok(snapshot.messages.every(message => !message.statuses.some(state => ['running', 'done', 'read', 'completed'].includes(state))));
});

test('a changed alias registration does not replace historical session identity', () => {
  const sources = makeSources();
  sources[0].store.bindings.carol.id = fixtureIDs.alice;
  sources[0].store.bindings.carol.sessionId = 'UNRELATED_REPLACEMENT_SESSION';
  const parent = formal(projectSources(sources), 'Can we inspect');
  assert.equal(parent.from.bindingId, fixtureIDs.carol);
  assert.equal(parent.from.sessionId, null);
  assert.equal(parent.from.harness, null);
});

test('ordering honors sender ledger and reply causality despite skewed clocks and ingestion order', () => {
  const sources = makeSources();
  sources[0].events[1].timestamp = '2030-01-01T00:00:00.000Z';
  sources[1].events[1].timestamp = '2000-01-01T00:00:00.000Z';
  sources.reverse(); sources[0].events.reverse(); sources[1].events.reverse();
  const snapshot = projectSources(sources);
  assert.ok(snapshot.messages.indexOf(question(snapshot)) < snapshot.messages.indexOf(formal(snapshot, 'The peer inbox')));
  assert.deepEqual(snapshot, projectSources(sources));
});

test('10k synthetic logical messages with colliding local IDs keep correct source counts', () => {
  const snapshot = projectSources(makeLargeSources());
  assert.equal(snapshot.messages.length, 10000);
  assert.equal(new Set(snapshot.messages.map(message => message.id)).size, 10000);
  for (const source of snapshot.sources) assert.equal(source.eventCount, 5000);
});

test('unframed hcom messages are visible, source scoped, and preserve fan-out without inferring native success', () => {
  const sources = makeSources();
  sources[0].store.bindings.alice.hcomName = 'owned-alice-endpoint';
  sources[0].events.push({ id: 60, type: 'message', timestamp: '2026-10-18T00:01:00.000Z', data: { from: 'owned-alice-endpoint', delivered_to: ['raw-kimi', 'raw-pi'], thread: fixtureIDs.room, text: 'Raw harness coordination message' } });
  sources[1].events.push({ id: 60, type: 'message', timestamp: '2026-10-18T00:01:01.000Z', data: { from: 'owned-alice-endpoint', delivered_to: ['raw-kimi'], thread: fixtureIDs.room, text: 'Raw harness coordination message' } });
  const snapshot = projectSources(sources), messages = snapshot.messages.filter(message => message.transport === 'hcom');
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.notEqual(messages[0].roomId, messages[1].roomId);
  assert.ok(messages.every(message => message.roomId !== question(snapshot).roomId));
  const owned = messages.find(message => message.sourceIds.includes('source-alpha'));
  assert.equal(owned.from.sessionId, 'synthetic-session-alice');
  assert.equal(owned.to.alias, '2 recipients');
  assert.equal(owned.recipients.length, 2);
  assert.equal(owned.recipients[0].harness, 'hcom');
  assert.deepEqual(owned.statuses, ['ledger-stored']);
});

test('raw hcom explicit local reply is validated within source and same thread', () => {
  const sources = makeSources();
  sources[0].events.push({ id: 60, type: 'message', data: { from: 'raw-a', delivered_to: ['raw-b'], thread: 'raw-room', text: 'Question' } },
    { id: 61, type: 'message', data: { from: 'raw-b', delivered_to: ['raw-a'], thread: 'raw-room', text: 'Answer', reply_to_local: 60 } });
  const snapshot = projectSources(sources), answer = formal(snapshot, 'Answer'), parent = formal(snapshot, 'Question');
  assert.equal(answer.replyTo.id, parent.id);
  assert.ok(parent.statuses.includes('reply-linked'));
});

test('queued rejection and missing forwarded result expose their own evidence', () => {
  const sources = makeSources();
  sources[0].workers[0].receipts[40] = { status: 'rejected', reason: 'PRIVATE_CAUSE', at: '2026-10-18T00:01:00.000Z' };
  let queue = projectSources(sources).messages.find(message => message.kind === 'submission');
  assert.ok(queue.statuses.includes('rejected'));
  assert.ok(queue.evidence.some(item => item.type === 'worker-receipt' && item.status === 'rejected'));
  assert.ok(!JSON.stringify(queue).includes('PRIVATE_CAUSE'));
  sources[0].workers[0].receipts[40] = { status: 'forwarded', submissionId: fixtureIDs.queue, result: { event_id: 999, messageId: fixtureIDs.question } };
  queue = projectSources(sources).messages.find(message => message.kind === 'submission');
  assert.ok(queue.statuses.includes('forwarded'));
  assert.ok(queue.issues.includes('forwarded-result-not-collected'));
  assert.ok(queue.evidence.some(item => item.type === 'forwarded-receipt' && item.resultEventId === 999));
});

test('replaced source generation gives local events new identities while signed global IDs remain stable', () => {
  const sources = makeSources(), before = projectSources(sources);
  sources[0].generation = 'source-alpha-replacement';
  const after = projectSources(sources);
  assert.notEqual(formal(before, 'Can we inspect').id, formal(after, 'Can we inspect').id);
  assert.equal(question(before).id, question(after).id);
  assert.notEqual(formal(before, 'Can we inspect').evidence[0].sourceGeneration, formal(after, 'Can we inspect').evidence[0].sourceGeneration);
});

test('colliding numeric IDs cannot redirect raw replies to another source', () => {
  const sources = makeSources();
  sources[0].events.push({ id: 80, type: 'message', data: { from: 'raw-a', delivered_to: ['raw-b'], thread: 'shared-thread', text: 'Source alpha question' } });
  sources[1].events.push({ id: 80, type: 'message', data: { from: 'raw-a', delivered_to: ['raw-b'], thread: 'shared-thread', text: 'Source beta question' } },
    { id: 81, type: 'message', data: { from: 'raw-b', delivered_to: ['raw-a'], thread: 'shared-thread', text: 'Source beta reply', reply_to_local: 80 } });
  const snapshot = projectSources(sources), reply = formal(snapshot, 'Source beta reply');
  assert.equal(reply.replyTo.id, formal(snapshot, 'Source beta question').id);
  assert.notEqual(reply.replyTo.id, formal(snapshot, 'Source alpha question').id);
});

test('admission requires a stable input and matching session/global wire reference', () => {
  const sources = makeSources(); delete sources[1].store.inbox[fixtureIDs.question];
  const receipt = sources[1].workers[0].receipts[42];
  receipt.globalMessageId = fixtureIDs.reply;
  let q = question(projectSources(sources));
  assert.ok(!q.statuses.includes('native-admitted'));
  assert.ok(q.issues.includes('invalid-admission-receipt'));
  delete receipt.globalMessageId; receipt.inputId = '';
  q = question(projectSources(sources));
  assert.ok(!q.statuses.includes('native-admitted'));
});

test('local detached registrations override stale remote peer cards in rooms and messages', () => {
  const sources = makeSources();
  for (const source of sources) for (const binding of Object.values(source.store.bindings)) {
    if (!binding.nodeId) continue;
    binding.remote = binding.nodeId !== source.node.nodeId;
    binding.active = binding.remote;
  }
  const snapshot = projectSources(sources), q = question(snapshot);
  assert.equal(q.from.active, false);
  assert.equal(q.to.active, false);
  const room = snapshot.rooms.find(item => item.id === q.roomId);
  assert.equal(room.participants.find(item => item.bindingId === fixtureIDs.alice).active, false);
  assert.equal(room.participants.find(item => item.bindingId === fixtureIDs.bob).active, false);
  // Descriptor copies never regain status authority by omitting the remote hint.
  for (const source of sources) for (const binding of Object.values(source.store.bindings)) delete binding.remote;
  const withoutHints = projectSources(sources), next = question(withoutHints);
  assert.equal(next.from.active, false);
  assert.equal(next.to.active, false);
  assert.ok(withoutHints.rooms.find(item => item.id === next.roomId).participants.every(item => item.active === false));
});

test('a single-source remote descriptor exposes unknown registration while legacy local state stays known', () => {
  const [source] = makeSources();
  source.store.bindings.alice.active = false;
  source.store.bindings.bob.remote = true;
  source.store.bindings.bob.active = true;
  const snapshot = projectSources([source]), q = question(snapshot);
  assert.equal(q.from.active, false);
  assert.equal(q.to.active, null);
  assert.equal(formal(snapshot, 'Can we inspect').from.active, false);
});
