import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exchange, validateTransport } from '../lib/node-transport.mjs';

const request = { payload: { kind: 'test', text: 'project communication' }, signature: 'test-signature' };
const response = { payload: { kind: 'receipt', accepted: true }, signature: 'response-signature' };
const transport = (kind = 'local-process') => ({ kind, executable: process.execPath, args: ['/opt/agent dialogue/bin/agent-dialogue.mjs'], stateDir: '/tmp/agent dialogue/state', ...(kind === 'ssh' ? { destination: 'user@project-server' } : {}) });
const ok = async () => ({ code: 0, stdout: JSON.stringify(response) });

test('SSH invokes a fixed quoted command while the entire envelope goes only to stdin', async () => {
  const peer = { transport: { ...transport('ssh'), cacheDir: '/tmp/cache', serviceFile: '/tmp/service.json', codexHome: '/tmp/codex' } };
  const envelope = { payload: { text: "SECRET_MESSAGE $(touch /tmp/nope) ' ; end" }, signature: 'SECRET_SIGNATURE' };
  let call;
  const result = await exchange(peer, envelope, { runner: async (exe, args, options) => { call = { exe, args, options }; return await ok(); } });
  assert.deepEqual(result, response);
  assert.equal(call.exe, 'ssh');
  assert.deepEqual(call.args.slice(0, 7), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', 'user@project-server']);
  assert.equal(call.args.length, 8);
  const command = call.args.at(-1);
  assert.match(command, /AGENT_DIALOGUE_STATE_DIR='\/tmp\/agent dialogue\/state'/);
  assert.match(command, /AGENT_DIALOGUE_CACHE_DIR='\/tmp\/cache'/);
  assert.match(command, /AGENT_DIALOGUE_OPENCODE_SERVICE_FILE='\/tmp\/service.json'/);
  assert.match(command, /CODEX_HOME='\/tmp\/codex'/);
  assert.match(command, /'\/opt\/agent dialogue\/bin\/agent-dialogue\.mjs' node receive$/);
  assert.equal(command.includes('SECRET_'), false);
  assert.deepEqual(JSON.parse(call.options.input), envelope);
  assert.equal(call.options.timeout, 20_000);
  assert.equal(call.options.maxOutput, 256 * 1024);
  assert.equal(call.args.some(arg => /StrictHostKeyChecking|UserKnownHostsFile/.test(arg)), false);
});

test('stored executable and arguments are shell quoted, including apostrophes and shell syntax', async () => {
  const peer = { transport: { ...transport('ssh'), executable: "/opt/a'b/node", args: ["/opt/cli's/main.mjs", '$(printf injected);literal'] } };
  await exchange(peer, request, { runner: async (_, args) => {
    assert.match(args.at(-1), /'\/opt\/a'\\''b\/node'/);
    assert.match(args.at(-1), /'\$\(printf injected\);literal'/);
    return await ok();
  } });
});

test('SSH destinations cannot inject flags, ports or remote shell fragments', () => {
  for (const destination of ['-oProxyCommand=evil', 'host;touch', 'user host', 'host:2222', 'user@host\ncommand', '', 'a'.repeat(129)]) {
    assert.throws(() => validateTransport({ ...transport('ssh'), destination }), /SSH destination/);
  }
});

test('transport configuration requires owner-stored absolute paths and bounded arguments', () => {
  assert.throws(() => validateTransport({ ...transport(), executable: 'node' }), /absolute path/);
  assert.throws(() => validateTransport({ ...transport(), stateDir: 'relative' }), /absolute path/);
  assert.throws(() => validateTransport({ ...transport(), serviceFile: '/tmp/a\u0000b' }), /absolute path/);
  assert.throws(() => validateTransport({ ...transport(), args: ['a'.repeat(8193)] }), /arguments/);
  assert.throws(() => validateTransport({ ...transport(), args: Array(65).fill('x') }), /arguments/);
  assert.throws(() => validateTransport({ ...transport(), args: [null] }), /arguments/);
  assert.throws(() => validateTransport({ ...transport(), shell: true }), /configuration/);
  assert.throws(() => validateTransport({ ...transport(), destination: 'host' }), /does not accept/);
});

test('local-process clears inherited agent and state identities before explicit peer environment', async t => {
  const original = { ...process.env };
  Object.assign(process.env, { HCOM_PROCESS_ID: 'parent-process', HCOM_NAME: 'parent', CODEX_THREAD_ID: 'parent-thread', CODEX_SESSION_ID: 'parent-session', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'parent', CODEX_HOME: '/parent/codex', CLAUDE_SESSION_ID: 'parent', AGENT_DIALOGUE_STATE_DIR: '/parent/state', AGENT_DIALOGUE_HCOM: '/parent/hcom', AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: '/parent/service', AGENT_DIALOGUE_SPACE: 'parent', AGENT_DIALOGUE_CACHE_DIR: '/parent/cache' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key]; Object.assign(process.env, original); });
  const peer = { transport: { ...transport(), cacheDir: '/peer/cache', serviceFile: '/peer/service', codexHome: '/peer/codex' } };
  await exchange(peer, request, { runner: async (exe, args, { env, input }) => {
    assert.equal(exe, process.execPath);
    assert.deepEqual(args, [...peer.transport.args, 'node', 'receive']);
    for (const key of ['HCOM_PROCESS_ID', 'HCOM_NAME', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CLAUDE_SESSION_ID', 'AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_SPACE']) assert.equal(env[key], undefined, key);
    assert.equal(env.AGENT_DIALOGUE_STATE_DIR, peer.transport.stateDir);
    assert.equal(env.AGENT_DIALOGUE_CACHE_DIR, '/peer/cache');
    assert.equal(env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE, '/peer/service');
    assert.equal(env.CODEX_HOME, '/peer/codex');
    assert.equal(env.HOME, process.env.HOME);
    assert.deepEqual(JSON.parse(input), request);
    return await ok();
  } });
});

test('only signed envelope objects may be exchanged and oversized requests never execute', async () => {
  let called = false;
  for (const envelope of [null, [], {}, { payload: {}, signature: '' }, { payload: [], signature: 's' }, { payload: {}, signature: 's', command: 'extra' }]) {
    await assert.rejects(exchange({ transport: transport() }, envelope, { runner: async () => { called = true; return await ok(); } }), /signed envelope/);
  }
  await assert.rejects(exchange({ transport: transport() }, { payload: { text: 'x'.repeat(256 * 1024) }, signature: 's' }, { runner: async () => { called = true; return await ok(); } }), /request exceeded/);
  assert.equal(called, false);
});

test('errors omit raw stderr, input, credential material and private paths', async () => {
  const secret = '/private/path/auth-token-very-secret';
  for (const runner of [async () => { throw new Error(secret); }, async () => ({ code: 255, stdout: secret, stderr: secret }), async () => ({ code: 0, stdout: secret, stderr: secret })]) {
    await assert.rejects(exchange({ transport: transport() }, request, { runner }), error => { assert.equal(error.message.includes(secret), false); assert.match(error.message, /Node transport/); return true; });
  }
});

test('oversized, extra-output and malformed unsigned responses are rejected', async () => {
  for (const stdout of ['x'.repeat(256 * 1024 + 1), `log line\n${JSON.stringify(response)}`, JSON.stringify({ payload: {}, signature: 's', extra: true }), JSON.stringify({ payload: {}, signature: null }), 'null']) {
    await assert.rejects(exchange({ transport: transport() }, request, { runner: async () => ({ code: 0, stdout }) }), /Node transport/);
  }
});

test('real local child receives stdin and returns signed JSON without a shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "test cli's.mjs"), stateDir = join(root, 'state');
  await mkdir(stateDir);
  await writeFile(cli, `let input='';for await(const chunk of process.stdin)input+=chunk;const value=JSON.parse(input);process.stdout.write(JSON.stringify({payload:{argv:process.argv.slice(2),state:process.env.AGENT_DIALOGUE_STATE_DIR,text:value.payload.text},signature:'test-response'}));`);
  const result = await exchange({ transport: { kind: 'local-process', executable: process.execPath, args: [cli], stateDir } }, request);
  assert.deepEqual(result.payload.argv, ['node', 'receive']);
  assert.equal(result.payload.state, stateDir);
  assert.equal(result.payload.text, request.payload.text);
});

test('real local child failures do not expose its diagnostic output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-transport-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'fail.mjs');
  await writeFile(cli, `console.error('PRIVATE_AUTH_TOKEN_AND_PATH');process.exit(23);`);
  await assert.rejects(exchange({ transport: { kind: 'local-process', executable: process.execPath, args: [cli], stateDir: join(root, 'state') } }, request), error => { assert.equal(error.message.includes('PRIVATE_AUTH'), false); assert.match(error.message, /exited unsuccessfully/); return true; });
});
