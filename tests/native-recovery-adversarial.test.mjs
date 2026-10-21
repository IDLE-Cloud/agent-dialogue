import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, decodeFrame, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { eventById, hcom, locked, saveRuntime, workerRuntimeSnapshot } from '../lib/bridge.mjs';
import { loadOrCreateNode, payloadHash, signObject } from '../lib/node-identity.mjs';
import { pauseBinding, withDispatch } from '../lib/lifecycle.mjs';
import { inputId } from '../lib/native-admission.mjs';
import { admitNativeGuarded, nativeEvidence, reconcileNative } from '../lib/native-recovery.mjs';
import { acceptRoom, exportNode, exportRoom, pairPeer, receiveEnvelope, sealRoom } from '../lib/nodes.mjs';

const budget = { timeout: process.platform === 'win32' ? 240000 : 20000 };
const dead = async () => 'confirmed-dead'; // Synthetic contract seam, never OS process-ownership proof.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const review = error => error?.uncertain === true || error?.code === 'RECOVERY_WORKER_NOT_STOPPED';

async function fixture(t, { remote = false, harness = 'opencode-v1', outcome = 'unknown' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-native-adversarial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'receiver'), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded' } }, node = await loadOrCreateNode(context);
  const make = (store, alias, node) => { const binding = createBinding(store, { alias, harness, sessionId: 'ses_' + alias, projectId: 'synthetic-project', directory: root, serviceId: 'synthetic-service', origin: 'http://127.0.0.1:1' }); binding.nodeId = node.nodeId; return binding; };
  let binding, peer, peerNode, peerContext, room;
  await withStore(context, store => { store.version = 4; store.lifecycle = {}; store.forwardings = {}; store.nativeIntents = {}; binding = make(store, 'selected', node); if (!remote) peer = make(store, 'peer', node); });
  if (remote) {
    peerContext = { ...context, stateDir: join(root, 'sender') }; peerNode = await loadOrCreateNode(peerContext);
    peer = await withStore(peerContext, store => make(store, 'peer', peerNode));
    const transport = target => ({ kind: 'local-process', executable: process.execPath, args: [], stateDir: target.stateDir });
    await pairPeer(context, await exportNode(peerContext), transport(peerContext));
    await pairPeer(peerContext, await exportNode(context), transport(context));
  }
  room = await withStore(context, store => createRoom(store, { name: 'Adversarial native source', members: ['selected', 'peer'] }));
  let event, frame;
  if (remote) {
    room = await sealRoom(context, room); await acceptRoom(peerContext, await exportRoom(context, room.id));
    await hcom(context, ['start', '--name', binding.hcomName]);
    const endpoint = (b, n) => ({ nodeId: n.nodeId, bindingId: b.id, revision: b.revision, alias: b.alias });
    const envelope = signObject(peerNode, { type: 'message', version: 1, messageId: `m_${randomUUID()}`, roomId: room.id, roomRevision: room.revision, manifestHash: room.manifestHash, from: endpoint(peer, peerNode), to: endpoint(binding, node), text: 'Original signed peer input.', replyToMessageId: null, createdAt: new Date().toISOString() });
    const receipt = await receiveEnvelope(context, envelope); event = await eventById(context, receipt.payload.eventId); frame = decodeFrame(event.data.text);
  } else {
    for (const actor of [binding.hcomName, peer.hcomName]) await hcom(context, ['start', '--name', actor]);
    frame = { version: 1, room: room.id, from: peer.alias, to: binding.alias, fromBindingId: peer.id, toBindingId: binding.id, fromRevision: peer.revision, toRevision: binding.revision, text: 'Original peer project input.', replyTo: null };
    const sent = JSON.parse(await hcom(context, ['send', '--json', '--name', peer.hcomName, '@' + binding.hcomName, '--thread', room.id, '--intent', 'request', '--', encodeFrame(frame)])); event = await eventById(context, sent.event_id);
  }
  const state = { pid: 912346, token: randomUUID(), status: 'ready', cursor: 0, receipts: { 999: { status: 'retained-adversarial', fixture: true } }, nativePending: { preserve: true }, outgoingPending: { preserve: true } }; // No real process is created at this synthetic PID.
  await withStore(context, store => { store.workerLaunches = { [binding.id]: { version: 1, bindingRevision: binding.revision, token: state.token, pid: state.pid, phase: 'ready' } }; });
  await saveRuntime(context, binding.id, state);
  const inputs = new Map(), text = 'Complete rendered prompt from the original installation.\nPeer body and command prefix.';
  let posts = 0, contacts = 0, closes = 0, currentOutcome = outcome, onPrompt, onEvidence;
  const client = {
    identity: { serviceId: binding.serviceId, origin: binding.origin },
    session: async id => ({ id, projectID: binding.projectId, location: { directory: binding.directory }, time: {} }),
    prompt: async (sessionId, request) => {
      posts++; await onPrompt?.(sessionId, request);
      if (currentOutcome === 'not-submitted') throw Object.assign(new Error('Synthetic known native preflight rejection'), { notSubmitted: true, nativeBusy: true });
      inputs.set(request.id, { sessionId, inputId: request.id, role: 'user', text: request.text, storage: 'persisted' });
      if (currentOutcome === 'unknown') throw new Error('Synthetic lost prompt response');
      return { id: request.id };
    },
    inputEvidence: async (_, id) => { await onEvidence?.(); return inputs.get(id) ?? null; },
    inbox: async () => assert.fail('No projected ID fallback'), messages: async () => assert.fail('No last-N fallback'), close: async () => { closes++; },
  };
  const factory = async () => { contacts++; return client; }, persist = value => saveRuntime(context, binding.id, value);
  const admit = overrides => admitNativeGuarded(context, binding, frame, event, state, { client, text, persist, ...overrides });
  const runtime = async () => (await workerRuntimeSnapshot(context, binding.id)).state;
  const stop = async () => { state.status = 'error'; state.error = 'Synthetic uncertain result'; await persist(state); await withStore(context, store => { store.workerLaunches[binding.id].phase = 'stopped'; }); await pauseBinding(context, binding.alias); };
  const lost = async () => { const lookup = client.inputEvidence; delete client.inputEvidence; await assert.rejects(admit(), review); client.inputEvidence = lookup; await stop(); };
  return { context, binding, peer, room, frame, event, state, client, text, inputs, admit, persist, runtime, stop, lost, rowId: inputId(binding, event.id), options: extra => ({ nativeFactory: factory, probe: dead, ...extra }), setOutcome: value => { currentOutcome = value; }, setOnPrompt: value => { onPrompt = value; }, setOnEvidence: value => { onEvidence = value; }, get posts() { return posts; }, get contacts() { return contacts; }, get closes() { return closes; } };
}

test('controlled adapter prompt invocation observes durable matching native provenance and pending first', budget, async t => {
  const f = await fixture(t, { outcome: 'success' });
  f.setOnPrompt(async (_, request) => {
    const row = (await readStore(f.context)).nativeIntents[f.rowId], runtime = await f.runtime();
    assert.equal(row.phase, 'submit-started'); assert.equal(row.inputId, request.id); assert.equal(row.promptHash, payloadHash(request.text));
    assert.equal(row.eventHash, payloadHash(f.event)); assert.equal(row.bindingHash, payloadHash(f.binding)); assert.equal(runtime.pending.inputId, request.id);
    assert.equal(runtime.pending.eventId, f.event.id); assert.equal(JSON.stringify(row).includes(request.text), false);
  });
  await f.admit(); assert.equal(f.posts, 1);
});

test('known-not-submitted permits one new attempt only after its durable control phase and pending clear', budget, async t => {
  const f = await fixture(t, { outcome: 'not-submitted' });
  await assert.rejects(f.admit(), error => error.notSubmitted === true);
  const before = (await readStore(f.context)).nativeIntents[f.rowId];
  assert.equal(before.phase, 'not-submitted'); assert.equal(before.attempt, 1); assert.equal((await f.runtime()).pending, null);
  f.setOutcome('success'); await f.admit(); const after = (await readStore(f.context)).nativeIntents[f.rowId];
  assert.equal(after.phase, 'admitted'); assert.equal(after.attempt, 2); assert.notEqual(after.attemptId, before.attemptId); assert.equal(after.inputId, before.inputId); assert.equal(f.posts, 2);
});

test('native admission refuses a client belonging to a different service before any prompt', budget, async t => {
  const f = await fixture(t, { outcome: 'success' }); f.client.identity = { serviceId: 'foreign-service', origin: f.binding.origin };
  await assert.rejects(f.admit()); assert.equal(f.posts, 0);
});

test('worker-side legacy pending cannot bootstrap v4 native provenance or prompt a second time', budget, async t => {
  const f = await fixture(t, { outcome: 'success' });
  f.state.pending = { eventId: f.event.id, inputId: f.rowId, bindingRevision: f.binding.revision, status: 'submitting' }; await f.persist(f.state);
  const path = join(f.context.stateDir, 'dialogue', 'store.json'), before = await readFile(path);
  await assert.rejects(f.admit(), review); assert.equal(f.posts, 0); assert.deepEqual(await readFile(path), before);
  assert.deepEqual((await readStore(f.context)).nativeIntents, {});
});

test('explicit native query holds source D while allowing independent control transactions', budget, async t => {
  const f = await fixture(t); await f.lost(); const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let controls = 0;
  f.setOnEvidence(async () => { await locked(f.context, () => { controls++; }); entered.resolve(); await release.promise; });
  const query = nativeEvidence(f.context, f.binding.alias, f.event.id, f.options({ native: true }));
  await entered.promise;
  await assert.rejects(withDispatch(f.context, f.binding, () => assert.fail('A second source D cannot enter'), { allowPaused: true, timeoutMs: 0 }), { code: 'DISPATCH_BUSY' });
  release.resolve(); const result = await query; assert.equal(result.status, 'verified'); assert.equal(controls, 1); assert.equal(f.posts, 1);
  assert.deepEqual(Object.keys(result).sort(), ['status', 'source', 'eventId', 'inputId', 'nativeContact', 'runtimeChanged'].sort());
  assert.equal(JSON.stringify(result).includes(payloadHash(f.text)), false); assert.equal(JSON.stringify(result).includes(f.text), false);
});

test('phase changes between initial preflight and source D admission prevent any native discovery', budget, async t => {
  for (const action of [nativeEvidence, reconcileNative]) {
    const f = await fixture(t); await f.lost(); const entered = deferred(), release = deferred(), selected = deferred(); t.after(() => release.resolve());
    const held = withDispatch(f.context, f.binding, async () => { entered.resolve(); await release.promise; }, { allowPaused: true }); await entered.promise;
    const options = f.options({ native: true });
    // The options getter observes completion of the caller's initial store
    // read. The source D is held until the exact control phase is changed.
    Object.defineProperty(options, 'allowSessionLoad', { enumerable: true, get() { selected.resolve(); return false; } });
    const result = action(f.context, f.binding.alias, f.event.id, options);
    await selected.promise;
    await withStore(f.context, store => { store.nativeIntents[f.rowId].phase = 'not-submitted'; });
    release.resolve(); await held;
    const observed = await result;
    assert.equal(observed.status, 'needs-review'); assert.equal(observed.reason, 'known-not-submitted'); assert.equal(f.contacts, 0); assert.equal(f.posts, 1);
  }
});

test('owner, route and immutable native intent changes during query cannot be overwritten by positive proof', budget, async t => {
  for (const mutate of [
    (store, f) => { store.workerLaunches[f.binding.id].pid++; },
    (store, f) => { store.rooms[f.room.id].ownerNodeId = 'n_' + 'f'.repeat(64); },
    (store, f) => { store.nativeIntents[f.rowId].attemptId = randomUUID(); },
  ]) {
    const f = await fixture(t); await f.lost(); const before = await f.runtime();
    f.setOnEvidence(async () => { await withStore(f.context, store => mutate(store, f)); });
    await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()));
    assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
  }
});

test('a known-not-submitted phase published during native query cannot be overwritten as admitted', budget, async t => {
  const f = await fixture(t); await f.lost(); const before = await f.runtime();
  f.setOnEvidence(async () => { await withStore(f.context, store => { store.nativeIntents[f.rowId].phase = 'not-submitted'; }); });
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()));
  assert.equal((await readStore(f.context)).nativeIntents[f.rowId].phase, 'not-submitted'); assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});

test('a new admitted receipt published during query is preserved rather than overwritten by an old snapshot', budget, async t => {
  const f = await fixture(t, { outcome: 'success' }); await f.admit(); await f.stop(); const before = await f.runtime();
  const changedAt = '2026-10-20T00:00:00.000Z';
  f.setOnEvidence(async () => { await withStore(f.context, store => { store.nativeIntents[f.rowId].receipt.at = changedAt; }); });
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()));
  assert.equal((await readStore(f.context)).nativeIntents[f.rowId].receipt.at, changedAt); assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});

test('Kimi requires session-load consent before either evidence or repair discovers an adapter', budget, async t => {
  const f = await fixture(t, { harness: 'kimi-code' }); await f.lost(); const before = await f.runtime();
  const first = await nativeEvidence(f.context, f.binding.alias, f.event.id, f.options({ native: true })), second = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(first.reason, 'kimi-session-load-not-requested'); assert.equal(second.reason, 'kimi-session-load-not-requested'); assert.equal(f.contacts, 0);
  assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});

test('unavailable native evidence is redacted, closes its client and neither repairs nor prompts', budget, async t => {
  const f = await fixture(t); await f.lost(); const before = await f.runtime();
  f.client.inputEvidence = async () => { throw new Error('PRIVATE_NATIVE_BODY PRIVATE_TOKEN'); };
  const result = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.status, 'needs-review'); assert.equal(result.reason, 'native-unavailable'); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(f.contacts, 1); assert.equal(f.closes, 1); assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});

test('runtime publication failing before or after its write converges on retry without POST or cursor movement', budget, async t => {
  for (const point of ['before', 'after']) {
    const f = await fixture(t); await f.lost(); const before = await f.runtime();
    await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options({ publishRuntime: async (...args) => { if (point === 'after') await saveRuntime(...args); throw Object.assign(new Error('Synthetic runtime publication interruption'), { code: 'FIXTURE_PUBLISH_INTERRUPTED' }); } })), { code: 'FIXTURE_PUBLISH_INTERRUPTED' });
    assert.equal((await reconcileNative(f.context, f.binding.alias, f.event.id, f.options())).status, 'reconciled');
    const after = await f.runtime(); assert.equal(after.cursor, before.cursor); assert.deepEqual(after.nativePending, before.nativePending); assert.deepEqual(after.outgoingPending, before.outgoingPending); assert.equal(f.posts, 1);
  }
});

test('an existing recovery checkpoint changed during native query is retained without publishing a stale runtime delta', budget, async t => {
  const f = await fixture(t); await f.lost();
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options({ checkpointHook: async point => { if (point === 'control-committed') throw Object.assign(new Error('Synthetic checkpoint interruption'), { code: 'FIXTURE_CHECKPOINT_INTERRUPTED' }); } })), { code: 'FIXTURE_CHECKPOINT_INTERRUPTED' });
  const before = await f.runtime(), replacement = randomUUID();
  f.setOnEvidence(async () => { await withStore(f.context, store => { store.nativeIntents[f.rowId].recovery.id = replacement; }); });
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()));
  assert.equal((await readStore(f.context)).nativeIntents[f.rowId].recovery.id, replacement); assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});

test('signed remote ingress can be admitted and repaired with its exact global inbox association', budget, async t => {
  const f = await fixture(t, { remote: true });
  assert.equal(f.event.data.intent, 'inform'); assert.equal(f.event.data.sender_kind, 'external');
  await f.lost(); assert.equal(f.posts, 1, 'Valid signed ingress must reach one synthetic adapter prompt before receipt loss.');
  const result = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.status, 'reconciled'); const store = await readStore(f.context), receipt = (await f.runtime()).receipts[f.event.id];
  assert.equal(receipt.globalMessageId, f.frame.globalMessageId); assert.equal(store.inbox[f.frame.globalMessageId].status, 'native-admitted');
  assert.equal(store.inbox[f.frame.globalMessageId].inputId, f.rowId); assert.equal(store.inbox[f.frame.globalMessageId].sessionId, f.binding.sessionId); assert.equal(f.posts, 1);
});

test('native repair refuses a signed remote inbox association whose source node changed during evidence lookup', budget, async t => {
  const f = await fixture(t, { remote: true }); await f.lost(); assert.equal(f.posts, 1, 'The synthetic remote precondition must include one fake adapter prompt call.');
  const before = await f.runtime(), changedNode = 'n_' + 'f'.repeat(64);
  f.setOnEvidence(async () => { await withStore(f.context, store => { store.inbox[f.frame.globalMessageId].senderNodeId = changedNode; }); });
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()));
  assert.equal((await readStore(f.context)).inbox[f.frame.globalMessageId].senderNodeId, changedNode); assert.deepEqual(await f.runtime(), before); assert.equal(f.posts, 1);
});
