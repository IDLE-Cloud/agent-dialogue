import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchArguments, runtimeEnvironment, run, validateArchiveListing, PROJECT_DIR } from '../bin/agent-dialogue.mjs';

const cli = join(PROJECT_DIR, 'bin', 'agent-dialogue.mjs');

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent dialogue test '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'fake hcom');
  const capture = join(dir, 'calls.jsonl');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CAPTURE, JSON.stringify({args, env: {HCOM_DIR: process.env.HCOM_DIR, HCOM_AUTO_APPROVE: process.env.HCOM_AUTO_APPROVE, HCOM_AUTO_TRUST_WORKSPACE: process.env.HCOM_AUTO_TRUST_WORKSPACE, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, TERM: process.env.TERM, PATH: process.env.PATH}}) + '\\n');
if (args[0] === 'list') console.log(process.env.TEST_ENDPOINTS || '[{"name":"codex-kano","base_name":"kano","tool":"codex","status":"listening","session_id":"session123"}]');
else if (args[0] === '--version') console.log('hcom 0.7.30');
else console.log(JSON.stringify({ok: true, args}));
process.exit(Number(process.env.TEST_EXIT || 0));
`, { mode: 0o755 });
  const env = { ...process.env, AGENT_DIALOGUE_HCOM: binary, AGENT_DIALOGUE_STATE_DIR: join(dir, 'isolated state'), AGENT_DIALOGUE_CACHE_DIR: join(dir, 'cache'), TEST_CAPTURE: capture, ...overrides };
  const invoke = async args => await run(process.execPath, [cli, ...args], { env, capture: true });
  const calls = async () => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  return { dir, env, invoke, calls };
}

test('operator message stays one literal argv item, including shell syntax and flags', async t => {
  const f = await fixture(t);
  const text = "hello\n`touch /tmp/not-run` $(echo secret) ; --device elsewhere ' \"";
  const result = await f.invoke(['send', '@codex-kano', '--message', text, '--reply-to', '42', '--thread', 'thread with spaces', '--intent', 'ack']);
  assert.equal(result.code, 0, result.stderr);
  const [{ args, env }] = await f.calls();
  assert.deepEqual(args, ['send', '-b', '--json', '@codex-kano', '--reply-to', '42', '--thread', 'thread with spaces', '--intent', 'ack', '--', text]);
  assert.equal(env.HCOM_DIR, f.env.AGENT_DIALOGUE_STATE_DIR);
  assert.equal(env.HCOM_AUTO_APPROVE, '0');
  assert.equal(env.HCOM_AUTO_TRUST_WORKSPACE, '0');
});

test('headless launch keeps spaced cwd and prompt intact, executes instead of preview', async t => {
  const f = await fixture(t, { TERM: 'dumb', HOME: process.env.HOME, CODEX_HOME: '/existing codex config' });
  const cwd = join(f.dir, 'working directory');
  await mkdir(cwd);
  const prompt = 'Reply to @peer; $(do-not-run)';
  const result = await f.invoke(['launch', 'codex', '--cwd', cwd, '--prompt', prompt, '--', '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.equal(result.code, 0, result.stderr);
  const [{ args, env }] = await f.calls();
  assert.deepEqual(args, ['codex', '--go', '--headless', '--dir', cwd, '--tag', 'codex', '--hcom-prompt', prompt, '--', '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.CODEX_HOME, '/existing codex config');
  assert.ok(env.PATH.startsWith(join(runtimeEnvironment(f.env).runtimeDir, 'bin')));
});

test('interactive launch requests a terminal and makes no foreground promise', () => {
  const { argv } = launchArguments('opencode', ['--cwd', '.', '--interactive', '--terminal', 'terminal.app']);
  assert.ok(!argv.includes('--headless'));
  assert.ok(argv.includes('--go'));
  assert.deepEqual(argv.slice(2, 4), ['--terminal', 'terminal.app']);
  assert.throws(() => launchArguments('codex', ['--cwd', '.', '--foreground']), /unsupported/);
});

test('native argument separator survives so upstream cannot consume harness flags', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['launch', 'pi', '--cwd', f.dir, '--', '--run-here', '--foo=bar']);
  assert.equal(result.code, 0, result.stderr);
  const [{ args }] = await f.calls();
  const boundary = args.indexOf('--');
  assert.ok(boundary > args.indexOf('--headless'));
  assert.deepEqual(args.slice(boundary), ['--', '--run-here', '--foo=bar']);
  assert.ok(!args.slice(0, boundary).includes('--run-here'));
  assert.ok(!launchArguments('pi', ['--cwd', f.dir]).argv.includes('--'));
});

test('invalid launch and reserved upstream controls never invoke hcom', async t => {
  const f = await fixture(t);
  for (const args of [
    ['launch', 'claude', '--cwd', f.dir],
    ['launch', 'codex', '--prompt', 'missing cwd'],
    ['launch', 'codex', '--cwd', f.dir, '--', '--device', 'remote'],
    ['launch', 'pi', '--cwd', f.dir, '--', '--tag=all'],
    ['launch', 'kimi', '--cwd', f.dir, '--terminal', 'terminal.app'],
  ]) {
    const result = await f.invoke(args);
    assert.equal(result.code, 1, `${args}: ${result.stdout}`);
  }
  assert.deepEqual(await f.calls(), []);
});

test('stop validates one current endpoint and resolves its exact full name', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['stop', 'kano']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.calls()).map(x => x.args), [['list', '--json'], ['kill', 'codex-kano']]);
});

test('stop rejects fan-out, remote syntax, missing and ambiguous endpoints', async t => {
  const f = await fixture(t);
  for (const input of [['all'], ['tag:codex'], ['codex-'], ['@kano:BOXE'], ['kano', 'other'], ['nonexistent']]) {
    const result = await f.invoke(['stop', ...input]);
    assert.equal(result.code, 1, input.join(' '));
  }
  assert.ok((await f.calls()).every(x => x.args[0] !== 'kill'));
  const ambiguous = await fixture(t, { TEST_ENDPOINTS: JSON.stringify([{ name: 'a-kano', base_name: 'kano' }, { name: 'b-kano', base_name: 'kano' }]) });
  assert.equal((await ambiguous.invoke(['stop', 'kano'])).code, 1);
  assert.ok((await ambiguous.calls()).every(x => x.args[0] !== 'kill'));
});

test('history filters are explicit and read passthrough rejects mutable commands', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke(['history', '--last', '7', '--thread', 'thread a'])).code, 0);
  assert.deepEqual((await f.calls())[0].args, ['events', '--type', 'message', '--full', '--last', '7', '--thread', 'thread a']);
  for (const command of [['reset'], ['relay', 'up'], ['update'], ['config', 'auto_approve', 'true'], ['events', 'sub', '--idle', 'kano'], ['events', '--remote-fetch'], ['list', '--name', 'someone']]) {
    assert.equal((await f.invoke(['hcom', ...command])).code, 1, command.join(' '));
  }
  assert.equal((await f.calls()).length, 1);
});

test('exit status 2 remains blocked/pending rather than success', async t => {
  const f = await fixture(t, { TEST_EXIT: '2' });
  const result = await f.invoke(['launch', 'codex', '--cwd', f.dir]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /"ok":true/);
});

test('missing executable is an actionable error', async t => {
  const f = await fixture(t, { AGENT_DIALOGUE_HCOM: '/nonexistent/hcom' });
  const result = await f.invoke(['list']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot run.*ENOENT/);
});

test('state isolation ignores inherited HCOM_DIR and protects personal state', () => {
  const ctx = runtimeEnvironment({ PATH: '/bin', HCOM_DIR: '/personal/state', TERM: 'screen' });
  assert.equal(ctx.stateDir, join(homedir(), '.local', 'state', 'agent-dialogue', 'spaces', 'default'));
  assert.equal(ctx.env.TERM, 'screen');
  assert.throws(() => runtimeEnvironment({ AGENT_DIALOGUE_STATE_DIR: join(homedir(), '.hcom') }), /dedicated directory/);
  assert.throws(() => runtimeEnvironment({ AGENT_DIALOGUE_STATE_DIR: homedir() }), /dedicated directory/);
});

test('a state override symlink cannot accidentally open personal state', async t => {
  const f = await fixture(t);
  const link = join(f.dir, 'home-link');
  await symlink(homedir(), link);
  f.env.AGENT_DIALOGUE_STATE_DIR = join(link, '.hcom', 'nested');
  const result = await f.invoke(['list']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /personal/);
  assert.deepEqual(await f.calls(), []);
});

test('a cache override symlink cannot install into personal hcom state', async t => {
  const f = await fixture(t);
  const link = join(f.dir, 'cache-home-link');
  await symlink(homedir(), link);
  f.env.AGENT_DIALOGUE_CACHE_DIR = join(link, '.hcom', 'nested');
  const result = await f.invoke(['list']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /personal/);
  assert.deepEqual(await f.calls(), []);
});

test('archive inspection rejects traversal, absolute paths and link entries', () => {
  assert.doesNotThrow(() => validateArchiveListing('hcom-release/\nhcom-release/hcom\n', 'drwxr-xr-x metadata\n-rwxr-xr-x metadata\n'));
  for (const path of ['/tmp/hcom', '../hcom', 'release/../../hcom', 'C:/hcom', 'release\\hcom']) assert.throws(() => validateArchiveListing(`${path}\n`, '-rwxr-xr-x metadata\n'), /Unsafe/);
  assert.throws(() => validateArchiveListing('release/link\n', 'lrwxr-xr-x metadata -> ../../outside\n'), /links/);
  assert.throws(() => validateArchiveListing('release/hardlink\n', 'hrwxr-xr-x metadata\n'), /links/);
});

test('doctor JSON exposes only selected endpoint fields', async t => {
  const f = await fixture(t, { TEST_ENDPOINTS: JSON.stringify([{ name: 'codex-kano', tool: 'codex', status: 'listening', session_id: 'session123', api_key: 'never-print-me', unrelated: 'private' }]), PATH: join(PROJECT_DIR, '.runtime', 'bin') });
  // Fake executable uses env node, so include Node's directory only, avoiding real harness checks.
  f.env.PATH = resolve(process.execPath, '..');
  await mkdir(f.env.AGENT_DIALOGUE_STATE_DIR);
  const result = await f.invoke(['doctor', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.hcom.version, 'hcom 0.7.30');
  assert.equal(data.endpoints[0].name, 'codex-kano');
  assert.ok(!result.stdout.includes('never-print-me'));
  assert.ok(!result.stdout.includes('unrelated'));
});
