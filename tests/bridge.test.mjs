import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeEnvironment, validateNative, inputId, shellQuote, deliveryPrompt, reconcile, ensureSessionReady, drainOwned, drainGuarded, validateDelivery, bridgeStatus, startBridge, detach, collabSend, roomCreate } from '../lib/bridge.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';

const binding = { id: 'b_local', revision: 1, alias: 'researcher', sessionId: 'ses_abc', projectId: 'p', directory: '/tmp/project', serviceId: 'service', origin: 'http://127.0.0.1:1234' };
const native = { id: 'ses_abc', projectID: 'p', location: { directory: '/tmp/project' }, time: {} };
test('bridge subprocess cannot inherit parent hcom/harness identity', () => {
  const env = bridgeEnvironment({ stateDir: '/tmp/bridge', env: { HCOM_PROCESS_ID: 'parent', HCOM_NAME: 'parent', CODEX_THREAD_ID: 'parent-chat', CLAUDE_SESSION_ID: 'parent', PATH: '/bin', KEEP: 'safe' } });
  assert.equal(env.HCOM_PROCESS_ID, undefined); assert.equal(env.HCOM_NAME, undefined);
  assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CLAUDE_SESSION_ID, undefined);
  assert.equal(env.HCOM_DIR, '/tmp/bridge'); assert.equal(env.KEEP, 'safe');
});
test('native guard requires exact service, session, project and directory before admission', async () => {
  const requested = [];
  const client = { identity: { serviceId: 'service', origin: binding.origin }, session: async id => { requested.push(id); return native; } };
  assert.deepEqual(await validateNative(client, binding), native);
  assert.deepEqual(requested, ['ses_abc']);
  for (const patch of [{ serviceId: 'other' }, { origin: 'http://127.0.0.1:9876' }, { projectId: 'other' }, { sessionId: 'ses_wrong' }, { directory: '/tmp/other' }]) {
    await assert.rejects(validateNative(client, { ...binding, ...patch }), /identity changed|does not match/);
  }
  await assert.rejects(validateNative({ ...client, session: async () => ({ ...native, time: { archived: 12 } }) }, binding), /does not match/);
});
test('stable input IDs isolate bindings, revisions and hcom events', () => {
  assert.equal(inputId(binding, 10), inputId(binding, 10));
  assert.notEqual(inputId(binding, 10), inputId(binding, 11));
  assert.notEqual(inputId(binding, 10), inputId({ ...binding, revision: 2 }, 10));
  assert.notEqual(inputId(binding, 10), inputId({ ...binding, id: 'b_other' }, 10));
});
test('injected instructions preserve existing context and use shell quoted absolute CLI/state', () => {
  assert.equal(shellQuote("a'b$(danger)"), "'a'\\''b$(danger)'");
  const text = deliveryPrompt({ stateDir: "/tmp/user's state" }, binding, { room: 'r_1', from: 'reviewer', replyTo: null, text: 'project fact' }, { id: 42 });
  assert.match(text, /Exact existing session: ses_abc/); assert.match(text, /--reply-to 42/);
  assert.match(text, /\/bin\/agent-dialogue.mjs/); assert.match(text, /project fact/);
  assert.match(text, /shares your existing project context/);
});
test('reconciliation checks durable inbox and native message IDs rather than SSE delivery', async () => {
  const client = { inbox: async id => { assert.equal(id, 'ses_abc'); return [{ id: 'msg_one' }]; }, messages: async () => [{ id: 'msg_two' }] };
  assert.equal(await reconcile(client, binding, 'msg_one'), true);
  assert.equal(await reconcile(client, binding, 'msg_two'), true);
  assert.equal(await reconcile(client, binding, 'msg_absent'), false);
});

test('agent reply instructions carry the complete configured runtime across harness environments', () => {
  const context = { stateDir: '/tmp/my state', cacheDir: '/tmp/my cache', binary: '/tmp/custom hcom', env: { AGENT_DIALOGUE_HCOM: '/tmp/custom hcom', AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: '/tmp/my service.json' } };
  const text = deliveryPrompt(context, binding, { room: 'r_1', from: 'reviewer', replyTo: null, text: 'Project question' }, { id: 43 });
  assert.match(text, /AGENT_DIALOGUE_STATE_DIR='\/tmp\/my state'/);
  assert.match(text, /AGENT_DIALOGUE_CACHE_DIR='\/tmp\/my cache'/);
  assert.match(text, /AGENT_DIALOGUE_HCOM='\/tmp\/custom hcom'/);
  assert.match(text, /AGENT_DIALOGUE_OPENCODE_SERVICE_FILE='\/tmp\/my service.json'/);
});

test('Codex existing-thread loading requires explicit consent and preserves the exact thread', async () => {
  const unloaded = { id: 'original-thread', native: { loaded: false, canAcceptDirectInput: true } };
  let resumes = 0;
  const client = { capabilities: { existingLoadedOnly: true }, resumeThread: async id => { resumes++; assert.equal(id, unloaded.id); return { ...unloaded, native: { loaded: true, canAcceptDirectInput: true } }; } };
  await assert.rejects(ensureSessionReady(client, unloaded), error => error.retryable && /--resume/.test(error.message));
  assert.equal(resumes, 0);
  const loaded = await ensureSessionReady(client, unloaded, { resume: true });
  assert.equal(loaded.id, unloaded.id); assert.equal(resumes, 1);
  assert.equal(await ensureSessionReady(client, loaded, { resume: true }), loaded);
  assert.equal(resumes, 1, 'already-loaded threads must not be resumed again');
  await assert.rejects(ensureSessionReady({ ...client, resumeThread: async () => ({ ...loaded, id: 'other-thread' }) }, unloaded, { resume: true }), /different thread/);
  await assert.rejects(ensureSessionReady(client, { ...loaded, native: { loaded: true, canAcceptDirectInput: false } }), /accept direct input/);
  assert.equal(await ensureSessionReady({ capabilities: { existingAttach: true } }, native), native);
});

test('worker drain supplies only its own admitted IDs in this exact native session', async () => {
  const received = [];
  const client = { drain: async (...args) => { received.push(args); return { started: false }; } };
  const state = { receipts: {
    1: { status: 'admitted', sessionId: binding.sessionId, inputId: 'msg_owned' },
    2: { status: 'rejected', sessionId: binding.sessionId, inputId: 'msg_rejected' },
    3: { status: 'admitted', sessionId: 'other-session', inputId: 'msg_other' },
    4: { status: 'admitted', sessionId: binding.sessionId, inputId: 'msg_owned' },
  } };
  await drainOwned(client, binding, state);
  assert.deepEqual(received, [[binding.sessionId, { inputIds: ['msg_owned'], expectedBinding: binding }]]);
  assert.equal(await drainOwned({}, binding, state), null);
});

test('cross-node reply instructions use global IDs and preserve the configured Codex daemon', () => {
  const context = { stateDir: '/tmp/space', env: { CODEX_HOME: '/tmp/codex home', AGENT_DIALOGUE_CODEX_SOCKET: '/tmp/codex daemon.sock' } };
  const frame = { room: 'r_1', from: 'peer', text: 'Project question', replyTo: null, globalMessageId: 'm_global-message' };
  const text = deliveryPrompt(context, binding, frame, { id: 44 });
  assert.match(text, /--reply-to 'm_global-message'/);
  assert.doesNotMatch(text, /--reply-to 44/);
  assert.match(text, /CODEX_HOME='\/tmp\/codex home'/);
  assert.match(text, /AGENT_DIALOGUE_CODEX_SOCKET='\/tmp\/codex daemon.sock'/);
});

function routingFixture() {
  const store = { version: 1, bindings: {}, rooms: {} };
  const input = alias => ({ ...binding, alias, harness: 'opencode-v2', sessionId: `ses_${alias}` });
  const a = createBinding(store, input('alice')), b = createBinding(store, input('bob'));
  const room = createRoom(store, { name: 'Project', members: ['alice', 'bob'] });
  const frame = { version: 1, room: room.id, from: a.alias, to: b.alias, fromBindingId: a.id, toBindingId: b.id, fromRevision: 1, toRevision: 1, text: 'Project context', replyTo: null };
  const event = { id: 42, data: { from: a.hcomName, sender_kind: 'instance' } };
  return { store, a, b, frame, event };
}

test('receiver refuses unverified remote claims and mismatched local sender identities', async () => {
  const { store, a, b, frame, event } = routingFixture();
  assert.equal(await validateDelivery({}, store, b, frame, event), null);
  await assert.rejects(validateDelivery({}, store, b, frame, { ...event, data: { ...event.data, from: 'other-hcom-name' } }), /sender does not match/);
  await assert.rejects(validateDelivery({}, store, b, frame, { ...event, data: { ...event.data, sender_kind: 'external' } }), /sender does not match/);
  a.remote = true;
  await assert.rejects(validateDelivery({}, store, b, frame, event), /verified signed ingress/);
  await assert.rejects(validateDelivery({}, store, { ...b, remote: true }, frame, event), /destination was changed/);
});

test('remote descriptors have no local managed worker and cannot impersonate local senders', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-remote-binding-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir }, { store, a, b, frame } = routingFixture();
  a.remote = true;
  await withStore(context, live => Object.assign(live, store));
  const status = await bridgeStatus(context);
  assert.deepEqual(status.bindings.find(item => item.alias === a.alias).worker, { managed: false, running: false, status: 'remote' });
  await assert.rejects(startBridge(context, a.alias), /no local managed worker/);
  await assert.rejects(collabSend(context, { room: frame.room, from: a.alias, to: b.alias, text: 'spoofed' }), /different node/);
  assert.equal((await detach(context, a.alias)).nativeSessionPreserved, true);
  assert.equal((await readStore(context)).bindings[a.alias].active, false);
});

test('new room is sealed with persistent node pins after releasing the create lock', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-room-seal-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir }, { store } = routingFixture();
  await withStore(context, live => Object.assign(live, store));
  const room = await roomCreate(context, { name: 'Sealed project', members: ['alice', 'bob'] });
  assert.equal(room.revision, 1); assert.match(room.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(room.ownerNodeId, /^n_[a-f0-9]{64}$/);
  assert.ok(room.members.every(pin => pin.nodeId === room.ownerNodeId));
  assert.equal((await readStore(context)).rooms[room.id].manifestHash, room.manifestHash);
});

test('execution rechecks identity and holds dispatch through native start while permitting control bookkeeping', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-drain-guard-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir }, liveBinding = { ...binding, id: 'b_12345678-1234-4234-8234-123456789abc', active: true };
  await withStore(context, store => { store.bindings[binding.alias] = liveBinding; });
  let starts = 0;
  const client = {
    identity: { serviceId: binding.serviceId, origin: binding.origin },
    session: async () => native,
    drain: async () => {
      starts++;
      // Ingress/control bookkeeping remains available; pause cannot pass its
      // shared dispatch gate between final identity validation and native start.
      await withStore(context, store => assert.equal(store.bindings[binding.alias].active, true));
      const { pauseBinding } = await import('../lib/lifecycle.mjs');
      await assert.rejects(pauseBinding(context, binding.alias, { timeoutMs: 0 }), error => error.code === 'DISPATCH_BUSY');
      return { started: true };
    },
  };
  assert.deepEqual(await drainGuarded(context, client, liveBinding, {}), { started: true });
  await withStore(context, store => { store.bindings[binding.alias].active = false; });
  assert.deepEqual(await drainGuarded(context, client, liveBinding, {}), { started: false, reason: 'detached' });
  await withStore(context, store => { store.bindings[binding.alias].active = true; store.bindings[binding.alias].revision++; });
  await assert.rejects(drainGuarded(context, client, liveBinding, {}), error => error.code === 'BINDING_CHANGED');
  await withStore(context, store => { store.bindings[binding.alias].revision = liveBinding.revision; });
  client.session = async () => ({ ...native, location: { directory: '/tmp/changed-project' } });
  await assert.rejects(drainGuarded(context, client, liveBinding, {}), /Native session\/project\/directory/);
  assert.equal(starts, 1);
});
