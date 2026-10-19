import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { absoluteRemotePath, remoteProcessCommand, posixQuote } from '../../platform.mjs';
import { acceptObservation, validateObservationRequest } from '../observation.mjs';
import { readSource } from './local.mjs';

const TIMEOUT = 12_000;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC = 64 * 1024;
const MAX_SOURCES = 16;
const CONFIG_KEYS = new Set(['kind', 'id', 'label', 'destination', 'executable', 'cli', 'stateDir', 'expectedNodeId', 'rooms']);
const OPTIONAL_KEYS = new Set(['shell']);
const DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NONCE = /^[0-9a-f]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
const emptyStore = () => ({ version: 1, rooms: {}, bindings: {}, peers: {}, inbox: {}, outbox: {} });

class SshObservationError extends Error {}
function fail(message) { throw new SshObservationError(message); }

/** Only owner-configured fixed commands and identity-pinned room scopes are accepted. */
export function validateSshSource(spec) {
  if (!object(spec) || [...CONFIG_KEYS].some(key => !Object.hasOwn(spec, key)) || Object.keys(spec).some(key => !CONFIG_KEYS.has(key) && !OPTIONAL_KEYS.has(key)) || spec.kind !== 'ssh') {
    fail('Invalid SSH observation source configuration.');
  }
  const shell = spec.shell ?? 'posix';
  if (Object.hasOwn(spec, 'shell') && !['posix', 'powershell'].includes(spec.shell)) fail('Invalid SSH observation remote shell.');
  if (!text(spec.id, 256) || !text(spec.label, 256)) fail('SSH observation source requires a bounded identity and label.');
  if (!text(spec.destination, 128) || !DESTINATION.test(spec.destination)) fail('SSH observation destination must be a host alias or user@host without options or ports.');
  for (const key of ['executable', 'cli', 'stateDir']) {
    if (!text(spec[key], 4096) || !absoluteRemotePath(spec[key], shell)) fail(`SSH observation paths must be absolute ${shell === 'powershell' ? 'Windows' : 'POSIX'} paths.`);
  }
  let request;
  try {
    request = validateObservationRequest({ version: 1, type: 'viewer-observe', requestId: '0'.repeat(32), expectedNodeId: spec.expectedNodeId, rooms: spec.rooms });
  } catch { fail('SSH observation requires a pinned node and distinct sealed room revisions.'); }
  return { ...spec, rooms: structuredClone(request.rooms) };
}

function remoteCommand(spec) {
  if (spec.shell === 'powershell') return remoteProcessCommand(spec.executable, [spec.cli, 'view-export', '--state-dir', spec.stateDir], { shell: 'powershell' });
  // Preserve the existing POSIX receiver argv and its fixed command contract.
  return [posixQuote(spec.executable), posixQuote(spec.cli), 'view-export', '--state-dir', posixQuote(spec.stateDir)].join(' ');
}
function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:HCOM_|AGENT_DIALOGUE_|CODEX_|CLAUDE_)/.test(key)) delete env[key];
  return env;
}

/** Owns exactly one SSH child, bounds both pipes, and always settles after cancellation. */
async function run(executable, args, { env, input, timeout, maxOutput, signal }) {
  if (signal?.aborted) fail('SSH observation was cancelled.');
  return new Promise((resolve, reject) => {
    let child;
    const pipe = process.platform === 'win32' ? 'overlapped' : 'pipe';
    try { child = spawn(executable, args, { env, shell: false, stdio: [pipe, pipe, pipe] }); }
    catch { reject(new SshObservationError('SSH observation process could not start.')); return; }
    let failure, settled = false, stdoutBytes = 0, diagnosticBytes = 0, killTimer, settleTimer;
    const chunks = [];
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(value);
    }
    function stop(message) {
      if (settled || failure) return;
      failure = new SshObservationError(message);
      chunks.length = 0;
      child.stdin.destroy();
      try { child.kill('SIGTERM'); } catch { /* The owned child may already have exited. */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* A close event may race escalation. */ }
      }, 500);
      // Inherited descriptors can delay `close` after exit. They cannot keep the viewer waiting.
      settleTimer = setTimeout(() => finish(failure), 1500);
    }
    const abort = () => stop('SSH observation was cancelled.');
    const timer = setTimeout(() => stop('SSH observation timed out.'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) stop('SSH observation response exceeded its limit.');
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > MAX_DIAGNOSTIC) stop('SSH observation diagnostic output exceeded its limit.');
    });
    child.once('error', () => finish(new SshObservationError('SSH observation process could not start.')));
    child.once('close', code => finish(failure, { code: code ?? 143, stdout: Buffer.concat(chunks) }));
    child.stdin.on('error', () => { /* An early receiver exit is handled by close. */ });
    if (!failure) child.stdin.end(input);
  });
}

/** A complete, identity-checked read snapshot. No request body enters argv or errors. */
export async function fetchSshObservation(spec, { runner = run, requestId = randomBytes(16).toString('hex'), signal } = {}) {
  const selected = validateSshSource(spec);
  if (typeof requestId !== 'string' || !NONCE.test(requestId)) fail('SSH observation request identity is invalid.');
  if (signal?.aborted) fail('SSH observation was cancelled.');
  const request = validateObservationRequest({ version: 1, type: 'viewer-observe', requestId, expectedNodeId: selected.expectedNodeId, rooms: selected.rooms });
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', '-o', 'ClearAllForwardings=yes', '--', selected.destination, remoteCommand(selected)];
  let result;
  try {
    result = await runner('ssh', args, { env: childEnvironment(), input: `${JSON.stringify(request)}\n`, timeout: TIMEOUT, maxOutput: MAX_OUTPUT, signal });
  } catch (error) {
    if (error instanceof SshObservationError) throw error;
    fail('SSH observation process failed.');
  }
  if (signal?.aborted) fail('SSH observation was cancelled.');
  if (!result || result.code !== 0) fail('SSH observation receiver exited unsuccessfully.');
  let stdout = typeof result.stdout === 'string' ? result.stdout : null;
  if (Buffer.isBuffer(result.stdout)) {
    if (result.stdout.length > MAX_OUTPUT) fail('SSH observation response exceeds its limit.');
    try { stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout); }
    catch { fail('SSH observation returned an invalid UTF-8 response.'); }
  }
  if (stdout === null || Buffer.byteLength(stdout) > MAX_OUTPUT) fail('SSH observation response is missing or exceeds its limit.');
  let source;
  try { source = acceptObservation(JSON.parse(stdout), request); }
  catch { fail('SSH observation returned an invalid or out-of-scope response.'); }
  // Remote clocks do not determine freshness in this observer.
  return { ...source, id: selected.id, label: selected.label, observedAt: new Date().toISOString() };
}

function initialSource(spec) {
  return { id: spec.id, label: spec.label, available: false, observedAt: null, generation: null,
    error: 'SSH observation is loading.', node: null, events: [], store: emptyStore(), workers: [], diagnostics: [] };
}
function clientGeneration(raw, epoch) {
  return createHash('sha256').update(`agent-dialogue-ssh-observer:${raw}:${epoch}`).digest('hex').slice(0, 32);
}
function sourceSnapshot(source, spec, generation) {
  return structuredClone({ id: spec.id, label: spec.label, available: true, observedAt: source.observedAt, generation, error: null,
    node: source.node || null, events: source.events, store: source.store || emptyStore(), workers: source.workers || [], diagnostics: source.diagnostics || [] });
}

/** Poll SSH in the background so an unavailable machine never blocks local observation. */
export function createSourceReader({ localReader = readSource, remoteReader = fetchSshObservation, clock = Date.now, intervalMs = 3000 } = {}) {
  if (typeof localReader !== 'function' || typeof remoteReader !== 'function' || typeof clock !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 3_600_000) fail('Invalid SSH observation reader configuration.');
  const states = new Map();
  let closed = false;
  async function read(spec) {
    if (closed) fail('SSH observation reader is closed.');
    if (spec?.kind !== 'ssh') {
      if (spec?.kind !== undefined && spec?.kind !== 'local') fail('Unknown observation source kind.');
      return localReader(spec);
    }
    const selected = validateSshSource(spec), identity = JSON.stringify(selected);
    let state = states.get(selected.id);
    if (state && state.identity !== identity) fail('SSH observation source configuration changed; restart the viewer.');
    if (!state) {
      if (states.size >= MAX_SOURCES) fail('SSH observation source limit exceeded.');
      state = { identity, snapshot: initialSource(selected), pending: null, controller: null, lastAttempt: null, rawGeneration: null, epoch: 0, events: new Map() };
      states.set(selected.id, state);
    }
    const now = clock();
    if (!state.pending && (state.lastAttempt === null || now - state.lastAttempt >= intervalMs)) {
      state.lastAttempt = now;
      const controller = new AbortController();
      state.controller = controller;
      // Schedule after assigning pending: even a synchronous custom-reader throw
      // must clear that same promise and allow a later retry.
      state.pending = Promise.resolve().then(async () => {
        try {
          const source = await remoteReader(selected, { signal: controller.signal });
          if (closed || controller.signal.aborted) return;
          if (!object(source) || source.available !== true || typeof source.generation !== 'string' || !Array.isArray(source.events)) fail('SSH observation source is unavailable.');
          const events = new Map(source.events.map(event => [event.id, JSON.stringify(event)]));
          const replaced = state.rawGeneration !== null && (source.generation !== state.rawGeneration ||
            [...state.events].some(([id, content]) => events.get(id) !== content));
          const epoch = state.epoch + Number(replaced);
          const snapshot = sourceSnapshot(source, selected, clientGeneration(source.generation, epoch));
          state.epoch = epoch; state.rawGeneration = source.generation; state.events = events; state.snapshot = snapshot;
        } catch {
          if (!closed) state.snapshot = { ...state.snapshot, available: false, attemptedAt: new Date(now).toISOString(), error: 'SSH observation is unavailable; check the configured source locally.' };
        } finally { state.pending = null; state.controller = null; }
      });
    }
    return state.snapshot;
  }
  read.close = async () => {
    if (closed) return;
    closed = true;
    const pending = [];
    for (const state of states.values()) {
      state.controller?.abort();
      if (state.pending) pending.push(state.pending);
    }
    // The production runner settles on abort; a custom reader cannot block shutdown forever.
    let timer;
    await Promise.race([Promise.allSettled(pending), new Promise(resolve => { timer = setTimeout(resolve, 1600); })]);
    clearTimeout(timer);
  };
  return read;
}
