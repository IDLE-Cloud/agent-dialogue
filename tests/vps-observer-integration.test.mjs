import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as contract from '../scripts/vps-observer-contract.mjs';
import { fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';

// Synthetic contracts only: every subprocess is a temporary local Node fixture.
// No fixture reads private project state, contacts SSH, or starts a model.
const runId = 'vps-observer-20990101-v1';
const nonce = 'a'.repeat(32), otherNonce = 'b'.repeat(32);
const roomId = 'r_11111111-1111-4111-8111-111111111111';
const nodeId = `n_${'1'.repeat(64)}`;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function config() {
  return {
    version: 1, runId,
    outputDir: `/synthetic/verification/${runId}`,
    privateDir: `/synthetic/private/${runId}`,
    localStateDir: '/synthetic/owned-project/.agent-dialogue',
    sshExecutable: '/synthetic/bin/ssh', sshConfig: '/synthetic/private/ssh.conf',
    remote: {
      destination: 'synthetic-observer', executable: '/synthetic/remote/node',
      cli: '/synthetic/remote/tool/bin/agent-dialogue.mjs', stateDir: '/synthetic/remote/state',
      expectedNodeId: nodeId,
      rooms: [{ id: roomId, revision: 1, manifestHash: '2'.repeat(64) }],
    },
  };
}
function request(c, requestId = nonce) {
  return { version: 1, type: 'viewer-observe', requestId,
    expectedNodeId: c.remote.expectedNodeId, rooms: c.remote.rooms };
}
async function execute(executable, args, input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    // This bounds only the synthetic local child under parallel CI load. The
    // production observer independently retains its twelve-second deadline.
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic SSH fixture timed out.')); }, 15000);
    child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-contract-'));
  let gate;
  t.after(async () => { await gate?.dispose(); await rm(root, { recursive: true, force: true }); });
  const c = config();
  c.outputDir = join(root, 'public', runId); c.privateDir = join(root, 'private', runId);
  c.localStateDir = join(root, 'owned-project', 'state');
  c.sshConfig = join(root, 'ssh.conf'); c.sshExecutable = join(root, 'real-ssh.mjs');
  const callsFile = join(root, 'real-ssh-calls.jsonl');
  await mkdir(c.privateDir, { recursive: true, mode: 0o700 });
  await writeFile(c.sshConfig, '# Synthetic fixture; no actual SSH client reads this.\n', { mode: 0o600 });
  await writeFile(c.sshExecutable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);\nconst result={args:process.argv.slice(2),input:Buffer.concat(chunks).toString('base64'),env:Object.fromEntries(['PATH','HOME','SSH_AUTH_SOCK','LANG','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENCODE_SERVER_PASSWORD','NODE_OPTIONS','BASH_ENV','AGENT_DIALOGUE_STATE_DIR','CODEX_HOME'].map(key=>[key,process.env[key]??null]))};\nappendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(result)+'\\n');\nprocess.stdout.write(JSON.stringify(result));\n`, { mode: 0o700 });
  gate = await contract.createObserverGate(c);
  const invoke = (body = request(c), args = contract.observerSshArgs(c), env = {}) => execute(join(gate.binDir, 'ssh'), args,
    typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body)}\n`, env);
  const calls = async () => { try { return (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const logs = async () => { try { return (await readFile(gate.requestsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { c, gate, invoke, calls, logs };
}

test('observer acceptance requires the exact versioned explicit configuration', () => {
  assert.deepEqual(contract.validateObserverConfig(config()), config());
  for (const input of [undefined, null, {}, [], 'synthetic-observer']) assert.throws(() => contract.validateObserverConfig(input));
  for (const field of Object.keys(config())) {
    const c = config(); delete c[field]; assert.throws(() => contract.validateObserverConfig(c), `Missing ${field}`);
  }
  for (const version of [0, 2, 1.5, '1', NaN, Infinity]) assert.throws(() => contract.validateObserverConfig({ ...config(), version }));
});

test('observer configuration rejects arbitrary commands, options, credentials and extra scope keys', () => {
  for (const [section, key, value] of [
    [null, 'env', { OPENAI_API_KEY: 'synthetic-secret' }], [null, 'sshArgs', ['-o', 'StrictHostKeyChecking=no']],
    ['remote', 'command', 'arbitrary'], ['remote', 'token', 'synthetic-secret'], ['remote', 'allRooms', true],
  ]) { const c = config(); (section ? c[section] : c)[key] = value; assert.throws(() => contract.validateObserverConfig(c)); }
  const c = config(); c.remote.rooms[0].label = 'Unexpected'; assert.throws(() => contract.validateObserverConfig(c));
});

test('observer run IDs require a real date, positive bounded sequence and exact directory basenames', () => {
  for (const bad of ['', '../vps-observer-20990101-v1', `${runId}\n`, `${runId}/other`,
    'vps-observer-20990230-v1', 'vps-observer-20991301-v1', 'vps-observer-20990101-v0',
    'vps-observer-20990101-v01', 'vps-observer-20990101-v9007199254740992', 'vps-integration-20990101-v1']) {
    assert.throws(() => contract.validateObserverConfig({ ...config(), runId: bad }), JSON.stringify(bad));
  }
  for (const field of ['outputDir', 'privateDir']) { const c = config(); c[field] = '/synthetic/another-run'; assert.throws(() => contract.validateObserverConfig(c)); }
});

test('observer paths are absolute bounded printable POSIX paths', () => {
  for (const [section, fields] of [[null, ['outputDir', 'privateDir', 'localStateDir', 'sshExecutable', 'sshConfig']],
    ['remote', ['executable', 'cli', 'stateDir']]]) for (const field of fields) {
    for (const value of ['', 'relative/path', '/synthetic/bad\npath', '/synthetic/a\0b', 'C:\\synthetic\\state', `/synthetic/${'x'.repeat(section === 'remote' ? 4096 : 8192)}`]) {
      const c = config(); (section ? c[section] : c)[field] = value;
      assert.throws(() => contract.validateObserverConfig(c), `${section || 'root'}.${field}`);
    }
  }
});

test('observer public and private evidence directories cannot overlap', () => {
  for (const [outputDir, privateDir] of [
    [`/synthetic/${runId}`, `/synthetic/${runId}`],
    [`/synthetic/${runId}`, `/synthetic/${runId}/private/${runId}`],
    [`/synthetic/${runId}/public/${runId}`, `/synthetic/${runId}`],
  ]) assert.throws(() => contract.validateObserverConfig({ ...config(), outputDir, privateDir }));
});

test('observer evidence and the selected local read-only source cannot overlap in either direction', () => {
  for (const field of ['outputDir', 'privateDir']) for (const relationship of ['evidence-in-source', 'source-in-evidence', 'same-root']) {
    const c = config();
    c[field] = `/synthetic/owned-source/${runId}`;
    c.localStateDir = relationship === 'evidence-in-source' ? '/synthetic/owned-source'
      : relationship === 'source-in-evidence' ? `${c[field]}/nested/state` : c[field];
    assert.throws(() => contract.validateObserverConfig(c), `${field}: ${relationship}`);
  }
});

test('observer node identity and SSH destination cannot select wildcards, options or shell execution', () => {
  for (const destination of ['', '-oProxyCommand=bad', 'host;bad', 'host bad', '$(bad)', 'host\nother', '*', 'user@host:22', 'a@@host', 'a@b@c']) {
    const c = config(); c.remote.destination = destination; assert.throws(() => contract.validateObserverConfig(c));
  }
  for (const expectedNodeId of ['', 'n_short', `n_${'g'.repeat(64)}`, `${nodeId}\n`, `${nodeId}x`]) {
    const c = config(); c.remote.expectedNodeId = expectedNodeId; assert.throws(() => contract.validateObserverConfig(c));
  }
});

test('observer rooms require one to sixteen unique complete sealed revision pins', () => {
  const c = config(); c.remote.rooms = Array.from({ length: 16 }, (_, i) => ({
    id: `r_${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, revision: i + 1, manifestHash: '2'.repeat(64),
  })); assert.equal(contract.validateObserverConfig(c).remote.rooms.length, 16);
  for (const rooms of [[], null, [...c.remote.rooms, { ...c.remote.rooms[0], id: 'r_99999999-1111-4111-8111-111111111111' }],
    [config().remote.rooms[0], config().remote.rooms[0]], [{ id: roomId, revision: 1 }]]) {
    const bad = config(); bad.remote.rooms = rooms; assert.throws(() => contract.validateObserverConfig(bad));
  }
  for (const [field, values] of [['id', ['r_123', `${roomId}\n`]], ['revision', [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]],
    ['manifestHash', ['a'.repeat(63), 'g'.repeat(64), `${'2'.repeat(64)}\n`]]]) for (const value of values) {
    const bad = config(); bad.remote.rooms[0][field] = value; assert.throws(() => contract.validateObserverConfig(bad));
  }
});

test('observer SSH argv matches the production fixed scoped exporter invocation', async () => {
  const c = config(); let actual;
  await assert.rejects(fetchSshObservation({ kind: 'ssh', id: 'synthetic-remote', label: 'Synthetic', ...c.remote }, {
    requestId: nonce, runner: async (_executable, args) => { actual = args; return { code: 255 }; },
  }));
  assert.deepEqual(contract.observerSshArgs(c), actual);
  assert.equal(actual.at(-1), `${quote(c.remote.executable)} ${quote(c.remote.cli)} view-export --state-dir ${quote(c.remote.stateDir)}`);
  assert.ok(!actual.includes('-F'), 'The shim alone supplies the explicit SSH configuration.');
});

test('observer command quoting keeps apostrophes and shell-looking path text literal', () => {
  const c = config(); c.remote.executable = "/synthetic/owner's node";
  c.remote.cli = '/synthetic/tool $(literal)/cli.mjs'; c.remote.stateDir = '/synthetic/`literal` state';
  const args = contract.observerSshArgs(c);
  assert.equal(args.at(-1), `${quote(c.remote.executable)} ${quote(c.remote.cli)} view-export --state-dir ${quote(c.remote.stateDir)}`);
});

test('observer gate starts open and forwards stdin bytes and exact explicit SSH config', async t => {
  const { c, gate, invoke, calls, logs } = await setup(t);
  assert.ok(gate.binDir.startsWith(c.privateDir + sep)); assert.ok(gate.gateFile.startsWith(c.privateDir + sep));
  assert.ok(gate.requestsFile.startsWith(c.privateDir + sep));
  const input = `${JSON.stringify(request(c))}\n`;
  const result = await invoke(input); assert.equal(result.code, 0);
  const forwarded = JSON.parse(result.stdout);
  assert.deepEqual(forwarded.args, ['-F', c.sshConfig, ...contract.observerSshArgs(c)]);
  assert.equal(Buffer.from(forwarded.input, 'base64').toString(), input);
  assert.equal((await calls()).length, 1); assert.equal((await logs())[0].requestId, nonce);
});

test('observer gate closed state prevents the lower fixture from executing and reopening uses a new nonce', async t => {
  const { c, gate, invoke, calls, logs } = await setup(t);
  await gate.close(); const blocked = await invoke(); assert.equal(blocked.code, 255);
  assert.deepEqual(await calls(), []);
  await gate.open(); const opened = await invoke(request(c, otherNonce)); assert.equal(opened.code, 0);
  assert.equal((await calls()).length, 1);
  assert.deepEqual((await logs()).map(({ requestId, status }) => ({ requestId, status })), [
    { requestId: nonce, status: 'blocked' }, { requestId: otherNonce, status: 'allowed' },
  ]);
});

test('closed observer gate passes unrelated bridge SSH calls unchanged without observer logging', async t => {
  const { c, gate, invoke, calls, logs } = await setup(t);
  await gate.close(); const args = ['-T', '--', c.remote.destination, "'synthetic-node' 'synthetic-cli' node receive"];
  const result = await invoke('synthetic bridge body\n', args); assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).args, ['-F', c.sshConfig, ...args]);
  assert.equal(Buffer.from(JSON.parse(result.stdout).input, 'base64').toString(), 'synthetic bridge body\n');
  assert.equal((await calls()).length, 1); assert.deepEqual(await logs(), []);
});

test('observer gate log stores only canonical nonce, decision and timestamp', async t => {
  const { c, invoke, gate, logs } = await setup(t);
  await invoke(); await gate.close(); await invoke(request(c, otherNonce));
  for (const entry of await logs()) {
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'requestId', 'status']);
    assert.match(entry.requestId, /^[0-9a-f]{32}$/); assert.ok(['allowed', 'blocked'].includes(entry.status));
    assert.equal(new Date(entry.at).toISOString(), entry.at);
  }
  const text = await readFile(gate.requestsFile, 'utf8');
  for (const secret of [c.privateDir, c.sshConfig, c.remote.stateDir, c.remote.destination, c.remote.expectedNodeId, roomId, 'viewer-observe']) assert.ok(!text.includes(secret));
  assert.equal((await stat(gate.requestsFile)).mode & 0o077, 0);
});

test('observer gate forwards normal environment but removes API and execution injection variables', async t => {
  const { invoke } = await setup(t);
  const result = await invoke(undefined, undefined, {
    HOME: '/synthetic/home', SSH_AUTH_SOCK: '/synthetic/ssh-agent.sock', LANG: 'C',
    OPENAI_API_KEY: 'synthetic-api-secret', ANTHROPIC_API_KEY: 'synthetic-anthropic-secret',
    OPENCODE_SERVER_PASSWORD: 'synthetic-service-secret', NODE_OPTIONS: '--no-warnings',
    BASH_ENV: '/synthetic/no-script', AGENT_DIALOGUE_STATE_DIR: '/synthetic/unrelated-state', CODEX_HOME: '/synthetic/codex',
  });
  assert.equal(result.code, 0); const { env } = JSON.parse(result.stdout);
  assert.equal(env.HOME, '/synthetic/home'); assert.equal(env.SSH_AUTH_SOCK, '/synthetic/ssh-agent.sock'); assert.equal(env.LANG, 'C');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_SERVER_PASSWORD', 'NODE_OPTIONS', 'BASH_ENV', 'AGENT_DIALOGUE_STATE_DIR', 'CODEX_HOME']) assert.equal(env[key], null, key);
});

test('observer gate rejects malformed, oversized and invalid-nonce selected requests before executing', async t => {
  const { c, invoke, calls, logs } = await setup(t);
  const requests = ['not json', '{}', JSON.stringify({ ...request(c), requestId: `${nonce}\n` }),
    JSON.stringify({ ...request(c), requestId: 'g'.repeat(32) }),
    JSON.stringify({ ...request(c), token: 'synthetic-body-secret' }),
    JSON.stringify(request(c)) + ' '.repeat(16384), Buffer.from([0xff, 0xfe, 0x0a])];
  for (const body of requests) { const result = await invoke(body); assert.equal(result.code, 255); assert.ok(!result.stderr.includes('synthetic-body-secret')); }
  assert.deepEqual(await calls(), []); assert.deepEqual(await logs(), []);
});

test('observer gate refuses a request that changes the configured sealed room or node pins', async t => {
  const { c, invoke, calls } = await setup(t);
  for (const body of [
    { ...request(c), expectedNodeId: `n_${'3'.repeat(64)}` },
    { ...request(c), rooms: [{ ...c.remote.rooms[0], revision: 2 }] },
    { ...request(c), rooms: [{ ...c.remote.rooms[0], manifestHash: '4'.repeat(64) }] },
    { ...request(c), rooms: [{ ...c.remote.rooms[0], id: 'r_99999999-1111-4111-8111-111111111111' }] },
  ]) assert.equal((await invoke(body)).code, 255);
  assert.deepEqual(await calls(), []);
});

test('observer gate disposal fails closed for later observer requests', async t => {
  const { gate, invoke, calls } = await setup(t);
  await gate.dispose(); const result = await invoke();
  assert.equal(result.code, 255); assert.deepEqual(await calls(), []);
});

test('observer gate cancellation reaps its stubborn owned SSH fixture and grandchild before an outer forced stop', async t => {
  const { c, gate } = await setup(t), pidsFile = join(c.privateDir, 'owned-fixture-pids.json');
  const grandchildSource = `process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.send({ready:true});`;
  await writeFile(c.sshExecutable, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM',()=>{});\nfor await (const _chunk of process.stdin) {}\nconst grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:['ignore','ignore','ignore','ipc']});\ngrandchild.once('message',()=>writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({child:process.pid,grandchild:grandchild.pid})));\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const child = spawn(join(gate.binDir, 'ssh'), contract.observerSshArgs(c), {
    shell: false, env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request(c)) + '\n');
  let owned, outerKill;
  t.after(() => {
    clearTimeout(outerKill);
    // Only PIDs produced by this synthetic fixture may be terminated here.
    for (const pid of [child.pid, owned?.child, owned?.grandchild]) if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const wait = async predicate => {
    const deadline = Date.now() + 15_000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Owned synthetic process did not reach its expected state.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await wait(async () => { try { owned = JSON.parse(await readFile(pidsFile, 'utf8')); return true; } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; } });
  assert.ok(Number.isSafeInteger(owned.child) && Number.isSafeInteger(owned.grandchild));
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  // Simulate the outer runner's hard stop with a deliberately shorter deadline.
  // The gate must terminate its isolated process group well before this point.
  outerKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
  await closed; clearTimeout(outerKill);
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
  const deadline = Date.now() + 1000;
  while ((!gone(owned.child) || !gone(owned.grandchild)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(gone(owned.child), true, 'The owned SSH fixture must not survive gate cancellation.');
  assert.equal(gone(owned.grandchild), true, 'The owned SSH fixture grandchild must not survive gate cancellation.');
});

test('observer state hash uses fixed read-only source with scope on stdin, not remote shell argv', () => {
  const c = config(); const invocation = contract.buildObserverHashInvocation(c);
  assert.equal(invocation.executable, c.sshExecutable);
  assert.deepEqual(invocation.args.slice(0, 2), ['-F', c.sshConfig]);
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ClearAllForwardings=yes', 'ControlMaster=no', 'ControlPath=none']) assert.ok(invocation.args.includes(option), option);
  assert.deepEqual(invocation.args.slice(-3, -1), ['--', c.remote.destination]);
  const command = invocation.args.at(-1);
  assert.ok(command.startsWith(`${quote(c.remote.executable)} `)); assert.ok(command.includes('-e'));
  assert.ok(!command.includes(c.remote.stateDir)); assert.ok(!command.includes(c.remote.expectedNodeId));
  const input = JSON.parse(invocation.input); assert.equal(input.stateDir, c.remote.stateDir);
  assert.match(input.requestId, /^[0-9a-f]{32}$/); assert.equal(input.version, 1);
  assert.ok(Buffer.byteLength(invocation.input) <= 16384);
});

test('observer state hash requests receive independent nonce identities without changing the fixed source', () => {
  const c = config(); const first = contract.buildObserverHashInvocation(c), second = contract.buildObserverHashInvocation(c);
  assert.deepEqual(first.args, second.args); assert.notEqual(JSON.parse(first.input).requestId, JSON.parse(second.input).requestId);
});

test('observer hash invocation validates an explicitly supplied request nonce without putting it in argv', () => {
  const c = config(); const invocation = contract.buildObserverHashInvocation(c, { requestId: nonce });
  assert.equal(JSON.parse(invocation.input).requestId, nonce); assert.ok(!invocation.args.join(' ').includes(nonce));
  for (const requestId of ['', 'x'.repeat(32), nonce.slice(1), `${nonce}\n`, null, 42]) assert.throws(() => contract.buildObserverHashInvocation(c, { requestId }));
});

test('observer fixed hasher preserves live synthetic WAL and SHM bytes without opening SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-hashes-'));
  let db;
  t.after(async () => { db?.close(); await rm(root, { recursive: true, force: true }); });
  const stateDir = join(root, "owner's synthetic state"); await mkdir(join(stateDir, 'nested'), { recursive: true });
  db = new DatabaseSync(join(stateDir, 'hcom.db'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('local fixture only');");
  await writeFile(join(stateDir, 'nested', 'control.json'), '{"synthetic":true}\n');
  const names = ['hcom.db', 'hcom.db-wal', 'hcom.db-shm', 'nested/control.json'];
  const hashes = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(join(stateDir, name))).digest('hex')])));
  const before = await hashes();
  const input = JSON.stringify({ version: 1, type: 'viewer-hash-state', requestId: nonce, stateDir }) + '\n';
  const result = await execute(process.execPath, ['-e', contract.OBSERVER_HASH_SOURCE], input);
  assert.equal(result.code, 0); const output = JSON.parse(result.stdout);
  assert.deepEqual(output, { version: 1, type: 'viewer-state-hashes', requestId: nonce, files: before });
  assert.deepEqual(await hashes(), before);
  assert.ok(!result.stdout.includes(stateDir)); assert.ok(!result.stdout.includes('local fixture only'));
});

test('observer fixed hasher fails closed on symlinked state entries instead of traversing outside scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'); await mkdir(stateDir);
  const outside = join(root, 'outside-private.txt'); await writeFile(outside, 'synthetic-outside-private');
  await symlink(outside, join(stateDir, 'linked.txt'));
  const input = JSON.stringify({ version: 1, type: 'viewer-hash-state', requestId: nonce, stateDir }) + '\n';
  const result = await execute(process.execPath, ['-e', contract.OBSERVER_HASH_SOURCE], input);
  assert.notEqual(result.code, 0); assert.ok(!result.stdout.includes('synthetic-outside-private'));
  assert.ok(!result.stderr.includes(outside));
});

test('observer fixed hasher rejects malformed requests without echoing body secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-hash-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = { version: 1, type: 'viewer-hash-state', requestId: nonce, stateDir: root };
  for (const input of ['not-json-synthetic-secret', JSON.stringify({ ...valid, token: 'synthetic-body-secret' }),
    JSON.stringify({ ...valid, requestId: `${nonce}\n` }), JSON.stringify({ ...valid, stateDir: 'relative/state' }),
    JSON.stringify(valid) + ' '.repeat(16384)]) {
    const result = await execute(process.execPath, ['-e', contract.OBSERVER_HASH_SOURCE], input);
    assert.notEqual(result.code, 0); assert.ok(!result.stderr.includes('synthetic-body-secret')); assert.ok(!result.stdout.includes('synthetic-body-secret'));
  }
});

function recoveryFixture({ neverFails = false, corruptStaleTime = false, changesMessages = false, neverRecovers = false } = {}) {
  let open = true, hasClosed = false, now = 0, failedRefreshes = 0;
  const calls = [], remoteId = 'synthetic-remote';
  const initialTime = '2099-01-01T00:00:00.000Z', recoveredTime = '2099-01-01T00:00:01.000Z';
  const viewer = { model: { sources: [], projection: { messages: [] }, async refresh() {
    const available = open ? !(neverRecovers && hasClosed) : neverFails;
    if (!available) failedRefreshes++;
    const observedAt = available && hasClosed ? recoveredTime : corruptStaleTime && failedRefreshes > 1 ? recoveredTime : initialTime;
    this.sources = [{ id: remoteId, available, observedAt, events: [{ id: 1, data: { text: 'synthetic' } }] }];
    this.projection.messages = [{ id: 'msg_synthetic-a' }, { id: changesMessages && hasClosed && open ? 'msg_unexpected' : 'msg_synthetic-b' }];
  } } };
  return { viewer, remoteId, calls, failedRefreshes: () => failedRefreshes,
    setGate: async value => { open = value; if (!value) hasClosed = true; calls.push(value); },
    timeoutMs: 2000, clock: () => now, pause: async () => { now += 250; } };
}

test('observer recovery proves available to stale to recovered while retaining logical message identities', async () => {
  const fixture = recoveryFixture(); const result = await contract.observeRecovery(fixture);
  assert.deepEqual(fixture.calls, [false, true]); assert.ok(fixture.failedRefreshes() >= 2);
  assert.equal(result.initial.available, true); assert.equal(result.stale.available, false); assert.equal(result.recovered.available, true);
  assert.equal(result.stale.observedAt, result.initial.observedAt); assert.ok(result.recovered.observedAt > result.stale.observedAt);
  assert.deepEqual(new Set(result.messageIds), new Set(['msg_synthetic-a', 'msg_synthetic-b']));
  fixture.viewer.model.sources[0].observedAt = '2100-01-01T00:00:00.000Z';
  assert.equal(result.recovered.observedAt, '2099-01-01T00:00:01.000Z', 'Returned evidence must be a detached snapshot.');
});

test('observer recovery rejects stale timestamps that advance after the failure is confirmed', async () => {
  await assert.rejects(contract.observeRecovery(recoveryFixture({ corruptStaleTime: true })));
});

test('observer recovery rejects changed logical message identities after reconnecting', async () => {
  await assert.rejects(contract.observeRecovery(recoveryFixture({ changesMessages: true })));
});

test('observer recovery times out when a closed gate never produces a stale source', async () => {
  await assert.rejects(contract.observeRecovery(recoveryFixture({ neverFails: true })));
});

test('observer recovery times out when reopening never produces a successful fresh observation', async () => {
  await assert.rejects(contract.observeRecovery(recoveryFixture({ neverRecovers: true })));
});

test('observer run directories are freshly claimed with private permissions and preserve existing evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = { ...config(), outputDir: join(root, 'public', runId), privateDir: join(root, 'private', runId) };
  assert.deepEqual(await contract.claimObserverDirectories(c), { outputDir: c.outputDir, privateDir: c.privateDir });
  assert.ok((await stat(c.outputDir)).isDirectory()); assert.ok((await stat(c.privateDir)).isDirectory());
  assert.equal((await stat(c.privateDir)).mode & 0o777, 0o700);
  await writeFile(join(c.outputDir, 'preserved.json'), '{"synthetic":"prior public result"}\n');
  await writeFile(join(c.privateDir, 'preserved.json'), '{"synthetic":"prior private result"}\n');
  await assert.rejects(contract.claimObserverDirectories(c));
  assert.equal(await readFile(join(c.outputDir, 'preserved.json'), 'utf8'), '{"synthetic":"prior public result"}\n');
  assert.equal(await readFile(join(c.privateDir, 'preserved.json'), 'utf8'), '{"synthetic":"prior private result"}\n');
});

test('observer claim rejects existing empty or symlinked leaves and rolls back only its newly created empty public root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['public-empty', 'private-empty', 'public-symlink', 'private-symlink']) {
    const parent = join(root, kind), c = { ...config(), outputDir: join(parent, 'public', runId), privateDir: join(parent, 'private', runId) };
    const existing = kind.startsWith('public') ? c.outputDir : c.privateDir;
    if (kind.endsWith('symlink')) {
      const target = join(parent, 'existing-target'); await mkdir(target, { recursive: true });
      await mkdir(join(existing, '..'), { recursive: true }); await symlink(target, existing);
      await writeFile(join(target, 'preserved.txt'), 'synthetic prior owned content');
    } else await mkdir(existing, { recursive: true });
    await assert.rejects(contract.claimObserverDirectories(c), kind);
    assert.ok((await stat(existing)).isDirectory(), `${kind}: retain the existing root`);
    if (kind.startsWith('private')) await assert.rejects(stat(c.outputDir), { code: 'ENOENT' });
    else await assert.rejects(stat(c.privateDir), { code: 'ENOENT' });
    if (kind.endsWith('symlink')) assert.equal(await readFile(join(existing, 'preserved.txt'), 'utf8'), 'synthetic prior owned content');
  }
});

test('observer effective public-private nesting through an ancestor symlink is rejected before creating run roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-effective-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const direction of ['private-in-public', 'public-in-private']) {
    const parent = join(root, direction), actual = join(parent, 'actual'); await mkdir(actual, { recursive: true });
    const alias = join(parent, 'alias'); await symlink(actual, alias);
    const outer = join(actual, runId), inner = join(alias, runId, 'nested', runId);
    const c = { ...config(), outputDir: direction === 'private-in-public' ? outer : inner,
      privateDir: direction === 'private-in-public' ? inner : outer };
    await assert.rejects(contract.claimObserverDirectories(c), direction);
    await assert.rejects(stat(outer), { code: 'ENOENT' }, `${direction}: reject without creating a run root`);
  }
});

test('observer effective source-evidence overlap through an ancestor symlink is rejected without writing either source or run roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-observer-source-effective-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const field of ['outputDir', 'privateDir']) for (const direction of ['evidence-in-source', 'source-in-evidence']) {
    const parent = join(root, `${field}-${direction}`), actual = join(parent, 'actual');
    await mkdir(actual, { recursive: true });
    const alias = join(parent, 'alias'); await symlink(actual, alias);
    const sentinel = join(actual, 'preserved-source.json'); await writeFile(sentinel, '{"synthetic":"source bytes must remain unchanged"}\n');
    const c = { ...config(), outputDir: join(parent, 'public', runId), privateDir: join(parent, 'private', runId) };
    if (direction === 'evidence-in-source') {
      c.localStateDir = actual; c[field] = join(alias, runId);
    } else {
      c.localStateDir = join(alias, runId, 'source'); c[field] = join(actual, runId);
    }
    // Lexical validation passes: only the effective ancestor resolves the alias.
    assert.doesNotThrow(() => contract.validateObserverConfig(c));
    await assert.rejects(contract.claimObserverDirectories(c), `${field}: ${direction}`);
    await assert.rejects(stat(c.outputDir), { code: 'ENOENT' });
    await assert.rejects(stat(c.privateDir), { code: 'ENOENT' });
    assert.equal(await readFile(sentinel, 'utf8'), '{"synthetic":"source bytes must remain unchanged"}\n');
  }
});
