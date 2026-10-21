import { randomUUID, createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readStore, resolveBinding, validateRoute, encodeFrame, decodeFrame } from './bridge-store.mjs';
import { locked, hcom, eventById, validateNative, processEvidence, workerRuntimeSnapshot, saveRuntime } from './bridge.mjs';
import { payloadHash } from './node-identity.mjs';
import { withNative } from './adapters.mjs';
import { withDispatch, requireEnabled, lifecycleState } from './lifecycle.mjs';
import { decodeSubmission, validateSubmission } from './submissions.mjs';
import { validateForwardingRecord } from './forwarding-record.mjs';
import { scanUniqueLedger } from './recovery-evidence.mjs';

const clone = value => structuredClone(value);
const hashBytes = value => createHash('sha256').update(value).digest('hex');
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code, message, uncertain = false) => { throw Object.assign(new Error(message), { code, ...(uncertain ? { uncertain: true } : {}) }); };
const pending = message => fail('FORWARDING_NEEDS_REVIEW', message, true);
const exact = (a, b) => payloadHash(a) === payloadHash(b);
function v3(store) { if (![3, 4].includes(store.version)) fail('PROVENANCE_UPGRADE_REQUIRED', 'Queued recovery requires explicit offline state upgrade --target 3 or 4.'); }
function routeFor(store, binding, request, event) {
  validateSubmission(store, binding, request, event);
  if (!Number.isSafeInteger(event.id) || event.id < 1 || !exact(decodeSubmission(event.data.text), request) || event.data.delivered_to.length !== 1) pending('The exact original queue event cannot be verified.');
  return validateRoute(store, { room: request.room, from: request.from, to: request.to, expectedSession: request.expectedSession, replyTo: request.replyTo });
}
function localFrame(request, dispatchId) {
  return { version: 1, room: request.room, from: request.from, to: request.to, fromBindingId: request.fromBindingId, toBindingId: request.toBindingId, fromRevision: request.fromRevision, toRevision: request.toRevision, text: request.text, replyTo: request.replyTo, forwardingId: dispatchId, submissionId: request.id };
}
function sameIntent(a, b) {
  const immutable = row => Object.fromEntries(['version', 'submissionId', 'submissionEventId', 'submissionHash', 'bindingId', 'bindingRevision', 'roomId', 'routeHash', 'kind', 'dispatchId', 'frameHash', 'createdAt', 'messageId', 'payloadHash'].map(k => [k, row[k]]));
  return a && b && exact(immutable(a), immutable(b));
}
function currentIntent(store, row, binding, request, event) {
  v3(store); const current = store.forwardings[row.submissionId];
  if (!current || !sameIntent(current, row) || payloadHash(routeFor(store, binding, request, event)) !== row.routeHash) pending('Forwarding identity, room pins or provenance changed; no repair was applied.');
  validateForwardingRecord(current); return current;
}
async function nativeVerify(context, route) {
  for (const binding of [route.from, route.to]) if (!binding.remote) await withNative(context, binding.harness, client => validateNative(client, binding));
}
async function checkParent(context, frame, route) {
  if (frame.replyTo === null) return;
  const parent = decodeFrame((await eventById(context, frame.replyTo)).data.text);
  if (parent.room !== frame.room || parent.from !== frame.to || parent.to !== frame.from || parent.toBindingId !== route.from.id || parent.toRevision !== route.from.revision || parent.fromBindingId !== route.to.id || parent.fromRevision !== route.to.revision) pending('The original local reply parent does not reverse these exact participants.');
}

/** Called only inside the owning worker's source dispatch scope. A persisted
 * append-started claim is never reused to issue a second formal append. */
export async function forwardQueued(context, binding, request, event, state, options = {}) {
  return withDispatch(context, binding, ({ permit }) => forwardWithinDispatch(context, binding, request, event, state, { ...options, permit }), { permit: options.permit });
}
async function forwardWithinDispatch(context, binding, request, event, state, {
  persist, permit, nativeVerify: verifyNative = nativeVerify, appendLocalImpl, flushImpl,
} = {}) {
  const snapshot = await readStore(context); v3(snapshot);
  const route = routeFor(snapshot, binding, request, event);
  if (state.receipts?.[event.id]?.status === 'forwarded') {
    if (state.receipts[event.id].submissionId !== request.id) pending('The existing receipt belongs to another original request.');
    return state.receipts[event.id].result;
  }
  if (state.outgoingPending) pending('A prior queued outcome is unresolved; preserve its original association before recovery.');
  if (typeof persist !== 'function') fail('PERSISTENCE_REQUIRED', 'Queued provenance requires durable worker persistence.');
  if (snapshot.forwardings[request.id]) pending('This request already has a durable intent; inspect its exact outcome before recovery.');
  const dispatchId = randomUUID(), createdAt = new Date().toISOString(), remote = !!route.to.remote;
  const provenance = { version: 1, submissionId: request.id, submissionEventId: event.id, submissionHash: payloadHash(request), dispatchId, bindingId: binding.id, bindingRevision: binding.revision };
  const nodes = remote ? await import('./nodes.mjs') : null;
  let prepared, frame = remote ? null : localFrame(request, dispatchId);
  if (remote) prepared = await nodes.prepareRemoteForwarding(context, { room: request.room, from: request.from, to: request.to, text: request.text, expectedSession: request.expectedSession, replyTo: request.replyTo }, { messageId: `m_${randomUUID()}`, createdAt, provenance, permit });
  else { await verifyNative(context, route); await checkParent(context, frame, route); }
  if (!remote && Buffer.byteLength(encodeFrame(frame), 'utf8') > 120000) fail('FORWARDING_FRAME_TOO_LARGE', 'The exact formal frame exceeds the bounded ledger format; no append was started.');
  const row = { ...provenance, roomId: request.room, routeHash: payloadHash(route), kind: remote ? 'remote' : 'local', phase: 'prepared', frameHash: payloadHash(remote ? decodeFrame(prepared.encoded) : frame), formalEventId: null, result: null, createdAt, messageId: remote ? prepared.messageId : null, payloadHash: remote ? prepared.payloadHash : null, recovery: null };
  validateForwardingRecord(row);
  await locked(context, store => {
    v3(store); requireEnabled(store, binding);
    if (store.forwardings[request.id] || payloadHash(routeFor(store, binding, request, event)) !== row.routeHash) pending('Forwarding identity changed before intent persistence.');
    // Node builder is imported before entering this short synchronous callback.
    if (remote) nodes.buildRemoteForwarding(store, prepared);
    store.forwardings[request.id] = clone(row);
  });
  state.outgoingPending = { version: 2, eventId: event.id, submissionId: request.id, dispatchId, status: 'forwarding' };
  try { await persist(state); } catch { pending('The worker intent could not be persisted; no formal append was attempted.'); }
  let sent;
  try {
    if (remote) {
      sent = await (await import('./nodes.mjs')).appendRemoteForwarding(context, prepared, { permit, beforeAppend: store => {
        const current = currentIntent(store, row, binding, request, event);
        if (current.phase !== 'prepared') pending('An existing append claim cannot be issued again.');
        current.phase = 'append-started';
      } });
    } else {
      await locked(context, store => { const current = currentIntent(store, row, binding, request, event); requireEnabled(store, binding); if (current.phase !== 'prepared') pending('An existing append claim cannot be issued again.'); current.phase = 'append-started'; });
      let appendUsed = false;
      const defaultAppend = () => {
        if (appendUsed) pending('The local append capability was already consumed.');
        appendUsed = true;
        return locked(context, async store => {
        const current = currentIntent(store, row, binding, request, event); requireEnabled(store, binding);
        if (current.phase !== 'append-started') pending('The formal append claim changed.');
        return JSON.parse(await hcom(context, ['send', '--json', '--name', route.from.hcomName, `@${route.to.hcomName}`, '--thread', request.room, '--intent', request.replyTo ? 'ack' : 'request', ...(request.replyTo ? ['--reply-to', request.replyTo] : []), '--', encodeFrame(frame)]));
        });
      };
      sent = appendLocalImpl ? await appendLocalImpl(context, { row: clone(row), frame: clone(frame) }, { defaultAppend }) : await defaultAppend();
    }
    if (!Number.isSafeInteger(sent?.event_id) || sent.event_id < 1) pending('The formal append returned no exact receipt.');
    const saved = await eventById(context, sent.event_id);
    await validateFormalEvent(context, binding, row, request, event, saved);
    await locked(context, store => {
      const current = currentIntent(store, row, binding, request, event);
      if (current.phase !== 'append-started') pending('The durable append claim changed.');
      current.phase = 'local-stored'; current.formalEventId = sent.event_id;
    });
    const result = remote ? await (flushImpl || nodes.flushMessage)(context, row.messageId, { permit }) : { event_id: sent.event_id };
    const canonical = remote ? { event_id: result.event_id, messageId: result.messageId, status: result.status, remoteEventId: result.remoteEventId } : { event_id: sent.event_id };
    await locked(context, store => { const current = currentIntent(store, row, binding, request, event); if (current.formalEventId !== sent.event_id) pending('The formal event changed.'); current.phase = 'forwarded'; current.result = canonical; validateForwardingRecord(current); });
    state.receipts ||= {}; state.receipts[event.id] = { status: 'forwarded', submissionId: request.id, result: canonical, at: new Date().toISOString() }; delete state.outgoingPending;
    await persist(state); return canonical;
  } catch { pending('The original formal append or delivery outcome is uncertain; no automatic second append was authorized.'); }
}

async function original(context, binding, row) {
  validateForwardingRecord(row); const event = await eventById(context, row.submissionEventId), request = decodeSubmission(event.data?.text);
  const store = await readStore(context); v3(store);
  if (row.bindingId !== binding.id || row.bindingRevision !== binding.revision || request.id !== row.submissionId || payloadHash(request) !== row.submissionHash || payloadHash(routeFor(store, binding, request, event)) !== row.routeHash) pending('The exact source event or route no longer matches its durable intent.');
  return { event, request, store };
}
async function validateFormalEvent(context, binding, row, request, submissionEvent, event) {
  const store = await readStore(context), route = routeFor(store, binding, request, submissionEvent);
  if (payloadHash(route) !== row.routeHash || !Number.isSafeInteger(event?.id) || event.id <= row.submissionEventId || event.type !== 'message') pending('The formal event or current route cannot be verified.');
  if (row.kind === 'remote') {
    await (await import('./nodes.mjs')).verifyRemoteForwarding(context, row, event); return;
  }
  const frame = decodeFrame(event.data?.text || '');
  if (!exact(frame, localFrame(request, row.dispatchId)) || payloadHash(frame) !== row.frameHash || event.data.from !== route.from.hcomName || event.data.sender_kind !== 'instance' || event.data.thread !== row.roomId || event.data.intent !== (request.replyTo ? 'ack' : 'request') || !Array.isArray(event.data.delivered_to) || event.data.delivered_to.length !== 1 || event.data.delivered_to[0] !== route.to.hcomName) pending('The formal ledger event does not prove this exact forwarding.');
}
/** Read-only full bounded scan. Picking a candidate by its ID precedes all
 * content/sender checks, so a forged second candidate cannot be filtered out. */
export async function verifyForwardingEvidence(context, binding, row, { ledgerImpl, maxEvents } = {}) {
  const { event: submitted, request } = await original(context, binding, row);
  if (row.phase === 'prepared') return { status: 'needs-review', reason: 'append-not-started', scanned: 0 };
  const proof = await scanUniqueLedger(context, event => {
    let frame; try { frame = JSON.parse((event.data.text || '').replace(/^agent-dialogue\/1\n/, '')); } catch { return false; }
    return row.kind === 'remote' ? frame.globalMessageId === row.messageId : frame.forwardingId === row.dispatchId || frame.submissionId === row.submissionId;
  }, { ...(ledgerImpl !== undefined ? { ledgerImpl } : {}), ...(maxEvents !== undefined ? { maxEvents } : {}) });
  if (proof.status !== 'unique') return { status: 'needs-review', reason: proof.status, scanned: proof.scanned };
  await validateFormalEvent(context, binding, row, request, submitted, proof.event);
  if (row.formalEventId !== null && row.formalEventId !== proof.event.id) pending('The saved formal event conflicts with the unique ledger proof.');
  let result = { event_id: proof.event.id };
  if (row.kind === 'remote') {
    const outbox = (await readStore(context)).outbox?.[row.messageId];
    if (outbox?.eventId && outbox.eventId !== proof.event.id) pending('The original outbox refers to a different formal event.');
    if (outbox?.status !== 'remote-stored' || !Number.isSafeInteger(outbox.remoteEventId) || outbox.remoteEventId < 1) return { status: 'needs-review', reason: 'remote-unconfirmed', formalEventId: proof.event.id, scanned: proof.scanned };
    result = { event_id: proof.event.id, messageId: row.messageId, status: 'remote-stored', remoteEventId: outbox.remoteEventId };
  }
  if (row.result && !exact(row.result, result)) pending('The stored result conflicts with the ledger and outbox evidence.');
  return { status: 'verified', result, scanned: proof.scanned };
}

async function absent(path) { try { await lstat(path); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } }
async function stopped(context, binding, store, probe) {
  const snapshot = await workerRuntimeSnapshot(context, binding.id), state = snapshot.state, launch = store.workerLaunches?.[binding.id];
  if (!Number.isSafeInteger(state.pid) || state.pid < 2 || typeof state.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(state.token) || !['stopped', 'error'].includes(state.status) || launch?.version !== 1 || launch.phase !== 'stopped' || launch.bindingRevision !== binding.revision || launch.token !== state.token || launch.pid !== undefined && launch.pid !== state.pid || await probe(state.pid, state.token, binding.id) !== 'confirmed-dead' || !await absent(join(context.stateDir, 'dialogue', `${binding.id}.worker.lock`)) || !await absent(join(context.stateDir, 'dialogue', 'windows-workers', `${binding.id}.${state.token}.launch.json`))) fail('RECOVERY_WORKER_NOT_STOPPED', 'Recovery requires the exact stopped, confirmed-dead worker with no owned lock or scheduled launch.');
  return { ...snapshot, hash: hashBytes(snapshot.bytes), ownerHash: payloadHash({ pid: state.pid, token: state.token, bindingId: binding.id, bindingRevision: binding.revision, launch }) };
}
export { stopped as stoppedRuntimeForRecovery };
function paused(store, binding) {
  v3(store); const lifecycle = lifecycleState(store, binding);
  if (lifecycle.desired !== 'paused') fail('RECOVERY_PAUSE_REQUIRED', 'Pause this exact binding before evidence reconciliation.');
  return lifecycle;
}
function pendingMatches(value, row) { return value && Object.keys(value).length === 5 && value.version === 2 && value.eventId === row.submissionEventId && value.submissionId === row.submissionId && value.dispatchId === row.dispatchId && value.status === 'forwarding'; }

/** Selected-q evidence repair only: no append, exchange, native input, spawn,
 * lock deletion, cursor advancement or automatic lifecycle change. */
export async function reconcileSubmission(context, alias, submissionId, { probe = processEvidence, ledgerImpl, maxEvents, checkpointHook, publishRuntime = saveRuntime } = {}) {
  if (typeof submissionId !== 'string' || !/^q_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(submissionId)) fail('RECOVERY_SELECTION_INVALID', 'Select one complete q_UUID.');
  return withDispatch(context, alias, async ({ binding, store }) => {
    const lifecycle = paused(store, binding), row = clone(store.forwardings[submissionId]);
    if (!row) return { status: 'needs-review', reason: 'legacy-or-missing-provenance', submissionId };
    const initial = await stopped(context, binding, store, probe), proof = await verifyForwardingEvidence(context, binding, row, { ledgerImpl, maxEvents });
    if (proof.status !== 'verified') return { ...proof, submissionId, runtimeChanged: false };
    const checkedStore = await readStore(context), checked = await stopped(context, binding, checkedStore, probe);
    if (checked.hash !== initial.hash || checked.ownerHash !== initial.ownerHash) pending('The stopped runtime changed during evidence lookup.');
    const { event, request } = await original(context, binding, row);
    let checkpoint = row.recovery;
    if (!checkpoint) {
      if (!pendingMatches(initial.state.outgoingPending, row)) pending('Only the original associated outgoing pending can be repaired.');
      const receipt = { status: 'forwarded', submissionId, result: proof.result, at: new Date().toISOString() };
      if (initial.state.receipts?.[row.submissionEventId] && !exact(initial.state.receipts[row.submissionEventId], receipt)) pending('An existing receipt cannot be overwritten.');
      const post = clone(initial.state); post.receipts ||= {}; post.receipts[row.submissionEventId] = receipt; delete post.outgoingPending;
      checkpoint = { version: 1, id: randomUUID(), phase: 'runtime-prepared', preHash: initial.hash, postHash: hashBytes(serialize(post)), pendingHash: payloadHash(initial.state.outgoingPending), ownerHash: initial.ownerHash, lifecycleGeneration: lifecycle.generation, lifecycleNonce: lifecycle.changeNonce, receipt };
    }
    const checkCheckpoint = (live, current) => {
      const lc = paused(live, binding);
      if (lc.generation !== checkpoint.lifecycleGeneration || lc.changeNonce !== checkpoint.lifecycleNonce || !exact(live.workerLaunches?.[binding.id], checkedStore.workerLaunches?.[binding.id]) || current.recovery && !exact(current.recovery, checkpoint)) pending('The recovery checkpoint or owner prerequisites changed.');
    };
    await locked(context, live => {
      const current = currentIntent(live, row, binding, request, event); checkCheckpoint(live, current);
      current.phase = 'forwarded'; current.formalEventId = proof.result.event_id; current.result = proof.result; current.recovery = clone(checkpoint); validateForwardingRecord(current);
    });
    await checkpointHook?.('control-committed');
    const freshStore = await readStore(context), fresh = await stopped(context, binding, freshStore, probe);
    checkCheckpoint(freshStore, freshStore.forwardings[submissionId]);
    if (fresh.ownerHash !== checkpoint.ownerHash) pending('The exact stopped worker owner changed.');
    if (fresh.hash === checkpoint.preHash) {
      if (!pendingMatches(fresh.state.outgoingPending, row) || payloadHash(fresh.state.outgoingPending) !== checkpoint.pendingHash) pending('The original pending changed.');
      const post = clone(fresh.state); post.receipts ||= {}; post.receipts[row.submissionEventId] = clone(checkpoint.receipt); delete post.outgoingPending;
      if (hashBytes(serialize(post)) !== checkpoint.postHash) pending('The deterministic recovery postimage changed.');
      await publishRuntime(context, binding.id, post);
    } else if (fresh.hash !== checkpoint.postHash) pending('Runtime matches neither saved recovery preimage nor postimage.');
    await checkpointHook?.('runtime-published');
    const finalStore = await readStore(context), final = await stopped(context, binding, finalStore, probe);
    if (final.hash !== checkpoint.postHash || final.ownerHash !== checkpoint.ownerHash) pending('Runtime publication was not confirmed; retain the recovery checkpoint.');
    await locked(context, live => { const current = currentIntent(live, row, binding, request, event); checkCheckpoint(live, current); current.recovery.phase = 'runtime-committed'; });
    return { status: 'reconciled', submissionId, event_id: proof.result.event_id, runtimeChanged: initial.hash !== final.hash, cursorPreserved: true, resumed: false };
  }, { allowPaused: true });
}
