import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startHub } from '../lib/hub.mjs';
import { HubClient, ApiError, newId } from '../lib/client.mjs';
import { waitForInbox } from '../lib/wait.mjs';

async function until(check) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert(performance.now() < deadline, 'Timed out waiting for the request to reach the Hub.');
    await delay(5);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'adl-wait-test-'));
  const adminToken = 'test_wait_admin_' + 'a'.repeat(32);
  const hub = await startHub({ dbPath: join(directory, 'hub.sqlite'), adminToken });
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const admin = new HubClient({ url: hub.url, token: adminToken });
  const enrollment = await admin.request('POST', '/v1/enrollments', {});
  const node = await admin.request('POST', '/v1/enroll', { code: enrollment.code, label: 'test-node' });
  const machine = new HubClient({ url: hub.url, token: node.token });
  const agents = [];
  for (const alias of ['alice', 'bob', 'charlie']) {
    agents.push(await machine.request('POST', '/v1/agents', { alias, harness: 'tool', mode: 'tool-pull', binding: {
      serviceIdentity: { serviceId: 'test-tools', origin: 'http://127.0.0.1:1' },
      sessionId: `test-${alias}`, projectDirectory: directory,
    } }));
  }
  const rooms = [];
  for (const label of ['project', 'other-project']) {
    const room = await admin.request('POST', '/v1/rooms', { label }); rooms.push(room);
    for (const agent of agents) await admin.request('POST', '/v1/members', { room: room.id, agentId: agent.id });
  }
  const issue = async (agent, selectedRooms) => {
    const scope = await admin.request('POST', '/v1/scopes', { agentId: agent.id, rooms: selectedRooms.map(room => room.id) });
    return new HubClient({ url: hub.url, token: scope.token });
  };
  const sender = await issue(agents[0], rooms), receiver = await issue(agents[1], [rooms[0]]);
  const send = async ({ to = agents[1].id, room = rooms[0].id, text = 'Please review this project.' } = {}) =>
    sender.request('POST', '/v1/messages', { id: newId(), room, to: [to], text });
  let reads = 0;
  const inbox = hub.store.inbox.bind(hub.store);
  hub.store.inbox = (...args) => { reads++; return inbox(...args); };
  return { hub, admin, machine, sender, receiver, agents, rooms, issue, send, get reads() { return reads; } };
}

test('scoped long poll wakes on a delayed message and keeps tool-read semantics', async t => {
  const f = await fixture(t);
  let finished = false;
  const pending = f.receiver.request('GET', '/v1/inbox?waitMs=1000').then(value => { finished = true; return value; });
  await until(() => f.reads === 1);
  assert.equal(finished, false);
  const sent = await f.send();
  const received = await pending;
  assert.equal(received.items[0].message.id, sent.message.id);
  assert.equal(received.items[0].delivery.state, 'tool-read');
  assert.equal(received.cursor, sent.message.seq);
  assert.equal((await f.admin.request('GET', `/v1/status?id=${sent.message.id}`)).deliveries[0].state, 'tool-read');
});

test('other rooms and recipients do not end a scoped wait or advance its cursor', async t => {
  const f = await fixture(t);
  let finished = false;
  const pending = f.receiver.request('GET', '/v1/inbox?after=0&limit=1&waitMs=1500').then(value => { finished = true; return value; });
  await until(() => f.reads === 1);
  const unrelated = await f.send({ to: f.agents[2].id });
  await until(() => f.reads >= 2);
  assert.equal(finished, false);
  const hidden = await f.send({ room: f.rooms[1].id });
  await until(() => f.reads >= 3);
  assert.equal(finished, false);
  const sent = await f.send();
  const received = await pending;
  assert.deepEqual(received.items.map(item => item.message.id), [sent.message.id]);
  for (const message of [hidden, unrelated]) assert.equal((await f.admin.request('GET', `/v1/status?id=${message.message.id}`)).deliveries[0].state, 'queued');
});

test('empty wait is bounded despite unrelated wakeups and immediate inbox stays compatible', async t => {
  const f = await fixture(t), started = performance.now();
  const pending = f.receiver.request('GET', '/v1/inbox?after=0&waitMs=150');
  await until(() => f.reads === 1);
  await f.send({ to: f.agents[2].id });
  const result = await pending;
  assert.deepEqual(result, { items: [], cursor: 0 });
  assert(performance.now() - started >= 100);
  assert.deepEqual(await f.receiver.request('GET', '/v1/inbox'), result);
  assert.deepEqual(await f.receiver.request('GET', '/v1/inbox?waitMs=0'), result);
});

test('waiter returns first nonempty page without silently advancing an explicit cursor', async t => {
  const f = await fixture(t), first = await f.send(), second = await f.send({ text: 'Second question.' });
  const read = await waitForInbox({ client: f.receiver, after: 0, limit: 1 });
  assert.equal(read.items[0].message.id, first.message.id);
  assert.deepEqual(await waitForInbox({ client: f.receiver, after: 0, limit: 1 }), read);
  const next = await waitForInbox({ client: f.receiver, after: read.cursor, limit: 1 });
  assert.equal(next.items[0].message.id, second.message.id);
  assert.equal(next.cursor, second.message.seq);
});

test('viewer credentials and permanent authorization failures fail before waiting', async t => {
  const f = await fixture(t), viewer = await f.admin.request('POST', '/v1/viewers', { rooms: [f.rooms[0].id] });
  const clients = [new HubClient({ url: f.hub.url, token: viewer.token }), new HubClient({ url: f.hub.url, token: 'wrong_credential_' + 'x'.repeat(32) }), f.machine];
  for (const [i, client] of clients.entries()) {
    await assert.rejects(waitForInbox({ client, sleep: () => assert.fail('Permanent auth failures must not retry.') }), { status: i === 1 ? 401 : 403 });
  }
  for (const value of ['-1', '25001', 'NaN', '1.5']) await assert.rejects(f.receiver.request('GET', `/v1/inbox?waitMs=${value}`), { status: 400 });
  await assert.rejects(f.receiver.request('GET', '/v1/inbox?after=-1&waitMs=25000'), { status: 400 });
});

test('invalid local pagination and cancellation inputs never reach the network', async () => {
  const client = { request: () => assert.fail('Invalid input reached the network.') };
  for (const after of [-1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(waitForInbox({ client, after }), /pagination/);
  for (const limit of [0, 101, 1.5, '10', NaN]) await assert.rejects(waitForInbox({ client, limit }), /pagination/);
  await assert.rejects(waitForInbox({ client, signal: {} }), /cancellation/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(waitForInbox({ client, signal: aborted.signal }), { name: 'AbortError' });
});

test('transient failures back off to 30 seconds, healthy empties reset it, and no cursor is consumed', async t => {
  const f = await fixture(t), delays = [], requests = [];
  const failures = [0, 408, 429, 500, 502, 503, 504, null, 500];
  const client = { request: async (method, path, body, options) => {
    requests.push({ method, path, body, options });
    const failure = failures.shift();
    if (failure !== undefined && failure !== null) throw new ApiError('Simulated temporary failure.', { status: failure });
    const result = await f.receiver.request(method, path.replace('waitMs=25000', 'waitMs=0'), body, options);
    if (failure === null) { assert.deepEqual(result.items, []); await f.send(); }
    return result;
  } };
  const result = await waitForInbox({ client, after: 0, limit: 3, sleep: async ms => { delays.push(ms); } });
  assert.equal(result.items.length, 1);
  assert.deepEqual(delays.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert(delays[7] > 0 && delays[7] <= 1000); // Healthy short poll gets its minimum interval.
  assert.equal(delays[8], 1000); // Healthy response reset the error backoff.
  assert.equal(delays.length, 9);
  assert(requests.every(request => request.method === 'GET' && request.path === '/v1/inbox?after=0&limit=3&waitMs=25000' && request.options.timeoutMs === 30000));
});

test('empty healthy polls repeat silently until actual scoped mail arrives', async t => {
  const f = await fixture(t), pauses = []; let calls = 0;
  const client = { request: async (method, path, body, options) => {
    calls++;
    const result = await f.receiver.request(method, path.replace('waitMs=25000', 'waitMs=20'), body, options);
    if (calls === 2) await f.send();
    return result;
  } };
  const result = await waitForInbox({ client, sleep: async ms => { pauses.push(ms); } });
  assert.equal(calls, 3);
  assert.equal(result.items.length, 1);
  assert.equal(pauses.length, 2);
  assert(pauses.every(ms => ms > 0 && ms <= 1000));
});

test('older Hubs ignoring waitMs cannot cause a busy loop and interval sleep is abortable', async t => {
  const f = await fixture(t), controller = new AbortController(), starts = [];
  const client = { request: (method, path, body, options) => {
    starts.push(performance.now());
    // Simulate the original Hub by dropping its unsupported waitMs parameter.
    return f.receiver.request(method, path.replace('&waitMs=25000', ''), body, options);
  } };
  const pending = assert.rejects(waitForInbox({ client, signal: controller.signal }), { name: 'AbortError' });
  await until(() => starts.length === 1);
  await delay(100);
  assert.equal(starts.length, 1);
  await until(() => starts.length === 2);
  assert(starts[1] - starts[0] >= 990, 'Healthy empty polls should start at most once per second.');
  await until(() => f.reads === 2);
  const beforeAbort = performance.now(); controller.abort(); await pending;
  assert(performance.now() - beforeAbort < 500);
  assert.equal(starts.length, 2);
});

test('elapsed long-poll time is deducted from the healthy empty interval', async () => {
  let calls = 0;
  const result = await waitForInbox({ client: { request: async () => {
    if (++calls === 1) { await delay(1010); return { items: [], cursor: 0 }; }
    return { items: [{ seq: 1 }], cursor: 1 };
  } }, sleep: () => assert.fail('A completed long poll must not add another interval.') });
  assert.equal(calls, 2);
  assert.equal(result.cursor, 1);
});

test('abort during a live long poll removes the wait before a later message arrives', async t => {
  const f = await fixture(t), controller = new AbortController();
  const pending = assert.rejects(waitForInbox({ client: f.receiver, signal: controller.signal }), { name: 'AbortError' });
  await until(() => f.reads === 1);
  controller.abort(); await pending;
  await delay(30); // Let the HTTP close event remove the server's waiter.
  const previous = f.reads;
  await f.send(); await delay(20);
  assert.equal(f.reads, previous);
});

test('abort interrupts retry sleep promptly instead of waiting for the backoff', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = assert.rejects(waitForInbox({ client: { request: async () => { calls++; throw new ApiError('Temporary.', { status: 503 }); } }, signal: controller.signal }), { name: 'AbortError' });
  await until(() => calls === 1);
  const start = performance.now(); controller.abort(); await pending;
  assert(performance.now() - start < 500);
  assert.equal(calls, 1);
});

test('Hub shutdown cleans pending long polls without waiting 25 seconds or reading a closed store', async t => {
  const f = await fixture(t);
  const pending = f.receiver.request('GET', '/v1/inbox?waitMs=25000').then(() => assert.fail('Shutdown should close the request.'), error => assert.equal(error.status, 0));
  await until(() => f.reads === 1);
  const start = performance.now(); await f.hub.close(); await pending;
  assert(performance.now() - start < 1000);
  assert.equal(f.reads, 1);
});
