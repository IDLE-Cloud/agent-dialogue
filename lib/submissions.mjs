import { randomUUID } from 'node:crypto';
import { readStore, validateAlias, validateRoute } from './bridge-store.mjs';
import { loadOrCreateNode } from './node-identity.mjs';
import { hcom } from './bridge.mjs';

const PREFIX = 'agent-dialogue/submit/1\n';
const MAX_ENCODED_BYTES = 120000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = prefix => new RegExp(`^${prefix}_${UUID}(?![\\s\\S])`);
const REQUEST_ID = ID('q'), ROOM_ID = ID('r'), BINDING_ID = ID('b');
const NODE_ID = /^n_[0-9a-f]{64}(?![\s\S])/;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/;
const KEYS = ['version', 'id', 'room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'expectedSession', 'replyTo', 'text'];
const IDENTITY_FIELDS = ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId', 'remote'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw new Error(message); }
function nonempty(value, label, maximum = 40000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) fail(`Invalid submission ${label}.`);
  return value;
}
function validateRequest(request) {
  if (!object(request) || Object.keys(request).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(request, key))) fail('Invalid submission fields.');
  if (request.version !== 1) fail('Unsupported submission version.');
  if (typeof request.id !== 'string' || !REQUEST_ID.test(request.id) || typeof request.room !== 'string' || !ROOM_ID.test(request.room) || typeof request.fromBindingId !== 'string' || !BINDING_ID.test(request.fromBindingId) || typeof request.toBindingId !== 'string' || !BINDING_ID.test(request.toBindingId)) fail('Invalid submission ID.');
  validateAlias(request.from); validateAlias(request.to);
  if (!ALIAS.test(request.from) || !ALIAS.test(request.to)) fail('Invalid submission alias.');
  if (request.from === 'operator' || request.to === 'operator' || request.from === request.to) fail('Submission requires two distinct agent bindings.');
  for (const key of ['fromRevision', 'toRevision']) {
    if (!Number.isSafeInteger(request[key]) || request[key] < 1) fail(`Invalid submission ${key}.`);
  }
  nonempty(request.expectedSession, 'expected session', 4096);
  nonempty(request.text, 'text');
  if (request.replyTo !== null) nonempty(request.replyTo, 'replyTo', 4096);
  return request;
}

/** One local mailbox per node; no network listener or native harness process. */
export function queueEndpoint(node) {
  if (typeof node?.nodeId !== 'string' || !NODE_ID.test(node.nodeId)) fail('Submission queue needs a valid local node identity.');
  return `submit${node.nodeId.slice(2, 18)}`;
}

export async function ensureSubmissionEndpoint(context, { hcomImpl = hcom } = {}) {
  const node = await loadOrCreateNode(context), endpoint = queueEndpoint(node);
  await hcomImpl(context, ['start', '--name', endpoint]);
  return endpoint;
}

export function isSubmission(text) { return typeof text === 'string' && text.startsWith(PREFIX); }

export function decodeSubmission(text) {
  if (!isSubmission(text)) fail('Unframed submission: expected agent-dialogue/submit/1 protocol.');
  if (Buffer.byteLength(text, 'utf8') > MAX_ENCODED_BYTES) fail('Encoded submission exceeds 120000 bytes.');
  let request;
  try { request = JSON.parse(text.slice(PREFIX.length)); }
  catch { fail('Invalid submission JSON.'); }
  return validateRequest(request);
}

/** Only local ledger I/O: the owning worker later runs the full delivery gates. */
export async function queueSubmission(context, { room, from, to, text, expectedSession, replyTo = null }, { hcomImpl = hcom } = {}) {
  if (from === 'operator') fail('Operator messages must use direct collab send.');
  const node = await loadOrCreateNode(context);
  const route = validateRoute(await readStore(context), { room, from, to, expectedSession, replyTo });
  if (route.from.remote || route.from.nodeId !== node.nodeId) fail('Cannot queue a submission on behalf of a different node.');
  const request = validateRequest({
    version: 1, id: `q_${randomUUID()}`, room, from, to,
    fromBindingId: route.from.id, toBindingId: route.to.id,
    fromRevision: route.from.revision, toRevision: route.to.revision,
    expectedSession: route.to.sessionId, replyTo, text,
  });
  const encoded = PREFIX + JSON.stringify(request);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENCODED_BYTES) fail('Encoded submission exceeds 120000 bytes.');
  const endpoint = queueEndpoint(node);
  await hcomImpl(context, ['start', '--name', endpoint]);
  const response = JSON.parse(await hcomImpl(context, ['send', '--json', '--name', route.from.hcomName, `@${endpoint}`, '--thread', room, '--intent', 'request', '--', encoded]));
  if (!Number.isSafeInteger(response?.event_id) || response.event_id < 1) fail('Submission append returned an invalid event ID; inspect the local ledger before retrying.');
  return { status: 'queued', submissionId: request.id, event_id: response.event_id };
}

/** Recheck the exact source snapshot and room pins before privileged dispatch. */
export function validateSubmission(store, binding, request, event) {
  validateRequest(request);
  const route = validateRoute(store, { room: request.room, from: request.from, to: request.to, expectedSession: request.expectedSession, replyTo: request.replyTo });
  if (!binding || route.from.remote || binding.remote || typeof binding.nodeId !== 'string' || !NODE_ID.test(binding.nodeId) || IDENTITY_FIELDS.some(key => binding[key] !== route.from[key])) fail('Submission source is remote, different or stale.');
  if (request.from !== binding.alias || request.fromBindingId !== route.from.id || request.fromRevision !== route.from.revision || request.toBindingId !== route.to.id || request.toRevision !== route.to.revision) fail('Submission has stale or mismatched binding IDs/revisions.');
  if (event?.type !== 'message' || event.data?.from !== route.from.hcomName || event.data?.sender_kind !== 'instance') fail('Submission hcom sender does not match the source binding.');
  if (!Array.isArray(event.data?.delivered_to) || !event.data.delivered_to.includes(queueEndpoint(binding))) fail('Submission event was not addressed to this node queue.');
  if (event.data.thread !== request.room || event.data.intent !== 'request') fail('Submission event room/intent does not match the request.');
  return { room: request.room, from: request.from, to: request.to, text: request.text, expectedSession: request.expectedSession, replyTo: request.replyTo };
}
