#!/usr/bin/env node
/**
 * Opt-in SSH stdio helper for scripts/vps-integration.mjs. This is not a daemon
 * or a model tool. Its caller is the owner controlling an isolated test space.
 * It reads local OpenCode credentials and never returns their contents.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX = 4 * 1024 * 1024;
const printable = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const absolute = value => printable(value) && isAbsolute(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail() { throw new Error('Remote acceptance helper rejected the operation.'); }
let diagnosis = null;

function validate(config, runId) {
  if (!plain(config) || !/^vps-integration-[0-9]{8}-v[1-9][0-9]*(?![\s\S])/.test(runId)) fail();
  for (const field of ['executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace']) if (!absolute(config[field])) fail();
  if (!printable(config.path)) fail();
  return config;
}
function environment(config) {
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSH_AUTH_SOCK']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, PATH: config.path, AGENT_DIALOGUE_STATE_DIR: config.stateDir, AGENT_DIALOGUE_CACHE_DIR: config.cacheDir, AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: config.serviceFile };
}
function modelCatalogPath(config) {
  return `/api/model?${new URLSearchParams({ 'location[directory]': config.workspace })}`;
}
async function execute(config, args, input) {
  if (!Array.isArray(args) || args.length > 64 || args.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 128 * 1024 || item.includes('\0'))) fail();
  if (!['attach', 'detach', 'bindings', 'bridge', 'node', 'room', 'history', 'collab', 'agent-guide'].includes(args[0])) fail();
  return await new Promise(done => {
    const child = spawn(config.executable, [config.cli, ...args], { env: environment(config), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let count = 0, diagnosticBytes = 0, failure = false, finished = false, killer, settle;
    const finish = code => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killer); clearTimeout(settle);
      done({ code: code ?? 143, stdout: Buffer.concat(chunks).toString('utf8'), failed: failure });
    };
    const stop = () => {
      failure = true; child.kill('SIGTERM');
      killer ??= setTimeout(() => child.kill('SIGKILL'), 500);
      settle ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(143); }, 1500);
    };
    const timer = setTimeout(stop, 35_000);
    child.stdout.on('data', chunk => { count += chunk.length; if (count > MAX) stop(); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 64 * 1024) stop(); });
    child.once('error', () => { failure = true; finish(127); });
    child.once('close', finish); child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? '' : `${JSON.stringify(input)}\n`);
  });
}
async function fileHashes(root) {
  const { readdir, lstat } = await import('node:fs/promises');
  const hashes = {};
  async function visit(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name, path = join(directory, item.name);
      if (item.isSymbolicLink()) fail();
      if (item.isDirectory()) await visit(path, relative);
      else if (item.isFile()) {
        const stat = await lstat(path);
        if (stat.size > 512 * 1024 * 1024) fail();
        hashes[relative] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  }
  await visit(root); return hashes;
}

async function main() {
  if (process.argv.length !== 2) fail();
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX) fail(); chunks.push(chunk); }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!plain(request) || request.version !== 1 || typeof request.operation !== 'string') fail();
  const config = validate(request.config, request.runId);
  diagnosis = { path: join(dirname(config.stateDir), 'vps-helper-errors.jsonl'), operation: request.operation, runId: request.runId };
  const modulePath = join(dirname(dirname(config.cli)), 'lib', 'opencode.mjs');
  const scopePath = join(config.stateDir, 'vps-acceptance-scope.json');
  let client;
  async function scoped() {
    const scope = JSON.parse(await readFile(scopePath, 'utf8'));
    if (scope.runId !== request.runId || scope.workspace !== config.workspace || !/^ses_[A-Za-z0-9]+$/.test(scope.sessionId)) fail();
    return scope;
  }
  async function open() {
    if (!client) {
      const { OpenCodeClient } = await import(pathToFileURL(modulePath).href);
      client = await OpenCodeClient.discover({ serviceFile: config.serviceFile });
    }
    return client;
  }
  const { operation } = request;
  let result;
  if (operation === 'probe') {
    const version = JSON.parse(await readFile(join(dirname(dirname(config.cli)), 'package.json'), 'utf8')).version;
    const implementationFiles = {};
    for (const relative of ['bin/agent-dialogue.mjs', 'lib/bridge.mjs', 'lib/bridge-store.mjs', 'lib/codex.mjs', 'lib/opencode.mjs', 'lib/nodes.mjs', 'lib/node-identity.mjs', 'lib/node-transport.mjs', 'lib/submissions.mjs', 'lib/viewer/observation.mjs']) implementationFiles[relative] = createHash('sha256').update(await readFile(join(dirname(dirname(config.cli)), relative))).digest('hex');
    result = { node: process.version, platform: process.platform, arch: process.arch, packageVersion: version, implementationFiles, acceptanceHelperSha256: createHash('sha256').update(await readFile(process.argv[1])).digest('hex'), service: (await open()).identity };
  } else if (operation === 'models') {
    result = (await (await open()).request('GET', modelCatalogPath(config))).data;
  } else if (operation === 'create-session') {
    const existing = await lstat(config.stateDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing && (!existing.isDirectory() || (await readdir(config.stateDir)).length)) fail();
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    // The exclusive intent prevents a lost SSH response from silently creating
    // another model chat when the controller is restarted or retried.
    await writeFile(scopePath, JSON.stringify({ runId: request.runId, workspace: config.workspace, status: 'creating' }) + '\n', { flag: 'wx', mode: 0o600 });
    const model = request.model;
    if (!plain(model) || !printable(model.id) || !printable(model.providerID)) fail();
    const catalog = (await (await open()).request('GET', modelCatalogPath(config))).data;
    const selected = Array.isArray(catalog) && catalog.find(item => item.id === model.id && item.providerID === model.providerID);
    if (!selected?.enabled || !Array.isArray(selected.cost) || !selected.cost.length || !selected.cost.every(tier => tier.input === 0 && tier.output === 0 && tier.cache?.read === 0 && tier.cache?.write === 0)) fail();
    const session = await (await open()).createSession({ title: `Owned VPS acceptance ${request.runId}`, agent: 'build', model, location: { directory: config.workspace }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    await writeFile(scopePath, JSON.stringify({ runId: request.runId, workspace: config.workspace, status: 'created', sessionId: session.id }) + '\n', { mode: 0o600 });
    result = session;
  } else if (['session', 'messages', 'prompt', 'permissions', 'permission-reply', 'abort'].includes(operation)) {
    const scope = await scoped(), id = scope.sessionId, api = await open();
    if (operation === 'session') result = await api.session(id);
    if (operation === 'messages') result = await api.messages(id, { limit: 100 });
    if (operation === 'prompt') {
      if (!printable(request.id) || typeof request.text !== 'string' || Buffer.byteLength(request.text) > 100_000) fail();
      result = await api.prompt(id, { id: request.id, text: request.text });
    }
    if (operation === 'permissions') result = (await api.request('GET', `/api/session/${id}/permission`)).data;
    if (operation === 'permission-reply') {
      if (!printable(request.permissionId) || !['once', 'reject'].includes(request.decision)) fail();
      const pending = (await api.request('GET', `/api/session/${id}/permission`)).data;
      if (!Array.isArray(pending) || !pending.some(permission => permission.id === request.permissionId)) fail();
      result = await api.request('POST', `/api/session/${id}/permission/${encodeURIComponent(request.permissionId)}/reply`, { decision: request.decision, message: request.decision === 'once' ? 'Exact owned VPS acceptance communication command only.' : 'Outside the owned VPS acceptance scope.' });
    }
    if (operation === 'abort') result = await api.request('POST', `/api/session/${id}/interrupt?resume=false`);
  } else if (operation === 'cli') {
    if (request.args?.[0] === 'attach') {
      const scope = await scoped();
      if (request.args[1] !== 'opencode' || request.args[2] !== '--session' || request.args[3] !== scope.sessionId) fail();
    }
    result = await execute(config, request.args, request.input);
  } else if (operation === 'save-pairing') {
    if (!['peer-card.json', 'room.json'].includes(request.name) || !plain(request.value)) fail();
    const path = join(config.stateDir, request.name);
    await writeFile(path, JSON.stringify(request.value) + '\n', { flag: 'wx', mode: 0o600 });
    result = { saved: true, path };
  } else if (operation === 'hash-state') result = await fileHashes(config.stateDir);
  else fail();
  const response = JSON.stringify({ version: 1, ok: true, result });
  if (Buffer.byteLength(response) > MAX) fail();
  process.stdout.write(response + '\n');
}
main().catch(async error => {
  if (diagnosis) await appendFile(diagnosis.path, JSON.stringify({ at: new Date().toISOString(), runId: diagnosis.runId, operation: diagnosis.operation, error: error.stack || error.message }) + '\n', { mode: 0o600 }).catch(() => {});
  // No raw exceptions, OpenCode responses, credentials or filesystem paths.
  process.stdout.write(JSON.stringify({ version: 1, ok: false, error: 'Remote acceptance operation failed; inspect the private target locally.' }) + '\n');
  process.exitCode = 1;
});
