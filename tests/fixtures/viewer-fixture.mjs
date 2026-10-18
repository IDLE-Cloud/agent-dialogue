import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { encodeFrame } from '../../lib/bridge-store.mjs';
import { payloadHash, signObject } from '../../lib/node-identity.mjs';

// Public, deterministic synthetic keys. They are test material, never usable node credentials.
function testNode(byte, name) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  return { version: 1, nodeId: `n_${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')}`, name, publicKey, privateKey: key.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

export const fixtureIDs = {
  room: 'r_10000000-0000-4000-8000-000000000001',
  legacyRoom: 'r_10000000-0000-4000-8000-000000000002',
  alice: 'b_20000000-0000-4000-8000-000000000001',
  bob: 'b_20000000-0000-4000-8000-000000000002',
  carol: 'b_20000000-0000-4000-8000-000000000003',
  dave: 'b_20000000-0000-4000-8000-000000000004',
  question: 'm_30000000-0000-4000-8000-000000000001',
  reply: 'm_30000000-0000-4000-8000-000000000002',
  queue: 'q_40000000-0000-4000-8000-000000000001',
};

export function makeSources() {
  const alpha = testNode(11, 'Synthetic laptop'), beta = testNode(22, 'Synthetic workstation');
  const pin = (node, alias, bindingId) => ({ nodeId: node.nodeId, alias, bindingId, revision: 1 });
  const alice = pin(alpha, 'alice', fixtureIDs.alice), bob = pin(beta, 'bob', fixtureIDs.bob);
  const binding = (p, harness) => ({ alias: p.alias, id: p.bindingId, revision: p.revision, nodeId: p.nodeId, harness, sessionId: `synthetic-session-${p.alias}`, active: true });
  const room = { id: fixtureIDs.room, name: 'Viewer demonstration', revision: 1, ownerNodeId: alpha.nodeId, manifestHash: 'a'.repeat(64), members: [alice, bob] };
  const question = { type: 'message', version: 1, messageId: fixtureIDs.question, roomId: room.id, roomRevision: 1, manifestHash: room.manifestHash,
    from: alice, to: bob, text: 'Please review the retry behavior. Which evidence confirms delivery?', replyToMessageId: null, createdAt: '2026-10-18T00:00:01.000Z' };
  const reply = { ...question, messageId: fixtureIDs.reply, from: bob, to: alice,
    text: 'The peer inbox confirms storage; native admission is recorded separately. <script>window.viewerXss = true</script> ![image](https://invalid.example/tracker.png)',
    replyToMessageId: fixtureIDs.question, createdAt: '2026-10-18T00:00:02.000Z' };
  const encoded = (node, payload) => encodeFrame({ version: 1, room: payload.roomId, from: payload.from.alias, to: payload.to.alias, fromBindingId: payload.from.bindingId,
    toBindingId: payload.to.bindingId, fromRevision: 1, toRevision: 1, text: payload.text, replyTo: null,
    globalMessageId: payload.messageId, replyToMessageId: payload.replyToMessageId, wireEnvelope: signObject(node, payload) });
  const event = (id, text, when, sender = 'synthetic') => ({ id, type: 'message', timestamp: when, data: { text, from: sender, thread: room.id, delivered_to: ['synthetic-destination'], sender_kind: 'instance', intent: 'inform' } });
  const queued = 'agent-dialogue/submit/1\n' + JSON.stringify({ version: 1, id: fixtureIDs.queue, room: room.id, from: 'alice', to: 'bob', fromBindingId: fixtureIDs.alice,
    toBindingId: fixtureIDs.bob, fromRevision: 1, toRevision: 1, expectedSession: 'synthetic-session-bob', text: question.text, replyTo: null });
  const publicNode = ({ nodeId, name, publicKey }) => ({ nodeId, name, publicKey });
  const source = (id, label, node, peer) => ({ id, label, available: true, observedAt: '2026-10-18T00:00:10.000Z', generation: `${id}-generation-1`, node: publicNode(node),
    events: [], store: { version: 1, rooms: { [room.id]: structuredClone(room) }, bindings: { alice: binding(alice, 'codex-app-server'), bob: binding(bob, 'opencode-v2') }, peers: { [peer.nodeId]: publicNode(peer) }, inbox: {}, outbox: {} }, workers: [], diagnostics: [] });
  const a = source('source-alpha', 'Laptop', alpha, beta), b = source('source-beta', 'Workstation', beta, alpha);
  a.events = [event(40, queued, '2026-10-18T00:00:00.000Z'), event(42, encoded(alpha, question), '2026-10-18T00:00:01.000Z'), event(44, encoded(beta, reply), '2026-10-18T00:00:04.000Z')];
  b.events = [event(42, encoded(alpha, question), '2026-10-18T00:00:03.000Z'), event(43, encoded(beta, reply), '2026-10-18T00:00:02.000Z')];
  a.store.outbox[question.messageId] = { payloadHash: payloadHash(question), peerNodeId: beta.nodeId, roomId: room.id, eventId: 42, remoteEventId: 42, status: 'remote-stored' };
  b.store.inbox[question.messageId] = { payloadHash: payloadHash(question), senderNodeId: alpha.nodeId, roomId: room.id, eventId: 42, status: 'native-admitted', inputId: 'synthetic-input-question', sessionId: 'synthetic-session-bob' };
  a.store.inbox[reply.messageId] = { payloadHash: payloadHash(reply), senderNodeId: beta.nodeId, roomId: room.id, eventId: 44, status: 'stored' };
  b.store.outbox[reply.messageId] = { payloadHash: payloadHash(reply), peerNodeId: alpha.nodeId, roomId: room.id, eventId: 43, remoteEventId: 44, status: 'remote-stored' };
  a.workers = [{ bindingId: fixtureIDs.alice, status: 'stopped', cursor: 44, receipts: { 40: { status: 'forwarded', submissionId: fixtureIDs.queue, result: { event_id: 42, messageId: question.messageId, status: 'remote-stored', remoteEventId: 42 }, at: '2026-10-18T00:00:01.100Z' } } }];
  b.workers = [{ bindingId: fixtureIDs.bob, status: 'ready', cursor: 43, receipts: { 42: { status: 'admitted', inputId: 'synthetic-input-question', sessionId: 'synthetic-session-bob', at: '2026-10-18T00:00:03.100Z' } } }];
  const carol = { alias: 'carol', bindingId: fixtureIDs.carol, revision: 1 }, dave = { alias: 'dave', bindingId: fixtureIDs.dave, revision: 1 };
  const legacy = { id: fixtureIDs.legacyRoom, name: 'Legacy local review', members: [carol, dave] };
  a.store.rooms[legacy.id] = legacy;
  a.store.bindings.carol = { alias: 'carol', id: carol.bindingId, revision: 1, harness: 'opencode-v2', sessionId: 'synthetic-session-carol', active: false };
  a.store.bindings.dave = { alias: 'dave', id: dave.bindingId, revision: 1, harness: 'codex-app-server', sessionId: 'synthetic-session-dave', active: false };
  const local = (from, to, text, replyTo = null) => encodeFrame({ version: 1, room: legacy.id, from: from.alias, to: to.alias, fromBindingId: from.bindingId, toBindingId: to.bindingId, fromRevision: 1, toRevision: 1, text, replyTo });
  a.events.push(event(50, local(carol, dave, 'Can we inspect a detached conversation?'), '2026-10-18T00:00:05.000Z'), event(51, local(dave, carol, 'Yes. Registration state does not erase historical evidence.', '50'), '2026-10-18T00:00:06.000Z'));
  a.events[3].data.thread = legacy.id; a.events[4].data.thread = legacy.id;
  return [a, b];
}

/** Fresh deterministic local events for scale checks, not real model traffic. */
export function makeLargeSources(count = 10000) {
  const sources = makeSources();
  for (const source of sources) { source.events = []; source.workers = []; source.store.inbox = {}; source.store.outbox = {}; }
  const room = sources[0].store.rooms[fixtureIDs.legacyRoom];
  sources[1].store.rooms[room.id] = structuredClone(room);
  sources[1].store.bindings.carol = structuredClone(sources[0].store.bindings.carol);
  sources[1].store.bindings.dave = structuredClone(sources[0].store.bindings.dave);
  for (let i = 0; i < count; i++) {
    const source = sources[i % 2], localID = Math.floor(i / 2) + 1;
    source.events.push({ id: localID, type: 'message', timestamp: new Date(Date.UTC(2026, 9, 18, 0, 0, 0) + i).toISOString(), data: { thread: room.id,
      text: encodeFrame({ version: 1, room: room.id, from: 'carol', to: 'dave', fromBindingId: fixtureIDs.carol, toBindingId: fixtureIDs.dave,
        fromRevision: 1, toRevision: 1, text: `Synthetic performance message ${i + 1}`, replyTo: null }) } });
  }
  return sources;
}
