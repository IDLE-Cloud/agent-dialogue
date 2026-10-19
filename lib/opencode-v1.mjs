import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Contract checked against the official v1.19.0 tag (733b2c627e5aec39cb33cc22373bdce33053ef2c):
// packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/session.ts
// packages/opencode/src/session/{prompt,session,status}.ts and packages/core/src/shell.ts.
// V1 has no durable inbox: HTTP 204 only starts a fiber and is not admission proof.
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]+$/;
const SUPPORTED_VERSION = '1.19.0';

function clean(value) { return typeof value === 'string' && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value); }
function failBefore(message, retryable = false) { return Object.assign(new Error(message), { notSubmitted: true, ...(retryable ? { retryable: true } : {}) }); }
function unknown() { return Object.assign(new Error('OpenCode V1 submission outcome is unknown; preserve the pending input and reconcile before retrying.'), { uncertain: true }); }
function sessionId(id) { if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid OpenCode V1 session ID.'); return id; }
function messageId(id) { if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw new Error('Invalid OpenCode V1 message ID.'); return id; }

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid OpenCode V1 service URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!(host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OpenCode V1 service must use an uncredentialed loopback origin.');
  }
  return url.origin;
}

function identityOf(identity) {
  if (!clean(identity?.serviceId) || identity.serviceId.length > 256) throw new Error('Invalid OpenCode V1 owner service identity.');
  if (identity.version !== SUPPORTED_VERSION) throw new Error('Unsupported OpenCode V1 version; this adapter is pinned to 1.19.0.');
  return Object.freeze({ serviceId: identity.serviceId, origin: originOf(identity.origin), version: identity.version });
}

function absolutePath(value) {
  if (!clean(value)) throw new Error('Invalid OpenCode V1 absolute path.');
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return win32.normalize(value);
  if (posix.isAbsolute(value)) return posix.normalize(value);
  throw new Error('Invalid OpenCode V1 absolute path.');
}

function scopeOf({ directory, projectId, shell, commandShell }) {
  if (!clean(projectId) || projectId.length > 512) throw new Error('Invalid OpenCode V1 project scope.');
  directory = absolutePath(directory);
  shell = absolutePath(shell);
  if (!['powershell', 'posix'].includes(commandShell)) throw new Error('Invalid OpenCode V1 command shell scope.');
  const name = win32.basename(shell).toLowerCase();
  if (commandShell === 'powershell' && !['powershell.exe', 'pwsh.exe'].includes(name)) throw new Error('Invalid OpenCode V1 PowerShell scope.');
  if (commandShell === 'posix' && !['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'dash', 'ksh'].includes(name)) throw new Error('Invalid OpenCode V1 POSIX shell scope.');
  return Object.freeze({ directory, projectId, shell, commandShell });
}

async function readService(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Cannot read the owner-selected OpenCode V1 service descriptor.'); }
  if (!clean(value?.password) || !clean(value.username ?? 'opencode') || (value.username ?? 'opencode').includes(':')) throw new Error('OpenCode V1 service credentials are missing or invalid.');
  return { identity: identityOf({ serviceId: value.id, origin: value.url, version: value.version }),
    scope: scopeOf(value), password: value.password, username: value.username ?? 'opencode' };
}

function normalizeSession(value, id, scope, { available = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== id ||
      value.projectID !== scope.projectId || absolutePath(value.directory) !== scope.directory) {
    throw new Error('OpenCode V1 native session/project/directory does not match the owner scope.');
  }
  if (available && value.time?.archived) throw new Error('OpenCode V1 native session is archived.');
  return { ...value, location: { directory: value.directory } };
}

function validateMessage(value, id, inputId) {
  const info = value?.info;
  if (!info || !MESSAGE_ID.test(info.id ?? '') || info.sessionID !== id || !['user', 'assistant'].includes(info.role) ||
      (inputId !== undefined && (info.id !== inputId || info.role !== 'user')) || !Array.isArray(value.parts) ||
      value.parts.some(part => !part || part.sessionID !== id || part.messageID !== info.id)) {
    throw new Error('OpenCode V1 returned a message for a different session/input or invalid parts.');
  }
  return value;
}

function inputText(value, expected) {
  if (value.parts.length !== 1 || value.parts[0].type !== 'text' || typeof value.parts[0].text !== 'string' || !value.parts[0].text.trim() ||
      expected !== undefined && value.parts[0].text !== expected) throw new Error('OpenCode V1 persisted input does not match the complete expected message text.');
  return value;
}

function modelOf(session) {
  if (!clean(session.agent) || !clean(session.model?.id) || !clean(session.model?.providerID) ||
      (session.model.variant !== undefined && !clean(session.model.variant))) {
    throw new Error('OpenCode V1 existing session needs an explicit native agent and model before submission.');
  }
  return { agent: session.agent, model: { providerID: session.model.providerID, modelID: session.model.id }, variant: session.model.variant ?? 'default' };
}

function sameModel(value, expected) {
  if (value.info.agent !== expected.agent || value.info.model?.providerID !== expected.model.providerID ||
      value.info.model?.modelID !== expected.model.modelID || (value.info.model?.variant ?? 'default') !== expected.variant) {
    throw new Error('OpenCode V1 persisted input agent/model does not match the existing native session.');
  }
  return value;
}

export class OpenCodeV1Client {
  #password; #username; #fetch; #scope; #serviceFile; #receiptTimeoutMs; #pollIntervalMs;
  #submitting = new Set();

  constructor({ identity, password, username = 'opencode', directory, projectId, shell, commandShell, fetchImpl = globalThis.fetch,
    serviceFile = null, receiptTimeoutMs = 5000, pollIntervalMs = 50 }) {
    Object.defineProperty(this, 'identity', { value: identityOf(identity), enumerable: true });
    if (!clean(password) || !clean(username) || username.includes(':')) throw new Error('OpenCode V1 service credentials are missing or invalid.');
    if (typeof fetchImpl !== 'function') throw new Error('OpenCode V1 HTTP client is unavailable.');
    if (!Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 20_000 ||
        !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > receiptTimeoutMs) throw new Error('Invalid OpenCode V1 receipt polling limits.');
    this.#scope = scopeOf({ directory, projectId, shell, commandShell });
    this.#password = password; this.#username = username; this.#fetch = fetchImpl; this.#serviceFile = serviceFile;
    this.#receiptTimeoutMs = receiptTimeoutMs; this.#pollIntervalMs = pollIntervalMs;
    Object.defineProperty(this, 'capabilities', { value: Object.freeze({ existingAttach: true, queue: false, stableInputId: true, resume: false, idleOnly: true, commandShell }), enumerable: true });
  }

  static async discover({ serviceFile = process.env.AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE, fetchImpl = globalThis.fetch } = {}) {
    if (!clean(serviceFile)) throw new Error('Set AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE to an owner-selected local service descriptor.');
    const record = await readService(serviceFile);
    const client = new OpenCodeV1Client({ identity: record.identity, ...record.scope, password: record.password, username: record.username, serviceFile, fetchImpl });
    await client.#revalidate();
    return client;
  }

  async #revalidate() {
    if (this.#serviceFile) {
      const record = await readService(this.#serviceFile);
      if (JSON.stringify(record.identity) !== JSON.stringify(this.identity) || JSON.stringify(record.scope) !== JSON.stringify(this.#scope)) {
        throw new Error('OpenCode V1 owner service identity changed; explicitly rebind the intended session.');
      }
      this.#password = record.password; this.#username = record.username;
    }
    await this.info();
    const config = await this.request('GET', '/config');
    if (!config || absolutePath(config.shell) !== this.#scope.shell) throw new Error('OpenCode V1 effective native shell no longer matches the owner scope.');
  }

  async request(method, path, body, { allowMissing = false, timeoutMs = 20_000, limit } = {}) {
    if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported OpenCode V1 HTTP method.');
    if (typeof path !== 'string' || !(path === '/global/health' || path === '/config' || path === '/session' || path === '/session/status' ||
        /^\/session\/ses_[A-Za-z0-9]+(?:\/message(?:\/msg_[A-Za-z0-9_-]+)?|\/prompt_async)?$/.test(path))) throw new Error('Invalid OpenCode V1 API path.');
    if (method === 'POST' && !/^\/session\/ses_[A-Za-z0-9]+\/prompt_async$/.test(path)) throw new Error('Invalid OpenCode V1 submission API path.');
    const url = new URL(path, this.identity.origin);
    if (path !== '/global/health') url.searchParams.set('directory', this.#scope.directory);
    if (limit !== undefined) {
      if (method !== 'GET' || !(path === '/session' || /^\/session\/ses_[A-Za-z0-9]+\/message$/.test(path)) || !Number.isInteger(limit) || limit < 1 || limit > 1001) throw new Error('Invalid OpenCode V1 native list limit.');
      url.searchParams.set('limit', String(limit));
    }
    const headers = { accept: 'application/json', authorization: `Basic ${Buffer.from(`${this.#username}:${this.#password}`).toString('base64')}` };
    const options = { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    let response;
    try { response = await this.#fetch(url, options); }
    catch { throw new Error('OpenCode V1 request failed or timed out; inspect the exact session before retrying a submission.'); }
    if (!response.ok) {
      if (allowMissing && response.status === 404) return null;
      throw new Error(`OpenCode V1 HTTP ${response.status}; response body withheld.`);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('OpenCode V1 returned an invalid JSON response.'); }
  }

  async info() {
    const value = await this.request('GET', '/global/health');
    if (value?.healthy !== true || value.version !== this.identity.version) throw new Error('OpenCode V1 service health/version changed; explicitly select the intended service.');
    return value;
  }

  async #session(id) { return normalizeSession(await this.request('GET', `/session/${id}`), id, this.#scope); }

  async sessions({ directory } = {}) {
    if (directory !== undefined && absolutePath(directory) !== this.#scope.directory) throw new Error('OpenCode V1 directory filter is outside the owner scope.');
    await this.#revalidate();
    // V1's directory-scoped endpoint is intentionally not a global session search.
    const items = await this.request('GET', '/session', undefined, { limit: 1001 });
    if (!Array.isArray(items)) throw new Error('Invalid OpenCode V1 session list.');
    if (items.length > 1000) throw new Error('OpenCode V1 owner directory exceeds the listing limit; select an exact full session ID explicitly.');
    return items.map(item => normalizeSession(item, sessionId(item?.id), this.#scope, { available: false }));
  }

  async session(id) { sessionId(id); await this.#revalidate(); return await this.#session(id); }

  async messages(id, { limit = 50 } = {}) {
    sessionId(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid OpenCode V1 message limit.');
    await this.#revalidate(); await this.#session(id);
    const values = await this.request('GET', `/session/${id}/message`, undefined, { limit });
    if (!Array.isArray(values)) throw new Error('Invalid OpenCode V1 messages response.');
    return values.map(value => validateMessage(value, id)).slice(-limit);
  }

  async #input(id, inputId, text, timeoutMs = 20_000) {
    const value = await this.request('GET', `/session/${id}/message/${inputId}`, undefined, { allowMissing: true, timeoutMs });
    return value === null ? null : inputText(validateMessage(value, id, inputId), text);
  }

  async input(id, inputId, { text } = {}) {
    sessionId(id); messageId(inputId);
    if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('OpenCode V1 expected message text must be nonempty.');
    await this.#revalidate(); await this.#session(id);
    return await this.#input(id, inputId, text);
  }

  async inbox(id) { await this.session(id); return []; }

  async prompt(id, { id: inputId, text, metadata = {}, delivery = 'queue', resume = true }) {
    let owns = false, native, chosen;
    try {
      sessionId(id); messageId(inputId);
      if (typeof text !== 'string' || !text.trim()) throw new Error('OpenCode V1 prompt text must be nonempty.');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || delivery !== 'queue' || resume !== true) throw new Error('Unsupported OpenCode V1 delivery options; only an idle native session can be prompted.');
      if (this.#submitting.has(id)) throw Object.assign(failBefore('OpenCode V1 session already has a local submission in progress.', true), { nativeBusy: true });
      this.#submitting.add(id); owns = true;
      await this.#revalidate(); native = await this.#session(id); chosen = modelOf(native);
      if (native.revert) throw new Error('OpenCode V1 session has a reverted history; review it in the native harness before bridge submission.');
      const existing = await this.#input(id, inputId, text);
      if (existing) { sameModel(existing, chosen); return { id: inputId, sessionID: id, type: 'user', status: 'persisted', reconciled: true }; }
      const status = await this.request('GET', '/session/status');
      if (!status || typeof status !== 'object' || Array.isArray(status) ||
          Object.values(status).some(item => !item || !['idle', 'busy', 'retry'].includes(item.type))) throw new Error('Invalid OpenCode V1 native session status.');
      if (status[id] && status[id].type !== 'idle') throw Object.assign(failBefore('OpenCode V1 session is busy; leave the local queue item pending until idle.', true), { nativeBusy: true });
    } catch (error) {
      if (owns) this.#submitting.delete(id);
      error.notSubmitted = true;
      throw error;
    }
    try {
      const body = { messageID: inputId, ...chosen, parts: [{ type: 'text', text }] };
      try { await this.request('POST', `/session/${id}/prompt_async`, body); }
      catch { /* A lost or rejected response cannot prove the native fiber never persisted the input. */ }
      const deadline = Date.now() + this.#receiptTimeoutMs;
      do {
        try {
          const receipt = await this.#input(id, inputId, text, Math.max(1, deadline - Date.now()));
          if (receipt) { sameModel(receipt, chosen); return { id: inputId, sessionID: id, type: 'user', status: 'persisted' }; }
        } catch { /* Partial message/parts persistence is not yet a complete receipt. */ }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw unknown();
    } finally { this.#submitting.delete(id); }
  }
}
