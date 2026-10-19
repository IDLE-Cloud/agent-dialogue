import { payloadHash, validatePublicNode, validateWireMessage, verifyObject } from '../node-identity.mjs';
import { toolAvailableReceipt, toolReadRecord } from './tool-inbox.mjs';
import { validateStore } from '../bridge-store.mjs';

export const MAX_OBSERVATION_BYTES = 16 * 1024 * 1024;
export const MAX_OBSERVATION_EVENTS = 20000;
export const MAX_OBSERVATION_REQUEST_BYTES = 16384;
const FRAME = 'agent-dialogue/1\n', SUBMIT = 'agent-dialogue/submit/1\n';
const MAX_FRAME_BYTES = 120000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = prefix => new RegExp(`^${prefix}_${UUID}(?![\\s\\S])`);
const ROOM = id('r'), BINDING = id('b'), SUBMISSION = id('q');
const NODE = /^n_[0-9a-f]{64}(?![\s\S])/, HASH = /^[0-9a-f]{64}(?![\s\S])/, NONCE = /^[0-9a-f]{32}(?![\s\S])/;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/;
const FRAME_KEYS = ['version', 'room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text', 'replyTo'];
const SUBMIT_KEYS = ['version', 'id', 'room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'expectedSession', 'replyTo', 'text'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value > 0;
const text = (value, maximum = 4096) => typeof value === 'string' && !!value.trim() && value.length <= maximum && !value.includes('\0');
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const own = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function fail() { throw new Error('Invalid viewer observation.'); }
function required(value, keys) { if (!object(value) || keys.some(key => !Object.hasOwn(value, key))) fail(); }
function exact(value, keys) { required(value, keys); if (Object.keys(value).length !== keys.length || Object.getOwnPropertySymbols(value).length) fail(); }
function safePublic(value) {
  required(value, ['nodeId', 'name', 'publicKey']);
  return validatePublicNode(own(value, ['nodeId', 'name', 'publicKey']));
}
/** Public lifecycle metadata only. No nonce, token, process or message body is projected. */
export function projectLifecycle(store, binding) {
  if (!object(store) || ![1, 2].includes(store.version) || !object(binding)) return null;
  if (store.version === 1) return { bindingRevision: binding.revision, desired: 'enabled', generation: 0, changedAt: null };
  if (!object(store.lifecycle)) return null;
  const row = store.lifecycle[binding.id];
  if (row === undefined) return { bindingRevision: binding.revision, desired: 'enabled', generation: 0, changedAt: null };
  if (!object(row) || row.bindingRevision !== binding.revision || !['enabled', 'paused'].includes(row.desired) || !integer(row.generation) || !iso(row.changedAt)) return null;
  // A local snapshot may still have the private writer row; a received DTO has
  // already discarded those fields. Validate private evidence before reducing
  // it, without requiring private fields to cross the SSH observation boundary.
  if (['version', 'changeNonce', 'reason'].some(key => Object.hasOwn(row, key))) {
    try { validateStore({ version: 2, bindings: { selected: binding }, rooms: {}, lifecycle: { [binding.id]: own(row, ['version', 'bindingRevision', 'desired', 'generation', 'changeNonce', 'changedAt', 'reason']) } }); }
    catch { return null; }
  }
  return own(row, ['bindingRevision', 'desired', 'generation', 'changedAt']);
}
// Equality is independent of object property order; arrays and encoded frame text remain exact.
function canonical(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!Array.isArray(value) && !object(value) || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail();
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail();
    result = '[' + Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
      return canonical(descriptor.value, ancestors, depth + 1);
    }).join(',') + ']';
  } else result = '{' + Object.keys(value).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    return JSON.stringify(key) + ':' + canonical(descriptor.value, ancestors, depth + 1);
  }).join(',') + '}';
  ancestors.delete(value);
  return result;
}
function bounded(value, maximum) { const serialized = canonical(value); if (Buffer.byteLength(serialized) > maximum) fail(); return serialized; }

/** Explicit scope and per-request nonce; neither labels nor paths are protocol selectors. */
export function validateObservationRequest(request) {
  try {
    bounded(request, MAX_OBSERVATION_REQUEST_BYTES);
    exact(request, ['version', 'type', 'requestId', 'expectedNodeId', 'rooms']);
    if (request.version !== 1 || request.type !== 'viewer-observe' || !NONCE.test(request.requestId) || !NODE.test(request.expectedNodeId) || !Array.isArray(request.rooms) || request.rooms.length < 1 || request.rooms.length > 16) fail();
    const seen = new Set();
    const rooms = request.rooms.map(room => {
      exact(room, ['id', 'revision', 'manifestHash']);
      if (!ROOM.test(room.id) || !integer(room.revision) || !HASH.test(room.manifestHash) || seen.has(room.id)) fail();
      seen.add(room.id); return own(room, ['id', 'revision', 'manifestHash']);
    });
    return { version: 1, type: 'viewer-observe', requestId: request.requestId, expectedNodeId: request.expectedNodeId, rooms };
  } catch { fail(); }
}

function scopedRoom(raw, pin) {
  required(raw, ['id', 'name', 'revision', 'ownerNodeId', 'manifestHash', 'members']);
  if (raw.id !== pin.id || raw.revision !== pin.revision || raw.manifestHash !== pin.manifestHash || !text(raw.name, 4096) || !NODE.test(raw.ownerNodeId) || !Array.isArray(raw.members) || raw.members.length < 2 || raw.members.length > 1024) fail();
  const aliases = new Set(), identities = new Set();
  const members = raw.members.map(member => {
    required(member, ['alias', 'bindingId', 'revision', 'nodeId']);
    if (!ALIAS.test(member.alias) || member.alias === 'operator' || !BINDING.test(member.bindingId) || !integer(member.revision) || !NODE.test(member.nodeId) || aliases.has(member.alias)) fail();
    const identity = `${member.nodeId}:${member.bindingId}:${member.revision}`;
    if (identities.has(identity)) fail(); aliases.add(member.alias); identities.add(identity);
    return own(member, ['alias', 'bindingId', 'revision', 'nodeId']);
  });
  const manifest = { type: 'room', version: 1, id: raw.id, name: raw.name, revision: raw.revision, ownerNodeId: raw.ownerNodeId, members };
  if (payloadHash(manifest) !== pin.manifestHash) fail();
  return { id: raw.id, name: raw.name, revision: raw.revision, ownerNodeId: raw.ownerNodeId, manifestHash: pin.manifestHash, members };
}
function member(room, frame, side, nodeId = null) {
  return room.members.find(pin => pin.alias === frame[side] && pin.bindingId === frame[`${side}BindingId`] && pin.revision === frame[`${side}Revision`] && (!nodeId || pin.nodeId === nodeId));
}
function validFrame(raw, room, submission, node, publicNodes) {
  const keys = submission ? SUBMIT_KEYS : FRAME_KEYS;
  required(raw, keys);
  const frame = own(raw, keys);
  if (frame.version !== 1 || frame.room !== room.id || !ALIAS.test(frame.from) || !ALIAS.test(frame.to) || frame.from === frame.to || !integer(frame.fromRevision) || !integer(frame.toRevision) || !text(frame.text, 40000) || frame.replyTo !== null && !text(frame.replyTo)) fail();
  const to = member(room, frame, 'to');
  if (!to || frame.to === 'operator') fail();
  if (frame.from === 'operator') {
    if (submission || frame.fromBindingId !== 'operator' || frame.fromRevision !== 1 || !room.members.some(pin => pin.nodeId === node.nodeId)) fail();
  } else if (!member(room, frame, 'from')) fail();
  if (submission) {
    if (!SUBMISSION.test(frame.id) || !text(frame.expectedSession) || member(room, frame, 'from').nodeId !== node.nodeId) fail();
    return { frame, wire: null, encoded: SUBMIT + JSON.stringify(frame), submission: true };
  }
  const hasWire = ['wireEnvelope', 'globalMessageId', 'replyToMessageId'].some(key => Object.hasOwn(raw, key));
  if (!hasWire) {
    // Unsigned local frames cannot claim participants hosted on another node.
    const from = frame.from === 'operator' ? { nodeId: node.nodeId } : member(room, frame, 'from');
    if (from.nodeId !== node.nodeId || to.nodeId !== node.nodeId) fail();
    return { frame, wire: null, encoded: FRAME + JSON.stringify(frame), submission: false };
  }
  required(raw.wireEnvelope, ['payload', 'signature']);
  const wire = validateWireMessage(raw.wireEnvelope.payload);
  if (wire.roomId !== room.id || wire.roomRevision !== room.revision || wire.manifestHash !== room.manifestHash || raw.globalMessageId !== wire.messageId || raw.replyToMessageId !== wire.replyToMessageId || frame.replyTo !== null ||
      ['from', 'to'].some(side => wire[side].alias !== frame[side] || wire[side].bindingId !== frame[`${side}BindingId`] || wire[side].revision !== frame[`${side}Revision`]) || wire.text !== frame.text) fail();
  if (!member(room, frame, 'to', wire.to.nodeId)) fail();
  if (frame.from === 'operator') {
    if (!room.members.some(pin => pin.nodeId === wire.from.nodeId)) fail();
  } else if (!member(room, frame, 'from', wire.from.nodeId)) fail();
  const signed = { payload: wire, signature: raw.wireEnvelope.signature }, key = publicNodes.get(wire.from.nodeId);
  if (!key) fail(); verifyObject(signed, key.publicKey);
  Object.assign(frame, { globalMessageId: wire.messageId, replyToMessageId: wire.replyToMessageId, wireEnvelope: signed });
  return { frame, wire, encoded: FRAME + JSON.stringify(frame), submission: false };
}
function eventMetadata(event, encoded) {
  // Protocol pins carry identity and replies. Raw hcom destinations and mentions can
  // refer to agents outside the selected rooms and are unnecessary to projection.
  const result = { id: event.id, type: 'message', data: { text: encoded, thread: event.data.thread } };
  if (iso(event.timestamp)) result.timestamp = event.timestamp;
  return result;
}
function bindingMatches(binding, pin) { return object(binding) && binding.id === pin.bindingId && binding.alias === pin.alias && binding.revision === pin.revision && binding.nodeId === pin.nodeId; }
function sameForward(queue, result, byEvent) {
  if (!queue?.submission || !result || result.submission || ['room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text'].some(key => queue.frame[key] !== result.frame[key])) return false;
  if (!result.wire) return queue.frame.replyTo === result.frame.replyTo;
  let parent = queue.frame.replyTo;
  if (typeof parent === 'string' && /^\d+$/.test(parent)) parent = byEvent.get(Number(parent))?.wire?.messageId || parent;
  return (parent || null) === result.wire.replyToMessageId;
}
function safeReceipt(raw, entry, worker, byEvent, bindings, nodeId) {
  if (!object(raw)) return null;
  const owner = entry.submission ? entry.frame.fromBindingId : entry.frame.toBindingId;
  if (worker.bindingId !== owner) return null;
  const result = {};
  if (raw.status === 'forwarded') {
    const target = byEvent.get(raw.result?.event_id);
    if (!entry.submission || raw.submissionId !== entry.frame.id || !sameForward(entry, target, byEvent) || raw.result.messageId && raw.result.messageId !== target.wire?.messageId) return null;
    Object.assign(result, { status: 'forwarded', submissionId: raw.submissionId, result: { event_id: raw.result.event_id } });
    if (target.wire && raw.result.messageId === target.wire.messageId) result.result.messageId = raw.result.messageId;
    if (['preparing', 'queued', 'unknown', 'remote-stored', 'stored', 'native-admitted'].includes(raw.result.status)) result.result.status = raw.result.status;
    if (integer(raw.result.remoteEventId)) result.result.remoteEventId = raw.result.remoteEventId;
  } else if (raw.status === 'admitted') {
    const binding = Object.values(bindings).find(value => value.id === owner);
    if (binding?.harness === 'zcode-tools' || entry.submission || !text(raw.inputId) || raw.globalMessageId && raw.globalMessageId !== entry.wire?.messageId || raw.sessionId && binding?.sessionId && raw.sessionId !== binding.sessionId) return null;
    Object.assign(result, { status: 'admitted', inputId: raw.inputId });
    if (text(raw.sessionId)) result.sessionId = raw.sessionId;
    if (text(raw.globalMessageId) && raw.globalMessageId === entry.wire?.messageId) result.globalMessageId = raw.globalMessageId;
    if (typeof raw.reconciled === 'boolean') result.reconciled = raw.reconciled;
  } else if (raw.status === 'tool-available') {
    return toolAvailableReceipt(raw, entry, Object.values(bindings).find(value => value.id === owner), nodeId);
  } else if (raw.status === 'rejected') result.status = 'rejected';
  else return null;
  if (iso(raw.at)) result.at = raw.at;
  return result;
}
function scopedStoreRecords(raw, entries, kind, node, bindings) {
  const result = {};
  for (const entry of entries.values()) {
    const wire = entry.wire;
    if (!wire || (kind === 'inbox' ? wire.to.nodeId : wire.from.nodeId) !== node.nodeId) continue;
    const record = raw?.[wire.messageId], nodeKey = kind === 'inbox' ? 'senderNodeId' : 'peerNodeId', expectedNode = kind === 'inbox' ? wire.from.nodeId : wire.to.nodeId;
    if (!object(record) || record.roomId !== wire.roomId || record.payloadHash !== payloadHash(wire) || record[nodeKey] !== expectedNode || record.eventId !== undefined && record.eventId !== entry.event.id) continue;
    const statuses = kind === 'inbox' ? ['preparing', 'stored', 'native-admitted'] : ['preparing', 'queued', 'unknown', 'remote-stored'];
    if (!statuses.includes(record.status)) continue;
    if (kind === 'inbox' && record.status === 'native-admitted' && Object.values(bindings).some(binding => binding.id === wire.to.bindingId && binding.harness === 'zcode-tools')) continue;
    const row = { payloadHash: record.payloadHash, [nodeKey]: expectedNode, roomId: wire.roomId, status: record.status };
    if (integer(record.eventId)) row.eventId = record.eventId;
    if (kind === 'outbox') {
      if (record.fromActor === wire.from.alias) row.fromActor = record.fromActor;
      if (integer(record.remoteEventId)) row.remoteEventId = record.remoteEventId;
    } else {
      const binding = Object.values(bindings).find(value => value.id === wire.to.bindingId);
      const sessionMatches = !record.sessionId || !binding?.sessionId || record.sessionId === binding.sessionId;
      if (sessionMatches && text(record.inputId)) row.inputId = record.inputId;
      if (sessionMatches && text(record.sessionId)) row.sessionId = record.sessionId;
    }
    result[wire.messageId] = row;
  }
  return result;
}
function scopeSource(source, request) {
  required(source, ['available', 'observedAt', 'generation', 'node', 'store', 'events', 'workers']);
  if (source.available !== true || !iso(source.observedAt) || !NONCE.test(source.generation) || !Array.isArray(source.events) || !Array.isArray(source.workers)) fail();
  const node = safePublic(source.node);
  if (node.nodeId !== request.expectedNodeId) fail();
  required(source.store, ['version', 'rooms', 'bindings']);
  if (![1, 2].includes(source.store.version) || !object(source.store.rooms) || !object(source.store.bindings) || source.store.version === 2 && !object(source.store.lifecycle)) fail();
  const rooms = Object.fromEntries(request.rooms.map(pin => [pin.id, scopedRoom(source.store.rooms[pin.id], pin)]));
  if (!Object.values(rooms).every(room => room.members.some(pin => pin.nodeId === node.nodeId))) fail();
  const selectedNodes = new Set(Object.values(rooms).flatMap(room => room.members.map(pin => pin.nodeId)));
  const publicNodes = new Map([[node.nodeId, node]]), peers = {};
  for (const [key, raw] of Object.entries(object(source.store.peers) ? source.store.peers : {})) {
    if (!selectedNodes.has(key) || key === node.nodeId) continue;
    const peer = safePublic(raw); if (peer.nodeId !== key) fail();
    publicNodes.set(key, peer); peers[key] = peer;
  }
  const bindings = {};
  for (const pin of Object.values(rooms).flatMap(room => room.members)) {
    const raw = source.store.bindings[pin.alias];
    if (!bindingMatches(raw, pin)) continue;
    const binding = { alias: pin.alias, id: pin.bindingId, revision: pin.revision, nodeId: pin.nodeId };
    for (const key of ['harness', 'sessionId', 'hcomName']) if (text(raw[key])) binding[key] = raw[key];
    for (const key of ['active', 'remote', 'resumeRequested']) if (typeof raw[key] === 'boolean') binding[key] = raw[key];
    bindings[pin.alias] = binding;
  }
  const lifecycle = {};
  if (source.store.version === 2) for (const binding of Object.values(bindings)) {
    if (binding.remote || binding.nodeId !== node.nodeId || source.store.lifecycle[binding.id] === undefined) continue;
    const row = projectLifecycle(source.store, binding); if (!row) fail();
    lifecycle[binding.id] = row;
  }
  const byEvent = new Map();
  for (const event of source.events) {
    if (!object(event) || event.type !== 'message' || !object(event.data) || typeof event.data.text !== 'string') continue;
    const body = event.data.text, submission = body.startsWith(SUBMIT), framed = body.startsWith(FRAME);
    if (!framed && !submission) { if (body.startsWith('agent-dialogue/') && rooms[event.data.thread]) fail(); continue; }
    let raw;
    try { raw = JSON.parse(body.slice((submission ? SUBMIT : FRAME).length)); }
    catch { if (rooms[event.data.thread]) fail(); continue; }
    const room = rooms[raw?.room], threadRoom = rooms[event.data.thread];
    if (!room && !threadRoom) continue;
    if (!room || event.data.thread !== raw.room || !integer(event.id) || byEvent.has(event.id) || Buffer.byteLength(body) > MAX_FRAME_BYTES) fail();
    const parsed = validFrame(raw, room, submission, node, publicNodes);
    if (Buffer.byteLength(parsed.encoded) > MAX_FRAME_BYTES) fail();
    byEvent.set(event.id, { ...parsed, event: eventMetadata(event, parsed.encoded) });
    if (byEvent.size > MAX_OBSERVATION_EVENTS) fail();
  }
  const workers = [];
  for (const raw of source.workers) {
    if (!object(raw)) continue;
    const binding = Object.values(bindings).find(value => value.id === raw.bindingId && value.nodeId === node.nodeId);
    if (!binding) continue;
    const worker = { bindingId: binding.id, receipts: {} };
    if (['starting', 'ready', 'waiting-native', 'paused', 'stopping', 'stopped', 'error'].includes(raw.status)) worker.status = raw.status;
    for (const [key, receipt] of Object.entries(object(raw.receipts) ? raw.receipts : {})) {
      if (!/^[1-9]\d*$/.test(key) || !byEvent.has(Number(key))) continue;
      const safe = safeReceipt(receipt, byEvent.get(Number(key)), worker, byEvent, bindings, node.nodeId);
      if (safe) worker.receipts[key] = safe;
    }
    for (const key of ['pending', 'outgoingPending']) {
      const pending = raw[key], entry = byEvent.get(pending?.eventId);
      if (!object(pending) || !entry || (entry.submission ? entry.frame.fromBindingId : entry.frame.toBindingId) !== binding.id) continue;
      if (key === 'pending' && entry.submission || key === 'outgoingPending' && !entry.submission || pending.bindingRevision !== undefined && pending.bindingRevision !== binding.revision) continue;
      const safe = { eventId: pending.eventId };
      if (key === 'pending' && text(pending.inputId)) safe.inputId = pending.inputId;
      if (integer(pending.bindingRevision) && pending.bindingRevision === binding.revision) safe.bindingRevision = pending.bindingRevision;
      if (['submitting', 'forwarding', 'pending'].includes(pending.status)) safe.status = pending.status;
      if (entry.submission && pending.submissionId === entry.frame.id) safe.submissionId = pending.submissionId;
      worker[key] = safe;
    }
    workers.push(worker);
  }
  const toolReads = {};
  for (const entry of byEvent.values()) {
    const binding = Object.values(bindings).find(value => value.id === entry.frame.toBindingId && value.nodeId === node.nodeId);
    if (!binding) continue;
    const key = `${binding.id}:${entry.event.id}`;
    const safe = toolReadRecord(source.store.toolReads?.[key], key, entry, binding, node.nodeId);
    if (safe) toolReads[key] = safe;
  }
  const events = [...byEvent.values()].sort((a, b) => a.event.id - b.event.id).map(entry => entry.event);
  return { id: 'remote', label: 'Remote observation', available: true, error: null, observedAt: source.observedAt, generation: source.generation, node, events,
    store: { version: source.store.version, bindings, rooms, peers, inbox: scopedStoreRecords(source.store.inbox, byEvent, 'inbox', node, bindings), outbox: scopedStoreRecords(source.store.outbox, byEvent, 'outbox', node, bindings),
      ...(source.store.version === 2 ? { lifecycle } : {}),
      ...(Object.keys(toolReads).length ? { toolReads } : {}) }, workers, diagnostics: [] };
}

/** Pure scope reduction. Original local snapshots and their ledgers are never mutated. */
export function exportObservation(source, request) {
  try {
    const validated = validateObservationRequest(request);
    const envelope = { version: 1, type: 'viewer-observation', requestId: validated.requestId, source: scopeSource(source, validated) };
    bounded(envelope, MAX_OBSERVATION_BYTES); return envelope;
  } catch { fail(); }
}

/** SSH authentication is transport protection; nonce and full DTO rescoping are still mandatory. */
export function acceptObservation(envelope, request) {
  try {
    const received = bounded(envelope, MAX_OBSERVATION_BYTES), validated = validateObservationRequest(request);
    exact(envelope, ['version', 'type', 'requestId', 'source']);
    if (envelope.version !== 1 || envelope.type !== 'viewer-observation' || envelope.requestId !== validated.requestId) fail();
    if (!Array.isArray(envelope.source?.events) || envelope.source.events.length > MAX_OBSERVATION_EVENTS) fail();
    const scoped = exportObservation(envelope.source, validated);
    if (canonical(scoped) !== received) fail();
    return scoped.source;
  } catch { fail(); }
}
