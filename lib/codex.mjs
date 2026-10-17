import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT = /^msg_[A-Za-z0-9_-]+$/;
const MAX_FRAME = 8 * 1024 * 1024;
const VERSION = /(?:codex-[^/\s]+|Codex Desktop)\/([^\s]+)/i;

function threadId(value) {
  if (typeof value !== 'string' || !THREAD.test(value)) throw new Error('Invalid Codex thread ID; use the full UUID.');
  return value;
}

function inputId(value) {
  if (typeof value !== 'string' || !INPUT.test(value)) throw new Error('Invalid Codex client input ID.');
  return value;
}

async function socketIdentity(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('Codex socket must be an absolute local Unix socket path.');
  let actual, info;
  try { actual = await realpath(path); info = await lstat(actual); }
  catch { throw new Error('Existing Codex daemon socket is unavailable; no daemon was started.'); }
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error('Codex socket must be owned by the current user.');
  const fingerprint = createHash('sha256').update(`${actual}\n${info.dev}\n${info.ino}\n${info.ctimeMs}`).digest('hex');
  return { serviceId: `codex-socket-${fingerprint}`, origin: `unix://${actual}`, path: actual };
}

function maskedFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > MAX_FRAME) throw new Error('Codex transport message exceeds the size limit.');
  const mask = randomBytes(4), extension = data.length < 126 ? 0 : data.length <= 65535 ? 2 : 8;
  const head = Buffer.alloc(2 + extension + 4);
  head[0] = 0x80 | opcode;
  head[1] = 0x80 | (extension === 0 ? data.length : extension === 2 ? 126 : 127);
  if (extension === 2) head.writeUInt16BE(data.length, 2);
  if (extension === 8) head.writeBigUInt64BE(BigInt(data.length), 2);
  mask.copy(head, 2 + extension);
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, body]);
}

/** JSON-RPC over the daemon's existing WebSocket Unix socket; never spawns a server. */
export async function codexSocketRequest(socketPath, method, params = {}, { timeoutMs = 20_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new Error('Invalid Codex request timeout.');
  return await new Promise((resolveRequest, rejectRequest) => {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let socket, buffer = Buffer.alloc(0), fragments = [], fragmented = false, total = 0, initialized, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); req.destroy();
      if (error) rejectRequest(error); else resolveRequest(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex daemon request timed out; inspect the target thread before retrying a submission.')), timeoutMs);
    const req = httpRequest({ socketPath, path: '/', method: 'GET', headers: {
      host: 'localhost', upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-key': key, 'sec-websocket-version': '13',
    } });
    const send = data => socket.write(maskedFrame(1, JSON.stringify(data)));
    const consumeMessage = data => {
      let message;
      try { message = JSON.parse(data.toString('utf8')); }
      catch { throw new Error('Codex daemon returned invalid JSON.'); }
      if (Object.hasOwn(message, 'id') && message.method) {
        // Do not grant permissions or answer model questions on the user's behalf.
        send({ id: message.id, error: { code: -32601, message: 'This client does not handle interactive server requests.' } });
        return;
      }
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error) {
        const error = new Error(`Codex RPC ${method} failed (code ${Number.isInteger(message.error.code) ? message.error.code : 'unknown'}); response body withheld.`);
        error.rpcCode = message.error.code;
        throw error;
      }
      if (!Object.hasOwn(message, 'result')) throw new Error('Codex daemon returned an invalid RPC response.');
      if (message.id === 1) {
        initialized = message.result;
        send({ method: 'initialized', params: {} });
        if (method === 'initialize') finish(null, initialized);
        else send({ id: 2, method, params });
      } else finish(null, message.result);
    };
    const consume = chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length >= 2 && !settled) {
          const first = buffer[0], second = buffer[1], opcode = first & 15, fin = Boolean(first & 128);
          if (first & 0x70 || second & 0x80) throw new Error('Invalid Codex WebSocket frame.');
          let length = second & 127, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          if (length === 127) {
            if (buffer.length < 10) return;
            const size = buffer.readBigUInt64BE(2);
            if (size > BigInt(MAX_FRAME)) throw new Error('Codex transport frame exceeds the size limit.');
            length = Number(size); offset = 10;
          }
          if (length > MAX_FRAME || buffer.length > MAX_FRAME * 2) throw new Error('Codex transport frame exceeds the size limit.');
          if (buffer.length < offset + length) return;
          const data = buffer.subarray(offset, offset + length); buffer = buffer.subarray(offset + length);
          if (opcode >= 8) {
            if (!fin || length > 125) throw new Error('Invalid Codex WebSocket control frame.');
            if (opcode === 8) throw new Error('Codex daemon closed the connection before a complete response.');
            if (opcode === 9) socket.write(maskedFrame(10, data));
            else if (opcode !== 10) throw new Error('Invalid Codex WebSocket control opcode.');
            continue;
          }
          if (opcode === 1 && !fragmented) { fragments = [data]; total = length; }
          else if (opcode === 0 && fragmented) { fragments.push(data); total += length; }
          else throw new Error('Unsupported Codex WebSocket data frame.');
          if (total > MAX_FRAME) throw new Error('Codex transport message exceeds the size limit.');
          fragmented = !fin;
          if (fin) { consumeMessage(Buffer.concat(fragments, total)); fragments = []; total = 0; }
        }
      } catch (error) { finish(error); }
    };
    req.once('upgrade', (response, upgraded, head) => {
      socket = upgraded;
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept ||
          response.headers.upgrade?.toLowerCase() !== 'websocket') {
        finish(new Error('Codex daemon WebSocket handshake failed.')); return;
      }
      socket.on('error', () => finish(new Error('Codex daemon transport failed; inspect before retrying a submission.')));
      socket.once('close', () => finish(new Error('Codex daemon transport closed; inspect before retrying a submission.')));
      socket.on('data', consume);
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'agent-dialogue', version: '0.3.0' }, capabilities: { experimentalApi: true },
      } });
      if (head.length) consume(head);
    });
    req.once('response', response => { response.resume(); finish(new Error(`Codex daemon upgrade rejected (HTTP ${response.statusCode}); response body withheld.`)); });
    req.once('error', () => finish(new Error('Existing Codex daemon is unavailable; no daemon was started.')));
    req.end();
  });
}

function normalize(thread, loaded) {
  threadId(thread?.id);
  if (typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)) throw new Error('Codex thread has no absolute working directory.');
  const directory = resolve(thread.cwd);
  return {
    id: thread.id, title: thread.name || null,
    projectID: thread.projectId || `codex-cwd:${createHash('sha256').update(directory).digest('hex').slice(0, 24)}`,
    location: { directory },
    time: { created: thread.createdAt * 1000, updated: thread.updatedAt * 1000 },
    model: thread.model ? { id: thread.model, providerID: thread.modelProvider } : null,
    loaded, canAcceptDirectInput: thread.canAcceptDirectInput === true, nativeStatus: thread.status?.type || 'unknown',
    native: { loaded, canAcceptDirectInput: thread.canAcceptDirectInput === true, status: thread.status?.type || 'unknown',
      projectId: thread.projectId ?? null, ephemeral: thread.ephemeral === true, source: thread.source },
  };
}

export class CodexClient {
  #request;
  #identity;
  #closed = false;

  constructor({ identity, requestImpl, identityProvider = null }) {
    if (!identity?.serviceId || typeof identity.origin !== 'string' || !identity.origin.startsWith('unix:///') || typeof requestImpl !== 'function') throw new Error('Invalid Codex native client configuration.');
    Object.defineProperty(this, 'identity', { value: Object.freeze({ ...identity }), enumerable: true });
    Object.defineProperty(this, 'capabilities', { value: Object.freeze({ existingLoadedOnly: true, durableQueue: true, clientInputId: true, autoResume: false, executionRequiresDrain: true }), enumerable: true });
    this.#request = requestImpl; this.#identity = identityProvider;
  }

  static async discover({ env = process.env, socketPath = env.AGENT_DIALOGUE_CODEX_SOCKET || join(env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock') } = {}) {
    const snapshot = await socketIdentity(socketPath);
    const requestImpl = (method, params) => codexSocketRequest(snapshot.path, method, params);
    const info = await requestImpl('initialize', {});
    if (typeof info?.codexHome !== 'string' || typeof info?.userAgent !== 'string') throw new Error('Invalid Codex daemon initialization response.');
    const after = await socketIdentity(snapshot.path);
    if (after.serviceId !== snapshot.serviceId) throw new Error('Codex daemon identity changed during discovery.');
    return new CodexClient({ identity: { serviceId: snapshot.serviceId, origin: snapshot.origin, version: info.userAgent.match(VERSION)?.[1] || null }, requestImpl, identityProvider: () => socketIdentity(snapshot.path) });
  }

  async #revalidate() {
    if (!this.#identity) return;
    const current = await this.#identity();
    if (current.serviceId !== this.identity.serviceId || current.origin !== this.identity.origin) throw new Error('Codex daemon identity changed; explicitly rebind the intended thread.');
  }

  async request(method, params = {}) {
    if (this.#closed) throw new Error('Codex client is closed.');
    await this.#revalidate();
    return await this.#request(method, params);
  }

  // Requests use short-lived connections, so there is no daemon or child to stop.
  close() { this.#closed = true; }

  async #pages(method, params) {
    const result = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const response = await this.request(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response?.data)) throw new Error('Invalid Codex paginated response.');
      result.push(...response.data);
      cursor = response.nextCursor;
      if (cursor == null || cursor === '') return result;
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid Codex pagination cursor.');
      cursors.add(cursor);
    }
    throw new Error('Codex pagination limit exceeded; narrow the query.');
  }

  async sessions({ directory } = {}) {
    if (directory !== undefined && (typeof directory !== 'string' || !isAbsolute(directory))) throw new Error('Codex directory filter must be absolute.');
    const loaded = new Set(await this.#pages('thread/loaded/list', { limit: 100 }));
    const data = await this.#pages('thread/list', { limit: 100, archived: false, useStateDbOnly: true, sortKey: 'updated_at', ...(directory ? { cwd: directory } : {}) });
    return data.map(thread => normalize(thread, loaded.has(thread.id)));
  }

  async session(id) {
    threadId(id);
    const response = await this.request('thread/read', { threadId: id, includeTurns: false });
    if (response?.thread?.id !== id) throw new Error('Codex returned a different thread.');
    const loaded = new Set(await this.#pages('thread/loaded/list', { limit: 100 }));
    return normalize(response.thread, loaded.has(id));
  }

  async inbox(id) {
    threadId(id);
    const items = await this.#pages('thread/queue/list', { threadId: id, limit: 100 });
    return items.map(item => ({ id: item.clientUserMessageId, sessionID: id, nativeQueueId: item.id, type: 'user', native: item }));
  }

  async messages(id, { limit = 50 } = {}) {
    threadId(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid Codex message limit.');
    const response = await this.request('thread/items/list', { threadId: id, limit, sortDirection: 'desc' });
    if (!Array.isArray(response?.data)) throw new Error('Invalid Codex thread items response.');
    return response.data.map(entry => {
      const item = entry.item || entry;
      return { ...item, id: item.type === 'userMessage' && item.clientId ? item.clientId : item.id, nativeId: item.id, sessionID: id, turnId: entry.turnId };
    });
  }

  async prompt(id, options = {}) {
    let clientId, text, inspecting = false;
    try {
      const { id: requestedId, text: requestedText, metadata = {}, delivery = 'queue', resume = true } = options;
      clientId = requestedId; text = requestedText;
      threadId(id); inputId(clientId);
      if (typeof text !== 'string' || !text.trim() || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid Codex prompt text or metadata.');
      if (delivery !== 'queue' || resume !== true) throw new Error('Codex native adapter currently supports queue delivery only, without auto-resume.');
      inspecting = true;
      const target = await this.session(id);
      inspecting = false;
      if (!target.native.loaded || !target.native.canAcceptDirectInput || target.native.ephemeral) throw Object.assign(new Error('Codex thread must already be loaded and accept direct input; it was not resumed.'), { retryable: true });
    } catch (error) {
      // Nothing above calls a mutating RPC. Preserve that distinction even if
      // the read-only inspection failed because the daemon was unreachable.
      error.notSubmitted = true;
      if (inspecting) error.retryable = true;
      throw error;
    }
    // Once queue/add is attempted, a failure must remain outcome-unknown.
    const response = await this.request('thread/queue/add', { threadId: id, clientUserMessageId: clientId, input: [{ type: 'text', text }] });
    const queued = response?.queuedSubmission;
    if (!queued?.id || queued.clientUserMessageId !== clientId) throw new Error('Codex queue receipt does not match the client input; inspect before retrying.');
    return { id: clientId, sessionID: id, type: 'user', nativeQueueId: queued.id, delivery: 'queue', execution: 'queued' };
  }

  /** Explicit user-selected load of the same thread in this existing daemon. */
  async resumeThread(id) {
    threadId(id);
    const result = await this.request('thread/resume', { threadId: id });
    if (result?.thread?.id !== id) throw new Error('Codex resume returned a different thread.');
    return await this.session(id);
  }

  /** Verification helper; normal attach never calls this. */
  async createThread(params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        (params.cwd !== undefined && (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)))) throw new Error('Invalid Codex thread creation parameters.');
    const result = await this.request('thread/start', params);
    threadId(result?.thread?.id);
    return await this.session(result.thread.id);
  }

  /** Starts only a bridge-owned queue item at the head; never skips a user's queued work. */
  async drain(id, { inputIds = [], expectedBinding } = {}) {
    threadId(id);
    if (!Array.isArray(inputIds) || inputIds.some(value => typeof value !== 'string' || !INPUT.test(value))) throw new Error('Invalid Codex drain input IDs.');
    if (expectedBinding && (expectedBinding.remote || expectedBinding.active === false || expectedBinding.serviceId !== this.identity.serviceId || expectedBinding.origin !== this.identity.origin || expectedBinding.sessionId !== id)) throw new Error('Codex drain service/session does not match the expected binding.');
    const target = await this.session(id);
    if (expectedBinding && (target.id !== expectedBinding.sessionId || target.projectID !== expectedBinding.projectId || typeof expectedBinding.directory !== 'string' || resolve(target.location.directory) !== expectedBinding.directory)) throw new Error('Codex drain project/directory does not match the expected binding.');
    if (!target.native.loaded || !target.native.canAcceptDirectInput || target.native.status !== 'idle') return { started: false, reason: 'not-ready' };
    const first = (await this.inbox(id))[0];
    if (!first || !inputIds.includes(first.id)) return { started: false, reason: first ? 'unowned-queue-head' : 'empty' };
    const result = await this.request('thread/queue/start', { threadId: id, queuedSubmissionId: first.nativeQueueId });
    if (!result?.turn?.id) throw new Error('Codex queue start returned an invalid turn receipt.');
    return { started: true, inputId: first.id, turnId: result.turn.id };
  }
}
