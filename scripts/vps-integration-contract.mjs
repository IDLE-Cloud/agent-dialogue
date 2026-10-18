/** Pure, opt-in contracts for real-host acceptance. No default network target. */
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
const DESTINATION = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}(?![\s\S])/;
const NORMAL_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSH_AUTH_SOCK'];
const OPERATIONS = new Set(['probe', 'models', 'create-session', 'session', 'messages', 'prompt', 'permissions', 'permission-reply', 'abort', 'cli', 'save-pairing', 'hash-state']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const printable = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const absolute = value => printable(value) && isAbsolute(value) && !value.includes('\\');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fail(message = 'Invalid explicit VPS acceptance configuration.') { throw new Error(message); }
function exact(value, keys) { if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(); }
function within(child, parent) { const rel = relative(parent, child); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

export function freshRunId(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^vps-integration-[0-9]{8}-v[1-9][0-9]*(?![\s\S])/.test(value)) fail('Use a fresh vps-integration-YYYYMMDD-vN run ID.');
  const date = value.slice(16, 24), iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) fail('Use a real calendar date in the VPS run ID.');
  return value;
}

export function validateVpsConfig(input) {
  exact(input, ['version', 'runId', 'timeoutSeconds', 'outputDir', 'privateDir', 'local', 'remote', 'model']);
  if (input.version !== 1 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 30 || input.timeoutSeconds > 600) fail();
  freshRunId(input.runId);
  exact(input.local, ['executable', 'cli', 'stateDir', 'cacheDir', 'codexThread', 'codexCwd', 'codexSocket', 'codexHome', 'path', 'peerSshDestination']);
  exact(input.remote, ['sshDestination', 'sshConfig', 'helper', 'executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace', 'path', 'peerSshDestination']);
  exact(input.model, ['providerID', 'id']);
  const config = structuredClone(input);
  for (const field of ['outputDir', 'privateDir']) {
    if (!absolute(config[field])) fail(); config[field] = resolve(config[field]);
    if (basename(config[field]) !== config.runId) fail('Output and private directory names must match the fresh run ID.');
  }
  if (within(config.outputDir, config.privateDir) || within(config.privateDir, config.outputDir)) fail('Public and private run directories must not overlap.');
  for (const [section, fields] of [
    ['local', ['executable', 'cli', 'stateDir', 'cacheDir', 'codexCwd', 'codexSocket', 'codexHome']],
    ['remote', ['sshConfig', 'helper', 'executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace']],
  ]) for (const field of fields) {
    if (!absolute(config[section][field])) fail(); config[section][field] = resolve(config[section][field]);
  }
  if (!within(config.local.stateDir, config.local.codexCwd) || config.local.stateDir === config.local.codexCwd) fail('The local state must be a dedicated directory inside the selected owned Codex workspace.');
  if (!UUID.test(config.local.codexThread)) fail('Select the exact owned Codex thread UUID.');
  for (const [section, field] of [['local', 'peerSshDestination'], ['remote', 'sshDestination'], ['remote', 'peerSshDestination']]) if (!DESTINATION.test(config[section][field])) fail();
  if (config.local.peerSshDestination !== config.remote.sshDestination) fail('The controller and local node must target the same explicit VPS alias.');
  for (const section of ['local', 'remote']) {
    if (!printable(config[section].path) || config[section].path.split(':').some(item => !absolute(item))) fail('Use an explicit absolute executable search path.');
  }
  if (!printable(config.model.providerID) || !printable(config.model.id)) fail();
  return freeze(config);
}

/** Parse a deliberately limited shell subset without evaluating any command. */
export function shellTokens(command) {
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 20000 || /[\x00-\x1f\x7f]/.test(command)) fail('Unsupported acceptance shell command.');
  const tokens = []; let token = '', started = false, quoted = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quoted === "'") { if (c === "'") quoted = null; else token += c; continue; }
    if (quoted === '"') {
      if (c === '"') { quoted = null; continue; }
      if (c === '$' || c === '`') fail('Executable shell expansion is outside the acceptance scope.');
      if (c === '\\') {
        if (++i >= command.length) fail();
        if ('\\"$`'.includes(command[i])) token += command[i]; else token += `\\${command[i]}`;
      } else token += c;
      continue;
    }
    if (c === "'" || c === '"') { quoted = c; started = true; continue; }
    if (c === '\\') { if (++i >= command.length) fail(); token += command[i]; started = true; continue; }
    if (';&|<>()$`*?[]{}~#'.includes(c)) fail('Shell operators and expansions are outside the acceptance scope.');
    if (/\s/.test(c)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += c; started = true; }
  }
  if (quoted) fail('Unterminated acceptance shell quote.');
  if (started) tokens.push(token);
  return tokens;
}

export function permittedVpsCommand(command, scope) {
  try {
    if (!object(scope) || typeof scope.queue !== 'boolean' || !printable(scope.expectedSession) || !/^r_[0-9a-f-]{36}(?![\s\S])/.test(scope.room)) return false;
    freshRunId(scope.runId);
    if (scope.replyTo != null && !/^m_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/.test(scope.replyTo)) return false;
    const expected = { AGENT_DIALOGUE_STATE_DIR: scope.stateDir, AGENT_DIALOGUE_CACHE_DIR: scope.cacheDir };
    for (const [key, field] of [['AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'serviceFile'], ['PATH', 'path'], ['CODEX_HOME', 'codexHome'], ['AGENT_DIALOGUE_CODEX_SOCKET', 'codexSocket']]) if (scope[field] !== undefined) expected[key] = scope[field];
    if (Object.values(expected).some(value => !printable(value))) return false;
    const tokens = shellTokens(command), assigned = {};
    while (tokens[0]?.match(/^[A-Z_][A-Z0-9_]*=/)) {
      const token = tokens.shift(), split = token.indexOf('='), key = token.slice(0, split), value = token.slice(split + 1);
      if (!Object.hasOwn(expected, key) || Object.hasOwn(assigned, key) || value !== expected[key]) return false;
      assigned[key] = value;
    }
    if (Object.keys(assigned).length !== Object.keys(expected).length) return false;
    if (tokens.shift() !== scope.node || tokens.shift() !== scope.cli || tokens.shift() !== 'collab' || tokens.shift() !== 'send') return false;
    const fields = {}; let queued = false;
    while (tokens.length) {
      const field = tokens.shift();
      if (field === '--queue') { if (queued) return false; queued = true; continue; }
      if (!['--room', '--from', '--to', '--expected-session', '--reply-to', '--message'].includes(field) || Object.hasOwn(fields, field) || !tokens.length) return false;
      fields[field] = tokens.shift();
    }
    if (queued !== scope.queue || fields['--room'] !== scope.room || fields['--from'] !== scope.from || fields['--to'] !== scope.to || fields['--expected-session'] !== scope.expectedSession || (fields['--reply-to'] ?? null) !== (scope.replyTo ?? null)) return false;
    const message = fields['--message'];
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 4000 || /[\x00-\x1f\x7f]/.test(message)) return false;
    const marker = scope.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])${marker}(?![A-Za-z0-9_-])`).test(message);
  } catch { return false; }
}

export function hasZeroCostModel(model) {
  return object(model) && model.enabled === true && Array.isArray(model.cost) && model.cost.length > 0 && model.cost.every(tier => object(tier) && tier.input === 0 && tier.output === 0 && object(tier.cache) && tier.cache.read === 0 && tier.cache.write === 0);
}

export function buildRemoteInvocation(input, operation, payload = {}) {
  const config = validateVpsConfig(input);
  if (!OPERATIONS.has(operation) || !object(payload) || ['version', 'runId', 'config', 'operation'].some(key => Object.hasOwn(payload, key))) fail('Unsupported remote acceptance operation.');
  const remote = Object.fromEntries(['executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace', 'path', 'peerSshDestination'].map(key => [key, config.remote[key]]));
  const request = { version: 1, runId: config.runId, config: remote, operation, ...payload };
  const inputText = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(inputText) > 4 * 1024 * 1024) fail('Remote acceptance request exceeds its limit.');
  return { executable: 'ssh', args: ['-F', config.remote.sshConfig, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=5', '--', config.remote.sshDestination, `${quote(config.remote.executable)} ${quote(config.remote.helper)}`], input: inputText };
}

export function buildHarnessEnv(local, baseEnv = {}) {
  if (!object(local) || !object(baseEnv)) fail();
  const env = {};
  for (const key of NORMAL_ENV) if (typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  for (const field of ['stateDir', 'cacheDir', 'codexHome', 'codexSocket']) if (!absolute(local[field])) fail();
  if (!printable(local.path)) fail();
  return { ...env, PATH: local.path, AGENT_DIALOGUE_STATE_DIR: local.stateDir, AGENT_DIALOGUE_CACHE_DIR: local.cacheDir, CODEX_HOME: local.codexHome, AGENT_DIALOGUE_CODEX_SOCKET: local.codexSocket };
}

export async function claimRunDirectories(input) {
  const config = validateVpsConfig(input);
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
  const publicPath = await effective(config.outputDir), privatePath = await effective(config.privateDir);
  if (within(publicPath, privatePath) || within(privatePath, publicPath)) fail('Effective public and private run directories must not overlap.');
  await mkdir(dirname(config.outputDir), { recursive: true });
  await mkdir(dirname(config.privateDir), { recursive: true, mode: 0o700 });
  await mkdir(config.outputDir, { mode: 0o755 });
  try { await mkdir(config.privateDir, { mode: 0o700 }); }
  catch (error) { await rmdir(config.outputDir).catch(() => {}); throw error; }
  return { outputDir: config.outputDir, privateDir: config.privateDir };
}
