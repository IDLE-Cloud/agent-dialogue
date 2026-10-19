import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWindowsWorker, cleanupWindowsWorker, loadWindowsWorkerConfig, parseWorkerArguments, windowsArgument, applyWindowsWorkerEnvironment } from '../lib/windows-worker.mjs';

const bindingId = 'b_10000000-0000-4000-8000-000000000001';
const token = '20000000-0000-4000-8000-000000000001';
const decode = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-windows-worker-')); t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: {
    PATH: 'C:\\Windows\\System32;C:\\Agent Tools\\Node', AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE: "D:\\Agent's State\\service.json",
    OPENAI_API_KEY: 'DO-NOT-PERSIST', OPENCODE_SERVER_PASSWORD: 'DO-NOT-PERSIST', HCOM_NAME: 'parent-agent', CODEX_THREAD_ID: 'parent-thread', RANDOM_SECRET: 'DO-NOT-PERSIST',
  } };
  const calls = [];
  const runner = async (executable, args, options) => { calls.push({ executable, args, options, script: decode(args) }); return { code: 0, stdout: JSON.stringify(calls.length === 1 ? { secured: true } : { taskName: `AgentDialogue-${bindingId}-${token}`, registered: true, started: true }), stderr: '' }; };
  const options = { bindingId, token, workerPath: "D:\\Agent's Tools\\$(bad);literal\\bin\\bridge-worker.mjs", projectDir: 'D:\\Agent Tools\\agent-dialogue', logPath: join(context.stateDir, 'dialogue', `${bindingId}.worker.log`), nodeExecutable: 'D:\\Agent Tools\\Node\\node.exe', runner };
  return { root, context, options, runner, calls };
}

test('worker argument contract keeps POSIX start and accepts only one exact launch-config option', () => {
  assert.deepEqual(parseWorkerArguments([bindingId, '--token', token]), { bindingId, token, launchConfigPath: null });
  assert.deepEqual(parseWorkerArguments([bindingId, '--token', token, '--launch-config', 'D:\\state\\launch.json']), { bindingId, token, launchConfigPath: 'D:\\state\\launch.json' });
  for (const args of [[], [bindingId, '--token', token, '--unknown'], [bindingId, '--token', token, '--launch-config', ''], ['b_bad', '--token', token], [bindingId, '--token', 'token;bad'], [bindingId, '--token', token, '--launch-config', 'x', 'extra']]) assert.throws(() => parseWorkerArguments(args));
});

test('Windows native action arguments quote spaces, quotes and trailing backslashes without shell evaluation', () => {
  assert.equal(windowsArgument('plain'), '"plain"');
  assert.equal(windowsArgument('a b'), '"a b"');
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.equal(windowsArgument('C:\\tail\\'), '"C:\\tail\\\\"');
  assert.equal(windowsArgument('$(bad);literal'), '"$(bad);literal"');
  assert.throws(() => windowsArgument('x\0bad'));
});

test('launcher persists only scoped env and creates a current-user Limited task without triggers or overwrite', async t => {
  const f = await fixture(t), result = await startWindowsWorker(f.context, f.options);
  assert.equal(result.taskName, `AgentDialogue-${bindingId}-${token}`);
  assert.equal(result.launcher, 'windows-scheduled-task');
  const config = JSON.parse(await readFile(result.launchConfigPath, 'utf8'));
  assert.equal(config.env.AGENT_DIALOGUE_STATE_DIR, f.context.stateDir);
  assert.equal(config.env.AGENT_DIALOGUE_CACHE_DIR, f.context.cacheDir);
  assert.equal(config.env.AGENT_DIALOGUE_LEDGER, 'embedded');
  assert.equal(config.env.AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE, f.context.env.AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE);
  for (const key of ['OPENAI_API_KEY', 'OPENCODE_SERVER_PASSWORD', 'HCOM_NAME', 'CODEX_THREAD_ID', 'RANDOM_SECRET']) assert.equal(Object.hasOwn(config.env, key), false);
  assert.equal(JSON.stringify(config).includes('DO-NOT-PERSIST'), false);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].script, /SetAccessRuleProtection/);
  const script = f.calls[1].script;
  assert.match(script, /Schedule\.Service/);
  assert.match(script, /RegisterTaskDefinition/);
  assert.match(script, /LogonType=3/);
  assert.match(script, /RunLevel=0/);
  assert.match(script, /ExecutionTimeLimit='PT0S'/);
  assert.equal(script.includes('Get-ScheduledTask'), false);
  assert.equal(script.includes('TASK_CREATE_OR_UPDATE'), false);
  assert.equal(script.includes('Stop-Process'), false);
  assert.equal(script.includes('Start-Process'), false);
  assert.equal(script.includes('DO-NOT-PERSIST'), false);
  assert.ok(f.calls.every(call => call.args.at(-1).length < 7600));
});

test('existing launch config is never overwritten and does not invoke task registration', async t => {
  const f = await fixture(t), result = await startWindowsWorker(f.context, f.options);
  const before = await readFile(result.launchConfigPath);
  await assert.rejects(startWindowsWorker(f.context, f.options), /exists|EEXIST/i);
  assert.deepEqual(await readFile(result.launchConfigPath), before);
  assert.equal(f.calls.filter(call => call.script.includes('RegisterTaskDefinition')).length, 1);
});

test('launch config validation checks version, exact binding/token, scoped path and unknown environment fields', async t => {
  const f = await fixture(t), result = await startWindowsWorker(f.context, f.options);
  const config = await loadWindowsWorkerConfig(result.launchConfigPath, { bindingId, token });
  assert.equal(config.bindingId, bindingId);
  await assert.rejects(loadWindowsWorkerConfig(result.launchConfigPath, { bindingId, token: '30000000-0000-4000-8000-000000000001' }), /token|identity|matching/i);
  const original = JSON.parse(await readFile(result.launchConfigPath, 'utf8'));
  for (const patch of [{ version: 2 }, { taskName: 'SomeoneElse' }, { logPath: join(f.root, 'elsewhere.log') }, { extra: 'field' }, { env: { ...original.env, OPENAI_API_KEY: 'secret' } }]) {
    await writeFile(result.launchConfigPath, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(loadWindowsWorkerConfig(result.launchConfigPath, { bindingId, token }));
  }
});

test('worker environment removes inherited identities and preserves ordinary OS context', () => {
  const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\z', HCOM_NAME: 'parent', CODEX_THREAD_ID: 'parent', AGENT_DIALOGUE_STATE_DIR: 'old', Path: 'old-path' };
  applyWindowsWorkerEnvironment({ AGENT_DIALOGUE_STATE_DIR: 'D:\\state', AGENT_DIALOGUE_LEDGER: 'embedded', PATH: 'D:\\Node' }, env);
  assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.USERPROFILE, 'C:\\Users\\z');
  assert.equal(env.HCOM_NAME, undefined); assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.AGENT_DIALOGUE_STATE_DIR, 'D:\\state'); assert.equal(env.PATH, 'D:\\Node'); assert.equal(env.Path, undefined);
});

test('cleanup inspects exact task definition and never sends Stop or deletes a stranger', async t => {
  const f = await fixture(t), result = await startWindowsWorker(f.context, f.options);
  let script;
  const cleanup = await cleanupWindowsWorker(bindingId, token, { launchConfigPath: result.launchConfigPath, runner: async (_, args) => {
    script = decode(args); return { code: 0, stdout: JSON.stringify({ taskName: result.taskName, removed: true }), stderr: '' };
  } });
  assert.equal(cleanup.removed, true);
  for (const evidence of ['Triggers.Count', 'Actions.Count', 'RegistrationInfo.Description', 'Principal.UserId', 'LogonType', 'RunLevel', 'WorkingDirectory', 'Arguments', 'DeleteTask']) assert.ok(script.includes(evidence), evidence);
  assert.equal(/Stop-Process|Stop-ScheduledTask|\.Stop\(/.test(script), false);
  await assert.rejects(readFile(result.launchConfigPath), { code: 'ENOENT' });
});

test('failed or mismatched cleanup retains launch evidence and never removes unrelated files', async t => {
  const f = await fixture(t), result = await startWindowsWorker(f.context, f.options);
  await assert.rejects(cleanupWindowsWorker(bindingId, token, { launchConfigPath: result.launchConfigPath, runner: async () => ({ code: 1, stdout: '', stderr: 'private error' }) }), /cleanup/i);
  assert.ok(await readFile(result.launchConfigPath));
  const other = join(f.root, 'unrelated.json'); await writeFile(other, '{}');
  await assert.rejects(cleanupWindowsWorker(bindingId, token, { launchConfigPath: other, runner: async () => assert.fail('bad config must not invoke scheduler') }));
  assert.equal(await readFile(other, 'utf8'), '{}');
});

test('known registration failure removes only the fresh config without stopping any task', async t => {
  const f = await fixture(t);
  f.options.runner = async (_, args) => {
    const script = decode(args); f.calls.push({ script });
    return script.includes('RegisterTaskDefinition') ? { code: 1, stdout: '', stderr: 'task already exists' } : { code: 0, stdout: '{"secured":true}', stderr: '' };
  };
  await assert.rejects(startWindowsWorker(f.context, f.options), /registration|start/i);
  assert.equal((await readdir(join(f.context.stateDir, 'dialogue', 'windows-workers'))).some(name => name.endsWith('.json')), false);
  assert.equal(f.calls.some(call => /\.Stop\(|Stop-Process/.test(call.script)), false);
});

test('uncertain scheduler outcomes retain the scoped descriptor for explicit reconciliation', async t => {
  const f = await fixture(t);
  f.options.runner = async (_, args) => {
    if (decode(args).includes('RegisterTaskDefinition')) throw new Error('sensitive transport details');
    return { code: 0, stdout: '{"secured":true}' };
  };
  await assert.rejects(startWindowsWorker(f.context, f.options), error => error.uncertain === true && !error.message.includes('sensitive'));
  const files = await readdir(join(f.context.stateDir, 'dialogue', 'windows-workers'));
  assert.equal(files.filter(name => name.endsWith('.json')).length, 1);
});

test('launch directory and config symlinks fail closed before scheduler changes', async t => {
  const f = await fixture(t), target = join(f.root, 'target'); await mkdir(target);
  try { await symlink(target, f.context.stateDir, 'junction'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error; }
  await assert.rejects(startWindowsWorker(f.context, f.options), /regular|private/i);
  assert.deepEqual(await readdir(target), []);
  assert.equal(f.calls.length, 0);
});
