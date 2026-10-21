/** Acceptance-only owned thread subscription. Never starts a Codex server. */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const MAX_FRAME = 8 * 1024 * 1024;
const THREAD = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
const ALLOWED = new Set(['initialize', 'thread/read', 'thread/queue/list', 'thread/resume']);
const fail = () => new Error('Owned Codex lease could not be established or was lost; inspect the selected thread before retrying.');
const path = value => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

async function identity(socketPath) {
  if (!path(socketPath)) throw fail();
  const actual = await realpath(socketPath), info = await lstat(actual);
  if (!info.isSocket() || process.getuid && info.uid !== process.getuid()) throw fail();
  const fingerprint = createHash('sha256').update(`${actual}\n${info.dev}\n${info.ino}\n${info.ctimeMs}`).digest('hex');
  return { serviceId: `codex-socket-${fingerprint}`, origin: `unix://${actual}`, socketPath: actual };
}
function sameIdentity(actual, expected) { return actual.serviceId === expected?.serviceId && actual.origin === expected?.origin; }
function maskedFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > MAX_FRAME) throw fail();
  const extension = data.length < 126 ? 0 : data.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extension + 4), mask = randomBytes(4), body = Buffer.alloc(data.length);
  header[0] = 128 | opcode; header[1] = 128 | (extension === 0 ? data.length : extension === 2 ? 126 : 127);
  if (extension === 2) header.writeUInt16BE(data.length, 2);
  if (extension === 8) header.writeBigUInt64BE(BigInt(data.length), 2);
  mask.copy(header, 2 + extension);
  for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, body]);
}

async function channel(socketPath, timeoutMs) {
  return await new Promise((resolveChannel, rejectChannel) => {
    let socket, closed = false, connected = false, sequence = 0, buffer = Buffer.alloc(0), fragments = [], fragmented = false, total = 0;
    const pending = new Map(), key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const stop = error => {
      if (closed) return; closed = true; clearTimeout(openingTimer);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error || fail()); }
      pending.clear(); socket?.destroy(); req.destroy();
      if (!connected) rejectChannel(error || fail());
    };
    const send = value => { if (closed || !socket) throw fail(); socket.write(maskedFrame(1, JSON.stringify(value))); };
    const rpc = async (method, params = {}) => {
      if (closed || !ALLOWED.has(method) || pending.size) throw fail();
      return await new Promise((resolveRpc, rejectRpc) => {
        const id = ++sequence;
        const timer = setTimeout(() => stop(fail()), timeoutMs);
        pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
        try { send({ id, method, params }); } catch { stop(fail()); }
      });
    };
    const message = bytes => {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
      if (Object.hasOwn(value, 'id') && value.method) {
        // Subscription ownership never grants a model permission or answers a question.
        send({ id: value.id, error: { code: -32601, message: 'This acceptance subscription does not handle interactive server requests.' } });
        return;
      }
      const item = pending.get(value.id);
      if (!item) return;
      if (value.error || !Object.hasOwn(value, 'result')) throw fail();
      pending.delete(value.id); clearTimeout(item.timer); item.resolve(value.result);
    };
    const consume = chunk => {
      if (closed) return;
      try {
        if (buffer.length + chunk.length > MAX_FRAME * 2) throw fail();
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2 && !closed) {
          const first = buffer[0], second = buffer[1], opcode = first & 15, fin = Boolean(first & 128);
          if (first & 112 || second & 128) throw fail();
          let length = second & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) {
            if (buffer.length < 10) return;
            const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) throw fail();
            length = Number(big); offset = 10;
          }
          if (length > MAX_FRAME) throw fail();
          if (opcode >= 8 && (!fin || length > 125)) throw fail();
          if (buffer.length < offset + length) return;
          const data = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          if (opcode >= 8) {
            if (opcode === 8) throw fail();
            if (opcode === 9) socket.write(maskedFrame(10, data));
            else if (opcode !== 10) throw fail();
            continue;
          }
          if (opcode === 1 && !fragmented) { fragments = [data]; total = length; }
          else if (opcode === 0 && fragmented) { fragments.push(data); total += length; }
          else throw fail();
          if (total > MAX_FRAME) throw fail();
          fragmented = !fin;
          if (fin) { message(Buffer.concat(fragments, total)); fragments = []; total = 0; }
        }
      } catch { stop(fail()); }
    };
    const openingTimer = setTimeout(() => stop(fail()), timeoutMs);
    const req = httpRequest({ socketPath, path: '/', method: 'GET', headers: {
      host: 'localhost', upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-key': key, 'sec-websocket-version': '13',
    } });
    req.once('upgrade', async (response, upgraded, head) => {
      socket = upgraded;
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept || response.headers.upgrade?.toLowerCase() !== 'websocket') { stop(fail()); return; }
      clearTimeout(openingTimer);
      socket.on('error', () => stop(fail())); socket.on('end', () => stop(fail())); socket.once('close', () => stop(fail())); socket.on('data', consume);
      try {
        const initialize = rpc('initialize', { clientInfo: { name: 'agent-dialogue-owned-vps-acceptance', version: '0.3.0' }, capabilities: { experimentalApi: true } });
        if (head.length) consume(head);
        const initialized = await initialize;
        if (typeof initialized?.userAgent !== 'string' || !path(initialized.codexHome)) throw fail();
        send({ method: 'initialized', params: {} });
        connected = true;
        resolveChannel({ rpc, close: () => stop(), get closed() { return closed; } });
      } catch { stop(fail()); }
    });
    req.once('error', () => stop(fail()));
    req.once('response', response => { response.resume(); stop(fail()); });
    req.end();
  });
}

export async function holdOwnedCodexThread({ socketPath, expectedIdentity, threadId, cwd, timeoutMs = 20_000 } = {}) {
  if (!THREAD.test(threadId) || !path(cwd) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw fail();
  const before = await identity(socketPath);
  if (!sameIdentity(before, expectedIdentity)) throw fail();
  let connection;
  const checkThread = thread => {
    if (thread?.id !== threadId || !path(thread.cwd) || resolve(thread.cwd) !== resolve(cwd) || thread.ephemeral === true ||
        !['idle', 'notLoaded'].includes(thread.status?.type) || thread.status.type === 'idle' && thread.canAcceptDirectInput !== true) throw fail();
  };
  try {
    connection = await channel(before.socketPath, timeoutMs);
    if (!sameIdentity(await identity(socketPath), expectedIdentity)) throw fail();
    checkThread((await connection.rpc('thread/read', { threadId, includeTurns: false })).thread);
    const queue = await connection.rpc('thread/queue/list', { threadId, limit: 100 });
    if (!Array.isArray(queue?.data) || queue.data.length || queue.nextCursor != null && queue.nextCursor !== '') throw fail();
    const resumed = await connection.rpc('thread/resume', { threadId });
    if (resumed?.thread?.id !== threadId || resumed.thread.cwd !== undefined && (!path(resumed.thread.cwd) || resolve(resumed.thread.cwd) !== resolve(cwd))) throw fail();
    const current = (await connection.rpc('thread/read', { threadId, includeTurns: false })).thread;
    checkThread(current);
    if (current.status.type !== 'idle' || current.canAcceptDirectInput !== true || connection.closed) throw fail();
    return Object.freeze({ threadId, get closed() { return connection.closed; }, close: () => connection.close() });
  } catch { connection?.close(); throw fail(); }
}
