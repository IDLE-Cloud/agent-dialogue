import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]+$/;
const SERVICE_FILE = join(homedir(), '.local', 'state', 'opencode', 'service.json');

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid OpenCode service URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OpenCode service must use an uncredentialed loopback origin.');
  }
  return url.origin;
}

function identityOf(value) {
  if (!value || typeof value.serviceId !== 'string' || !value.serviceId.trim() ||
      value.serviceId.length > 256 || /[\x00-\x1f\x7f]/.test(value.serviceId)) {
    throw new Error('Invalid OpenCode service identity.');
  }
  return Object.freeze({
    serviceId: value.serviceId,
    origin: originOf(value.origin),
    version: typeof value.version === 'string' ? value.version : null,
  });
}

async function readService(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Cannot read OpenCode service credentials; start or select the intended service.'); }
  if (!value || typeof value.password !== 'string' || !value.password) {
    throw new Error('OpenCode service credentials are missing.');
  }
  return {
    identity: identityOf({ serviceId: value.id, origin: value.url, version: value.version }),
    password: value.password,
  };
}

function sessionId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid OpenCode session ID.');
  return id;
}

function messageId(id) {
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw new Error('Invalid OpenCode message ID.');
  return id;
}

function dataOf(response, label) {
  if (!response || !Object.hasOwn(response, 'data')) throw new Error(`Invalid OpenCode ${label} response.`);
  return response.data;
}

export class OpenCodeClient {
  #password;
  #fetch;
  #serviceFile;

  constructor({ identity, password, fetchImpl = globalThis.fetch, serviceFile = null }) {
    Object.defineProperty(this, 'identity', { value: identityOf(identity), enumerable: true });
    if (typeof password !== 'string' || !password) throw new Error('OpenCode service credentials are missing.');
    if (typeof fetchImpl !== 'function') throw new Error('OpenCode HTTP client is unavailable.');
    this.#password = password;
    this.#fetch = fetchImpl;
    this.#serviceFile = serviceFile;
  }

  static async discover({ serviceFile = process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE || SERVICE_FILE } = {}) {
    const { identity, password } = await readService(serviceFile);
    const client = new OpenCodeClient({ identity, password, serviceFile });
    const info = await client.info();
    if (typeof info?.version !== 'string' || (identity.version && info.version !== identity.version)) {
      throw new Error('OpenCode service version changed; rediscover the intended service.');
    }
    return client;
  }

  async #revalidate() {
    if (!this.#serviceFile) return;
    const current = await readService(this.#serviceFile);
    if (current.identity.serviceId !== this.identity.serviceId || current.identity.origin !== this.identity.origin) {
      throw new Error('OpenCode service identity changed; explicitly rebind the intended session.');
    }
    // Rotate the in-memory credential only after confirming the same service.
    this.#password = current.password;
  }

  async request(method, path, body) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported OpenCode HTTP method.');
    if (typeof path !== 'string' || !(path.startsWith('/api/') || path === '/openapi.json') || path.includes('#')) {
      throw new Error('Invalid OpenCode API path.');
    }
    const url = new URL(path, this.identity.origin);
    if (url.origin !== this.identity.origin || !url.pathname.startsWith('/api/') && url.pathname !== '/openapi.json') {
      throw new Error('Invalid OpenCode API path.');
    }
    const headers = {
      accept: 'application/json',
      authorization: `Basic ${Buffer.from(`opencode:${this.#password}`).toString('base64')}`,
    };
    const options = { method, headers, signal: AbortSignal.timeout(20_000), redirect: 'error' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try { response = await this.#fetch(url, options); }
    catch { throw new Error('OpenCode request failed or timed out; inspect the session before retrying a submission.'); }
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}; response body withheld.`);
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new Error('OpenCode returned an invalid JSON response.'); }
  }

  async info() { return this.request('GET', '/api/info'); }

  async sessions({ directory } = {}) {
    if (directory !== undefined && (typeof directory !== 'string' || !directory)) throw new Error('Invalid OpenCode directory filter.');
    const items = [], seen = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({ limit: '100' });
      if (directory !== undefined) params.set('directory', directory);
      if (cursor) params.set('cursor', cursor); else params.set('order', 'desc');
      const response = await this.request('GET', `/api/session?${params}`);
      const data = dataOf(response, 'session list');
      if (!Array.isArray(data)) throw new Error('Invalid OpenCode session list response.');
      for (const item of data) {
        sessionId(item?.id);
        if (!seen.has(item.id)) { items.push(item); seen.add(item.id); }
      }
      const next = response.cursor?.next;
      if (next == null || next === '') return items;
      if (typeof next !== 'string' || next === cursor) throw new Error('Invalid OpenCode session pagination cursor.');
      cursor = next;
    }
    throw new Error('OpenCode session list exceeded the pagination limit; narrow the directory filter.');
  }

  async session(id) {
    sessionId(id);
    await this.#revalidate();
    const value = dataOf(await this.request('GET', `/api/session/${id}`), 'session');
    if (!value || value.id !== id) throw new Error('OpenCode returned a different session.');
    return value;
  }

  async messages(id, { limit = 50 } = {}) {
    sessionId(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid OpenCode message limit.');
    const value = dataOf(await this.request('GET', `/api/session/${id}/message?limit=${limit}&order=desc`), 'messages');
    if (!Array.isArray(value)) throw new Error('Invalid OpenCode messages response.');
    return value;
  }

  async inbox(id) {
    sessionId(id);
    const value = dataOf(await this.request('GET', `/api/session/${id}/inbox`), 'inbox');
    if (!Array.isArray(value) || value.some(item => item?.sessionID !== id)) throw new Error('Invalid OpenCode inbox response.');
    return value;
  }

  async prompt(id, { id: inputId, text, metadata = {}, delivery = 'queue', resume = true }) {
    sessionId(id);
    messageId(inputId);
    if (typeof text !== 'string' || !text.trim()) throw new Error('OpenCode prompt text must be nonempty.');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid OpenCode message metadata.');
    if (!['queue', 'steer'].includes(delivery) || typeof resume !== 'boolean') throw new Error('Invalid OpenCode prompt delivery options.');
    await this.#revalidate();
    const value = dataOf(await this.request('POST', `/api/session/${id}/prompt`, { id: inputId, text, metadata, delivery, resume }), 'prompt');
    if (value?.id !== inputId || value?.sessionID !== id || value?.type !== 'user') {
      throw new Error('OpenCode prompt receipt does not match the expected session and message; inspect before retrying.');
    }
    return value;
  }

  async createSession(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid OpenCode session creation request.');
    await this.#revalidate();
    const value = dataOf(await this.request('POST', '/api/session', body), 'session creation');
    sessionId(value?.id);
    return value;
  }
}
