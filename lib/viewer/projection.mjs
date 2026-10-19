import { createHash } from 'node:crypto';
import { decodeFrame } from '../bridge-store.mjs';
import { decodeSubmission, isSubmission } from '../submissions.mjs';
import { payloadHash, validatePublicNode, validateWireMessage, verifyObject } from '../node-identity.mjs';
import { toolAvailableReceipt, toolReadRecord } from './tool-inbox.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const values = value => object(value) ? Object.values(value) : [];
const string = value => typeof value === 'string' ? value : null;
const integer = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const unique = array => [...new Set(array)];
const sorted = array => unique(array).sort();
const STATUS_ORDER = ['queued', 'ledger-stored', 'forwarded', 'remote-stored', 'tool-available', 'tool-read', 'native-admitted', 'reply-linked', 'pending', 'unknown', 'rejected', 'conflict'];

/** Viewer IDs deliberately contain neither filesystem paths nor native session IDs. */
export function opaqueId(prefix, ...parts) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('base64url')}`;
}

function localKey(sourceId, eventId) { return JSON.stringify([sourceId, eventId]); }
function localMessageId(source, eventId) { return opaqueId('message', source.id, source.generation || null, eventId); }
function sourceGeneration(source) { return source.generation ? opaqueId('generation', source.generation) : null; }
function endpointEqual(a, b) {
  return a.bindingId === b.bindingId && a.revision === b.revision && a.nodeId === b.nodeId && a.alias === b.alias;
}
function reversed(parent, child) { return endpointEqual(parent.from, child.to) && endpointEqual(parent.to, child.from); }
function issue(message, code) { if (!message.issues.includes(code)) message.issues.push(code); }
function status(message, value) { if (!message.statuses.includes(value)) message.statuses.push(value); }
function evidence(message, record) { message.evidence.push(record); }

function identity(source, pin) {
  const binding = values(source.store?.bindings).find(item => item?.id === pin.bindingId && item.revision === pin.revision && item.alias === pin.alias && (!pin.nodeId || !item.nodeId || pin.nodeId === item.nodeId));
  // Peer cards describe pinned identity; only the owning source observes live registration.
  const ownsBinding = binding && !binding.remote && (!binding.nodeId || binding.nodeId === source.node?.nodeId);
  return {
    alias: string(pin.alias), nodeId: string(pin.nodeId) || string(binding?.nodeId) || (binding && !binding.remote || pin.bindingId === 'operator' ? string(source.node?.nodeId) : null),
    bindingId: string(pin.bindingId), revision: integer(pin.revision),
    harness: string(binding?.harness), sessionId: string(binding?.sessionId),
    active: ownsBinding && typeof binding.active === 'boolean' ? binding.active : null,
  };
}

function sourceRoom(source, roomId) {
  const room = object(source.store?.rooms) ? source.store.rooms[roomId] : null;
  return object(room) && room.id === roomId ? room : null;
}

function roomDescriptor(source, frame, wire = null) {
  const record = sourceRoom(source, frame.room);
  const framePinsMatch = !frame.from || ['from', 'to'].every(side => frame[side] === 'operator' || list(record?.members).some(pin => pin.alias === frame[side] && pin.bindingId === frame[`${side}BindingId`] && pin.revision === frame[`${side}Revision`]));
  const sealed = wire || (framePinsMatch && integer(record?.revision) && typeof record?.manifestHash === 'string' ? record : null);
  const revision = sealed ? (wire?.roomRevision || sealed.revision) : null;
  const manifestHash = sealed ? string(sealed.manifestHash) : null;
  const id = sealed ? opaqueId('room', frame.room, revision, manifestHash) : opaqueId('room', source.id, frame.room);
  const participants = list(record?.members).map(pin => identity(source, pin)), issues = [];
  if (record && !framePinsMatch) issues.push('room-pins-mismatch');
  if (wire && record?.manifestHash && (record.manifestHash !== wire.manifestHash || record.revision !== wire.roomRevision)) issues.push('room-manifest-mismatch');
  return { id, name: string(record?.name) || frame.room, roomId: frame.room, revision, manifestHash, sourceIds: [source.id], participants, messageCount: 0, lastActivity: null, issues };
}

function framePin(source, frame, side) {
  const alias = frame[side], bindingId = frame[`${side}BindingId`], revision = frame[`${side}Revision`];
  const pin = list(sourceRoom(source, frame.room)?.members).find(member => member?.alias === alias && member.bindingId === bindingId && member.revision === revision);
  return { alias, bindingId, revision, nodeId: string(pin?.nodeId) };
}

function wireFrame(frame) {
  if (!frame.wireEnvelope && !frame.globalMessageId && !frame.replyToMessageId) return null;
  const p = validateWireMessage(frame.wireEnvelope?.payload);
  const checks = [frame.globalMessageId === p.messageId, frame.room === p.roomId, frame.from === p.from.alias, frame.to === p.to.alias,
    frame.fromBindingId === p.from.bindingId, frame.toBindingId === p.to.bindingId, frame.fromRevision === p.from.revision,
    frame.toRevision === p.to.revision, frame.text === p.text, frame.replyToMessageId === p.replyToMessageId];
  if (checks.some(value => !value) || typeof frame.wireEnvelope.signature !== 'string') throw new Error('wire-wrapper-mismatch');
  return p;
}

function rawEndpoint(source, endpoint) {
  const binding = values(source.store?.bindings).find(item => typeof endpoint === 'string' && item?.hcomName === endpoint);
  return binding ? identity(source, { alias: binding.alias, bindingId: binding.id, revision: binding.revision, nodeId: binding.nodeId })
    : { alias: string(endpoint) || 'unknown', nodeId: null, bindingId: null, revision: null, harness: 'hcom', sessionId: null, active: null };
}

function normalizeRaw(source, event) {
  const thread = string(event.data?.thread) || 'unthreaded';
  const room = { id: opaqueId('room', 'hcom', source.id, thread), name: `hcom · ${thread}`, roomId: thread, revision: null, manifestHash: null,
    sourceIds: [source.id], participants: [], messageCount: 0, lastActivity: null, issues: [] };
  const recipients = sorted(list(event.data?.delivered_to).filter(value => typeof value === 'string')).map(endpoint => rawEndpoint(source, endpoint));
  const to = recipients.length === 1 ? recipients[0] : { alias: recipients.length ? `${recipients.length} recipients` : 'unknown', nodeId: null, bindingId: null, revision: null, harness: 'hcom', sessionId: null, active: null };
  const message = { id: localMessageId(source, event.id), roomId: room.id, text: event.data.text,
    from: rawEndpoint(source, event.data.from), to, recipients, timestamp: timestamp(event.timestamp), kind: 'message', transport: 'hcom', statuses: ['ledger-stored'],
    replyTo: null, evidence: [{ type: 'ledger', sourceId: source.id, sourceGeneration: sourceGeneration(source), localEventId: event.id, status: 'ledger-stored', at: timestamp(event.timestamp), transport: 'hcom' }], sourceIds: [source.id], issues: [] };
  const candidate = event.data.reply_to_local ?? event.data.reply_to;
  const rawReply = integer(candidate) || (typeof candidate === 'string' && /^\d+$/.test(candidate) ? integer(Number(candidate)) : null);
  return { message, source, event, room, frame: null, wire: null, submission: false, rawReply: rawReply ? String(rawReply) : null,
    orderEvents: [{ sourceId: source.id, eventId: event.id, origin: false }] };
}

function normalize(source, event, keys) {
  const body = event.data?.text;
  if (event.type !== 'message' || typeof body !== 'string') return null;
  if (!body.startsWith('agent-dialogue/')) return normalizeRaw(source, event);
  const base = {
    id: localMessageId(source, event.id), roomId: null, text: '', from: {}, to: {},
    timestamp: timestamp(event.timestamp), kind: 'message', transport: 'agent-dialogue', statuses: ['ledger-stored'], replyTo: null,
    evidence: [{ type: 'ledger', sourceId: source.id, sourceGeneration: sourceGeneration(source), localEventId: event.id, status: 'ledger-stored', at: timestamp(event.timestamp) }],
    sourceIds: [source.id], issues: [],
  };
  try {
    const submission = isSubmission(body), frame = submission ? decodeSubmission(body) : decodeFrame(body), wire = submission ? null : wireFrame(frame);
    const room = roomDescriptor(source, frame, wire);
    base.issues.push(...room.issues);
    base.roomId = room.id; base.text = frame.text; base.kind = submission ? 'submission' : 'message';
    base.from = identity(source, wire?.from || framePin(source, frame, 'from'));
    base.to = identity(source, wire?.to || framePin(source, frame, 'to'));
    if (submission) {
      base.statuses = ['queued']; base.evidence[0].status = 'queued'; base.evidence[0].type = 'submission';
      base.evidence[0].submissionId = frame.id;
      base.evidence[0].expectedSession = frame.expectedSession;
    }
    if (wire) {
      base.evidence[0].messageId = wire.messageId;
      base.evidence[0].payloadHash = payloadHash(wire);
      const key = keys.get(wire.from.nodeId);
      if (key) {
        try { verifyObject(frame.wireEnvelope, key); base.evidence[0].signature = 'verified'; }
        catch { base.evidence[0].signature = 'invalid'; issue(base, 'wire-signature-invalid'); }
      } else base.evidence[0].signature = 'not-collected';
      if (source.node?.nodeId === wire.to.nodeId) status(base, 'remote-stored');
    }
    return { message: base, source, event, frame, wire, room, submission, orderEvents: [{ sourceId: source.id, eventId: event.id, origin: wire?.from.nodeId === source.node?.nodeId }] };
  } catch {
    const roomId = string(event.data?.thread) || 'unclassified';
    const room = { id: opaqueId('room', source.id, roomId), name: sourceRoom(source, roomId)?.name || roomId, roomId, revision: null, manifestHash: null, sourceIds: [source.id], participants: [], messageCount: 0, lastActivity: null, issues: ['malformed-record'] };
    base.roomId = room.id; base.kind = 'malformed'; base.text = '无法解析该 agent-dialogue 协议记录。';
    base.statuses = []; base.issues = ['malformed-record']; base.evidence[0].status = 'unparsed';
    return { message: base, source, event, frame: null, wire: null, room, submission: false, orderEvents: [{ sourceId: source.id, eventId: event.id, origin: false }] };
  }
}

function mergeIdentity(a, b, message) {
  for (const key of ['harness', 'sessionId']) {
    if (a[key] && b[key] && a[key] !== b[key]) issue(message, 'identity-metadata-conflict');
    else if (!a[key]) a[key] = b[key];
  }
  // These fields describe the current registration, never historical delivery success.
  if (a.active === null) a.active = b.active;
  else if (b.active !== null && a.active !== b.active) a.active = null;
}

function merge(target, other) {
  target.message.evidence.push(...other.message.evidence);
  target.message.sourceIds = sorted([...target.message.sourceIds, ...other.message.sourceIds]);
  target.message.statuses = unique([...target.message.statuses, ...other.message.statuses]);
  target.message.issues = unique([...target.message.issues, ...other.message.issues]);
  mergeIdentity(target.message.from, other.message.from, target.message);
  mergeIdentity(target.message.to, other.message.to, target.message);
  target.orderEvents.push(...other.orderEvents);
}

function exactQueueResult(queue, target, byLocal) {
  const a = queue.frame, b = target.frame;
  if (!b || target.submission || queue.message.roomId !== target.message.roomId) return false;
  if (['room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text'].some(key => a[key] !== b[key])) return false;
  if (target.message.to.sessionId && target.message.to.sessionId !== a.expectedSession) return false;
  if (!target.wire) return a.replyTo === b.replyTo;
  let reference = a.replyTo;
  if (reference && /^\d+$/.test(reference)) reference = byLocal.get(localKey(queue.source.id, Number(reference)))?.wire?.messageId;
  return (reference || null) === target.wire.replyToMessageId;
}

function attachRecords(entry, original) {
  const { source, event, wire } = original, message = entry.message;
  const binding = values(source.store?.bindings).find(value => value.id === original.frame?.toBindingId && value.nodeId === source.node?.nodeId);
  for (const worker of list(source.workers)) {
    const receipt = object(worker.receipts) ? worker.receipts[event.id] : null;
    const receiptBinding = original.submission ? original.message.from.bindingId : original.message.to.bindingId;
    if (object(receipt) && worker.bindingId === receiptBinding) {
      if (receipt.status === 'admitted') {
        if (original.message.to.harness !== 'zcode-tools' && binding?.harness !== 'zcode-tools' && !original.submission && typeof receipt.inputId === 'string' && receipt.inputId && (!receipt.sessionId || !message.to.sessionId || receipt.sessionId === message.to.sessionId) && (!receipt.globalMessageId || receipt.globalMessageId === wire?.messageId)) {
          status(message, 'native-admitted');
          evidence(message, { type: 'worker-receipt', sourceId: source.id, localEventId: event.id, bindingId: worker.bindingId, status: 'native-admitted', inputId: receipt.inputId, sessionId: string(receipt.sessionId), at: timestamp(receipt.at) });
        } else issue(message, 'invalid-admission-receipt');
      } else if (receipt.status === 'tool-available') {
        const safe = toolAvailableReceipt(receipt, original, binding, source.node?.nodeId);
        if (safe) {
          status(message, 'tool-available');
          evidence(message, { type: 'worker-receipt', sourceId: source.id, localEventId: event.id, bindingId: binding.id, ...safe,
            detail: '消息可由绑定的原生会话通过工具读取；不证明原生持久输入或模型执行。' });
        } else issue(message, 'invalid-tool-availability-receipt');
      } else if (receipt.status === 'rejected') {
        status(message, 'rejected');
        evidence(message, { type: 'worker-receipt', sourceId: source.id, localEventId: event.id, bindingId: worker.bindingId, status: 'rejected', at: timestamp(receipt.at) });
      }
    }
    for (const key of ['pending', 'outgoingPending']) {
      const pending = worker[key];
      const expectedBinding = original.submission ? message.from.bindingId : message.to.bindingId;
      if (pending?.eventId === event.id && worker.bindingId === expectedBinding) {
        if (pending.bindingRevision && pending.bindingRevision !== (original.submission ? message.from.revision : message.to.revision)) { issue(message, 'pending-binding-revision-mismatch'); continue; }
        status(message, 'pending');
        evidence(message, { type: key === 'pending' ? 'native-pending' : 'forward-pending', sourceId: source.id, localEventId: event.id, bindingId: worker.bindingId, status: 'pending', inputId: string(pending.inputId) });
      }
    }
  }
  if (!original.submission && binding) {
    const key = `${binding.id}:${event.id}`, raw = source.store?.toolReads?.[key];
    if (raw) {
      const safe = toolReadRecord(raw, key, original, binding, source.node?.nodeId);
      if (safe) {
        status(message, 'tool-read');
        evidence(message, { type: 'tool-inbox-read', sourceId: source.id, localEventId: event.id, ...safe,
          detail: '准确的原生会话发起工具读取，服务端已提供此消息；不证明原生持久输入或模型已读完成。' });
      } else issue(message, 'invalid-tool-read-evidence');
    }
  }
  if (!wire) return;
  const expectedHash = payloadHash(wire);
  for (const kind of ['inbox', 'outbox']) {
    const record = object(source.store?.[kind]) ? source.store[kind][wire.messageId] : null;
    if (!object(record)) continue;
    const nodeField = kind === 'outbox' ? 'peerNodeId' : 'senderNodeId';
    const expectedNode = kind === 'outbox' ? wire.to.nodeId : wire.from.nodeId;
    if (record.payloadHash !== expectedHash || record.roomId !== wire.roomId || record[nodeField] !== expectedNode || (record.eventId && record.eventId !== event.id)) {
      issue(message, `${kind}-record-mismatch`); continue;
    }
    const allowed = kind === 'outbox' ? ['preparing', 'queued', 'unknown', 'remote-stored'] : ['preparing', 'stored', 'native-admitted'];
    if (!allowed.includes(record.status)) { issue(message, `${kind}-status-unsupported`); continue; }
    evidence(message, { type: `${kind}-record`, sourceId: source.id, localEventId: event.id, messageId: wire.messageId,
      status: record.status, payloadHash: expectedHash, remoteEventId: integer(record.remoteEventId),
      inputId: string(record.inputId), sessionId: string(record.sessionId) });
    if (record.status === 'remote-stored' || (kind === 'inbox' && record.status === 'stored')) status(message, 'remote-stored');
    if (record.status === 'native-admitted') {
      status(message, 'remote-stored');
      if (original.message.to.harness !== 'zcode-tools' && binding?.harness !== 'zcode-tools' && typeof record.inputId === 'string' && record.inputId && (!record.sessionId || !message.to.sessionId || record.sessionId === message.to.sessionId)) status(message, 'native-admitted');
      else issue(message, 'invalid-admission-receipt');
    }
    if (record.status === 'unknown') status(message, 'unknown');
    if (record.status === 'preparing') status(message, 'pending');
  }
}

function linkReply(entry, candidates) {
  const message = entry.message;
  if (!candidates.length) {
    message.replyTo.missing = true; message.replyTo.reason = 'not-collected'; return;
  }
  const valid = candidates.filter(parent => parent !== entry && parent.message.roomId === message.roomId && reversed(parent.message, message));
  if (valid.length !== 1) {
    message.replyTo.missing = true; message.replyTo.reason = valid.length ? 'ambiguous-parent' : 'room-or-participant-mismatch';
    issue(message, 'reply-reference-mismatch'); return;
  }
  message.replyTo.id = valid[0].message.id; message.replyTo.missing = false;
  status(valid[0].message, 'reply-linked');
}

function orderMessages(entries, diagnostics) {
  const byId = new Map(entries.map(entry => [entry.message.id, entry]));
  const outgoing = new Map(entries.map(entry => [entry.message.id, new Set()]));
  const indegree = new Map(entries.map(entry => [entry.message.id, 0]));
  const add = (a, b) => { if (a !== b && !outgoing.get(a).has(b)) { outgoing.get(a).add(b); indegree.set(b, indegree.get(b) + 1); } };
  const sourceOrders = new Map();
  for (const entry of entries) {
    const ordered = [...entry.orderEvents].sort((a, b) => Number(b.origin) - Number(a.origin) || a.sourceId.localeCompare(b.sourceId) || a.eventId - b.eventId);
    const canonical = ordered[0];
    if (canonical) {
      if (!sourceOrders.has(canonical.sourceId)) sourceOrders.set(canonical.sourceId, []);
      sourceOrders.get(canonical.sourceId).push({ entry, eventId: canonical.eventId });
    }
    if (entry.message.replyTo?.id && byId.has(entry.message.replyTo.id)) add(entry.message.replyTo.id, entry.message.id);
  }
  for (const order of sourceOrders.values()) {
    order.sort((a, b) => a.eventId - b.eventId || a.entry.message.id.localeCompare(b.entry.message.id));
    for (let i = 1; i < order.length; i++) add(order[i - 1].entry.message.id, order[i].entry.message.id);
  }
  const compare = (a, b) => (Date.parse(a.message.timestamp) || 0) - (Date.parse(b.message.timestamp) || 0) || a.message.id.localeCompare(b.message.id);
  // A binary heap keeps the 10k-message fixture bounded even with many unrelated sources.
  const heap = [];
  const push = entry => { heap.push(entry); let i = heap.length - 1; while (i) { const parent = (i - 1) >> 1; if (compare(heap[parent], heap[i]) <= 0) break; [heap[parent], heap[i]] = [heap[i], heap[parent]]; i = parent; } };
  const pop = () => { const first = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++; if (compare(heap[i], heap[child]) <= 0) break; [heap[i], heap[child]] = [heap[child], heap[i]]; i = child; } } return first; };
  for (const entry of entries) if (!indegree.get(entry.message.id)) push(entry);
  const result = [];
  while (heap.length) {
    const entry = pop(); result.push(entry);
    for (const id of outgoing.get(entry.message.id)) { indegree.set(id, indegree.get(id) - 1); if (!indegree.get(id)) push(byId.get(id)); }
  }
  if (result.length < entries.length) {
    const seen = new Set(result.map(entry => entry.message.id));
    const rest = entries.filter(entry => !seen.has(entry.message.id)).sort(compare);
    for (const entry of rest) issue(entry.message, 'ordering-cycle');
    diagnostics.push({ code: 'ordering-cycle', count: rest.length }); result.push(...rest);
  }
  return result;
}

/** Pure, rebuildable projection. No filesystem, process, native API, or communication mutations. */
export function projectSources(input) {
  const sources = list(input).filter(source => object(source) && typeof source.id === 'string');
  const diagnostics = [], keys = new Map(), sourceSummaries = [];
  for (const source of sources) {
    if (source.node) { try { const node = validatePublicNode(source.node); keys.set(node.nodeId, node.publicKey); } catch { diagnostics.push({ sourceId: source.id, code: 'invalid-public-node' }); } }
    for (const peer of values(source.store?.peers)) {
      try { const node = validatePublicNode({ nodeId: peer.nodeId, name: peer.name, publicKey: peer.publicKey }); keys.set(node.nodeId, node.publicKey); }
      catch { diagnostics.push({ sourceId: source.id, code: 'invalid-peer-public-node' }); }
    }
    sourceSummaries.push({ id: source.id, label: string(source.label) || source.id, available: source.available === true,
      observedAt: timestamp(source.observedAt), generation: sourceGeneration(source),
      error: source.error ? 'source-read-failed' : null,
      node: source.node ? { nodeId: string(source.node.nodeId), name: string(source.node.name) } : null,
      eventCount: list(source.events).length,
      workers: list(source.workers).map(worker => ({ bindingId: string(worker.bindingId), status: ['starting', 'ready', 'stopped', 'error'].includes(worker.status) ? worker.status : 'unknown', cursor: Number.isSafeInteger(worker.cursor) ? worker.cursor : null, hasError: Boolean(worker.error) })) });
    if (!source.available) diagnostics.push({ sourceId: source.id, code: 'source-unavailable' });
    if (list(source.diagnostics).length) diagnostics.push({ sourceId: source.id, code: 'source-diagnostics', count: source.diagnostics.length });
  }
  const originals = [], byLocal = new Map(), roomMap = new Map();
  const registerRoom = room => {
    const previous = roomMap.get(room.id);
    if (previous) {
      previous.sourceIds = sorted([...previous.sourceIds, ...room.sourceIds]); previous.issues = unique([...previous.issues, ...room.issues]);
      if (previous.name !== room.name) previous.issues = unique([...previous.issues, 'room-name-conflict']);
      for (const participant of room.participants) {
        const existing = previous.participants.find(other => endpointEqual(other, participant));
        if (existing) mergeIdentity(existing, participant, previous);
        else previous.participants.push({ ...participant });
      }
    }
    else roomMap.set(room.id, room);
  };
  for (const source of sources) {
    for (const room of values(source.store?.rooms)) {
      if (!room?.id) continue;
      registerRoom(roomDescriptor(source, { room: room.id }));
    }
    const seen = new Set();
    for (const event of list(source.events).filter(event => integer(event?.id)).sort((a, b) => a.id - b.id)) {
      if (seen.has(event.id)) { diagnostics.push({ sourceId: source.id, code: 'duplicate-local-event', localEventId: event.id }); continue; }
      seen.add(event.id);
      const entry = normalize(source, event, keys);
      if (!entry) continue;
      originals.push(entry); byLocal.set(localKey(source.id, event.id), entry); registerRoom(entry.room);
    }
  }
  const representatives = new Map(originals.map(entry => [entry, entry]));
  const candidates = new Map();
  for (const entry of originals) if (entry.wire) {
    const key = JSON.stringify([entry.wire.from.nodeId, entry.wire.messageId]);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(entry);
  }
  for (const [candidate, entries] of candidates) {
    const groups = new Map();
    for (const entry of entries) {
      const variant = payloadHash({ payload: entry.wire, signature: entry.frame.wireEnvelope.signature });
      if (!groups.has(variant)) groups.set(variant, []);
      groups.get(variant).push(entry);
    }
    for (const [variant, copies] of groups) {
      copies.sort((a, b) => a.source.id.localeCompare(b.source.id) || a.event.id - b.event.id);
      const main = copies[0]; main.message.id = opaqueId('message', 'wire', candidate, variant);
      for (const copy of copies.slice(1)) { merge(main, copy); representatives.set(copy, main); }
      if (groups.size > 1) { issue(main.message, 'wire-message-conflict'); status(main.message, 'conflict'); }
    }
  }
  const queueIDs = new Map();
  for (const queue of originals.filter(entry => entry.submission)) {
    const key = JSON.stringify([queue.source.id, queue.frame.id]);
    if (!queueIDs.has(key)) queueIDs.set(key, []);
    queueIDs.get(key).push(queue);
  }
  for (const queues of queueIDs.values()) if (queues.length > 1) for (const queue of queues) issue(queue.message, 'duplicate-submission-id');
  for (const queue of originals.filter(entry => entry.submission)) {
    const matching = [];
    for (const worker of list(queue.source.workers)) {
      const receipt = worker.receipts?.[queue.event.id];
      if (worker.bindingId !== queue.frame.fromBindingId || receipt?.status !== 'forwarded') continue;
      if (receipt.submissionId !== queue.frame.id || !integer(receipt.result?.event_id)) { issue(queue.message, 'invalid-forwarded-receipt'); continue; }
      const target = byLocal.get(localKey(queue.source.id, receipt.result.event_id));
      if (!target) {
        status(queue.message, 'forwarded'); issue(queue.message, 'forwarded-result-not-collected');
        evidence(queue.message, { type: 'forwarded-receipt', sourceId: queue.source.id, localEventId: queue.event.id, bindingId: worker.bindingId,
          status: 'forwarded', submissionId: queue.frame.id, resultEventId: receipt.result.event_id, messageId: string(receipt.result.messageId), at: timestamp(receipt.at) });
        continue;
      }
      if (!exactQueueResult(queue, target, byLocal) || (receipt.result.messageId && receipt.result.messageId !== target.wire?.messageId)) { issue(queue.message, 'forwarded-result-mismatch'); continue; }
      matching.push({ target: representatives.get(target), receipt, worker });
    }
    if (new Set(matching.map(item => item.target)).size > 1) { issue(queue.message, 'ambiguous-forwarded-result'); continue; }
    if (matching.length) {
      const { target, receipt, worker } = matching[0];
      target.message.evidence.push(...queue.message.evidence); target.message.issues = unique([...target.message.issues, ...queue.message.issues]);
      status(target.message, 'queued'); status(target.message, 'forwarded');
      evidence(target.message, { type: 'forwarded-receipt', sourceId: queue.source.id, localEventId: queue.event.id, bindingId: worker.bindingId,
        status: 'forwarded', submissionId: queue.frame.id, resultEventId: receipt.result.event_id, messageId: string(receipt.result.messageId), at: timestamp(receipt.at) });
      representatives.set(queue, target);
    }
  }
  for (const original of originals) attachRecords(representatives.get(original), original);
  const entries = unique([...representatives.values()]);
  const wireByID = new Map();
  for (const entry of entries) if (entry.wire) {
    if (!wireByID.has(entry.wire.messageId)) wireByID.set(entry.wire.messageId, []);
    wireByID.get(entry.wire.messageId).push(entry);
  }
  for (const entry of entries) {
    const reference = entry.wire?.replyToMessageId || entry.frame?.replyTo || entry.rawReply;
    if (!reference) continue;
    entry.message.replyTo = { id: null, reference: String(reference), missing: true };
    if (/^\d+$/.test(reference)) {
      const parent = byLocal.get(localKey(entry.source.id, Number(reference)));
      linkReply(entry, parent ? [representatives.get(parent)] : []);
    } else if (String(reference).startsWith('m_')) linkReply(entry, wireByID.get(reference) || []);
    else entry.message.replyTo.reason = 'unsupported-reference';
  }
  const ordered = orderMessages(entries, diagnostics);
  for (const entry of ordered) {
    const message = entry.message, room = roomMap.get(message.roomId);
    room.messageCount++; room.sourceIds = sorted([...room.sourceIds, ...message.sourceIds]);
    if (message.timestamp && (!room.lastActivity || Date.parse(message.timestamp) > Date.parse(room.lastActivity))) room.lastActivity = message.timestamp;
    room.issues = unique([...room.issues, ...message.issues]);
    for (const participant of [message.from, ...(message.recipients || [message.to])]) {
      if (!participant.bindingId && (!participant.alias || participant.alias === 'unknown')) continue;
      if (!room.participants.some(other => endpointEqual(other, participant))) room.participants.push({ ...participant });
    }
    message.statuses.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
    message.issues.sort();
    message.evidence.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || (a.localEventId || 0) - (b.localEventId || 0) || a.type.localeCompare(b.type));
  }
  return { sources: sourceSummaries, rooms: [...roomMap.values()].sort((a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0) || a.id.localeCompare(b.id)), messages: ordered.map(entry => entry.message), diagnostics };
}
