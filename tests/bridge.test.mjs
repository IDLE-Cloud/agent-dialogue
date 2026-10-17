import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeEnvironment, validateNative, inputId, shellQuote, deliveryPrompt, reconcile } from '../lib/bridge.mjs';

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
