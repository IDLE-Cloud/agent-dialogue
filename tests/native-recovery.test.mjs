import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, decodeFrame, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { eventById, hcom, saveRuntime, workerRuntimeSnapshot } from '../lib/bridge.mjs';
import { loadOrCreateNode, payloadHash } from '../lib/node-identity.mjs';
import { pauseBinding } from '../lib/lifecycle.mjs';
import { inputId } from '../lib/native-admission.mjs';
import { admitNativeGuarded, nativeEvidence, reconcileNative } from '../lib/native-recovery.mjs';

const budget = { timeout: process.platform === 'win32' ? 180000 : 15000 };
const dead = async () => 'confirmed-dead'; // Contract seam, not OS ownership proof.
async function fixture(t, { harness = 'opencode-v1', outcome = 'unknown' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ad-native-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const context = { stateDir: dir, ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded' } };
  const node = await loadOrCreateNode(context);
  const { binding, peer, room } = await withStore(context, store => {
    store.version = 4; store.lifecycle = {}; store.forwardings = {}; store.nativeIntents = {};
    const make = alias => { const b = createBinding(store, { alias, harness, sessionId: 'ses_' + alias, projectId: 'synthetic-project', directory: dir, serviceId: 'synthetic-service', origin: 'http://127.0.0.1:1' }); b.nodeId = node.nodeId; return b; };
    const binding = make('selected'), peer = make('peer');
    return { binding, peer, room: createRoom(store, { name: 'Native recovery fixture', members: [binding.alias, peer.alias] }) };
  });
  for (const b of [binding, peer]) await hcom(context, ['start', '--name', b.hcomName]);
  const frame = { version: 1, room: room.id, from: peer.alias, to: binding.alias, fromBindingId: peer.id, toBindingId: binding.id, fromRevision: peer.revision, toRevision: binding.revision, text: 'Keep this original project input.', replyTo: null };
  const sent = JSON.parse(await hcom(context, ['send', '--json', '--name', peer.hcomName, '@' + binding.hcomName, '--thread', room.id, '--intent', 'request', '--', encodeFrame(frame)]));
  const event = await eventById(context, sent.event_id), text = 'An exact old installation prefix and complete project prompt.';
  const state = { pid: 912345, token: randomUUID(), status: 'ready', cursor: 0, receipts: { 99: { status: 'retained', fixture: true } }, nativePending: { fixture: 'retain' }, outgoingPending: { fixture: 'also-retain' } };
  await withStore(context, store => { store.workerLaunches = { [binding.id]: { version: 1, bindingRevision: binding.revision, token: state.token, pid: state.pid, phase: 'ready' } }; });
  await saveRuntime(context, binding.id, state);
  const inputs = new Map(); let posts = 0, contacts = 0, closes = 0;
  const client = {
    identity: { serviceId: binding.serviceId, origin: binding.origin },
    session: async id => ({ id, projectID: binding.projectId, location: { directory: binding.directory }, time: {} }),
    prompt: async (sessionId, request) => {
      posts++;
      if (outcome === 'not-submitted') throw Object.assign(new Error('synthetic busy'), { notSubmitted: true, nativeBusy: true });
      inputs.set(request.id, { sessionId, inputId: request.id, role: 'user', text: request.text, storage: 'persisted' });
      if (outcome === 'unknown') throw new Error('lost acknowledgement');
      return { id: request.id };
    },
    inputEvidence: async (_, id) => inputs.get(id) ?? null,
    inbox: async () => { throw new Error('ID-only fallback forbidden'); },
    messages: async () => { throw new Error('History fallback forbidden'); },
    close: async () => { closes++; },
  };
  const factory = async () => { contacts++; return client; };
  const persist = value => saveRuntime(context, binding.id, value);
  const admit = overrides => admitNativeGuarded(context, binding, frame, event, state, { client, text, persist, ...overrides });
  const stop = async () => {
    state.status = 'error'; state.error = 'synthetic uncertain admission'; await persist(state);
    await withStore(context, store => { store.workerLaunches[binding.id].phase = 'stopped'; });
    await pauseBinding(context, binding.alias);
  };
  const runtime = async () => (await workerRuntimeSnapshot(context, binding.id)).state;
  const options = overrides => ({ nativeFactory: factory, probe: dead, ...overrides });
  return { context, binding, peer, room, event, frame, text, state, client, inputs, admit, stop, runtime, options, persist, get posts() { return posts; }, get contacts() { return contacts; }, get closes() { return closes; } };
}
const uncertain = e => e.code === 'NATIVE_RECOVERY_NEEDS_REVIEW' && e.uncertain === true;
async function lostReceipt(f) {
  delete f.client.inputEvidence;
  await assert.rejects(f.admit(), uncertain);
  f.client.inputEvidence = async (_, id) => f.inputs.get(id) ?? null;
  await f.stop();
}

test('v4 saves exact native provenance before one POST and returns one fixed admitted receipt', budget, async t => {
  const f = await fixture(t, { outcome: 'success' });
  const receipt = await f.admit(), row = (await readStore(f.context)).nativeIntents[inputId(f.binding, f.event.id)];
  assert.equal(f.posts, 1); assert.equal(row.phase, 'admitted'); assert.equal(row.promptHash, payloadHash(f.text));
  assert.equal(row.eventHash, payloadHash(f.event)); assert.equal(row.frameHash, payloadHash(decodeFrame(f.event.data.text)));
  assert.deepEqual(receipt, row.receipt); assert.equal(receipt.sessionId, f.binding.sessionId);
  assert.equal(JSON.stringify(row).includes(f.text), false);
});
test('pending persistence failure prevents POST and keeps the prepared native intent', budget, async t => {
  const f = await fixture(t);
  await assert.rejects(f.admit({ persist: async () => { throw new Error('disk failure'); } }), uncertain);
  assert.equal(f.posts, 0); assert.equal((await readStore(f.context)).nativeIntents[inputId(f.binding, f.event.id)].phase, 'prepared');
});
test('unknown POST is reconciled only from complete persisted input without another POST', budget, async t => {
  const f = await fixture(t);
  assert.equal((await f.admit()).reconciled, true); assert.equal(f.posts, 1);
});
test('local evidence is read-only and does not contact native or change state bytes', budget, async t => {
  const f = await fixture(t); await lostReceipt(f);
  const path = join(f.context.stateDir, 'dialogue', 'store.json'), before = await readFile(path), runtime = await f.runtime();
  const result = await nativeEvidence(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.status, 'not-probed'); assert.equal(f.contacts, 0);
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await f.runtime(), runtime);
});
test('stopped native repair preserves cursor and every unrelated runtime field and is idempotent', budget, async t => {
  const f = await fixture(t); await lostReceipt(f); const before = await f.runtime();
  assert.equal((await nativeEvidence(f.context, f.binding.alias, f.event.id, f.options({ native: true }))).status, 'verified');
  const result = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.status, 'reconciled'); assert.equal(result.cursorPreserved, true);
  const after = await f.runtime(), row = (await readStore(f.context)).nativeIntents[inputId(f.binding, f.event.id)];
  const expected = structuredClone(before); delete expected.pending; expected.receipts[f.event.id] = row.receipt;
  assert.deepEqual(after, expected); assert.equal(row.recovery.phase, 'runtime-committed'); assert.equal(f.posts, 1);
  const path = join(f.context.stateDir, 'dialogue', 'store.json'), storeBytes = await readFile(path), runtimeBytes = await readFile(join(f.context.stateDir, 'dialogue', f.binding.id + '.worker.json'));
  assert.equal((await reconcileNative(f.context, f.binding.alias, f.event.id, f.options())).runtimeChanged, false);
  assert.deepEqual(await readFile(path), storeBytes); assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', f.binding.id + '.worker.json')), runtimeBytes);
});
for (const point of ['control-committed', 'runtime-published']) test('native repair retries after ' + point + ' without another POST', budget, async t => {
  const f = await fixture(t); await lostReceipt(f);
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options({ checkpointHook: async p => { if (p === point) throw Object.assign(new Error('interrupted'), { code: 'FIXTURE_INTERRUPTED' }); } })), { code: 'FIXTURE_INTERRUPTED' });
  assert.equal((await reconcileNative(f.context, f.binding.alias, f.event.id, f.options())).status, 'reconciled');
  assert.equal(f.posts, 1); assert.equal((await f.runtime()).cursor, 0);
});
test('Kimi evidence requires explicit session-load permission before discovery', budget, async t => {
  const f = await fixture(t, { harness: 'kimi-code' }); await lostReceipt(f);
  const result = await nativeEvidence(f.context, f.binding.alias, f.event.id, f.options({ native: true }));
  assert.equal(result.reason, 'kimi-session-load-not-requested'); assert.equal(f.contacts, 0);
  assert.equal((await nativeEvidence(f.context, f.binding.alias, f.event.id, f.options({ native: true, allowSessionLoad: true }))).status, 'verified');
});
test('same native ID with wrong content remains pending with no repair or POST', budget, async t => {
  const f = await fixture(t); await lostReceipt(f);
  f.inputs.get(inputId(f.binding, f.event.id)).text = 'different input';
  const before = await f.runtime(), store = await readFile(join(f.context.stateDir, 'dialogue', 'store.json'));
  const result = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.status, 'needs-review'); assert.equal(result.reason, 'input-mismatch');
  assert.deepEqual(await f.runtime(), before); assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', 'store.json')), store); assert.equal(f.posts, 1);
});
test('missing native provenance does not bootstrap an old pending input', budget, async t => {
  const f = await fixture(t);
  f.state.pending = { eventId: f.event.id, inputId: inputId(f.binding, f.event.id), bindingRevision: f.binding.revision, status: 'submitting' }; await f.stop();
  const result = await reconcileNative(f.context, f.binding.alias, f.event.id, f.options());
  assert.equal(result.reason, 'legacy-or-missing-native-provenance'); assert.equal(f.contacts, 0); assert.equal(f.posts, 0);
});
test('live or unknown owner and new worker lock reject native repair before querying', budget, async t => {
  const f = await fixture(t); await lostReceipt(f);
  for (const answer of ['owned-live', 'unknown']) await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options({ probe: async () => answer })), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
  await mkdir(join(f.context.stateDir, 'dialogue', f.binding.id + '.worker.lock'));
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
  assert.equal(f.contacts, 0);
});
test('runtime changes after checkpoint are retained and cannot be overwritten on retry', budget, async t => {
  const f = await fixture(t); await lostReceipt(f); let changed;
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options({ checkpointHook: async point => {
    if (point === 'control-committed') { changed = await f.runtime(); changed.nativePending.changed = true; await f.persist(changed); }
  } })), uncertain);
  assert.deepEqual(await f.runtime(), changed);
  await assert.rejects(reconcileNative(f.context, f.binding.alias, f.event.id, f.options()), uncertain);
  assert.deepEqual(await f.runtime(), changed); assert.equal(f.posts, 1);
});
