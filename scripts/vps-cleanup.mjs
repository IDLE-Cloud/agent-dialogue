/** Pure ownership check for interrupting only an active, test-owned Codex turn. */
import { inputId } from '../lib/native-admission.mjs';

const input = value => typeof value === 'string' && /^msg_[0-9a-f]{32}$/.test(value);
const eventId = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function ownedCodexActiveTurn({ threadId, thread, messages, inputIds = [], binding, worker } = {}) {
  if (typeof threadId !== 'string' || !threadId || thread?.id !== threadId || !Array.isArray(thread.turns) || !Array.isArray(messages) || !Array.isArray(inputIds)) return null;
  const active = thread.turns.filter(turn => turn?.status === 'inProgress');
  if (active.length !== 1 || typeof active[0].id !== 'string' || !active[0].id) return null;
  const owned = new Set(inputIds.filter(input));
  if (binding?.harness === 'codex-app-server' && binding.sessionId === threadId &&
      typeof binding.id === 'string' && binding.id && Number.isSafeInteger(binding.revision) && binding.revision > 0) {
    const matchesAdmission = (id, event) => input(id) && eventId(event) && id === inputId(binding, event);
    const pending = worker?.pending;
    if (pending?.bindingRevision === binding.revision && matchesAdmission(pending.inputId, pending.eventId)) owned.add(pending.inputId);
    for (const [event, receipt] of Object.entries(worker?.receipts || {})) {
      if (receipt?.status === 'admitted' && receipt.sessionId === threadId && matchesAdmission(receipt.inputId, event)) owned.add(receipt.inputId);
    }
  }
  // thread/read can expose the current turn before thread/items/list has indexed
  // it. Native item IDs differ from the caller's stable clientId.
  const direct = Array.isArray(active[0].items) ? active[0].items.filter(item => item?.type === 'userMessage') : [];
  if (direct.length) {
    if (direct.some(item => !input(item.clientId) || !owned.has(item.clientId))) return null;
    return { turnId: active[0].id, inputId: direct[0].clientId };
  }
  const users = messages.filter(item => item?.type === 'userMessage' && item.turnId === active[0].id);
  return users.length && users.every(user => owned.has(user.id)) ? { turnId: active[0].id, inputId: users[0].id } : null;
}
