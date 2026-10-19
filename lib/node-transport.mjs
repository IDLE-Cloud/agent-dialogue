import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { absoluteRemotePath, remoteProcessCommand } from './platform.mjs';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 20_000;
const DESTINATION = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const PATH_KEYS = ['stateDir', 'cacheDir', 'serviceFile', 'opencodeV1ServiceFile', 'kimiServiceFile', 'codexHome'];
const CONFIG_KEYS = new Set(['kind', 'destination', 'executable', 'args', 'shell', 'ledgerBackend', 'sshConfig', ...PATH_KEYS]);
const ENV_KEYS = {
  stateDir: 'AGENT_DIALOGUE_STATE_DIR',
  cacheDir: 'AGENT_DIALOGUE_CACHE_DIR',
  serviceFile: 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE',
  opencodeV1ServiceFile: 'AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE',
  kimiServiceFile: 'AGENT_DIALOGUE_KIMI_SERVICE_FILE',
  codexHome: 'CODEX_HOME',
  ledgerBackend: 'AGENT_DIALOGUE_LEDGER',
};

class TransportError extends Error {}
function fail(message) { throw new TransportError(message); }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedString(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate stored, owner-selected process configuration; never accept it from a message. */
export function validateTransport(transport) {
  if (!plainObject(transport) || Object.keys(transport).some(key => !CONFIG_KEYS.has(key))) fail('Invalid node transport configuration.');
  if (!['ssh', 'local-process'].includes(transport.kind)) fail('Node transport must use ssh or local-process.');
  const shell = transport.shell ?? 'posix';
  if (!['posix', 'powershell'].includes(shell)) fail('Invalid node transport configuration: shell must be posix or powershell.');
  const absolute = transport.kind === 'ssh' ? value => absoluteRemotePath(value, shell) : isAbsolute;
  if (!boundedString(transport.executable) || !absolute(transport.executable)) fail('Node transport executable must be an absolute path.');
  const args = transport.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 8192 || /[\x00-\x1f\x7f]/.test(arg)) || Buffer.byteLength(JSON.stringify(args)) > 32 * 1024) fail('Invalid node transport arguments.');
  for (const key of PATH_KEYS) {
    if (key === 'stateDir' || transport[key] !== undefined) {
      if (!boundedString(transport[key]) || !absolute(transport[key])) fail(`Node transport ${key} must be an absolute path.`);
    }
  }
  if (transport.kind === 'ssh' && (typeof transport.destination !== 'string' || !DESTINATION.test(transport.destination))) fail('SSH destination must be a stored host alias or user@host without options, ports or whitespace.');
  if (transport.kind === 'local-process' && transport.destination !== undefined) fail('local-process transport does not accept an SSH destination.');
  if (transport.sshConfig !== undefined && (transport.kind !== 'ssh' || !boundedString(transport.sshConfig) || !isAbsolute(transport.sshConfig))) fail('SSH config must be an absolute controller-local path.');
  if (transport.ledgerBackend !== undefined && !['hcom', 'embedded'].includes(transport.ledgerBackend)) fail('Invalid node transport ledger backend.');
  return { ...transport, args: [...args] };
}

function signedEnvelope(value) {
  if (!plainObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'payload') || !Object.hasOwn(value, 'signature') || !plainObject(value.payload) || typeof value.signature !== 'string' || value.signature.length < 1 || Buffer.byteLength(value.signature) > 16 * 1024) fail('Node transport requires one signed envelope with payload and signature.');
  return value;
}

function childEnvironment(transport) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HCOM_|AGENT_DIALOGUE_|CODEX_(SESSION|THREAD|PARENT|AGENT|PROCESS|APP|INTERNAL)|CLAUDE_)/.test(key) || key === 'CODEX_HOME') delete env[key];
  }
  for (const [key, envKey] of Object.entries(ENV_KEYS)) if (transport[key] !== undefined) env[envKey] = transport[key];
  return env;
}

function remoteCommand(transport) {
  const env = Object.fromEntries(Object.entries(ENV_KEYS).filter(([key]) => transport[key] !== undefined).map(([key, envKey]) => [envKey, transport[key]]));
  if ((transport.shell ?? 'posix') === 'posix') return `${remoteProcessCommand(transport.executable, transport.args, { env })} node receive`;
  return remoteProcessCommand(transport.executable, [...transport.args, 'node', 'receive'], { shell: transport.shell ?? 'posix', env });
}

async function run(executable, args, { env, input, timeout, maxOutput }) {
  return await new Promise((done, reject) => {
    let child;
    // Win32 OpenSSH requires overlapped handles for reliable stdin EOF/exit.
    // These remain bounded streams; the signed JSON never enters shell argv.
    const pipe = process.platform === 'win32' ? 'overlapped' : 'pipe';
    try { child = spawn(executable, args, { env, shell: false, stdio: [pipe, pipe, pipe] }); }
    catch { reject(new TransportError('Node transport process could not start.')); return; }
    let stdoutBytes = 0, stderrBytes = 0, failure, killTimer, settled = false;
    const chunks = [];
    function stop(message) {
      if (!failure) failure = new TransportError(message);
      child.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) stop('Node transport response exceeded 256 KiB.');
      else chunks.push(chunk);
    });
    // Diagnostic text can contain credentials and private paths. Bound it and
    // discard it; callers receive only transport failure categories.
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutput) stop('Node transport diagnostic output exceeded its limit.');
    });
    const timer = setTimeout(() => stop('Node transport timed out.'), timeout);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      if (error) reject(error); else done(result);
    }
    child.once('error', () => finish(new TransportError('Node transport process could not start.')));
    child.once('close', (code, signal) => finish(failure, { code: code ?? 143, signal, stdout: Buffer.concat(chunks).toString('utf8') }));
    child.stdin.on('error', () => { /* Early receiver exit is reported by close. */ });
    child.stdin.end(input);
  });
}

/** Transport signed JSON only. Signature verification belongs to the node gate. */
export async function exchange(peer, envelope, { runner = run } = {}) {
  const transport = validateTransport(peer?.transport);
  signedEnvelope(envelope);
  let input;
  try { input = `${JSON.stringify(envelope)}\n`; }
  catch { fail('Node transport envelope cannot be serialized.'); }
  if (Buffer.byteLength(input) > MAX_BYTES) fail('Node transport request exceeded 256 KiB.');
  const env = childEnvironment(transport);
  const executable = transport.kind === 'ssh' ? 'ssh' : transport.executable;
  const args = transport.kind === 'ssh'
    ? [...(transport.sshConfig ? ['-F', transport.sshConfig] : []), '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', transport.destination, remoteCommand(transport)]
    : [...transport.args, 'node', 'receive'];
  let result;
  try { result = await runner(executable, args, { env, input, timeout: TIMEOUT_MS, maxOutput: MAX_BYTES }); }
  catch (error) {
    if (error instanceof TransportError) throw error;
    fail('Node transport process failed.');
  }
  if (!result || result.code !== 0) fail('Node transport receiver exited unsuccessfully.');
  const stdout = typeof result.stdout === 'string' ? result.stdout : Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : null;
  if (stdout === null) fail('Node transport returned no JSON response.');
  if (Buffer.byteLength(stdout) > MAX_BYTES) fail('Node transport response exceeded 256 KiB.');
  let response;
  try { response = JSON.parse(stdout); }
  catch { fail('Node transport returned an invalid JSON response.'); }
  return signedEnvelope(response);
}
