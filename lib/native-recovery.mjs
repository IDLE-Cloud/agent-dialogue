import { randomUUID, createHash } from 'node:crypto';
import { readStore, resolveBinding, validateRoute, decodeFrame } from './bridge-store.mjs';
import { eventById, locked, processEvidence, saveRuntime, validateDelivery, validateNative } from './bridge.mjs';
import { withNative } from './adapters.mjs';
import { admit, inputId } from './native-admission.mjs';
import { nativeInputEvidence } from './native-proof.mjs';
import { validateNativeIntent } from './native-record.mjs';
import { payloadHash } from './node-identity.mjs';
import { lifecycleState, requireEnabled, withDispatch } from './lifecycle.mjs';
import { stoppedRuntimeForRecovery } from './recovery.mjs';

const clone = value => structuredClone(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = state => Buffer.from(JSON.stringify(state, null, 2) + '\n');
const exact = (a, b) => payloadHash(a) === payloadHash(b);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const uncertain = () => { throw Object.assign(new Error('Native input outcome requires exact evidence review; preserve the original pending input.'), { code: 'NATIVE_RECOVERY_NEEDS_REVIEW', uncertain: true }); };
const review = (reason, eventId, id) => ({ status: 'needs-review', reason, eventId, inputId: id, runtimeChanged: false });
const immutableKeys = ['version', 'inputId', 'eventId', 'bindingId', 'bindingRevision', 'roomId', 'eventHash', 'frameHash', 'bindingHash', 'routeHash', 'promptHash', 'rendererVersion', 'attemptId', 'attempt', 'createdAt'];
const immutable = row => Object.fromEntries(immutableKeys.map(key => [key, row[key]]));
function v4(store) {
  if (store.version !== 4) fail('NATIVE_UPGRADE_REQUIRED', 'Native provenance requires explicit offline state upgrade --target 4.');
}
function selectEvent(eventId) {
  if (!Number.isSafeInteger(eventId) || eventId < 1) fail('NATIVE_SELECTION_INVALID', 'Select one exact positive local event ID.');
}
function localBinding(store, alias) {
  const binding = resolveBinding(store, alias);
  if (binding.remote) fail('NATIVE_SELECTION_INVALID', 'Inspect this native binding on its owning node.');
  return binding;
}
function routeHash(store, binding, frame) {
  return payloadHash(validateRoute(store, { room: frame.room, from: frame.from, to: frame.to, expectedSession: binding.sessionId }));
}
async function delivery(context, store, binding, frame, event) {
  if (!Number.isSafeInteger(event?.id) || event.id < 1 || event.type !== 'message' || !exact(decodeFrame(event.data?.text || ''), frame) || event.data.thread !== frame.room || !Array.isArray(event.data.delivered_to) || event.data.delivered_to.length !== 1 || event.data.delivered_to[0] !== binding.hcomName) uncertain();
  // Signed node ingress has its own external/inform ledger wrapper. Its exact
  // sender, signature and metadata are checked by validateDelivery/Ingress.
  if (!frame.wireEnvelope && (event.data.intent !== (frame.replyTo === null ? 'request' : 'ack') || event.data.sender_kind !== (frame.from === 'operator' ? 'external' : 'instance'))) uncertain();
  await validateDelivery(context, store, binding, frame, event);
  ingressRecord(store, binding, event, frame);
}
function currentIntent(store, binding, row, { outcome = false } = {}) {
  v4(store);
  const current = store.nativeIntents[row.inputId];
  if (!current || !exact(immutable(current), immutable(row)) || outcome && !exact(current, row) || binding.id !== row.bindingId || binding.revision !== row.bindingRevision || payloadHash(resolveBinding(store, binding.alias)) !== row.bindingHash) uncertain();
  validateNativeIntent(current); return current;
}
function workerGate(store, binding, state) {
  requireEnabled(store, binding);
  const launch = store.workerLaunches?.[binding.id];
  if (launch?.version !== 1 || launch.phase !== 'ready' || launch.bindingRevision !== binding.revision || launch.token !== state.token || launch.pid !== state.pid || !Number.isSafeInteger(state.pid) || state.pid < 2) fail('WORKER_OWNER_UNVERIFIED', 'Native admission requires the matching ready worker reservation.');
}
function pendingMatches(pending, row) {
  return pending && Object.keys(pending).length === 4 && pending.eventId === row.eventId && pending.inputId === row.inputId && pending.bindingRevision === row.bindingRevision && pending.status === 'submitting';
}
function ingressRecord(store, binding, event, frame) {
  if (!frame.wireEnvelope) return null;
  const record = store.inbox?.[frame.globalMessageId];
  if (!record || record.eventId !== event.id || record.payloadHash !== payloadHash(frame.wireEnvelope.payload) || record.senderNodeId !== frame.wireEnvelope.payload.from.nodeId || record.roomId !== frame.room || !['stored', 'native-admitted'].includes(record.status) || record.status === 'native-admitted' && (record.inputId !== inputId(binding, event.id) || record.sessionId !== binding.sessionId)) uncertain();
  return clone(record);
}
function markIngress(store, binding, event, frame, receipt, expected) {
  if (!frame.wireEnvelope) return;
  const record = store.inbox?.[frame.globalMessageId];
  if (!exact(ingressRecord(store, binding, event, frame), expected)) uncertain();
  record.status = 'native-admitted'; record.inputId = receipt.inputId; record.sessionId = binding.sessionId;
}
function receiptFor(binding, row, frame, reconciled) {
  return { status: 'admitted', inputId: row.inputId, reconciled, sessionId: binding.sessionId, at: new Date().toISOString(), ...(frame.globalMessageId ? { globalMessageId: frame.globalMessageId } : {}) };
}

/** V4 worker-only admission, protected by the same source dispatch capability
 * as normal delivery. Only this helper owns the native intent phase changes. */
export async function admitNativeGuarded(context, input, frame, event, state, { client, text, persist, permit } = {}) {
  selectEvent(event?.id);
  if (typeof persist !== 'function' || typeof text !== 'string' || !text.trim()) fail('NATIVE_PERSISTENCE_REQUIRED', 'Native admission requires a complete prompt and durable runtime writer.');
  return withDispatch(context, input, async ({ binding, store }) => {
    v4(store); workerGate(store, binding, state); await delivery(context, store, binding, frame, event);
    const ingress = ingressRecord(store, binding, event, frame);
    try { await validateNative(client, binding); } catch { uncertain(); }
    const actual = await eventById(context, event.id);
    if (!exact(actual, event)) uncertain();
    const id = inputId(binding, event.id), promptHash = payloadHash(text);
    let row = await locked(context, live => {
      v4(live); workerGate(live, binding, state);
      if (payloadHash(resolveBinding(live, binding.alias)) !== payloadHash(binding) || routeHash(live, binding, frame) !== routeHash(store, binding, frame)) uncertain();
      const prior = live.nativeIntents[id];
      if (prior) {
        validateNativeIntent(prior);
        if (prior.eventId !== event.id || prior.bindingHash !== payloadHash(binding) || prior.eventHash !== payloadHash(event) || prior.frameHash !== payloadHash(frame) || prior.routeHash !== routeHash(live, binding, frame) || prior.promptHash !== promptHash) uncertain();
        if (state.pending) {
          if (!pendingMatches(state.pending, prior) || !['submit-started', 'admitted'].includes(prior.phase)) uncertain();
          return clone(prior);
        }
        if (prior.phase !== 'not-submitted') uncertain();
      } else if (state.pending) uncertain();
      const prepared = { version: 1, inputId: id, eventId: event.id, bindingId: binding.id, bindingRevision: binding.revision, roomId: frame.room, eventHash: payloadHash(event), frameHash: payloadHash(frame), bindingHash: payloadHash(binding), routeHash: routeHash(live, binding, frame), promptHash, rendererVersion: 1, phase: 'prepared', attemptId: randomUUID(), attempt: (prior?.attempt || 0) + 1, createdAt: prior?.createdAt || new Date().toISOString(), receipt: null, recovery: null };
      validateNativeIntent(prepared); live.nativeIntents[id] = prepared; return clone(prepared);
    });
    let result;
    try {
      result = await admit({
        client, binding, eventId: event.id, pending: state.pending, text,
        metadata: { agentDialogue: { room: frame.room, eventId: event.id, bindingId: binding.id, bindingRevision: binding.revision } },
        onPending: async pending => { state.pending = pending; await persist(state); },
        beforeSubmit: async () => {
          row = await locked(context, live => {
            workerGate(live, binding, state); const current = currentIntent(live, binding, row, { outcome: true });
            if (current.phase !== 'prepared' || routeHash(live, binding, frame) !== row.routeHash) uncertain();
            current.phase = 'submit-started'; return clone(current);
          });
        },
        onNotSubmitted: async () => {
          row = await locked(context, live => {
            workerGate(live, binding, state); const current = currentIntent(live, binding, row, { outcome: true });
            if (current.phase !== 'submit-started') uncertain();
            current.phase = 'not-submitted'; return clone(current);
          });
        },
        reconcileInput: async () => (await nativeInputEvidence(client, binding, { inputId: id, text, promptHash: row.promptHash })).status === 'verified',
      });
    } catch (error) {
      if (error.notSubmitted === true) throw error;
      uncertain();
    }
    try {
      return await locked(context, live => {
        workerGate(live, binding, state); const current = currentIntent(live, binding, row, { outcome: true });
        if (!['submit-started', 'admitted'].includes(current.phase) || routeHash(live, binding, frame) !== row.routeHash) uncertain();
        const receipt = current.receipt || receiptFor(binding, row, frame, result.reconciled);
        if (receipt.sessionId !== binding.sessionId) uncertain();
        current.phase = 'admitted'; current.receipt = receipt; validateNativeIntent(current);
        markIngress(live, binding, event, frame, receipt, ingress); return clone(receipt);
      });
    } catch { uncertain(); }
  }, { permit });
}

function paused(store, binding) {
  v4(store); const lifecycle = lifecycleState(store, binding);
  if (lifecycle.desired !== 'paused') fail('NATIVE_PAUSE_REQUIRED', 'Pause this exact binding before a native evidence query or repair.');
  return lifecycle;
}
function selectedRow(store, binding, eventId) {
  const id = inputId(binding, eventId), row = store.nativeIntents?.[id];
  if (!row) return { id, row: null };
  if (row.bindingId !== binding.id || row.bindingRevision !== binding.revision || row.eventId !== eventId || row.bindingHash !== payloadHash(binding)) uncertain();
  return { id, row: clone(row) };
}
async function original(context, store, binding, row) {
  currentIntent(store, binding, row, { outcome: true });
  const event = await eventById(context, row.eventId), frame = decodeFrame(event.data?.text || '');
  if (payloadHash(event) !== row.eventHash || payloadHash(frame) !== row.frameHash || frame.room !== row.roomId || routeHash(store, binding, frame) !== row.routeHash) uncertain();
  await delivery(context, store, binding, frame, event); return { event, frame };
}
async function query(context, binding, row, nativeFactory) {
  try {
    return await withNative(context, binding.harness, client => nativeInputEvidence(client, binding, { inputId: row.inputId, promptHash: row.promptHash }), { factory: nativeFactory });
  } catch { return { status: 'needs-review', reason: 'native-unavailable' }; }
}
function preflight(store, binding, eventId, { native = false, allowSessionLoad = false } = {}) {
  const id = inputId(binding, eventId);
  if (binding.harness === 'zcode-tools') return review('unsupported-native-admission', eventId, id);
  if (store.version !== 4) return review('native-upgrade-required', eventId, id);
  const { row } = selectedRow(store, binding, eventId);
  if (!row) return review('legacy-or-missing-native-provenance', eventId, id);
  if (!native) return { status: 'not-probed', reason: 'native-not-requested', eventId, inputId: id, phase: row.phase, nativeContact: false, runtimeChanged: false };
  if (binding.harness === 'kimi-code' && !allowSessionLoad) return review('kimi-session-load-not-requested', eventId, id);
  if (!['submit-started', 'admitted'].includes(row.phase)) return review(row.phase === 'prepared' ? 'submit-not-started' : 'known-not-submitted', eventId, id);
  return null;
}

/** Default metadata-only report does not take a lock, initialize a ledger, or
 * discover a native service. Explicit query holds D but no C during native I/O. */
export async function nativeEvidence(context, alias, eventId, options = {}) {
  selectEvent(eventId);
  const store = await readStore(context), binding = localBinding(store, alias), result = preflight(store, binding, eventId, options);
  if (result) return result;
  const { probe = processEvidence, nativeFactory } = options;
  return withDispatch(context, binding, async ({ store: live, binding: current }) => {
    const gate = preflight(live, current, eventId, options); if (gate) return gate;
    paused(live, current); const row = selectedRow(live, current, eventId).row;
    if (!row) return review('legacy-or-missing-native-provenance', eventId, inputId(current, eventId));
    const initial = await stoppedRuntimeForRecovery(context, current, live, probe); await original(context, live, current, row);
    const proof = await query(context, current, row, nativeFactory);
    const fresh = await readStore(context), after = await stoppedRuntimeForRecovery(context, current, fresh, probe);
    if (initial.hash !== after.hash || initial.ownerHash !== after.ownerHash || !exact(lifecycleState(live, current), paused(fresh, current))) uncertain();
    await original(context, fresh, current, row);
    return { status: proof.status, ...(proof.status === 'verified' ? { source: proof.source } : { reason: proof.reason }), eventId, inputId: row.inputId, nativeContact: true, runtimeChanged: false };
  }, { allowPaused: true });
}

export async function reconcileNative(context, alias, eventId, options = {}) {
  selectEvent(eventId);
  const store = await readStore(context), binding = localBinding(store, alias), result = preflight(store, binding, eventId, { ...options, native: true });
  if (result) return result;
  const { probe = processEvidence, nativeFactory, checkpointHook, publishRuntime = saveRuntime } = options;
  return withDispatch(context, binding, async ({ binding: current, store: live }) => {
    const gate = preflight(live, current, eventId, { ...options, native: true }); if (gate) return gate;
    const lifecycle = paused(live, current), row = selectedRow(live, current, eventId).row;
    if (!row) return review('legacy-or-missing-native-provenance', eventId, inputId(current, eventId));
    const initial = await stoppedRuntimeForRecovery(context, current, live, probe), { event, frame } = await original(context, live, current, row);
    const ingress = ingressRecord(live, current, event, frame);
    const proof = await query(context, current, row, nativeFactory);
    if (proof.status !== 'verified') return { ...proof, eventId, inputId: row.inputId, runtimeChanged: false };
    const checkedStore = await readStore(context), checked = await stoppedRuntimeForRecovery(context, current, checkedStore, probe);
    if (initial.hash !== checked.hash || initial.ownerHash !== checked.ownerHash) uncertain();
    await original(context, checkedStore, current, row);
    if (!exact(ingressRecord(checkedStore, current, event, frame), ingress)) uncertain();
    let checkpoint = row.recovery;
    if (!checkpoint) {
      if (!pendingMatches(initial.state.pending, row)) uncertain();
      const receipt = row.receipt || receiptFor(current, row, frame, true);
      if (receipt.sessionId !== current.sessionId || initial.state.receipts?.[eventId] && !exact(initial.state.receipts[eventId], receipt)) uncertain();
      const post = clone(initial.state); post.receipts ||= {}; post.receipts[eventId] = clone(receipt); delete post.pending;
      checkpoint = { version: 1, id: randomUUID(), phase: 'runtime-prepared', preHash: initial.hash, postHash: digest(bytes(post)), pendingHash: payloadHash(initial.state.pending), ownerHash: initial.ownerHash, lifecycleGeneration: lifecycle.generation, lifecycleNonce: lifecycle.changeNonce, receipt };
    }
    const check = (latest, intent, committed = false) => {
      const lc = paused(latest, current);
      if (lc.generation !== checkpoint.lifecycleGeneration || lc.changeNonce !== checkpoint.lifecycleNonce || !exact(latest.workerLaunches?.[current.id], checkedStore.workerLaunches?.[current.id]) || intent.recovery && !exact(intent.recovery, checkpoint)) uncertain();
      if (routeHash(latest, current, frame) !== row.routeHash) uncertain();
      if (committed && (intent.phase !== 'admitted' || !exact(intent.receipt, checkpoint.receipt) || !exact(intent.recovery, checkpoint))) uncertain();
      if (committed && frame.wireEnvelope && !exact(ingressRecord(latest, current, event, frame), { ...ingress, status: 'native-admitted', inputId: checkpoint.receipt.inputId, sessionId: current.sessionId })) uncertain();
    };
    await locked(context, latest => {
      const intent = currentIntent(latest, current, row, { outcome: true }); check(latest, intent);
      intent.phase = 'admitted'; intent.receipt = clone(checkpoint.receipt); intent.recovery = clone(checkpoint); validateNativeIntent(intent);
      markIngress(latest, current, event, frame, checkpoint.receipt, ingress);
    });
    await checkpointHook?.('control-committed');
    const freshStore = await readStore(context), fresh = await stoppedRuntimeForRecovery(context, current, freshStore, probe);
    const freshIntent = currentIntent(freshStore, current, row); check(freshStore, freshIntent, true);
    if (fresh.ownerHash !== checkpoint.ownerHash) uncertain();
    if (fresh.hash === checkpoint.preHash) {
      if (!pendingMatches(fresh.state.pending, row) || payloadHash(fresh.state.pending) !== checkpoint.pendingHash) uncertain();
      const post = clone(fresh.state); post.receipts ||= {}; post.receipts[eventId] = clone(checkpoint.receipt); delete post.pending;
      if (digest(bytes(post)) !== checkpoint.postHash) uncertain();
      await publishRuntime(context, current.id, post);
    } else if (fresh.hash !== checkpoint.postHash) uncertain();
    await checkpointHook?.('runtime-published');
    const finalStore = await readStore(context), final = await stoppedRuntimeForRecovery(context, current, finalStore, probe);
    if (final.hash !== checkpoint.postHash || final.ownerHash !== checkpoint.ownerHash) uncertain();
    await locked(context, latest => {
      const intent = currentIntent(latest, current, row); check(latest, intent, true); intent.recovery.phase = 'runtime-committed';
    });
    return { status: 'reconciled', eventId, inputId: row.inputId, runtimeChanged: initial.hash !== final.hash, cursorPreserved: true, resumed: false };
  }, { allowPaused: true });
}
