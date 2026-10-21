import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, codexSocketRequest } from '../lib/codex.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const identity = { serviceId: 'codex-socket-test', origin: 'unix:///tmp/test-codex.sock', version: '0.163.0' };
const thread = (changes = {}) => ({ id: ID, cwd: '/work/project', projectId: null, createdAt: 100, updatedAt: 200, status: { type: 'idle' }, canAcceptDirectInput: true, ephemeral: false, model: 'test-model', modelProvider: 'test', ...changes });
function mock({ info = thread(), loaded = true, queue = [], override } = {}) {
  const calls = [];
  const client = new CodexClient({ identity, requestImpl: async (method, params) => {
    calls.push({ method, params });
    const custom = override ? await override(method, params) : undefined;
    if (custom !== undefined) return custom;
    if (method === 'thread/read') return { thread: info };
    if (method === 'thread/loaded/list') return { data: loaded ? [ID] : [] };
    if (method === 'thread/queue/list') return { data: queue };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'native-queue-1', clientUserMessageId: params.clientUserMessageId, input: params.input } };
    if (method === 'thread/queue/start') return { turn: { id: 'native-turn-1' } };
    assert.fail(`Unexpected mocked method ${method}`);
  } });
  return { client, calls };
}

test('inspects an existing UUID without loading, resuming, or copying it', async () => {
  const { client, calls } = mock({ loaded: false, info: thread({ status: { type: 'notLoaded' }, canAcceptDirectInput: null }) });
  const item = await client.session(ID);
  assert.equal(item.id, ID);
  assert.equal(item.location.directory, '/work/project');
  assert.match(item.projectID, /^codex-cwd:/);
  assert.equal(item.loaded, false);
  assert.equal(item.canAcceptDirectInput, false);
  assert.equal(item.nativeStatus, 'notLoaded');
  assert.deepEqual(item.time, { created: 100000, updated: 200000 });
  assert.deepEqual(calls.map(call => call.method), ['thread/read', 'thread/loaded/list']);
});

test('queues a stable client ID for precisely the selected loaded thread', async () => {
  const { client, calls } = mock();
  const receipt = await client.prompt(ID, { id: 'msg_own_1', text: 'Project collaboration', metadata: { test: true } });
  assert.deepEqual(receipt, { id: 'msg_own_1', sessionID: ID, type: 'user', nativeQueueId: 'native-queue-1', delivery: 'queue', execution: 'queued' });
  assert.deepEqual(calls.at(-1), { method: 'thread/queue/add', params: { threadId: ID, clientUserMessageId: 'msg_own_1', input: [{ type: 'text', text: 'Project collaboration' }] } });
  assert.equal(calls.some(call => call.method === 'thread/resume' || call.method === 'thread/start'), false);
});

test('refuses unloaded, ephemeral, or noninteractive targets before mutation', async () => {
  for (const options of [{ loaded: false }, { info: thread({ ephemeral: true }) }, { info: thread({ canAcceptDirectInput: false }) }]) {
    const { client, calls } = mock(options);
    await assert.rejects(client.prompt(ID, { id: 'msg_test', text: 'hello' }), error => /already be loaded/.test(error.message) && error.notSubmitted === true && error.retryable === true);
    assert.equal(calls.some(call => call.method.includes('/queue/add')), false);
  }
});

test('read-only preflight transport failure is known not submitted; queue failure is not', async () => {
  const readFailure = mock({ override: method => { if (method === 'thread/read') throw new Error('read-only connection failed'); } });
  await assert.rejects(readFailure.client.prompt(ID, { id: 'msg_test', text: 'hello' }), error => error.notSubmitted === true && error.retryable === true);
  assert.equal(readFailure.calls.some(call => call.method === 'thread/queue/add'), false);
  const queueFailure = mock({ override: method => { if (method === 'thread/queue/add') throw new Error('queue response disconnected'); } });
  await assert.rejects(queueFailure.client.prompt(ID, { id: 'msg_test', text: 'hello' }), error => error.notSubmitted !== true);
  assert.equal(queueFailure.calls.filter(call => call.method === 'thread/queue/add').length, 1);
});

test('invalid target, client IDs, and steering options fail before RPC', async () => {
  const { client, calls } = mock();
  for (const value of ['latest', 'title', ID + '/extra']) await assert.rejects(client.session(value), /Invalid/);
  await assert.rejects(client.prompt(ID, { id: 'anything', text: 'hello' }), /Invalid/);
  await assert.rejects(client.prompt(ID, { id: 'msg_ok', text: 'hello', delivery: 'steer' }), /queue delivery/);
  assert.equal(calls.length, 0);
});

test('detects mismatched native thread and queue receipts', async () => {
  await assert.rejects(mock({ info: thread({ id: OTHER }) }).client.session(ID), /different thread/);
  const { client } = mock({ override: method => method === 'thread/queue/add' ? { queuedSubmission: { id: 'q', clientUserMessageId: 'msg_someone_else' } } : undefined });
  await assert.rejects(client.prompt(ID, { id: 'msg_expected', text: 'hello' }), /does not match/);
});

test('normalizes queue and persisted UserMessage client IDs for reconciliation', async () => {
  const { client } = mock({ queue: [{ id: 'native-q', clientUserMessageId: 'msg_own', input: [] }], override: method => method === 'thread/items/list' ? { data: [
    { turnId: 't1', item: { id: 'native-u', type: 'userMessage', clientId: 'msg_own', content: [] } },
    { turnId: 't1', item: { id: 'native-a', type: 'agentMessage', text: 'done' } },
  ] } : undefined });
  assert.equal((await client.inbox(ID))[0].id, 'msg_own');
  const items = await client.messages(ID);
  assert.equal(items[0].id, 'msg_own');
  assert.equal(items[0].nativeId, 'native-u');
  assert.equal(items[1].id, 'native-a');
});

test('drain never starts unrelated queue heads or skips an active turn', async () => {
  for (const options of [
    { queue: [{ id: 'q-user', clientUserMessageId: 'msg_user' }, { id: 'q-own', clientUserMessageId: 'msg_own' }] },
    { info: thread({ status: { type: 'active' } }), queue: [{ id: 'q-own', clientUserMessageId: 'msg_own' }] },
  ]) {
    const { client, calls } = mock(options);
    const result = await client.drain(ID, { inputIds: ['msg_own'] });
    assert.equal(result.started, false);
    assert.equal(calls.some(call => call.method === 'thread/queue/start'), false);
  }
  const { client, calls } = mock({ queue: [{ id: 'q-own', clientUserMessageId: 'msg_own' }] });
  assert.deepEqual(await client.drain(ID, { inputIds: ['msg_own'] }), { started: true, inputId: 'msg_own', turnId: 'native-turn-1' });
  assert.deepEqual(calls.at(-1), { method: 'thread/queue/start', params: { threadId: ID, queuedSubmissionId: 'q-own' } });
});

test('drain revalidates service, thread, project and latest directory before execution', async () => {
  const normalized = await mock().client.session(ID);
  const expectedBinding = { serviceId: identity.serviceId, origin: identity.origin, sessionId: ID, projectId: normalized.projectID, directory: normalized.location.directory, active: true };
  for (const change of [
    { serviceId: 'other-service' }, { origin: 'unix:///tmp/other.sock' }, { sessionId: OTHER },
    { projectId: 'other-project' }, { directory: '/work/changed' }, { active: false }, { remote: true },
  ]) {
    const { client, calls } = mock({ queue: [{ id: 'q-own', clientUserMessageId: 'msg_own' }] });
    await assert.rejects(client.drain(ID, { inputIds: ['msg_own'], expectedBinding: { ...expectedBinding, ...change } }), /expected binding/);
    assert.equal(calls.some(call => call.method === 'thread/queue/start'), false);
  }
  const { client, calls } = mock({ info: thread({ cwd: '/work/changed-after-admission' }), queue: [{ id: 'q-own', clientUserMessageId: 'msg_own' }] });
  await assert.rejects(client.drain(ID, { inputIds: ['msg_own'], expectedBinding }), /expected binding/);
  assert.equal(calls.some(call => call.method === 'thread/queue/start'), false);
  assert.equal((await mock({ queue: [{ id: 'q-own', clientUserMessageId: 'msg_own' }] }).client.drain(ID, { inputIds: ['msg_own'], expectedBinding })).started, true);
});

test('daemon replacement and closed clients cannot submit', async () => {
  let calls = 0;
  const client = new CodexClient({ identity, identityProvider: async () => ({ ...identity, serviceId: 'replacement' }), requestImpl: async () => { calls++; } });
  await assert.rejects(client.session(ID), /identity changed/);
  assert.equal(calls, 0);
  client.close();
  await assert.rejects(client.session(ID), /closed/);
});

test('explicit resume preserves exact thread ID and is separate from inspect', async () => {
  const { client, calls } = mock({ override: method => method === 'thread/resume' ? { thread: thread() } : undefined });
  assert.equal((await client.resumeThread(ID)).loaded, true);
  assert.deepEqual(calls[0], { method: 'thread/resume', params: { threadId: ID } });
  assert.equal(calls.some(call => call.method === 'thread/start'), false);
});

test('session pagination filters cwd and exposes metadata without chat previews', async () => {
  let page = 0;
  const { client } = mock({ override: (method, params) => {
    if (method === 'thread/list') {
      assert.equal(params.cwd, '/work/project'); assert.equal(params.useStateDbOnly, true);
      page++;
      return page === 1 ? { data: [thread({ preview: 'private user content' })], nextCursor: 'next' } : { data: [thread({ id: OTHER })] };
    }
  } });
  const result = await client.sessions({ directory: '/work/project' });
  assert.deepEqual(result.map(item => item.id), [ID, OTHER]);
  assert.equal(JSON.stringify(result).includes('private user content'), false);
});

function serverFrame(value, opcode = 1, fin = true) {
  const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const head = Buffer.alloc(payload.length < 126 ? 2 : 4);
  head[0] = (fin ? 128 : 0) | opcode;
  head[1] = payload.length < 126 ? payload.length : 126;
  if (head.length === 4) head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

async function fakeDaemon(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-codex-'));
  const socketPath = join(directory, 'daemon.sock'), sockets = new Set(), calls = [];
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + length) return;
        assert.ok(buffer[1] & 128, 'client frames must be masked');
        const opcode = buffer[0] & 15, mask = buffer.subarray(offset, offset + 4), payload = buffer.subarray(offset + 4, offset + 4 + length);
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 10) continue;
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        const request = JSON.parse(payload.toString()); calls.push(request);
        if (request.method === 'initialize') socket.write(serverFrame({ id: request.id, result: { userAgent: 'codex-tui/0.163.0 (test)', codexHome: '/test/codex' } }));
        else if (request.id) respond(request, socket);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { socketPath, calls, directory };
}

test('real Unix transport initializes and accepts ping plus fragmented metadata response', async t => {
  const daemon = await fakeDaemon(t, (request, socket) => {
    assert.equal(request.method, 'thread/loaded/list');
    const body = JSON.stringify({ id: request.id, result: { data: [ID] } });
    socket.write(serverFrame('ping', 9));
    socket.write(serverFrame(body.slice(0, 15), 1, false));
    socket.write(serverFrame(body.slice(15), 0, true));
  });
  const result = await codexSocketRequest(daemon.socketPath, 'thread/loaded/list', { limit: 10 });
  assert.deepEqual(result, { data: [ID] });
  assert.deepEqual(daemon.calls.slice(0, 3).map(call => call.method), ['initialize', 'initialized', 'thread/loaded/list']);
  const client = await CodexClient.discover({ socketPath: daemon.socketPath });
  assert.equal(client.identity.version, '0.163.0');
  assert.ok(client.identity.serviceId.startsWith('codex-socket-'));
  client.close();
});

test('native RPC errors omit server message and private body', async t => {
  const daemon = await fakeDaemon(t, (request, socket) => socket.write(serverFrame({ id: request.id, error: { code: -32000, message: 'private transcript or credential' } })));
  await assert.rejects(codexSocketRequest(daemon.socketPath, 'thread/read', { threadId: ID }), error => error.rpcCode === -32000 && !error.message.includes('private transcript'));
});

test('discovery does not accept a regular file or start a missing daemon', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ad-codex-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'regular-file'); await writeFile(file, 'not a daemon');
  await assert.rejects(CodexClient.discover({ socketPath: file }), /socket must be owned/);
  await assert.rejects(CodexClient.discover({ socketPath: join(directory, 'missing') }), /no daemon was started/);
});
