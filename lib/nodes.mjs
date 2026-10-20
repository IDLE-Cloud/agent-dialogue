import { randomUUID } from 'node:crypto';
import { canonicalPeerDirectory } from './platform.mjs';
import { readStore, resolveBinding, resolveRoom, validateAlias, validateRoute, encodeFrame, decodeFrame } from './bridge-store.mjs';
import { loadOrCreateNode, readExistingNode, nodePublic, validatePublicNode, signObject, verifyObject, payloadHash, validateWireMessage } from './node-identity.mjs';
import { exchange, validateTransport } from './node-transport.mjs';
import { locked, hcom, eventById } from './bridge.mjs';
import { withNative, inspectBinding } from './adapters.mjs';
import { withDispatch, requireEnabled } from './lifecycle.mjs';
import { decodeSubmission, validateSubmission } from './submissions.mjs';
import { validateForwardingRecord } from './forwarding-record.mjs';
import { scanUniqueLedger } from './recovery-evidence.mjs';

function maps(store) { store.peers ||= {}; store.inbox ||= {}; store.outbox ||= {}; return store; }
function own(binding, node) { return !binding.remote && (!binding.nodeId || binding.nodeId === node.nodeId); }
const wireEndpoint = node => `wire${node.nodeId.slice(2, 18)}`;
const ingressSender = nodeId => `node-${nodeId.slice(2, 18)}`;
const endpoint = (binding, node) => ({ nodeId: binding.nodeId || node.nodeId, bindingId: binding.id, revision: binding.revision, alias: binding.alias });
function manifest(room, node) {
  return { type: 'room', version: 1, id: room.id, name: room.name, revision: room.revision || 1, ownerNodeId: room.ownerNodeId || node.nodeId, members: room.members.map(p => ({ alias: p.alias, bindingId: p.bindingId, revision: p.revision, nodeId: p.nodeId || node.nodeId })) };
}
function descriptor(binding, node) {
  const { alias, id, revision, harness, sessionId, projectId, directory, serviceId, origin, hcomName, resumeRequested } = binding;
  return { alias, id, revision, harness, sessionId, projectId, directory, serviceId, origin, hcomName, active: true, nodeId: node.nodeId, ...(resumeRequested ? { resumeRequested: true } : {}) };
}
export async function exportNode(context) {
  const node = await loadOrCreateNode(context), store = await readStore(context);
  return signObject(node, { type: 'node-card', version: 1, node: nodePublic(node), bindings: Object.values(store.bindings).filter(b => b.active && own(b, node)).map(b => descriptor(b, node)) });
}
function verifiedCard(card) {
  const pub = validatePublicNode(card?.payload?.node);
  const p = verifyObject(card, pub.publicKey);
  if (p.type !== 'node-card' || p.version !== 1 || !Array.isArray(p.bindings) || p.bindings.length > 100) throw new Error('Invalid node card.');
  for (const binding of p.bindings) {
    validateAlias(binding.alias);
    if (binding.alias === 'operator' || binding.nodeId !== pub.nodeId || !/^b_[0-9a-f-]{36}$/.test(binding.id) || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || binding.active !== true) throw new Error('Invalid signed binding descriptor.');
    for (const field of ['harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName']) if (typeof binding[field] !== 'string' || !binding[field] || binding[field].includes('\0')) throw new Error('Invalid signed binding field.');
    if (!canonicalPeerDirectory(binding.directory)) throw new Error('Peer binding directory must be absolute.');
  }
  if (new Set(p.bindings.map(b => b.alias)).size !== p.bindings.length || new Set(p.bindings.map(b => b.id)).size !== p.bindings.length) throw new Error('Duplicate peer binding descriptor.');
  return p;
}
export async function pairPeer(context, card, transport) {
  const p = verifiedCard(card), node = await loadOrCreateNode(context);
  if (p.node.nodeId === node.nodeId) throw new Error('Cannot pair a node with itself or clone the same node key.');
  validateTransport(transport);
  return await locked(context, store => {
    maps(store);
    const previous = store.peers[p.node.nodeId];
    if (previous && previous.publicKey !== p.node.publicKey) throw new Error('Pinned peer key changed.');
    for (const binding of p.bindings) {
      const old = Object.hasOwn(store.bindings, binding.alias) ? store.bindings[binding.alias] : undefined, remote = { ...binding, remote: true };
      if (old && payloadHash(old) !== payloadHash(remote)) throw new Error(`Peer alias ${binding.alias} conflicts with an existing binding. Choose unique aliases before export.`);
      store.bindings[binding.alias] = remote;
    }
    store.peers[p.node.nodeId] = { ...p.node, transport, cardHash: payloadHash(p) };
    return { node: p.node, importedBindings: p.bindings.map(b => b.alias) };
  });
}
export async function sealRoom(context, room) {
  const node = await loadOrCreateNode(context);
  return await locked(context, store => {
    const live = resolveRoom(store, room.id);
    live.revision ||= 1; live.ownerNodeId ||= node.nodeId;
    for (const pin of live.members) pin.nodeId ||= store.bindings[pin.alias].nodeId || node.nodeId;
    live.manifestHash = payloadHash(manifest(live, node));
    return live;
  });
}
export async function exportRoom(context, id) {
  const node = await loadOrCreateNode(context), room = resolveRoom(await readStore(context), id);
  if (room.ownerNodeId && room.ownerNodeId !== node.nodeId) throw new Error('Only the room owner can export its signed manifest.');
  return signObject(node, manifest(room, node));
}
export async function acceptRoom(context, envelope) {
  const node = await loadOrCreateNode(context);
  return await locked(context, store => {
    maps(store);
    const alleged = envelope?.payload, peer = alleged?.ownerNodeId === node.nodeId ? node : store.peers[alleged?.ownerNodeId];
    if (!peer) throw new Error('Room owner is not explicitly paired.');
    const p = verifyObject(envelope, peer.publicKey);
    if (p.type !== 'room' || p.version !== 1 || !/^r_[0-9a-f-]{36}$/.test(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1 || typeof p.name !== 'string' || !p.name || !Array.isArray(p.members) || p.members.length < 2) throw new Error('Invalid room manifest.');
    if (new Set(p.members.map(m => m.alias)).size !== p.members.length) throw new Error('Duplicate room members.');
    let local = false;
    for (const member of p.members) {
      const b = resolveBinding(store, member.alias);
      if (b.id !== member.bindingId || b.revision !== member.revision || (b.nodeId || node.nodeId) !== member.nodeId) throw new Error('Room member does not match a pinned local or paired binding.');
      if (own(b, node)) local = true;
    }
    if (!local) throw new Error('A room must contain at least one local participant before acceptance.');
    const hash = payloadHash(p), previous = store.rooms[p.id];
    if (previous && previous.manifestHash !== hash) throw new Error('Room ID already exists with a different manifest.');
    const room = { id: p.id, name: p.name, revision: p.revision, ownerNodeId: p.ownerNodeId, members: p.members, manifestHash: hash };
    store.rooms[room.id] = room; return room;
  });
}
function validateWireRoute(store, node, payload, incoming) {
  const p = validateWireMessage(payload), route = validateRoute(store, { room: p.roomId, from: p.from.alias, to: p.to.alias });
  if (route.room.revision !== p.roomRevision || route.room.manifestHash !== p.manifestHash) throw new Error('Wire room manifest is missing, stale or unaccepted.');
  if (p.from.bindingId === 'operator') {
    if (p.from.alias !== 'operator' || p.from.revision !== 1 || !route.room.members.some(m => m.nodeId === p.from.nodeId)) throw new Error('Operator node is not represented in this room.');
  } else if (payloadHash(endpoint(route.from, node)) !== payloadHash(p.from)) throw new Error('Wire source binding does not match room.');
  if (payloadHash(endpoint(route.to, node)) !== payloadHash(p.to)) throw new Error('Wire destination binding does not match room.');
  if (incoming ? p.to.nodeId !== node.nodeId || route.to.remote : p.from.nodeId !== node.nodeId || (p.from.alias !== 'operator' && route.from.remote)) throw new Error('Node does not own the message endpoint.');
  return route;
}
function frameFor(envelope, replyTo = null) {
  const p = envelope.payload;
  return { version: 1, room: p.roomId, from: p.from.alias, to: p.to.alias, fromBindingId: p.from.bindingId, toBindingId: p.to.bindingId, fromRevision: p.from.revision, toRevision: p.to.revision, text: p.text, replyTo, globalMessageId: p.messageId, replyToMessageId: p.replyToMessageId, wireEnvelope: envelope };
}
function encodeLedgerFrame(envelope) {
  const encoded = encodeFrame(frameFor(envelope));
  if (Buffer.byteLength(encoded, 'utf8') > 120_000) throw new Error('Encoded frame exceeds local ledger argv limit (120000 bytes).');
  return encoded;
}
async function findWireEvent(context, messageId, sender) {
  const evidence = await scanUniqueLedger(context, event => {
    const text = event.data?.text;
    if (typeof text !== 'string' || !text.startsWith('agent-dialogue/1\n')) return false;
    // Select identity candidates before validating their body or actual sender.
    // Otherwise a valid row plus a contradictory same-m row could look unique.
    try {
      const frame = JSON.parse(text.slice('agent-dialogue/1\n'.length));
      return frame?.globalMessageId === messageId || frame?.wireEnvelope?.payload?.messageId === messageId;
    } catch { return false; }
  });
  if (!evidence.complete || evidence.status === 'ambiguous') throw Object.assign(new Error('Global message ledger evidence is ambiguous or incomplete; preserve its original intent for explicit recovery.'), { code: 'RECOVERY_EVIDENCE_INCOMPLETE', uncertain: true });
  if (evidence.event) {
    let frame;
    try { frame = decodeFrame(evidence.event.data.text); }
    catch { throw Object.assign(new Error('The unique global message candidate is malformed; preserve its original intent for explicit recovery.'), { code: 'RECOVERY_EVIDENCE_INVALID', uncertain: true }); }
    if (evidence.event.data.from !== sender || frame.globalMessageId !== messageId || frame.wireEnvelope?.payload?.messageId !== messageId) throw Object.assign(new Error('The unique global message candidate has mismatched identity or sender evidence; no retry was authorized.'), { code: 'RECOVERY_EVIDENCE_INVALID', uncertain: true });
  }
  return evidence.event;
}
async function parentPayload(context, entry) {
  if (!entry?.eventId) throw new Error('Reply references an uncommitted or unknown global message.');
  const event = await eventById(context, entry.eventId);
  return decodeFrame(event.data.text).wireEnvelope?.payload;
}
function assertReverse(parent, p) {
  if (!parent || parent.roomId !== p.roomId || parent.roomRevision !== p.roomRevision || payloadHash(parent.from) !== payloadHash(p.to) || payloadHash(parent.to) !== payloadHash(p.from)) throw new Error('Global reply does not reverse the original room and exact participants.');
}
async function ensureWireEndpoint(context, node) {
  await hcom(context, ['start', '--name', wireEndpoint(node)]);
}
function receipt(node, payload, record) {
  return signObject(node, { type: 'receipt', version: 1, nodeId: node.nodeId, sourceNodeId: payload.from.nodeId, messageId: payload.messageId, payloadHash: payloadHash(payload), status: 'stored', eventId: record.eventId });
}
export async function receiveEnvelope(context, envelope) {
  const node = await loadOrCreateNode(context), p = validateWireMessage(envelope?.payload), hash = payloadHash(p);
  const encoded = encodeLedgerFrame(envelope);
  let fresh = false;
  await locked(context, async store => {
    maps(store); const peer = store.peers[p.from.nodeId];
    if (!peer) throw new Error('Message source node is not paired.');
    verifyObject(envelope, peer.publicKey); validateWireRoute(store, node, p, true);
    if (p.replyToMessageId) assertReverse(await parentPayload(context, store.outbox[p.replyToMessageId]), p);
    const old = store.inbox[p.messageId];
    if (old && old.payloadHash !== hash) throw new Error('Global message ID was reused with different content.');
    if (!old) {
      store.inbox[p.messageId] = { payloadHash: hash, senderNodeId: p.from.nodeId, roomId: p.roomId, status: 'preparing' };
      fresh = true;
    }
  });
  return await locked(context, async store => {
    maps(store); const peer = store.peers[p.from.nodeId];
    if (!peer) throw new Error('Peer was removed before ingress.');
    verifyObject(envelope, peer.publicKey); validateWireRoute(store, node, p, true);
    const record = store.inbox[p.messageId];
    if (record.payloadHash !== hash) throw new Error('Ingress intent content changed.');
    if (!record.eventId) {
      const existing = await findWireEvent(context, p.messageId, ingressSender(p.from.nodeId));
      if (existing) record.eventId = existing.id;
      else if (!fresh) throw Object.assign(new Error('Ingress outcome cannot be reconciled; preserve pending intent for explicit recovery.'), { uncertain: true });
      else {
        const b = resolveBinding(store, p.to.alias);
        const r = JSON.parse(await hcom(context, ['send', '--json', '--from', ingressSender(p.from.nodeId), `@${b.hcomName}`, '--thread', p.roomId, '--intent', 'inform', '--', encoded]));
        record.eventId = r.event_id;
      }
      const stored = await eventById(context, record.eventId), saved = decodeFrame(stored.data.text);
      if (payloadHash(saved.wireEnvelope) !== payloadHash(envelope)) throw new Error('Recovered ledger frame differs from the signed ingress.');
    }
    record.status = record.status === 'native-admitted' ? record.status : 'stored';
    return receipt(node, p, record);
  });
}
export async function validateIngress(context, store, binding, frame, event) {
  return validateIngressWithNode(context, store, binding, frame, event, await loadOrCreateNode(context));
}
async function validateIngressWithNode(context, store, binding, frame, event, node) {
  const p = validateWireMessage(frame.wireEnvelope?.payload);
  const peer = store.peers?.[p.from.nodeId];
  if (!peer) throw new Error('Ingress peer is not paired.');
  verifyObject(frame.wireEnvelope, peer.publicKey); validateWireRoute(store, node, p, true);
  const record = store.inbox?.[p.messageId];
  if (!record || record.eventId !== event.id || record.payloadHash !== payloadHash(p) || event.data.from !== ingressSender(p.from.nodeId) || frame.globalMessageId !== p.messageId || binding.id !== p.to.bindingId) throw new Error('Ingress ledger mapping or sender does not match the signed message.');
  const expected = frameFor(frame.wireEnvelope);
  for (const key of ['room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text', 'replyTo', 'replyToMessageId']) if (frame[key] !== expected[key]) throw new Error('Local ingress frame was changed after signature verification.');
  if (!(event.data.delivered_to || []).includes(binding.hcomName)) throw new Error('Ingress event was not addressed to this binding.');
  if (p.replyToMessageId) assertReverse(await parentPayload(context, store.outbox[p.replyToMessageId]), p);
  return record;
}

/** A new queued reply needs a complete signed incoming parent, rather than a
 * body merely loaded through an event ID. Keep metadata and record evidence
 * tied to the original parent m before signing the new outbound payload. */
async function verifiedIncomingParent(context, store, node, messageId) {
  const record = store.inbox?.[messageId];
  if (!record || !['stored', 'native-admitted'].includes(record.status) || !Number.isSafeInteger(record.eventId) || record.eventId < 1) forwardingFailure('Remote reply parent has no confirmed incoming ledger association.');
  const event = await eventById(context, record.eventId), frame = decodeFrame(event.data?.text), payload = frame.wireEnvelope?.payload;
  if (payload?.messageId !== messageId) forwardingFailure('Remote reply parent identity differs from its inbox association.');
  const binding = resolveBinding(store, payload?.to?.alias);
  await validateIngressWithNode(context, store, binding, frame, event, node);
  if (payloadHash(frame) !== payloadHash(frameFor(frame.wireEnvelope)) || event.type !== 'message' || event.data.sender_kind !== 'external' || event.data.thread !== payload.roomId || event.data.intent !== 'inform' || !Array.isArray(event.data.delivered_to) || event.data.delivered_to.length !== 1 || event.data.delivered_to[0] !== binding.hcomName || record.senderNodeId !== payload.from.nodeId || record.roomId !== payload.roomId) forwardingFailure('Remote reply parent has inconsistent signed wrapper or actual ingress metadata.');
  return payload;
}
// The preflight only identifies the signed source. Every writable reconciliation
// and the exchange are repeated inside that source's dispatch critical section.
async function outboxSource(context, messageId) {
  const node = await loadOrCreateNode(context), store = maps(await readStore(context)), record = store.outbox[messageId];
  if (!record) throw new Error('Unknown outbox message.');
  const event = record.eventId ? await eventById(context, record.eventId) : record.fromActor ? await findWireEvent(context, messageId, record.fromActor) : null;
  if (!event) throw Object.assign(new Error(`Outbox ${messageId} has no confirmed ledger event; preserve its intent for explicit recovery.`), { uncertain: true, messageId });
  const envelope = decodeFrame(event.data.text).wireEnvelope;
  verifyObject(envelope, node.publicKey);
  if (envelope.payload.messageId !== messageId || payloadHash(envelope.payload) !== record.payloadHash || (record.fromActor && event.data.from !== record.fromActor)) throw new Error('Outbox ledger content does not match its intent.');
  return validateWireRoute(store, node, envelope.payload, false).from;
}
export async function flushMessage(context, messageId, { exchangeImpl = exchange, permit } = {}) {
  if (!/^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(messageId)) throw new Error('Use an exact global message ID (m_UUID).');
  const source = await outboxSource(context, messageId);
  const flush = () => flushWithinDispatch(context, messageId, { exchangeImpl });
  if (source.alias === 'operator') return flush(); // operator has no binding lifecycle.
  return withDispatch(context, source, flush, { permit });
}
async function flushWithinDispatch(context, messageId, { exchangeImpl }) {
  const node = await loadOrCreateNode(context), store = maps(await readStore(context)), record = store.outbox[messageId];
  if (!record) throw new Error('Unknown outbox message.');
  if (!record.eventId) {
    const recovered = record.fromActor ? await findWireEvent(context, messageId, record.fromActor) : null;
    if (!recovered) throw Object.assign(new Error(`Outbox ${messageId} has no confirmed ledger event; preserve its intent for explicit recovery.`), { uncertain: true, messageId });
    const saved = decodeFrame(recovered.data.text).wireEnvelope;
    verifyObject(saved, node.publicKey);
    if (saved.payload.messageId !== messageId || payloadHash(saved.payload) !== record.payloadHash) throw new Error('Recovered outbox content differs from its intent.');
    await locked(context, live => {
      live.outbox[messageId].eventId = recovered.id;
      // A recovered local ID supplies no new remote-outcome evidence. Keep
      // unknown or already confirmed storage intact across a failed retry.
      if (live.outbox[messageId].status === 'preparing') live.outbox[messageId].status = 'queued';
    });
    record.eventId = recovered.id;
  }
  const event = await eventById(context, record.eventId), envelope = decodeFrame(event.data.text).wireEnvelope;
  verifyObject(envelope, node.publicKey);
  if (envelope.payload.messageId !== messageId || payloadHash(envelope.payload) !== record.payloadHash || (record.fromActor && event.data.from !== record.fromActor)) throw new Error('Outbox ledger content does not match its intent.');
  const route = validateWireRoute(store, node, envelope.payload, false);
  if (route.from.alias !== 'operator') requireEnabled(store, route.from);
  const peer = store.peers[record.peerNodeId];
  if (!peer) throw new Error('Destination node is not paired.');
  let response;
  try {
    const signed = await exchangeImpl(peer, envelope); response = verifyObject(signed, peer.publicKey);
    if (response.type !== 'receipt' || response.version !== 1 || response.nodeId !== peer.nodeId || response.sourceNodeId !== node.nodeId || response.messageId !== messageId || response.payloadHash !== record.payloadHash || response.status !== 'stored' || !Number.isSafeInteger(response.eventId)) throw new Error('Remote receipt does not match the exact message.');
  } catch (error) {
    const confirmed = await locked(context, live => {
      maps(live);
      if (live.outbox[messageId].status === 'remote-stored') return true;
      live.outbox[messageId].status = 'unknown';
      return false;
    });
    const message = confirmed
      ? `Retry for ${messageId} failed; prior remote-stored evidence is retained. `
      : `Remote outcome for ${messageId} is unknown; retry this same message ID with node flush. `;
    throw Object.assign(new Error(message + error.message), { uncertain: true, messageId });
  }
  await locked(context, live => { maps(live); live.outbox[messageId].status = 'remote-stored'; live.outbox[messageId].remoteEventId = response.eventId; });
  return { messageId, event_id: record.eventId, status: 'remote-stored', remoteEventId: response.eventId };
}
export async function sendRemote(context, { room, from, to, text, expectedSession, replyTo = null }, options = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 40000) throw new Error('Message must be nonempty and at most 40000 characters.');
  const source = validateRoute(await readStore(context), { room, from, to, expectedSession }).from;
  const send = permit => sendRemoteWithinDispatch(context, { room, from, to, text, expectedSession, replyTo }, { ...options, permit });
  if (source.alias === 'operator') return send(); // operator has no binding lifecycle.
  return withDispatch(context, source, ({ permit }) => send(permit), { permit: options.permit });
}
async function sendRemoteWithinDispatch(context, { room, from, to, text, expectedSession, replyTo }, options) {
  const node = await loadOrCreateNode(context); await ensureWireEndpoint(context, node);
  const snapshot = maps(await readStore(context));
  const inspectedRoute = validateRoute(snapshot, { room, from, to, expectedSession });
  if (!inspectedRoute.to.remote || !snapshot.peers[inspectedRoute.to.nodeId]) throw new Error('Destination must be an explicitly paired remote binding.');
  if (from !== 'operator') {
    if (!own(inspectedRoute.from, node)) throw new Error('Cannot send on behalf of a different node.');
    requireEnabled(snapshot, inspectedRoute.from);
    // Dispatch admission remains held, while incoming signed ledger storage can
    // still acquire the short control lock during a bounded native query.
    await withNative(context, inspectedRoute.from.harness, client => inspectBinding(client, inspectedRoute.from));
  }
  const result = await locked(context, async store => {
    maps(store); const route = validateRoute(store, { room, from, to, expectedSession });
    if (payloadHash(route) !== payloadHash(inspectedRoute)) throw Object.assign(new Error('Binding identity or room pins changed during native verification; inspect the route before sending.'), { code: 'BINDING_CHANGED' });
    if (!route.to.remote || !store.peers[route.to.nodeId]) throw new Error('Destination must be an explicitly paired remote binding.');
    if (from !== 'operator') {
      if (!own(route.from, node)) throw new Error('Cannot send on behalf of a different node.');
      requireEnabled(store, route.from);
    }
    let parentId = replyTo;
    if (parentId && /^\d+$/.test(parentId)) parentId = decodeFrame((await eventById(context, parentId)).data.text).globalMessageId;
    const p = { type: 'message', version: 1, messageId: `m_${randomUUID()}`, roomId: room, roomRevision: route.room.revision, manifestHash: route.room.manifestHash, from: from === 'operator' ? { nodeId: node.nodeId, bindingId: 'operator', revision: 1, alias: 'operator' } : endpoint(route.from, node), to: endpoint(route.to, node), text, replyToMessageId: parentId, createdAt: new Date().toISOString() };
    validateWireRoute(store, node, p, false);
    if (parentId) assertReverse(await parentPayload(context, store.inbox[parentId]), p);
    const envelope = signObject(node, p), encoded = encodeLedgerFrame(envelope);
    const record = { payloadHash: payloadHash(p), peerNodeId: p.to.nodeId, roomId: room, fromActor: from === 'operator' ? 'dialogue-operator' : route.from.hcomName, status: 'preparing' };
    store.outbox[p.messageId] = record;
    return { envelope, record, encoded };
  });
  await locked(context, async store => {
    maps(store); const p = result.envelope.payload, record = store.outbox[p.messageId];
    const route = validateWireRoute(store, node, p, false);
    if (route.from.alias !== 'operator') requireEnabled(store, route.from);
    const argv = ['send', '--json', ...(from === 'operator' ? ['--from', 'dialogue-operator'] : ['--name', resolveBinding(store, from).hcomName]), `@${wireEndpoint(node)}`, '--thread', room, '--intent', 'inform', '--', result.encoded];
    const sent = JSON.parse(await hcom(context, argv)); record.eventId = sent.event_id; record.status = 'queued';
  });
  return await flushMessage(context, result.envelope.payload.messageId, options);
}

const FORWARDING_PROVENANCE = ['version', 'submissionId', 'submissionEventId', 'submissionHash', 'dispatchId', 'bindingId', 'bindingRevision'];
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const exactId = prefix => new RegExp(`^${prefix}_${uuid}(?![\\s\\S])`);
const forwardingId = (prefix, value) => typeof value === 'string' && exactId(prefix).test(value);
const fixedHash = value => typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value);
const forwardingFailure = message => { throw Object.assign(new Error(message), { code: 'FORWARDING_INVALID', uncertain: true }); };
function forwardingMetadata(intent) {
  if (intent?.kind === 'remote' && intent.provenance === undefined) {
    validateForwardingRecord(intent);
    intent = { ...intent, provenance: Object.fromEntries(FORWARDING_PROVENANCE.map(key => [key, intent[key]])) };
  }
  const p = intent?.provenance;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== FORWARDING_PROVENANCE.length || FORWARDING_PROVENANCE.some(key => !Object.hasOwn(p, key)) || p.version !== 1 || !forwardingId('q', p.submissionId) || !forwardingId('b', p.bindingId) || !Number.isSafeInteger(p.submissionEventId) || p.submissionEventId < 1 || !Number.isSafeInteger(p.bindingRevision) || p.bindingRevision < 1 || !fixedHash(p.submissionHash) || typeof p.dispatchId !== 'string' || !new RegExp(`^${uuid}(?![\\s\\S])`).test(p.dispatchId) || !forwardingId('m', intent?.messageId) || typeof intent.createdAt !== 'string' || !Number.isFinite(Date.parse(intent.createdAt)) || new Date(intent.createdAt).toISOString() !== intent.createdAt) forwardingFailure('Invalid exact remote forwarding allocation.');
  if (intent.payloadHash !== undefined && !fixedHash(intent.payloadHash) || intent.routeHash !== undefined && !fixedHash(intent.routeHash)) forwardingFailure('Invalid remote forwarding content evidence.');
  return { messageId: intent.messageId, createdAt: intent.createdAt, payloadHash: intent.payloadHash, routeHash: intent.routeHash, provenance: structuredClone(p) };
}
function requireRecoveryStore(store) {
  if (store.version !== 3 || !store.forwardings || typeof store.forwardings !== 'object' || Array.isArray(store.forwardings)) forwardingFailure('Remote queued forwarding requires explicitly upgraded v3 state.');
}
async function queuedRemoteSource(context, store, node, intent, expectedOptions) {
  requireRecoveryStore(store); const meta = forwardingMetadata(intent), p = meta.provenance;
  const event = await eventById(context, p.submissionEventId), request = decodeSubmission(event.data?.text), binding = resolveBinding(store, request.from);
  const options = validateSubmission(store, binding, request, event);
  if (request.id !== p.submissionId || payloadHash(request) !== p.submissionHash || binding.id !== p.bindingId || binding.revision !== p.bindingRevision || binding.nodeId !== node.nodeId) forwardingFailure('Remote forwarding does not match its exact local q event.');
  const route = validateRoute(store, options);
  if (!route.to.remote || !store.peers?.[route.to.nodeId]) forwardingFailure('Remote forwarding destination is not explicitly paired.');
  if (expectedOptions) {
    const normalized = { room: expectedOptions.room, from: expectedOptions.from, to: expectedOptions.to, text: expectedOptions.text, expectedSession: expectedOptions.expectedSession ?? route.to.sessionId, replyTo: expectedOptions.replyTo ?? null };
    if (payloadHash(normalized) !== payloadHash(options)) forwardingFailure('Remote forwarding arguments differ from the original q request.');
  }
  return { event, request, binding, options, route };
}
async function remoteForwardingPayload(context, store, node, options, route, meta) {
  let parentId = options.replyTo;
  if (parentId && /^\d+$/.test(String(parentId))) parentId = decodeFrame((await eventById(context, parentId)).data.text).globalMessageId;
  if (options.replyTo && !parentId) forwardingFailure('Remote reply has no exact global parent.');
  const payload = { type: 'message', version: 1, messageId: meta.messageId, roomId: options.room, roomRevision: route.room.revision, manifestHash: route.room.manifestHash, from: endpoint(route.from, node), to: endpoint(route.to, node), text: options.text, replyToMessageId: parentId, createdAt: meta.createdAt };
  validateWireRoute(store, node, payload, false);
  const parent = parentId ? await verifiedIncomingParent(context, store, node, parentId) : null;
  if (parentId) assertReverse(parent, payload);
  return { payload, parentId, parentRecord: parentId ? structuredClone(store.inbox[parentId]) : null };
}
/** The owning source D remains held by the caller; no body or key is persisted. */
export async function prepareRemoteForwarding(context, options, allocation = {}) {
  const meta = forwardingMetadata(allocation);
  const source = validateRoute(await readStore(context), options).from;
  if (source.alias === 'operator') forwardingFailure('Queued remote forwarding requires an exact local agent source.');
  return await withDispatch(context, source, async ({ store }) => {
    const node = await readExistingNode(context), original = await queuedRemoteSource(context, store, node, meta, options);
    await withNative(context, original.binding.harness, client => inspectBinding(client, original.binding));
    const built = await remoteForwardingPayload(context, store, node, original.options, original.route, meta);
    const envelope = signObject(node, built.payload), encoded = encodeLedgerFrame(envelope);
    return { ...meta, payloadHash: payloadHash(built.payload), routeHash: payloadHash(original.route), envelope, encoded, node: nodePublic(node), options: original.options, parentId: built.parentId, parentRecord: built.parentRecord };
  }, { permit: allocation.permit });
}
function requirePreparedRoute(store, prepared) {
  requireRecoveryStore(store); validatePublicNode(prepared?.node); const meta = forwardingMetadata(prepared), route = validateWireRoute(store, prepared.node, prepared.envelope?.payload, false);
  requireEnabled(store, route.from); verifyObject(prepared.envelope, prepared.node.publicKey);
  if (route.from.nodeId !== prepared.node.nodeId || payloadHash(route) !== meta.routeHash || payloadHash(prepared.envelope.payload) !== meta.payloadHash || prepared.envelope.payload.messageId !== meta.messageId || prepared.envelope.payload.createdAt !== meta.createdAt || encodeLedgerFrame(prepared.envelope) !== prepared.encoded) forwardingFailure('Remote forwarding route or canonical frame changed.');
  if (prepared.parentId && payloadHash(store.inbox?.[prepared.parentId]) !== payloadHash(prepared.parentRecord)) forwardingFailure('Remote forwarding parent evidence changed.');
  return { meta, route };
}
/** Pure C transaction helper; the caller creates forwardings[q] in this same C. */
export function buildRemoteForwarding(store, prepared) {
  const { meta, route } = requirePreparedRoute(store, prepared); maps(store);
  if (Object.hasOwn(store.outbox, meta.messageId)) forwardingFailure('Remote message ID already has an outbox intent.');
  store.outbox[meta.messageId] = { payloadHash: meta.payloadHash, peerNodeId: route.to.nodeId, roomId: route.room.id, fromActor: route.from.hcomName, status: 'preparing', dispatchPhase: 'prepared', createdAt: meta.createdAt, routeHash: meta.routeHash, provenance: meta.provenance };
  return meta;
}
function requireRemoteAssociation(store, intent) {
  requireRecoveryStore(store); const meta = forwardingMetadata(intent), p = meta.provenance;
  const row = validateForwardingRecord(store.forwardings[p.submissionId], p.submissionId), outbox = store.outbox?.[meta.messageId];
  if (row.kind !== 'remote' || row.submissionEventId !== p.submissionEventId || row.submissionHash !== p.submissionHash || row.dispatchId !== p.dispatchId || row.bindingId !== p.bindingId || row.bindingRevision !== p.bindingRevision || row.messageId !== meta.messageId || row.createdAt !== meta.createdAt || row.payloadHash !== meta.payloadHash || row.routeHash !== meta.routeHash || !outbox || payloadHash(outbox.provenance) !== payloadHash(p) || outbox.payloadHash !== meta.payloadHash || outbox.createdAt !== meta.createdAt || outbox.routeHash !== meta.routeHash || outbox.roomId !== row.roomId) forwardingFailure('Remote q and outbox provenance are not the same exact durable association.');
  return { meta, row, outbox };
}
function verifyRemoteEvent(node, store, intent, payload, event) {
  const { meta, row, outbox } = requireRemoteAssociation(store, intent), frame = decodeFrame(event?.data?.text), envelope = frame.wireEnvelope;
  if (row.phase === 'prepared') forwardingFailure('A remote formal event cannot precede its durable append-started claim.');
  verifyObject(envelope, node.publicKey); const route = validateWireRoute(store, node, envelope.payload, false);
  if (payloadHash(envelope.payload) !== meta.payloadHash || payloadHash(payload) !== meta.payloadHash || payloadHash(frame) !== payloadHash(frameFor(envelope)) || payloadHash(frame) !== row.frameHash || !Number.isSafeInteger(event.id) || event.id < 1 || event.type !== 'message' || event.data.from !== route.from.hcomName || event.data.sender_kind !== 'instance' || event.data.thread !== row.roomId || event.data.intent !== 'inform' || !Array.isArray(event.data.delivered_to) || event.data.delivered_to.length !== 1 || event.data.delivered_to[0] !== wireEndpoint(node) || outbox.fromActor !== route.from.hcomName || outbox.peerNodeId !== route.to.nodeId || row.formalEventId !== null && row.formalEventId !== event.id || outbox.eventId !== undefined && outbox.eventId !== event.id) forwardingFailure('Remote formal event does not match its exact q/frame/sender/route evidence.');
  return { messageId: meta.messageId, event_id: event.id, payloadHash: meta.payloadHash };
}
/** Read-only: pending outcomes never authorize a second append or exchange. */
export async function verifyRemoteForwarding(context, intent, event) {
  const store = await readStore(context), node = await readExistingNode(context), { meta } = requireRemoteAssociation(store, intent);
  const original = await queuedRemoteSource(context, store, node, meta);
  if (payloadHash(original.route) !== meta.routeHash) forwardingFailure('Remote forwarding route changed before evidence verification.');
  const expected = await remoteForwardingPayload(context, store, node, original.options, original.route, meta);
  return verifyRemoteEvent(node, store, meta, expected.payload, event);
}
/** Only this invocation's committed prepared→append-started claim may append. */
export async function appendRemoteForwarding(context, prepared, { permit, beforeAppend, hcomImpl = hcom } = {}) {
  if (typeof beforeAppend !== 'function' || typeof hcomImpl !== 'function') forwardingFailure('Remote append requires a synchronous provenance claim callback.');
  return await withDispatch(context, prepared?.options?.from, async () => {
    await locked(context, store => {
      requirePreparedRoute(store, prepared); const { row, outbox } = requireRemoteAssociation(store, prepared);
      if (row.phase !== 'prepared' || outbox.dispatchPhase !== 'prepared' || outbox.eventId !== undefined) forwardingFailure('Remote append was already started; only exact ledger reconciliation is allowed.');
      const value = beforeAppend(store, outbox);
      if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); forwardingFailure('Remote append claim callback must be synchronous.'); }
      const checked = requireRemoteAssociation(store, prepared);
      if (checked.row.phase !== 'append-started') forwardingFailure('Remote append claim did not persist its source transition.');
      checked.outbox.dispatchPhase = 'append-started';
    });
    return await locked(context, async store => {
      requirePreparedRoute(store, prepared); const { row, outbox } = requireRemoteAssociation(store, prepared);
      if (row.phase !== 'append-started' || outbox.dispatchPhase !== 'append-started' || outbox.eventId !== undefined) forwardingFailure('Remote append claim changed before the ledger operation.');
      await hcomImpl(context, ['start', '--name', wireEndpoint(prepared.node)]);
      const sent = JSON.parse(await hcomImpl(context, ['send', '--json', '--name', outbox.fromActor, `@${wireEndpoint(prepared.node)}`, '--thread', row.roomId, '--intent', 'inform', '--', prepared.encoded]));
      if (!Number.isSafeInteger(sent?.event_id) || sent.event_id < 1) forwardingFailure('Remote append returned no exact ledger event.');
      const event = await eventById(context, sent.event_id); verifyRemoteEvent(prepared.node, store, prepared, prepared.envelope.payload, event);
      outbox.eventId = sent.event_id; outbox.status = 'queued'; outbox.dispatchPhase = 'local-stored';
      return { messageId: prepared.messageId, event_id: sent.event_id, status: 'queued' };
    });
  }, { permit });
}
export async function nodeStatus(context) {
  const node = await loadOrCreateNode(context), store = maps(await readStore(context));
  return { node: nodePublic(node), peers: Object.values(store.peers).map(({ nodeId, name }) => ({ nodeId, name })), inbox: store.inbox, outbox: store.outbox };
}
