import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export function newId(prefix = 'msg') { return `${prefix}_${randomUUID()}`; }

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', messageId } = {}) {
    super(message);
    this.name = 'ApiError'; this.status = status; this.code = code;
    if (messageId) this.messageId = messageId;
  }
}

export function hubUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Hub URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || (url.protocol === 'http:' && !loopback)) {
    throw new Error('Hub requires an HTTPS origin or a loopback HTTP origin (including an SSH tunnel).');
  }
  return url.origin;
}

export class HubClient {
  #token; #fetch;
  constructor({ url, token = '', fetchImpl = globalThis.fetch }) {
    this.url = hubUrl(url);
    if (typeof token !== 'string' || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid Hub credential.');
    this.#token = token; this.#fetch = fetchImpl;
  }

  async request(method, path, body, { signal, timeoutMs = 30_000 } = {}) {
    const target = new URL(path, this.url);
    if (!['GET', 'POST'].includes(method) || !path.startsWith('/v1/') || target.origin !== this.url || target.hash) {
      throw new Error('Invalid Hub request.');
    }
    const messageId = method === 'POST' && path === '/v1/messages' ? body?.id : undefined;
    const headers = { accept: 'application/json' };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await this.#fetch(target, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ApiError('Hub request failed or timed out. Retain the message ID and query or retry with the same ID.', { messageId });
    }
    let value;
    try { value = await response.json(); }
    catch { throw new ApiError('Hub returned an invalid response; retain the original message ID.', { status: response.status, code: 'invalid_response', messageId }); }
    if (!response.ok) {
      // Hub errors contain fixed public messages; never copy arbitrary proxy bodies.
      const code = typeof value?.error?.code === 'string' && /^[a-z_]{1,64}$/.test(value.error.code) ? value.error.code : 'http_error';
      throw new ApiError(`Hub HTTP ${response.status} (${code}).`, { status: response.status, code, messageId });
    }
    return value;
  }
}
