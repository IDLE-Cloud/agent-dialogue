import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// KAP contract checked at official kimi-code 2.1.1 f67e6398 and 2.2.0 472192c3:
// kap-server routes/{meta,prompts,messages}, services/messages/message{History,Projection};
// agent-core-v2 agent/loop/loopService. Client prompt_id becomes the persisted user
// message ID. messageHistory flushes native Wire before reading persisted history.
// POST acknowledgement and the in-memory prompt queue are NOT durable receipts.
// No cross-process TUI ownership lock is exposed: the owner descriptor must name
// only sessions created/owned by this exact selected server, never a live TUI.
const VERSIONS = new Set(['2.1.1', '2.2.0']);
const SESSION_ID = /^session_[A-Za-z0-9_-]+$/;
const INPUT_ID = /^msg_[A-Za-z0-9_-]+$/;
function clean(value) { return typeof value === 'string' && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value); }
function failBefore(message, busy = false) { return Object.assign(new Error(message), { notSubmitted: true, ...(busy ? { nativeBusy: true, retryable: true } : {}) }); }
function unknown() { return Object.assign(new Error('Kimi submission outcome is unknown; preserve the pending input and reconcile before retrying.'), { uncertain: true }); }
function sessionId(id) { if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid Kimi session ID.'); return id; }
function inputId(id) { if (typeof id !== 'string' || !INPUT_ID.test(id)) throw new Error('Invalid Kimi input ID.'); return id; }
function absolute(value) {
  if (!clean(value)) throw new Error('Invalid Kimi absolute path scope.');
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return win32.normalize(value);
  if (posix.isAbsolute(value)) return posix.normalize(value);
  throw new Error('Invalid Kimi absolute path scope.');
}
function canonical(value) { const path = absolute(value); return win32.isAbsolute(path) && !posix.isAbsolute(path) ? path.toLowerCase() : path; }
function originOf(value) {
  let url;
  try { if (typeof value !== 'string') throw new Error(); url = new URL(value); } catch { throw new Error('Invalid Kimi loopback service origin.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!(host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Kimi service must use an uncredentialed loopback origin.');
  return url.origin;
}
function identityOf(value) {
  if (!clean(value?.serviceId) || value.serviceId.length > 256) throw new Error('Invalid Kimi owner service identity.');
  if (!VERSIONS.has(value.version)) throw new Error('Unsupported Kimi version; the adapter supports verified 2.1.1 and 2.2.0 contracts.');
  return Object.freeze({ serviceId: value.serviceId, origin: originOf(value.origin), version: value.version });
}
function scopeOf({ directory, workspaceId, sessionIds, commandShell }) {
  directory = absolute(directory);
  if (!clean(workspaceId) || workspaceId.length > 256 || !Array.isArray(sessionIds) || sessionIds.length < 1 || sessionIds.length > 100 || sessionIds.some(id => typeof id !== 'string' || !SESSION_ID.test(id)) || new Set(sessionIds).size !== sessionIds.length) throw new Error('Invalid Kimi owner-selected workspace/session scope.');
  if (commandShell !== 'posix') throw new Error('Invalid Kimi command shell scope; native Bash tools require POSIX command syntax, including on Windows.');
  return Object.freeze({ directory, workspaceId, sessionIds: Object.freeze([...sessionIds].sort()), commandShell });
}
async function readService(file) {
  let record, token;
  try {
    record = JSON.parse(await readFile(file, 'utf8'));
    token = (await readFile(absolute(record.tokenFile), 'utf8')).trim();
  } catch { throw new Error('Cannot read the owner-selected Kimi service descriptor or private token file.'); }
  if (!clean(token) || token.length > 4096) throw new Error('Kimi private service token is missing or invalid.');
  return { identity: identityOf({ serviceId: record.id, origin: record.url, version: record.version }), scope: scopeOf(record), token, tokenFile: absolute(record.tokenFile) };
}
function millis(value) { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error('Invalid Kimi native session timestamp.'); return result; }
function normalizeSession(value, id, scope, { available = true } = {}) {
  if (!value || typeof value !== 'object' || value.id !== id || value.workspace_id !== scope.workspaceId || canonical(value.metadata?.cwd) !== canonical(scope.directory) || typeof value.archived !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.main_turn_active !== 'boolean' || !['none', 'approval', 'question'].includes(value.pending_interaction)) throw new Error('Kimi native session/workspace/directory does not match owner scope or has invalid state.');
  if (available && value.archived) throw new Error('Kimi native session is archived.');
  const time = { created: millis(value.created_at), updated: millis(value.updated_at) };
  if (value.archived) time.archived = value.archived_at ? millis(value.archived_at) : time.updated;
  const model = clean(value.agent_config?.model) ? value.agent_config.model : undefined;
  return { id, projectID: 'kimi_' + createHash('sha256').update(canonical(value.metadata.cwd)).digest('hex').slice(0, 32), location: { directory: value.metadata.cwd }, title: typeof value.title === 'string' ? value.title : '', time, ...(model ? { model } : {}), busy: value.busy, mainTurnActive: value.main_turn_active, pendingInteraction: value.pending_interaction };
}
function validateMessage(value, session, expectedId) {
  if (!value || !clean(value.id) || value.session_id !== session || !['user', 'assistant', 'tool', 'system'].includes(value.role) || !Array.isArray(value.content) || (expectedId !== undefined && (value.id !== expectedId || value.role !== 'user'))) throw new Error('Kimi native message does not match the exact session/input.');
  return value;
}
function completeInput(value, text) {
  if (value.content.length !== 1 || value.content[0]?.type !== 'text' || typeof value.content[0]?.text !== 'string' || !value.content[0].text.trim() || text !== undefined && value.content[0].text !== text) throw new Error('Kimi persisted input does not match the complete expected message text.');
  return value;
}
function promptQueue(value) {
  if (!value || !Array.isArray(value.queued) || value.active !== null && (!value.active || typeof value.active !== 'object')) throw new Error('Invalid Kimi native prompt queue.');
  for (const item of [...(value.active ? [value.active] : []), ...value.queued]) {
    if (!clean(item?.prompt_id) || !clean(item.user_message_id) || !['queued', 'running', 'blocked'].includes(item.status) || !Array.isArray(item.content) || !item.content.length) throw new Error('Invalid Kimi native prompt queue item.');
  }
  return value;
}

export class KimiClient {
  #token; #scope; #fetch; #serviceFile; #tokenFile; #receiptTimeoutMs; #pollIntervalMs; #submitting = new Set();
  constructor({ identity, token, directory, workspaceId, sessionIds, commandShell, fetchImpl = globalThis.fetch, serviceFile = null, tokenFile = null, receiptTimeoutMs = 5000, pollIntervalMs = 50 }) {
    Object.defineProperty(this, 'identity', { value: identityOf(identity), enumerable: true });
    if (!clean(token) || token.length > 4096) throw new Error('Kimi private service token is missing or invalid.');
    if (typeof fetchImpl !== 'function' || !Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 20_000 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > receiptTimeoutMs) throw new Error('Invalid Kimi HTTP client or receipt polling limits.');
    this.#scope = scopeOf({ directory, workspaceId, sessionIds, commandShell }); this.#token = token; this.#fetch = fetchImpl;
    this.#serviceFile = serviceFile; this.#tokenFile = tokenFile; this.#receiptTimeoutMs = receiptTimeoutMs; this.#pollIntervalMs = pollIntervalMs;
    Object.defineProperty(this, 'capabilities', { value: Object.freeze({ existingAttach: true, queue: false, stableInputId: true, resume: false, idleOnly: true, commandShell }), enumerable: true });
  }
  static async discover({ serviceFile = process.env.AGENT_DIALOGUE_KIMI_SERVICE_FILE, fetchImpl = globalThis.fetch } = {}) {
    if (!clean(serviceFile)) throw new Error('Set AGENT_DIALOGUE_KIMI_SERVICE_FILE to an owner-selected local Kimi service descriptor.');
    const record = await readService(serviceFile);
    const client = new KimiClient({ identity: record.identity, ...record.scope, token: record.token, tokenFile: record.tokenFile, serviceFile, fetchImpl });
    await client.#revalidate(); return client;
  }
  #allowed(id) { sessionId(id); if (!this.#scope.sessionIds.includes(id)) throw new Error('Kimi session is outside the owner-selected exact server session allowlist.'); }
  async #revalidate() {
    if (this.#serviceFile) {
      const record = await readService(this.#serviceFile);
      if (JSON.stringify(record.identity) !== JSON.stringify(this.identity) || JSON.stringify(record.scope) !== JSON.stringify(this.#scope) || record.tokenFile !== this.#tokenFile) throw new Error('Kimi owner service identity or session scope changed; explicitly rebind the intended session.');
      this.#token = record.token;
    }
    await this.info();
  }
  async request(method, path, body, { allowMissing = false, timeoutMs = 20_000, pageSize } = {}) {
    if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported Kimi HTTP method.');
    if (typeof path !== 'string') throw new Error('Invalid Kimi API path.');
    const match = /^\/api\/v1\/sessions\/(session_[A-Za-z0-9_-]+)(?:\/(prompts|messages)(?:\/(msg_[A-Za-z0-9_-]+))?)?$/.exec(path);
    if (path !== '/api/v1/meta' && !match || match?.[2] === 'prompts' && match[3] || method === 'POST' && (!match || match[2] !== 'prompts' || match[3])) throw new Error('Invalid Kimi API path.');
    if (match) this.#allowed(match[1]);
    const url = new URL(path, this.identity.origin);
    if (pageSize !== undefined) {
      if (method !== 'GET' || match?.[2] !== 'messages' || match[3] || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid Kimi native messages page size.');
      url.searchParams.set('page_size', String(pageSize));
    }
    const headers = { accept: 'application/json', authorization: `Bearer ${this.#token}` };
    const options = { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    let response, envelope;
    try { response = await this.#fetch(url, options); } catch { throw new Error('Kimi request failed or timed out; inspect the exact session before retrying a submission.'); }
    if (!response.ok) throw new Error(`Kimi HTTP ${response.status}; response body withheld.`);
    try { envelope = await response.json(); } catch { throw new Error('Kimi returned an invalid JSON envelope.'); }
    if (!envelope || !Number.isSafeInteger(envelope.code)) throw new Error('Kimi returned an invalid response envelope.');
    if (allowMissing && envelope.code === 40403) return null;
    if (envelope.code !== 0) throw new Error(`Kimi API ${envelope.code}; response body withheld.`);
    return envelope.data;
  }
  async info() {
    const value = await this.request('GET', '/api/v1/meta');
    if (value?.server_id !== this.identity.serviceId || value.server_version !== this.identity.version || value.backend !== 'v2') throw new Error('Kimi native service identity/version/backend changed; explicitly select the intended server.');
    if (value.dangerous_bypass_auth !== false) throw new Error('Kimi native server authentication must remain enabled.');
    return value;
  }
  async #session(id, options) { return normalizeSession(await this.request('GET', `/api/v1/sessions/${id}`), id, this.#scope, options); }
  async sessions({ directory } = {}) {
    if (directory !== undefined && canonical(directory) !== canonical(this.#scope.directory)) throw new Error('Kimi directory filter is outside the owner scope.');
    await this.#revalidate(); const items = [];
    for (const id of this.#scope.sessionIds) items.push(await this.#session(id, { available: false }));
    return items;
  }
  async session(id) { this.#allowed(id); await this.#revalidate(); return this.#session(id); }
  async messages(id, { limit = 50 } = {}) {
    this.#allowed(id); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Kimi native message limit.');
    await this.#revalidate(); await this.#session(id);
    const page = await this.request('GET', `/api/v1/sessions/${id}/messages`, undefined, { pageSize: limit });
    if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' || page.items.length > limit) throw new Error('Invalid Kimi native messages response.');
    return page.items.map(value => validateMessage(value, id)).reverse();
  }
  async #input(id, input, text, timeoutMs) {
    const value = await this.request('GET', `/api/v1/sessions/${id}/messages/${input}`, undefined, { allowMissing: true, timeoutMs });
    return value === null ? null : completeInput(validateMessage(value, id, input), text);
  }
  async input(id, input, { text } = {}) {
    this.#allowed(id); inputId(input); if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw new Error('Kimi expected input text must be nonempty.');
    await this.#revalidate(); await this.#session(id); return this.#input(id, input, text);
  }
  /** Recovery-only: project the exact persisted GET, never the prompt queue. */
  async inputEvidence(id, input) {
    const value = await this.input(id, input);
    if (value === null) return null;
    completeInput(validateMessage(value, id, input));
    return { sessionId: value.session_id, inputId: value.id, role: value.role, text: value.content[0].text, storage: 'persisted' };
  }
  async inbox(id) {
    this.#allowed(id); await this.#revalidate(); await this.#session(id);
    const queue = promptQueue(await this.request('GET', `/api/v1/sessions/${id}/prompts`));
    // Queue records are useful status but do not masquerade as persisted input IDs.
    return [...(queue.active ? [queue.active] : []), ...queue.queued];
  }
  async prompt(id, { id: input, text, metadata = {}, delivery = 'queue', resume = true }) {
    let owns = false;
    try {
      this.#allowed(id); inputId(input);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Kimi prompt text must be nonempty.');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || delivery !== 'queue' || resume !== true) throw new Error('Unsupported Kimi prompt delivery options.');
      if (this.#submitting.has(id)) throw failBefore('Kimi native session has a local submission in progress.', true);
      this.#submitting.add(id); owns = true;
      await this.#revalidate(); const native = await this.#session(id);
      const existing = await this.#input(id, input, text);
      if (existing) return { id: input, sessionID: id, type: 'user', status: 'persisted', reconciled: true };
      if (native.busy || native.mainTurnActive || native.pendingInteraction !== 'none') throw failBefore('Kimi native session is busy or awaiting an interaction; retain the local queue until idle.', true);
      const queue = promptQueue(await this.request('GET', `/api/v1/sessions/${id}/prompts`));
      if (queue.active || queue.queued.length) throw failBefore('Kimi native prompt queue is occupied; retain the local queue until idle.', true);
    } catch (error) { if (owns) this.#submitting.delete(id); error.notSubmitted = true; throw error; }
    try {
      try { await this.request('POST', `/api/v1/sessions/${id}/prompts`, { prompt_id: input, content: [{ type: 'text', text }] }); }
      catch { /* Transport and business errors after POST cannot prove absence of native persistence. */ }
      const deadline = Date.now() + this.#receiptTimeoutMs;
      do {
        try {
          const receipt = await this.#input(id, input, text, Math.max(1, deadline - Date.now()));
          if (receipt) return { id: input, sessionID: id, type: 'user', status: 'persisted' };
        } catch { /* Partial, unavailable or mismatched receipts never establish admission. */ }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      throw unknown();
    } finally { this.#submitting.delete(id); }
  }
}
