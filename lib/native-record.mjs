// Private native-input provenance only. Message text stays in the ledger and
// native history; this module performs no I/O or dynamic identity resolution.
export const NATIVE_PHASES = Object.freeze(['prepared', 'submit-started', 'not-submitted', 'admitted']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = prefix => new RegExp(`^${prefix}_${uuid}(?![\\s\\S])`);
const INPUT = /^msg_[0-9a-f]{32}(?![\s\S])/, BINDING = id('b'), ROOM = id('r'), MESSAGE = id('m');
const UUID = new RegExp(`^${uuid}(?![\\s\\S])`), HASH = /^[0-9a-f]{64}(?![\s\S])/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const fail = () => { throw Object.assign(new Error('Invalid native input provenance; preserve the original pending state.'), { code: 'NATIVE_INTENT_INVALID' }); };
const KEYS = ['version', 'inputId', 'eventId', 'bindingId', 'bindingRevision', 'roomId', 'eventHash', 'frameHash', 'bindingHash', 'routeHash', 'promptHash', 'rendererVersion', 'phase', 'attemptId', 'attempt', 'createdAt', 'receipt', 'recovery'];
const CHECKPOINT = ['version', 'id', 'phase', 'preHash', 'postHash', 'pendingHash', 'ownerHash', 'lifecycleGeneration', 'lifecycleNonce', 'receipt'];
const RECEIPT = ['status', 'inputId', 'reconciled', 'sessionId', 'at'];
function validReceipt(receipt, inputId) {
  const keys = Object.hasOwn(receipt || {}, 'globalMessageId') ? [...RECEIPT, 'globalMessageId'] : RECEIPT;
  return exact(receipt, keys) && receipt.status === 'admitted' && receipt.inputId === inputId && typeof receipt.reconciled === 'boolean' && text(receipt.sessionId) && iso(receipt.at) && (!Object.hasOwn(receipt, 'globalMessageId') || matches(MESSAGE, receipt.globalMessageId));
}
function equalReceipt(first, second) {
  return Object.keys(first).length === Object.keys(second).length && Object.keys(first).every(key => Object.hasOwn(second, key) && first[key] === second[key]);
}
export function validateNativeIntent(row, key = row?.inputId) {
  if (!exact(row, KEYS) || row.version !== 1 || !matches(INPUT, key) || row.inputId !== key || !positive(row.eventId) || !matches(BINDING, row.bindingId) || !positive(row.bindingRevision) || !matches(ROOM, row.roomId) || !['eventHash', 'frameHash', 'bindingHash', 'routeHash', 'promptHash'].every(field => matches(HASH, row[field])) || row.rendererVersion !== 1 || !NATIVE_PHASES.includes(row.phase) || !matches(UUID, row.attemptId) || !positive(row.attempt) || !iso(row.createdAt)) fail();
  if (row.phase !== 'admitted') {
    if (row.receipt !== null || row.recovery !== null) fail();
    return row;
  }
  if (!validReceipt(row.receipt, row.inputId)) fail();
  if (row.recovery !== null) {
    const checkpoint = row.recovery;
    if (!exact(checkpoint, CHECKPOINT) || checkpoint.version !== 1 || !matches(UUID, checkpoint.id) || !['runtime-prepared', 'runtime-committed'].includes(checkpoint.phase) || !['preHash', 'postHash', 'pendingHash', 'ownerHash'].every(field => matches(HASH, checkpoint[field])) || !positive(checkpoint.lifecycleGeneration) || !matches(UUID, checkpoint.lifecycleNonce) || !validReceipt(checkpoint.receipt, row.inputId) || !equalReceipt(checkpoint.receipt, row.receipt)) fail();
  }
  return row;
}
export function validateNativeIntents(map) {
  if (!object(map)) fail();
  for (const [key, row] of Object.entries(map)) validateNativeIntent(row, key);
  return map;
}
