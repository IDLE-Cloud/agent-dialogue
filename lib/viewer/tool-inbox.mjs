// Tool-pull evidence records a service response to the selected native session.
// It never proves durable native user input, model execution, or completion.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function target(entry, binding, nodeId) {
  return !entry.submission && object(entry.frame) && object(binding) && binding.harness === 'zcode-tools' && !binding.remote
    && text(nodeId) && binding.nodeId === nodeId && (!entry.wire || entry.wire.to.nodeId === nodeId)
    && binding.id === entry.frame.toBindingId && binding.alias === entry.frame.to && binding.revision === entry.frame.toRevision
    && text(binding.sessionId) && Number.isSafeInteger(entry.event?.id) && entry.event.id > 0;
}
function common(raw, entry, binding, nodeId) {
  return object(raw) && target(entry, binding, nodeId) && raw.sessionId === binding.sessionId && iso(raw.at)
    && (entry.wire ? raw.globalMessageId === entry.wire.messageId : !Object.hasOwn(raw, 'globalMessageId'));
}
export function toolAvailableReceipt(raw, entry, binding, nodeId) {
  if (!common(raw, entry, binding, nodeId) || raw.status !== 'tool-available' || Object.hasOwn(raw, 'inputId')) return null;
  const result = { status: 'tool-available', sessionId: binding.sessionId, at: raw.at };
  if (entry.wire) result.globalMessageId = entry.wire.messageId;
  return result;
}
export function toolReadRecord(raw, key, entry, binding, nodeId) {
  if (!common(raw, entry, binding, nodeId) || raw.status !== 'tool-read' || key !== `${binding.id}:${entry.event.id}`
    || raw.bindingId !== binding.id || raw.bindingRevision !== binding.revision || raw.eventId !== entry.event.id || raw.roomId !== entry.frame.room) return null;
  const result = { bindingId: binding.id, bindingRevision: binding.revision, sessionId: binding.sessionId,
    eventId: entry.event.id, roomId: entry.frame.room, status: 'tool-read', at: raw.at };
  if (entry.wire) result.globalMessageId = entry.wire.messageId;
  return result;
}
