import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessId, inspectBinding, listNative, nativeClient, withNative } from '../lib/adapters.mjs';

const identity = { serviceId: 'local-service', origin: 'local://native-service', version: 'test-version' };
const binding = { harness: 'opencode-v2', serviceId: identity.serviceId, origin: identity.origin, sessionId: 'ses_existing', projectId: 'project-one', directory: '/workspace/project' };
const session = { id: binding.sessionId, projectID: binding.projectId, location: { directory: binding.directory }, title: 'Existing project', time: { created: 1, updated: 2 } };
function fake(overrides = {}) {
  return {
    identity,
    session: async () => structuredClone(session),
    prompt: async () => {}, inbox: async () => [], messages: async () => [], sessions: async () => [structuredClone(session)],
    ...overrides,
  };
}

test('normalizes explicit harness aliases and rejects unavailable adapters', () => {
  assert.equal(harnessId('opencode'), 'opencode-v2'); assert.equal(harnessId('opencode-v2'), 'opencode-v2');
  assert.equal(harnessId('codex'), 'codex-app-server'); assert.equal(harnessId('codex-app-server'), 'codex-app-server');
  for (const tool of [undefined, null, '', 'pi', 'kimi-cli', 'latest', 'CODEX']) assert.throws(() => harnessId(tool), /Unsupported native harness/);
});

test('factory receives normalized harness/context and retains instance methods and capabilities', async () => {
  class Adapter {
    #session = session;
    identity = identity;
    async session() { return this.#session; }
    async prompt() {} async inbox() { return []; } async messages() { return []; }
  }
  const adapter = new Adapter(), context = { env: { KEEP: 'yes' } };
  const opened = await nativeClient(context, 'opencode', { factory: async (harness, passed) => { assert.equal(harness, 'opencode-v2'); assert.equal(passed, context); return adapter; } });
  assert.equal(opened, adapter); assert.equal(await opened.session(), session);
  assert.deepEqual(opened.capabilities, { existingAttach: true, queue: true, stableInputId: true, resume: false });
  const capabilities = { existingAttach: false, loadedOnly: true };
  const codex = fake({ capabilities });
  assert.equal((await nativeClient(context, 'codex', { factory: () => codex })).capabilities, capabilities);
});

test('withNative closes exactly once on callback success or failure and rejects malformed clients', async () => {
  for (const failure of [false, true]) {
    let closed = 0;
    const adapter = fake({ close: async () => { closed++; } });
    const invoke = () => withNative({}, 'codex', async value => { assert.equal(value, adapter); if (failure) throw new Error('callback failed'); return 'result'; }, { factory: () => adapter });
    if (failure) await assert.rejects(invoke(), /callback failed/); else assert.equal(await invoke(), 'result');
    assert.equal(closed, 1);
  }
  let closed = 0;
  await assert.rejects(nativeClient({}, 'codex', { factory: () => ({ identity, close() { closed++; } }) }), /required session interface/);
  assert.equal(closed, 1);
});

test('binding inspection checks authoritative service and session metadata without imposing loaded state', async () => {
  assert.equal((await inspectBinding(fake(), binding)).id, binding.sessionId);
  assert.equal((await inspectBinding(fake({ session: async () => ({ ...session, loaded: false }) }), binding)).loaded, false);
  const noCalls = fake({ session: async () => assert.fail('must fail before native lookup') });
  await assert.rejects(inspectBinding(noCalls, { ...binding, remote: true }), /remote binding/);
  await assert.rejects(inspectBinding(noCalls, { ...binding, serviceId: 'other' }), /service identity/);
  await assert.rejects(inspectBinding(noCalls, { ...binding, origin: 'local://other' }), /service identity/);
  for (const value of [
    { ...session, id: 'other-session' }, { ...session, projectID: 'other-project' },
    { ...session, location: { directory: '/unrelated/project' } }, { ...session, location: {} },
    { ...session, time: { archived: 1 } },
  ]) await assert.rejects(inspectBinding(fake({ session: async () => value }), binding), /session\/project\/directory/);
});

test('listing passes an exact directory filter and whitelists native metadata', async () => {
  let closed = 0, received;
  const adapter = fake({
    identity: { ...identity, password: 'must-not-list' },
    sessions: async options => {
      received = options;
      return [
        { ...session, loaded: true, password: 'private', model: { id: 'model', providerID: 'provider', apiKey: 'hidden' }, time: { ...session.time, secret: 'hidden' } },
        { ...session, id: 'ses_other', location: { directory: '/other/project' } },
      ];
    },
    close: async () => { closed++; },
  });
  const result = await listNative({}, 'opencode', { directory: '/workspace/./project', factory: () => adapter });
  assert.deepEqual(received, { directory: '/workspace/project' });
  assert.equal(result.harness, 'opencode-v2'); assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].loaded, true);
  assert.deepEqual(result.sessions[0].model, { id: 'model', providerID: 'provider' });
  assert.deepEqual(result.sessions[0].time, session.time);
  assert.ok(!JSON.stringify(result).includes('must-not-list')); assert.ok(!JSON.stringify(result).includes('hidden')); assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(closed, 1);
});

test('listing closes after API failure and distinguishes unknown loaded status', async () => {
  const result = await listNative({}, 'codex', { factory: () => fake({ capabilities: { existingAttach: false } }) });
  assert.equal(result.sessions[0].loaded, null);
  let closed = 0;
  await assert.rejects(listNative({}, 'codex', { factory: () => fake({ sessions: async () => { throw new Error('offline'); }, close: async () => { closed++; } }) }), /offline/);
  assert.equal(closed, 1);
  await assert.rejects(listNative({}, 'codex', { directory: '', factory: () => assert.fail('must not open') }), /directory filter/);
});
