// Local control metadata only. Never persist message bodies or native credentials.
export const FORWARDING_PHASES = Object.freeze(['prepared', 'append-started', 'local-stored', 'forwarded']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = prefix => new RegExp(`^${prefix}_${uuid}(?![\\s\\S])`);
const Q = id('q'), B = id('b'), R = id('r'), M = id('m');
const UUID = new RegExp(`^${uuid}(?![\\s\\S])`), HASH = /^[0-9a-f]{64}(?![\s\S])/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const fail = () => { throw Object.assign(new Error('Invalid forwarding provenance; preserve the original control state.'), { code: 'FORWARDING_INVALID' }); };
const KEYS = ['version', 'submissionId', 'submissionEventId', 'submissionHash', 'bindingId', 'bindingRevision', 'roomId', 'routeHash', 'kind', 'dispatchId', 'phase', 'frameHash', 'formalEventId', 'result', 'createdAt', 'messageId', 'payloadHash', 'recovery'];
function validResult(result, row) {
  if (row.kind === 'local') return exact(result, ['event_id']) && result.event_id === row.formalEventId;
  return exact(result, ['event_id', 'messageId', 'status', 'remoteEventId']) && result.event_id === row.formalEventId && result.messageId === row.messageId && result.status === 'remote-stored' && positive(result.remoteEventId);
}
export function validateForwardingRecord(row, key = row?.submissionId) {
  if (!exact(row, KEYS) || row.version !== 1 || !matches(Q, key) || row.submissionId !== key || !positive(row.submissionEventId) || !matches(HASH, row.submissionHash) || !matches(B, row.bindingId) || !positive(row.bindingRevision) || !matches(R, row.roomId) || !matches(HASH, row.routeHash) || !['local', 'remote'].includes(row.kind) || !matches(UUID, row.dispatchId) || !FORWARDING_PHASES.includes(row.phase) || !matches(HASH, row.frameHash) || !iso(row.createdAt)) fail();
  if (row.kind === 'local' ? row.messageId !== null || row.payloadHash !== null : !matches(M, row.messageId) || !matches(HASH, row.payloadHash)) fail();
  if (['prepared', 'append-started'].includes(row.phase) ? row.formalEventId !== null : !positive(row.formalEventId)) fail();
  if (row.phase === 'forwarded' ? !validResult(row.result, row) : row.result !== null) fail();
  if (row.recovery !== null) {
    const cp = row.recovery;
    if (row.phase !== 'forwarded' || !exact(cp, ['version', 'id', 'phase', 'preHash', 'postHash', 'pendingHash', 'ownerHash', 'lifecycleGeneration', 'lifecycleNonce', 'receipt']) || cp.version !== 1 || !matches(UUID, cp.id) || !['runtime-prepared', 'runtime-committed'].includes(cp.phase) || !['preHash', 'postHash', 'pendingHash', 'ownerHash'].every(key => matches(HASH, cp[key])) || !positive(cp.lifecycleGeneration) || !matches(UUID, cp.lifecycleNonce)) fail();
    const receipt = cp.receipt;
    if (!exact(receipt, ['status', 'submissionId', 'result', 'at']) || receipt.status !== 'forwarded' || receipt.submissionId !== row.submissionId || !iso(receipt.at) || !validResult(receipt.result, row) || JSON.stringify(receipt.result) !== JSON.stringify(row.result)) fail();
  }
  return row;
}
export function validateForwardings(map) {
  if (!object(map)) fail();
  for (const [key, row] of Object.entries(map)) validateForwardingRecord(row, key);
  return map;
}
