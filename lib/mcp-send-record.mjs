import { payloadHash } from './node-identity.mjs';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = prefix => new RegExp(`^${prefix}_${uuid}(?![\\s\\S])`);
const Q = id('q'), B = id('b'), R = id('r');
const HASH = /^[0-9a-f]{64}(?![\s\S])/, NODE = /^n_[0-9a-f]{64}(?![\s\S])/;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/, KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/;
const KEYS = ['version', 'bindingId', 'bindingRevision', 'roomId', 'requestKey', 'payloadHash', 'status', 'at', 'submissionId', 'submissionHash', 'pins'];
const IDENTITY = ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const text = value => typeof value === 'string' && value.trim() && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = () => { throw Object.assign(new Error('Invalid durable MCP send provenance; preserve the original request key and control state.'), { code: 'MCP_SEND_INVALID' }); };

function identity(value) {
  const keys = Object.hasOwn(value || {}, 'remote') ? [...IDENTITY, 'remote'] : IDENTITY;
  if (!exact(value, keys) || !matches(ALIAS, value.alias) || value.alias === 'operator' || !matches(B, value.id) || !positive(value.revision) || value.active !== true || !matches(NODE, value.nodeId) || !['harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName'].every(key => text(value[key])) || Object.hasOwn(value, 'remote') && typeof value.remote !== 'boolean') fail();
}
function pins(value, row) {
  if (!exact(value, ['from', 'to', 'room'])) fail();
  identity(value.from); identity(value.to);
  const room = value.room;
  if (!exact(room, ['id', 'name', 'members', 'revision', 'ownerNodeId', 'manifestHash']) || !matches(R, room.id) || !text(room.name) || !positive(room.revision) || !matches(NODE, room.ownerNodeId) || !matches(HASH, room.manifestHash) || !Array.isArray(room.members) || room.members.length < 2) fail();
  const aliases = new Set();
  for (const member of room.members) {
    if (!exact(member, ['alias', 'bindingId', 'revision', 'nodeId']) || !matches(ALIAS, member.alias) || member.alias === 'operator' || !matches(B, member.bindingId) || !positive(member.revision) || !matches(NODE, member.nodeId) || aliases.has(member.alias)) fail();
    aliases.add(member.alias);
  }
  if (value.from.remote || value.from.id === value.to.id || value.from.alias === value.to.alias || row.bindingId !== value.from.id || row.bindingRevision !== value.from.revision || row.roomId !== room.id) fail();
  for (const binding of [value.from, value.to]) {
    const member = room.members.find(member => member.alias === binding.alias);
    if (!member || member.bindingId !== binding.id || member.revision !== binding.revision || member.nodeId !== binding.nodeId) fail();
  }
}

/** Validate new fixed-q provenance without inventing provenance for historical
 * preparing records. It is pure and does not resolve routes or perform I/O. */
export function validateMcpSends(map) {
  if (map === undefined) return map;
  if (!object(map)) fail();
  for (const [key, row] of Object.entries(map)) {
    // Old stores did not define a send-record schema. Retain those observations
    // as historical data; only version 2 claims our durable recovery contract.
    if (row?.version !== 2) continue;
    if (!exact(row, row.status === 'queued' ? [...KEYS, 'result'] : KEYS) || !matches(HASH, key) || !matches(B, row.bindingId) || !positive(row.bindingRevision) || !matches(R, row.roomId) || !matches(KEY, row.requestKey) || !matches(HASH, row.payloadHash) || !['prepared', 'append-started', 'queued'].includes(row.status) || !iso(row.at) || !matches(Q, row.submissionId) || !matches(HASH, row.submissionHash)) fail();
    if (key !== payloadHash({ bindingId: row.bindingId, revision: row.bindingRevision, requestKey: row.requestKey })) fail();
    pins(row.pins, row);
    if (row.status === 'queued') {
      const result = row.result;
      const keys = Object.hasOwn(result || {}, 'dispatch') ? ['status', 'submissionId', 'event_id', 'requestKey', 'dispatch'] : ['status', 'submissionId', 'event_id', 'requestKey'];
      if (!exact(result, keys) || result.status !== 'queued' || result.submissionId !== row.submissionId || !positive(result.event_id) || result.requestKey !== row.requestKey || Object.hasOwn(result, 'dispatch') && result.dispatch !== 'paused') fail();
    }
  }
  return map;
}
