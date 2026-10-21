/** Explicit contracts for a controlled real-SSH observation fault test. */
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateObservationRequest } from '../lib/viewer/observation.mjs';

const NORMAL_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSH_AUTH_SOCK', 'PATH'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const printable = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const absolute = value => printable(value) && value.startsWith('/') && isAbsolute(value) && !value.includes('\\');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function fail(message = 'Invalid explicit VPS observation acceptance configuration.') { throw new Error(message); }
function exact(value, keys) { if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(); }
function within(child, parent) { const rel = relative(parent, child); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

export function validateObserverConfig(input) {
  exact(input, ['version', 'runId', 'outputDir', 'privateDir', 'localStateDir', 'sshExecutable', 'sshConfig', 'remote']);
  exact(input.remote, ['destination', 'executable', 'cli', 'stateDir', 'expectedNodeId', 'rooms']);
  const match = typeof input.runId === 'string' && input.runId.match(/^vps-observer-([0-9]{4})([0-9]{2})([0-9]{2})-v([1-9][0-9]*)(?![\s\S])/);
  if (input.version !== 1 || !match || input.runId.length > 64 || !Number.isSafeInteger(Number(match[4]))) fail();
  const iso = `${match[1]}-${match[2]}-${match[3]}`, date = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) fail();
  const config = structuredClone(input);
  for (const field of ['outputDir', 'privateDir', 'localStateDir', 'sshExecutable', 'sshConfig']) { if (!absolute(config[field])) fail(); config[field] = resolve(config[field]); }
  for (const field of ['executable', 'cli', 'stateDir']) { if (!absolute(config.remote[field]) || Buffer.byteLength(config.remote[field]) > 4096) fail(); config.remote[field] = resolve(config.remote[field]); }
  if (basename(config.outputDir) !== config.runId || basename(config.privateDir) !== config.runId || within(config.outputDir, config.privateDir) || within(config.privateDir, config.outputDir)) fail();
  for (const evidence of [config.outputDir, config.privateDir]) if (within(evidence, config.localStateDir) || within(config.localStateDir, evidence)) fail('Observation evidence must not overlap the source state.');
  if (!printable(config.remote.destination) || Buffer.byteLength(config.remote.destination) > 128 || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/.test(config.remote.destination)) fail();
  const request = validateObservationRequest({ version: 1, type: 'viewer-observe', requestId: '0'.repeat(32), expectedNodeId: config.remote.expectedNodeId, rooms: config.remote.rooms });
  config.remote.rooms = request.rooms;
  return freeze(config);
}

export function observerSshArgs(input) {
  const { remote } = validateObserverConfig(input);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', '-o', 'ClearAllForwardings=yes', '--', remote.destination,
    `${quote(remote.executable)} ${quote(remote.cli)} view-export --state-dir ${quote(remote.stateDir)}`];
}

/** A process-local PATH shim; other SSH commands pass through even when closed. */
export async function createObserverGate(input) {
  const config = validateObserverConfig(input), runtime = resolve(config.privateDir, 'observer-gate'), binDir = resolve(runtime, 'bin');
  const gateFile = resolve(runtime, 'gate.json'), requestsFile = resolve(runtime, 'requests.jsonl');
  await mkdir(runtime, { mode: 0o700 }); await mkdir(binDir, { mode: 0o700 });
  await writeFile(requestsFile, '', { flag: 'wx', mode: 0o600 });
  const args = observerSshArgs(config);
  const request = { version: 1, type: 'viewer-observe', requestId: '0'.repeat(32), expectedNodeId: config.remote.expectedNodeId, rooms: config.remote.rooms };
  const moduleURL = new URL('../lib/viewer/observation.mjs', import.meta.url).href;
  const script = `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { validateObservationRequest } from ${JSON.stringify(moduleURL)};
const expectedArgs = ${JSON.stringify(args)}, expectedRequest = ${JSON.stringify(request)};
const gateFile = ${JSON.stringify(gateFile)}, requestsFile = ${JSON.stringify(requestsFile)};
const original = process.argv.slice(2), selected = JSON.stringify(original) === JSON.stringify(expectedArgs);
const env = {}; for (const key of ${JSON.stringify(NORMAL_ENV)}) if (typeof process.env[key] === 'string') env[key] = process.env[key];
let child, stopping = false;
function killOwned(signal) {
  if (!child?.pid) return;
  try { if (selected) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
}
function finish(code) {
  if (stopping) return;
  stopping = true;
  if (!selected) { process.exit(code ?? 255); return; }
  // A dedicated process group includes an SSH proxy child if one exists.
  // Finish its cleanup before the outer collector's 500ms escalation.
  killOwned('SIGTERM');
  setTimeout(() => { killOwned('SIGKILL'); process.exit(code ?? 255); }, 100);
}
function forward(input) {
  child = spawn(${JSON.stringify(config.sshExecutable)}, ['-F', ${JSON.stringify(config.sshConfig)}, ...original], { shell: false, detached: selected, env, stdio: ['pipe', 'inherit', 'inherit'] });
  child.once('error', () => finish(255)); child.once('close', code => finish(code));
  child.stdin.on('error', () => {});
  if (input === undefined) process.stdin.pipe(child.stdin); else child.stdin.end(input);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child) { killOwned(signal); finish(255); } else process.exit(255); });
if (!selected) forward();
else {
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw new Error('limit'); chunks.push(chunk); }
    const input = Buffer.concat(chunks), parsed = validateObservationRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)));
    if (parsed.expectedNodeId !== expectedRequest.expectedNodeId || JSON.stringify(parsed.rooms) !== JSON.stringify(expectedRequest.rooms)) throw new Error('scope');
    const gate = JSON.parse(readFileSync(gateFile, 'utf8'));
    const allowed = gate.version === 1 && gate.open === true;
    appendFileSync(requestsFile, JSON.stringify({ requestId: parsed.requestId, status: allowed ? 'allowed' : 'blocked', at: new Date().toISOString() }) + '\\n', { mode: 0o600 });
    if (allowed) forward(input); else process.exit(255);
  } catch { process.exit(255); }
}
`;
  await writeFile(resolve(binDir, 'ssh'), script, { flag: 'wx', mode: 0o700 });
  async function state(open) {
    const temporary = `${gateFile}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, open }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, gateFile);
  }
  await state(true);
  return { binDir, gateFile, requestsFile, open: () => state(true), close: () => state(false), dispose: () => state(false) };
}

// This exact bounded read-only program is used on both hosts. It opens files
// with O_RDONLY|O_NOFOLLOW and never loads SQLite or the communication runtime.
async function hashMain() {
  const { constants } = await import('node:fs');
  const { open, readdir, lstat } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { join, isAbsolute } = await import('node:path');
  const deadline = Date.now() + 10_000;
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw new Error('request-limit'); chunks.push(chunk); }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!request || Object.keys(request).sort().join(',') !== 'requestId,stateDir,type,version' || request.version !== 1 || request.type !== 'viewer-hash-state' || typeof request.requestId !== 'string' || !/^[0-9a-f]{32}(?![\s\S])/.test(request.requestId) || typeof request.stateDir !== 'string' || !isAbsolute(request.stateDir) || Buffer.byteLength(request.stateDir) > 8192 || /[\x00-\x1f\x7f]/.test(request.stateDir)) throw new Error('request');
  const root = await lstat(request.stateDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('root');
  const files = Object.create(null); let count = 0, total = 0;
  const stable = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  async function visit(directory, prefix, depth) {
    if (depth > 32 || Date.now() > deadline) throw new Error('tree-limit');
    const before = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of before) {
      const path = join(directory, item.name), relative = prefix ? prefix + '/' + item.name : item.name;
      if (item.isSymbolicLink()) throw new Error('symlink');
      if (item.isDirectory()) await visit(path, relative, depth + 1);
      else if (item.isFile()) {
        if (++count > 4096) throw new Error('file-limit');
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const initial = await handle.stat({ bigint: true });
          if (!initial.isFile() || initial.size > 512n * 1024n * 1024n) throw new Error('file-limit');
          total += Number(initial.size); if (total > 1024 * 1024 * 1024) throw new Error('total-limit');
          const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
          for (;;) {
            if (Date.now() > deadline) throw new Error('deadline');
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
          }
          const after = await handle.stat({ bigint: true }), live = await lstat(path, { bigint: true });
          if (offset !== Number(initial.size) || stable(initial) !== stable(after) || stable(after) !== stable(live)) throw new Error('changed');
          files[relative] = digest.digest('hex');
        } finally { await handle.close(); }
      } else throw new Error('unsupported-file');
    }
    const after = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(before.map(item => item.name)) !== JSON.stringify(after)) throw new Error('tree-changed');
  }
  await visit(request.stateDir, '', 0);
  const response = JSON.stringify({ version: 1, type: 'viewer-state-hashes', requestId: request.requestId, files });
  if (Buffer.byteLength(response) > 1024 * 1024) throw new Error('response-limit');
  process.stdout.write(response + '\n');
}
export const OBSERVER_HASH_SOURCE = `(${hashMain.toString()})().catch(() => { process.stdout.write(JSON.stringify({version:1,ok:false,error:'Read-only state hashing failed.'})+'\\n'); process.exitCode=1; });`;

export function buildObserverHashInvocation(input, options = {}) {
  const config = validateObserverConfig(input);
  if (!object(options) || Object.keys(options).some(key => key !== 'requestId')) fail();
  const requestId = Object.hasOwn(options, 'requestId') ? options.requestId : randomBytes(16).toString('hex');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{32}(?![\s\S])/.test(requestId)) fail();
  return { executable: config.sshExecutable,
    args: ['-F', config.sshConfig, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=5', '--', config.remote.destination, `${quote(config.remote.executable)} '-e' ${quote(OBSERVER_HASH_SOURCE)}`],
    input: JSON.stringify({ version: 1, type: 'viewer-hash-state', requestId, stateDir: config.remote.stateDir }) + '\n' };
}

export async function observeRecovery({ viewer, remoteId, setGate, timeoutMs = 20_000, clock = Date.now, pause = delay, onStage = async () => {} }) {
  if (!viewer?.model || typeof viewer.model.refresh !== 'function' || typeof setGate !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('Invalid observer recovery orchestration.');
  const current = () => viewer.model.sources.find(source => source.id === remoteId);
  const ids = () => viewer.model.projection.messages.map(message => message.id).sort();
  async function wait(predicate) {
    const started = clock();
    for (;;) {
      await viewer.model.refresh();
      if (predicate(current())) return structuredClone(current());
      if (clock() - started >= timeoutMs) fail('Observer recovery phase timed out.');
      await pause(50);
    }
  }
  const initial = await wait(source => source?.available === true), messageIds = ids();
  await onStage('live'); await setGate(false);
  const stale = await wait(source => source && source.available === false);
  if (JSON.stringify(ids()) !== JSON.stringify(messageIds) || !stale.observedAt || Date.parse(stale.observedAt) < Date.parse(initial.observedAt)) fail('Unavailable observation lost its last successful history.');
  await onStage('stale');
  // The production source throttle is three seconds. This ensures at least a
  // second gated attempt, not only a repeated read of the first failure cache.
  await pause(3500); await viewer.model.refresh();
  const stillStale = current();
  if (stillStale?.available !== false || stillStale.observedAt !== stale.observedAt || JSON.stringify(ids()) !== JSON.stringify(messageIds)) fail('Failed observation incorrectly refreshed freshness or history.');
  await onStage('stale-confirmed');
  if (current()?.observedAt !== stale.observedAt || current()?.available !== false || JSON.stringify(ids()) !== JSON.stringify(messageIds)) fail('Confirmed failed collection changed freshness or history.');
  await setGate(true);
  const recovered = await wait(source => source?.available === true && Date.parse(source.observedAt) > Date.parse(stale.observedAt));
  if (JSON.stringify(ids()) !== JSON.stringify(messageIds)) fail('Recovery duplicated or removed logical messages.');
  await onStage('recovered');
  return { initial, stale, recovered, messageIds };
}

export async function claimObserverDirectories(input) {
  const config = validateObserverConfig(input);
  async function effective(path) {
    let ancestor = path; const parts = [];
    for (;;) {
      try { return resolve(await realpath(ancestor), ...parts); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = dirname(ancestor); if (parent === ancestor) throw error;
        parts.unshift(basename(ancestor)); ancestor = parent;
      }
    }
  }
  const publicPath = await effective(config.outputDir), privatePath = await effective(config.privateDir), sourcePath = await effective(config.localStateDir);
  if (within(publicPath, privatePath) || within(privatePath, publicPath)) fail('Effective public and private observation directories must not overlap.');
  for (const evidence of [publicPath, privatePath]) if (within(evidence, sourcePath) || within(sourcePath, evidence)) fail('Effective observation evidence must not overlap the source state.');
  await mkdir(dirname(config.outputDir), { recursive: true });
  await mkdir(dirname(config.privateDir), { recursive: true, mode: 0o700 });
  await mkdir(config.outputDir, { mode: 0o755 });
  try { await mkdir(config.privateDir, { mode: 0o700 }); }
  catch (error) { await rmdir(config.outputDir).catch(() => {}); throw error; }
  return { outputDir: config.outputDir, privateDir: config.privateDir };
}
