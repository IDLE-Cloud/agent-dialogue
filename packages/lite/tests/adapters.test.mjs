import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingFor, inspectBinding, dialoguePrompt, nativeAdapter, discoverAdapter } from '../lib/adapters.mjs';

const identity = { serviceId: 'test-service', origin: 'http://127.0.0.1:8901', version: '2.0.20' };
const session = { id: 'ses_test', projectID: 'project-test', location: { directory: '/project/test' }, time: {} };
const client = { identity, session: async id => ({ ...session, id }) };

test('exact service, full session, project and directory form immutable chat binding', async () => {
  const binding = await bindingFor(client, session.id);
  assert.deepEqual(binding, { serviceIdentity: identity, sessionId: session.id, projectDirectory: '/project/test', projectId: 'project-test' });
  assert.equal((await inspectBinding(client, binding)).id, session.id);
  for (const changed of [
    { ...binding, serviceIdentity: { ...identity, serviceId: 'replacement-service' } },
    { ...binding, serviceIdentity: { ...identity, origin: 'http://127.0.0.1:8902' } },
    { ...binding, serviceIdentity: { ...identity, version: 'changed' } },
    { ...binding, projectId: 'other-project' }, { ...binding, projectDirectory: '/other' },
  ]) await assert.rejects(inspectBinding(client, changed), error => error.notSubmitted === true);
  await assert.rejects(inspectBinding({ ...client, session: async () => ({ ...session, id: 'ses_wrong' }) }, binding), /does not match/);
  await assert.rejects(inspectBinding({ ...client, session: async () => ({ ...session, time: { archived: 1 } }) }, binding), /does not match/);
  await assert.rejects(bindingFor(client, 'latest'), /complete native session ID/);
});

test('Windows absolute binding can be validated without adopting the local platform path rules', async () => {
  const windows = { ...client, session: async () => ({ ...session, location: { directory: 'E:\\Knowledgebase\\Project' } }) };
  const binding = await bindingFor(windows, session.id);
  assert.equal(binding.projectDirectory, 'E:\\Knowledgebase\\Project');
  assert.equal((await inspectBinding(windows, binding)).id, session.id);
});

test('native prompt preserves one message ID and scoped config without credentials', () => {
  const message = { id: 'msg_test', room: 'room_test', sender: 'agent_peer', text: '请检查项目\n$(not a shell command)' };
  const prompt = dialoguePrompt(message, { configPath: "/private/test's scope.json", cliPath: '/app/adl.mjs', powershell: false });
  assert.ok(prompt.includes('--reply-to msg_test'));
  assert.ok(prompt.includes('--to agent_peer'));
  assert.ok(prompt.includes('msg_UUID'));
  assert.ok(prompt.includes(JSON.stringify(message.text)));
  assert.ok(prompt.includes("test'\\''s scope.json"));
  assert.equal(prompt.includes('token'), false);
  const ps = dialoguePrompt(message, { configPath: "C:\\Users\\idle\\scope's.json", cliPath: 'C:\\adl.mjs', powershell: true });
  assert.ok(ps.includes("scope''s.json")); assert.ok(ps.includes('Inspect context: & '));
  assert.ok(dialoguePrompt(message).includes('not automatically forwarded'));
});

test('missing service or mismatched harness is unavailable before touching native service', async () => {
  const agent = { id: 'agent_test', mode: 'native-push', harness: 'opencode', binding: { serviceIdentity: identity } };
  assert.deepEqual(await nativeAdapter(agent).inspect(), { state: 'unavailable' });
  assert.deepEqual(await nativeAdapter(agent, { services: { 'test-service': { kind: 'opencode-v1' } } }).inspect(), { state: 'unavailable' });
});

async function nativeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'adl-native-contract-'));
  const controls = { active: {}, permissions: [], forms: [], posts: [], native: { ...session }, wrongReceipt: false };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('opencode:contract-private-password').toString('base64')}`);
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url, 'http://local').pathname;
    if (path === '/api/info') res.end(JSON.stringify({ version: '2.0.20' }));
    else if (path === '/api/session/ses_test') res.end(JSON.stringify({ data: controls.native }));
    else if (path === '/api/session/active') res.end(JSON.stringify({ data: controls.active }));
    else if (path === '/api/session/ses_test/permission') res.end(JSON.stringify({ data: controls.permissions }));
    else if (path === '/api/session/ses_test/form') res.end(JSON.stringify({ data: controls.forms }));
    else if (path === '/api/session/ses_test/prompt') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); controls.posts.push(body);
      res.end(JSON.stringify({ data: { id: body.id, sessionID: controls.wrongReceipt ? 'ses_other' : session.id, type: 'user' } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const serviceFile = join(directory, 'service.json');
  const descriptor = { id: 'contract-service', url: origin, version: '2.0.20', password: 'contract-private-password' };
  await writeFile(serviceFile, JSON.stringify(descriptor), { mode: 0o600 });
  const client = await discoverAdapter({ kind: 'opencode', serviceFile });
  const binding = await bindingFor(client, session.id);
  const agent = { id: 'agent_contract', harness: 'opencode', mode: 'native-push', binding };
  const adapter = nativeAdapter(agent, { services: { 'contract-service': { kind: 'opencode', serviceFile } } });
  return { ...controls, controls, adapter, descriptor, serviceFile, agent };
}

test('V2 native contract checks active drain, permission and forms without interrupting or approving', async t => {
  const f = await nativeFixture(t);
  const message = { id: 'msg_contract', room: 'room_contract', sender: 'agent_sender', text: 'check project' };
  assert.deepEqual(await f.adapter.inspect(), { state: 'ready' });
  for (const [key, busy] of [['active', { ses_test: { type: 'working' } }], ['permissions', [{ id: 'pending' }]], ['forms', [{ id: 'pending' }]]]) {
    f.controls[key] = busy;
    assert.deepEqual(await f.adapter.inspect(), { state: 'busy' });
    await assert.rejects(f.adapter.submit(message), error => error.notSubmitted && error.retryable);
    f.controls[key] = key === 'active' ? {} : [];
  }
  assert.equal(f.posts.length, 0);
  await f.adapter.submit(message);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].id, message.id);
  assert.equal(f.posts[0].delivery, 'queue');
  assert.equal(f.posts[0].text.includes('contract-private-password'), false);
});

test('V2 native contract rejects swapped descriptor, session directory, and receipt without blind POST retry', async t => {
  const f = await nativeFixture(t);
  await f.adapter.inspect();
  const message = { id: 'msg_contract', room: 'room_contract', sender: 'agent_sender', text: 'review' };
  f.controls.native = { ...session, location: { directory: '/wrong-project' } };
  await assert.rejects(f.adapter.submit(message), error => error.notSubmitted);
  assert.equal(f.posts.length, 0);
  f.controls.native = session;
  f.controls.wrongReceipt = true;
  await assert.rejects(f.adapter.submit(message), error => !error.notSubmitted && /receipt/.test(error.message));
  assert.equal(f.posts.length, 1);
  await writeFile(f.serviceFile, JSON.stringify({ ...f.descriptor, version: '2.0.21' }));
  await assert.rejects(f.adapter.submit(message), /identity changed/);
  assert.equal(f.posts.length, 1);
  await writeFile(f.serviceFile, JSON.stringify({ ...f.descriptor, id: 'replacement-service' }));
  await assert.rejects(f.adapter.submit(message), /identity changed/);
  assert.equal(f.posts.length, 1);
});
