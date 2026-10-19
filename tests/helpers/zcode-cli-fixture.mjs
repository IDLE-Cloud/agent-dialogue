import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
export const cliFile = fileURLToPath(new URL('../../bin/agent-dialogue.mjs', import.meta.url));
export function hostMeta(sessionId, directory) {
  const value = { session_id: sessionId, workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' };
  return { ...value, 'com.zcode/request-context': { ...value } };
}
export async function cliFixture(t, { cleanup = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'ad-zcode-cli-'));
  if (cleanup) t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'native project'); await mkdir(directory);
  const serviceFile = join(temp, 'private', 'zcode.json');
  const scopeFile = join(temp, 'private', 'context.json');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AGENT_DIALOGUE_|HCOM_|CODEX_|CLAUDE_|ZCODE_)/.test(key)) delete env[key];
  delete env.NODE_OPTIONS;
  Object.assign(env, { AGENT_DIALOGUE_STATE_DIR: join(temp, 'state'), AGENT_DIALOGUE_CACHE_DIR: join(temp, 'cache'), AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile });
  const cli = async (args, { success = true } = {}) => {
    let result;
    try { const r = await execute(process.execPath, [cliFile, ...args], { env, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true }); result = { code: 0, ...r }; }
    catch (error) { result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
    if (success) assert.equal(result.code, 0, `CLI ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`);
    return result;
  };
  const json = async args => JSON.parse((await cli(args)).stdout);
  const service = await json(['zcode', 'init', '--cwd', directory, '--file', serviceFile]);
  return { temp, directory, serviceFile, scopeFile, env, cli, json, service, context: { stateDir: env.AGENT_DIALOGUE_STATE_DIR, cacheDir: env.AGENT_DIALOGUE_CACHE_DIR, ledgerBackend: 'embedded', env } };
}

export async function mcpClient(t, f) {
  const child = spawn(process.execPath, [cliFile, 'mcp', '--zcode-service', f.serviceFile, '--context', f.scopeFile], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exit = once(child, 'close');
  const pending = new Map();
  let serial = 0, buffer = '', stderr = '', failure;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.on('data', text => {
    buffer += text;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line), waiter = pending.get(frame.id);
        assert.equal(frame.jsonrpc, '2.0', 'stdout must contain only MCP JSON-RPC frames');
        if (waiter) { pending.delete(frame.id); clearTimeout(waiter.timeout); waiter.resolve(frame); }
      } catch (error) {
        failure = error;
        for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(error); }
        pending.clear();
      }
    }
  });
  child.on('error', error => { failure = error; for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(error); } pending.clear(); });
  child.on('close', code => { if (pending.size) { failure = new Error(`MCP closed (${code}): ${stderr}`); for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(failure); } pending.clear(); } });
  const request = async (method, params) => {
    if (failure) throw failure;
    const id = ++serial;
    const response = new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout (${method}): ${stderr}`)); }, 45000).unref(); pending.set(id, { resolve, reject, timeout }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    return await response;
  };
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    child.stdin.end();
    const graceful = await Promise.race([exit.then(() => true), delay(3000, null, { ref: false }).then(() => false)]);
    if (!graceful) { child.kill('SIGTERM'); await exit; }
    assert.equal(buffer, '', 'stdout must end at an MCP frame boundary');
  };
  t.after(close);
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-zcode-cli-fixture', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'agent-dialogue');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (name, args = {}, meta) => {
    const response = await request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  return { request, call, close, getStderr: () => stderr };
}
export function toolValue(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
export async function until(fn, { timeout = 10000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn(); if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(100);
  }
}
