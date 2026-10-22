import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHub } from '../lib/hub.mjs';
import { HubClient } from '../lib/client.mjs';
import { runNode } from '../lib/node.mjs';

const id = () => `msg_${randomUUID()}`;
async function until(fn, label = 'condition') {
  const deadline = Date.now() + 5000;
  do { if (await fn()) return; await sleep(20); } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}
async function fixture(t, modes = ['native-push', 'native-push', 'tool-pull']) {
  const directory = await mkdtemp(join(tmpdir(), 'adl-node-test-'));
  const hub = await startHub({ dbPath: join(directory, 'hub.db'), adminToken: 'test-node-admin-credential-at-least-24' });
  const closers = [];
  t.after(async () => { await Promise.all(closers.map(close => close())); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const admin = new HubClient({ url: hub.url, token: 'test-node-admin-credential-at-least-24' });
  const enrollment = await admin.request('POST', '/v1/enrollments', {});
  const enrolled = await admin.request('POST', '/v1/enroll', { code: enrollment.code, label: 'test-machine' });
  const client = new HubClient({ url: hub.url, token: enrolled.token });
  const room = await admin.request('POST', '/v1/rooms', { label: 'project-room' });
  const agents = [];
  for (let i = 0; i < modes.length; i++) {
    const agent = await client.request('POST', '/v1/agents', { alias: `chat-${i}`, harness: 'opencode', mode: modes[i], binding: {
      serviceIdentity: { serviceId: 'service-test', origin: 'http://127.0.0.1:1', version: '2.0.20' },
      sessionId: `ses_test${i}`, projectDirectory: directory, projectId: 'project-test',
    } });
    await admin.request('POST', '/v1/members', { room: room.id, agentId: agent.id });
    agents.push(agent);
  }
  const scope = await admin.request('POST', '/v1/scopes', { agentId: agents.at(-1).id, rooms: [room.id] });
  const sender = new HubClient({ url: hub.url, token: scope.token });
  const send = async (agent, text = 'collaborate') => {
    const messageId = id();
    await sender.request('POST', '/v1/messages', { id: messageId, room: room.id, to: [agent.id], text });
    return messageId;
  };
  const status = async messageId => (await admin.request('GET', `/v1/status?id=${messageId}`)).deliveries[0].state;
  const start = async options => {
    const node = await runNode({ client, pollMs: 20, ...options }); closers.push(node.close); return node;
  };
  return { hub, admin, client, room, agents, sender, send, status, start };
}

test('offline recipients persist; busy chat does not block ready chat; tool pull is never pushed', async t => {
  const f = await fixture(t);
  const [busy, ready, pull] = f.agents;
  const first = await f.send(busy), second = await f.send(ready), tool = await f.send(pull);
  assert.equal(await f.status(first), 'queued');
  let isBusy = true; const submissions = [];
  await f.start({ adapterFactory: agent => ({
    inspect: async () => ({ state: agent.id === busy.id && isBusy ? 'busy' : 'ready' }),
    submit: async message => { submissions.push(message.id); },
  }) });
  await until(async () => await f.status(second) === 'delivered');
  assert.equal(await f.status(first), 'queued');
  assert.equal(await f.status(tool), 'queued');
  isBusy = false;
  await until(async () => await f.status(first) === 'delivered');
  assert.deepEqual(submissions.sort(), [first, second].sort());
});

test('same chat serializes submissions while another chat can continue', async t => {
  const f = await fixture(t);
  const first = await f.send(f.agents[0]), second = await f.send(f.agents[0]), third = await f.send(f.agents[1]);
  let active = 0, max = 0, release;
  const started = [];
  const held = new Promise(resolve => { release = resolve; });
  await f.start({ adapterFactory: agent => ({
    inspect: async () => ({ state: 'ready' }),
    submit: async message => {
      started.push(message.id);
      if (agent.id === f.agents[0].id) {
        active++; max = Math.max(max, active);
        if (message.id === first) await held;
        active--;
      }
    },
  }) });
  await until(async () => await f.status(third) === 'delivered');
  assert.equal(started.includes(second), false);
  release();
  await until(async () => await f.status(second) === 'delivered');
  assert.equal(max, 1);
});

test('uncertain native result blocks only that chat, never leaks native errors or resubmits', async t => {
  const f = await fixture(t);
  const first = await f.send(f.agents[0]), second = await f.send(f.agents[0]), other = await f.send(f.agents[1]);
  const calls = [];
  const node = await f.start({ adapterFactory: agent => ({
    inspect: async () => ({ state: 'ready' }),
    submit: async message => { calls.push(message.id); if (agent.id === f.agents[0].id) throw new Error('Bearer do-not-expose-native-secret'); },
  }) });
  await until(async () => await f.status(first) === 'unknown' && await f.status(other) === 'delivered');
  await sleep(350);
  assert.equal(await f.status(second), 'queued');
  assert.equal(calls.filter(value => value === first).length, 1);
  assert.equal(calls.includes(second), false);
  const health = await (await fetch(`${node.url}/health`)).text();
  assert.equal(health.includes('do-not-expose'), false);
  const persisted = await f.admin.request('GET', `/v1/status?id=${first}`);
  assert.equal(JSON.stringify(persisted).includes('do-not-expose'), false);
});

test('lost begin response is marked unknown without calling native submit and remains blocked after restart', async t => {
  const f = await fixture(t, ['native-push', 'tool-pull']);
  const messageId = await f.send(f.agents[0]);
  let calls = 0, lost = false;
  const client = { request: async (...args) => {
    const result = await f.client.request(...args);
    if (args[1] === '/v1/deliveries/begin' && !lost) { lost = true; throw new Error('response lost'); }
    return result;
  } };
  const node = await f.start({ client, adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async () => { calls++; } }) });
  await until(async () => await f.status(messageId) === 'unknown');
  assert.equal(calls, 0);
  await node.close();
  await f.start({ adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async () => { calls++; } }) });
  await sleep(350);
  assert.equal(calls, 0);
  assert.equal(await f.status(messageId), 'unknown');
});

test('proven pre-submit busy may requeue, then submit once when ready', async t => {
  const f = await fixture(t, ['native-push', 'tool-pull']);
  const messageId = await f.send(f.agents[0]);
  let attempts = 0, nativePosts = 0;
  await f.start({ adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async () => {
    if (++attempts === 1) throw Object.assign(new Error('became busy'), { notSubmitted: true, retryable: true });
    nativePosts++;
  } }) });
  await until(async () => await f.status(messageId) === 'delivered');
  assert.equal(attempts, 2); assert.equal(nativePosts, 1);
});

test('malformed begin responses never authorize a native submission', async t => {
  const f = await fixture(t, ['native-push', 'tool-pull']);
  const messageId = await f.send(f.agents[0]); let posts = 0;
  const client = { request: async (...args) => {
    const result = await f.client.request(...args);
    return args[1] === '/v1/deliveries/begin' ? { granted: true } : result;
  } };
  await f.start({ client, adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async () => { posts++; } }) });
  await until(async () => await f.status(messageId) === 'unknown');
  assert.equal(posts, 0);
});

test('lost receipt report after native success never resubmits or advances that chat blindly', async t => {
  const f = await fixture(t, ['native-push', 'tool-pull']);
  const first = await f.send(f.agents[0]), second = await f.send(f.agents[0]);
  let posts = 0, lost = false;
  const client = { request: async (...args) => {
    const result = await f.client.request(...args);
    if (args[1] === '/v1/deliveries/result' && !lost) { lost = true; throw new Error('receipt response lost'); }
    return result;
  } };
  const node = await f.start({ client, adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async () => { posts++; } }) });
  await until(async () => await f.status(first) === 'delivered');
  await sleep(350);
  assert.equal(posts, 1);
  assert.equal(await f.status(second), 'queued');
  const health = await (await fetch(`${node.url}/health`)).json();
  assert.equal(health.statuses.find(status => status.agentId === f.agents[0].id).state, 'blocked');
});

test('duplicate Node health port fails before joining the Hub; listener is loopback only', async t => {
  const f = await fixture(t, ['tool-pull']);
  const node = await f.start({});
  const port = Number(new URL(node.url).port);
  await assert.rejects(runNode({ client: f.client, port }), error => error.code === 'EADDRINUSE');
  await assert.rejects(runNode({ client: f.client, host: '0.0.0.0' }), /loopback/);
  const health = await fetch(`${node.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await fetch(`${node.url}/other`)).status, 404);
});
