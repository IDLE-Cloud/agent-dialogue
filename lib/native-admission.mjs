import { createHash } from 'node:crypto';

function uncertain(message) { return Object.assign(new Error(message), { uncertain: true }); }

/** A stable native input ID is scoped to the exact binding generation and ledger event. */
export function inputId(binding, eventId) {
  if (!binding || typeof binding.id !== 'string' || !binding.id || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw new Error('Invalid native admission binding.');
  if (!/^\d+$/.test(String(eventId))) throw new Error('Invalid native admission event ID.');
  return 'msg_' + createHash('sha256').update(`${binding.id}/${binding.revision}/${eventId}`).digest('hex').slice(0, 32);
}

function hasInput(value, id) {
  const items = Array.isArray(value) ? value : value?.data;
  return Array.isArray(items) && items.some(item => (item?.id || item?.info?.id || item?.message?.id) === id);
}

async function reconcile(client, binding, id, text) {
  if (typeof client.input === 'function') return Boolean(await client.input(binding.sessionId, id, { text }));
  if (hasInput(await client.inbox(binding.sessionId), id)) return true;
  return hasInput(await client.messages(binding.sessionId, { limit: 100 }), id);
}

async function requireReconciled(client, binding, id, text, { eventId, reconcileInput } = {}) {
  try {
    if (reconcileInput ? await reconcileInput({ client, binding, eventId, inputId: id, text }) === true : await reconcile(client, binding, id, text)) return;
  } catch { /* An unavailable lookup cannot establish that a submission was absent. */ }
  throw uncertain('Native submission outcome is unknown; preserve the pending event and pause before retrying.');
}

/**
 * Persist a submission intent before POST. A pending or uncertain input is only
 * reconciled, never POSTed again. The hcom ledger remains the body authority;
 * onPending receives control metadata only.
 */
export async function admit({ client, binding, eventId, pending = null, onPending, text, metadata = {}, beforeSubmit, onNotSubmitted, reconcileInput }) {
  const id = inputId(binding, eventId);
  if (typeof binding.sessionId !== 'string' || !binding.sessionId) throw new Error('Native admission requires an exact session ID.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Native admission requires nonempty text.');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid native admission metadata.');
  if ([beforeSubmit, onNotSubmitted, reconcileInput].some(hook => hook !== undefined && typeof hook !== 'function')) throw new Error('Invalid native admission hooks.');
  if (pending !== null && pending !== undefined) {
    if (String(pending.eventId) !== String(eventId) || pending.inputId !== id ||
        (pending.bindingRevision !== undefined && pending.bindingRevision !== binding.revision)) {
      throw uncertain('Another or stale native submission is pending; explicit reconciliation is required.');
    }
    await requireReconciled(client, binding, id, text, { eventId, reconcileInput });
    return { inputId: id, reconciled: true };
  }
  if (typeof onPending !== 'function') throw new Error('Native admission requires a durable onPending callback.');
  try { await onPending({ eventId, inputId: id, bindingRevision: binding.revision, status: 'submitting' }); }
  catch { throw uncertain('Native intent persistence failed before submission; pause for explicit recovery.'); }
  if (beforeSubmit) {
    try { await beforeSubmit({ client, binding, eventId, inputId: id, text, metadata }); }
    catch { throw uncertain('Native submission gate failed after intent persistence; preserve the pending input for explicit recovery.'); }
  }
  try {
    await client.prompt(binding.sessionId, { id, text, metadata });
    return { inputId: id, reconciled: false };
  } catch (error) {
    if (error?.notSubmitted === true) {
      if (onNotSubmitted) {
        try { await onNotSubmitted({ client, binding, eventId, inputId: id, text, metadata }); }
        catch { throw uncertain('Known native non-submission could not be durably recorded; preserve the pending input for explicit recovery.'); }
      }
      try { await onPending(null); }
      catch { throw uncertain('Native input was not submitted, but its pending intent could not be durably cleared; pause for explicit recovery.'); }
      throw error;
    }
    await requireReconciled(client, binding, id, text, { eventId, reconcileInput });
    return { inputId: id, reconciled: true };
  }
}
