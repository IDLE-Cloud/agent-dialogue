import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient } from '../lib/codex.mjs';
import { holdOwnedCodexThread } from '../scripts/vps-codex-lease.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const CWD = '/synthetic/owned-project';
function frame(payload, opcode = 1, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = Buffer.alloc(data.length < 126 ? 2 : 4);
  header[0] = (fin ? 128 : 0) | opcode; header[1] = header.length === 2 ? data.length : 126;
  if (header.length === 4) header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}
async function fixture(t, { busy = false, queue = [], mutateThread, responseMode } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-vps-lease-'));
  const socketPath = join(directory, 'daemon.sock'), sockets = new Set(), subscribers = new Set(), calls = [];
  let foreignOwner = true, pong = false, interactiveAnswer = null;
  const loaded = () => foreignOwner || subscribers.size > 0;
  const thread = () => ({ id: ID, cwd: CWD, projectId: null, ephemeral: false, model: 'synthetic-model',
    modelProvider: 'synthetic', createdAt: 1, updatedAt: 2,
    canAcceptDirectInput: loaded(), status: { type: busy ? 'active' : loaded() ? 'idle' : 'notLoaded' },
    ...(mutateThread || {}),
  });
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('end', () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + length) return;
        assert.ok(buffer[1] & 128, 'masked client frame');
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        buffer = buffer.subarray(offset + 4 + length);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 10) { pong = true; continue; }
        const request = JSON.parse(payload.toString('utf8'));
        if (request.id === 'synthetic-approval') { interactiveAnswer = request; continue; }
        if (!request.id) continue;
        calls.push(request);
        let result;
        if (request.method === 'initialize') result = { userAgent: 'codex-tui/0.163.0 (synthetic)', codexHome: '/synthetic/codex-home' };
        else if (request.method === 'thread/read') result = { thread: thread() };
        else if (request.method === 'thread/loaded/list') result = { data: loaded() ? [ID] : [] };
        else if (request.method === 'thread/queue/list') result = { data: queue };
        else if (request.method === 'thread/resume') { subscribers.add(socket); result = { thread: thread() }; }
        else { assert.fail(`Unexpected lease RPC ${request.method}`); }
        if (responseMode === 'timeout' && request.method === 'thread/read') continue;
        if (responseMode === 'invalid-utf8' && request.method === 'thread/read') { socket.write(frame(Buffer.from([0xc3, 0x28]))); continue; }
        if (responseMode === 'invalid-control' && request.method === 'thread/read') { socket.write(frame('x', 9, false)); continue; }
        if (responseMode === 'oversize' && request.method === 'thread/read') { const header = Buffer.alloc(10); header[0] = 129; header[1] = 127; header.writeBigUInt64BE(BigInt(8 * 1024 * 1024 + 1), 2); socket.write(header); continue; }
        if (responseMode === 'fragment' && request.method === 'thread/read') {
          const bytes = Buffer.from(JSON.stringify({ id: request.id, result }));
          const multibyte = bytes.findIndex(byte => byte >= 128);
          const mid = multibyte < 0 ? Math.floor(bytes.length / 2) : multibyte + 1;
          socket.write(frame(bytes.subarray(0, mid), 1, false)); socket.write(frame('ping', 9)); socket.write(frame(bytes.subarray(mid), 0, true));
          continue;
        }
        socket.write(frame({ id: request.id, result }));
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const client = await CodexClient.discover({ socketPath });
  t.after(() => client.close());
  return { socketPath, calls, client, options: { socketPath, expectedIdentity: client.identity, threadId: ID, cwd: CWD, timeoutMs: 500 },
    disconnectForeign() { foreignOwner = false; }, loaded,
    ownedSockets: () => subscribers.size, pong: () => pong,
    askApproval() { for (const socket of subscribers) socket.write(frame({ id: 'synthetic-approval', method: 'item/commandExecution/requestApproval', params: { private: 'synthetic-only' } })); },
    interactiveAnswer: () => interactiveAnswer,
  };
}

test('VPS lifecycle demonstrates that ordinary short-lived Codex resume is not a subscription lease', async t => {
  const f = await fixture(t); assert.equal((await f.client.session(ID)).loaded, true);
  await f.client.resumeThread(ID); await delay(30); f.disconnectForeign();
  assert.equal((await f.client.session(ID)).loaded, false);
});

test('VPS controller owns a persistent exact thread subscription after another client disconnects', async t => {
  const f = await fixture(t); const lease = await holdOwnedCodexThread(f.options);
  t.after(() => lease.close()); f.disconnectForeign(); await delay(30);
  assert.equal((await f.client.session(ID)).loaded, true);
  assert.equal(f.ownedSockets(), 1);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/resume').map(call => call.params), [{ threadId: ID }]);
  await lease.close(); await delay(30);
  assert.equal((await f.client.session(ID)).loaded, false);
});

test('VPS lease refuses busy, queued, ephemeral and wrong-project targets before resuming', async t => {
  for (const setup of [{ busy: true }, { queue: [{ id: 'unowned-queue-item' }] },
    { mutateThread: { ephemeral: true } }, { mutateThread: { cwd: '/synthetic/other-project' } }]) {
    const f = await fixture(t, setup);
    await assert.rejects(holdOwnedCodexThread(f.options));
    assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  }
});

test('VPS lease refuses a different daemon identity before mutating a thread', async t => {
  const f = await fixture(t);
  await assert.rejects(holdOwnedCodexThread({ ...f.options, expectedIdentity: { ...f.client.identity, serviceId: 'wrong-daemon' } }));
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
});

test('VPS lease supports fragmented UTF-8 messages and ping without handling approvals', async t => {
  const f = await fixture(t, { responseMode: 'fragment', mutateThread: { name: '合成项目' } }); const lease = await holdOwnedCodexThread(f.options);
  t.after(() => lease.close()); f.askApproval(); await delay(30);
  assert.equal(f.pong(), true);
  assert.equal(f.interactiveAnswer()?.error?.code, -32601);
  assert.equal(f.interactiveAnswer()?.result, undefined);
  assert.equal(Object.hasOwn(lease, 'request'), false);
});

test('VPS lease bounds malformed frames, UTF-8 and RPC wait without resuming', async t => {
  for (const responseMode of ['invalid-utf8', 'invalid-control', 'oversize', 'timeout']) {
    const f = await fixture(t, { responseMode }); const start = Date.now();
    await assert.rejects(holdOwnedCodexThread({ ...f.options, timeoutMs: 50 }));
    assert.ok(Date.now() - start < 1000);
    assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  }
});
