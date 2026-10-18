import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateSshSource, fetchSshObservation, createSourceReader } from '../lib/viewer/readers/ssh.mjs';
import { exportObservation } from '../lib/viewer/observation.mjs';
import { ViewerModel } from '../lib/viewer/stream.mjs';
import { fixtureIDs, makeSources } from './fixtures/viewer-fixture.mjs';

const nonce = '0123456789abcdef0123456789abcdef';
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const source = makeSources({ sealedManifest: true })[0];
  source.generation = '1'.repeat(32);
  const room = source.store.rooms[fixtureIDs.room];
  const spec = { kind: 'ssh', id: 'remote-laptop', label: 'Project laptop', destination: 'research-laptop',
    executable: '/opt/node/bin/node', cli: '/opt/agent dialogue/bin/agent-dialogue.mjs', stateDir: '/srv/project dialogue/state',
    expectedNodeId: source.node.nodeId, rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] };
  return { source, spec };
}
const requestFor = spec => ({ version: 1, type: 'viewer-observe', requestId: nonce, expectedNodeId: spec.expectedNodeId, rooms: structuredClone(spec.rooms) });
const responseFor = (source, spec) => exportObservation(source, requestFor(spec));
function reply(source, spec) { return { code: 0, stdout: JSON.stringify(responseFor(source, spec)) }; }
const noLeak = secret => error => {
  assert.equal(String(error.message).includes(secret), false);
  assert.match(error.message, /SSH|observation|source/i);
  return true;
};

test('SSH viewer sources require pinned identities, explicit room revisions, and fixed absolute POSIX paths', () => {
  const { spec } = fixture();
  assert.deepEqual(validateSshSource(spec), spec);
  assert.doesNotThrow(() => validateSshSource({ ...spec, destination: 'researcher@lab.example' }));
  for (const change of [
    { kind: 'local-process' }, { executable: 'node' }, { cli: 'bin/agent-dialogue.mjs' }, { stateDir: '../state' },
    { executable: 'C:\\node.exe' }, { cli: '/opt/cli\u0000.mjs' }, { stateDir: '/srv/state\nother' },
    { expectedNodeId: '' }, { expectedNodeId: 'n_short' }, { expectedNodeId: 'n_' + 'g'.repeat(64) },
    { rooms: [] }, { rooms: [{ ...spec.rooms[0], revision: 0 }] }, { rooms: [{ ...spec.rooms[0], revision: 1.5 }] },
    { rooms: [{ ...spec.rooms[0], manifestHash: '' }] }, { rooms: [{ ...spec.rooms[0], id: 'same-name-is-not-an-id' }] },
    { rooms: [spec.rooms[0], spec.rooms[0]] },
  ]) assert.throws(() => validateSshSource({ ...spec, ...change }), undefined, JSON.stringify(change));
  for (const key of ['kind', 'id', 'label', 'destination', 'executable', 'cli', 'stateDir', 'expectedNodeId', 'rooms']) {
    const incomplete = { ...spec }; delete incomplete[key];
    assert.throws(() => validateSshSource(incomplete), undefined, `missing ${key}`);
  }
});

test('SSH viewer destinations cannot inject options, ports, shell fragments or controls', () => {
  const { spec } = fixture();
  for (const destination of ['-oProxyCommand=evil', 'host:2222', 'user@host:22', 'host;printf injected', 'host$(printf injected)',
    'user host', 'host\ncommand', 'host\u0000suffix', '', 'a'.repeat(129)]) {
    assert.throws(() => validateSshSource({ ...spec, destination }), undefined, destination);
  }
});

test('viewer SSH configuration rejects arbitrary execution, SSH options, and room-level extras before invoking a runner', async () => {
  const { spec, source } = fixture();
  let calls = 0;
  const runner = async () => { calls++; return reply(source, spec); };
  for (const extra of [{ args: ['send'] }, { sshOptions: ['-oStrictHostKeyChecking=no'] }, { command: 'cat ~/.ssh/id_ed25519' },
    { localProcess: true }, { shell: true }, { cacheDir: '/private/cache' }, { serviceFile: '/private/service.json' },
    { rooms: [{ ...spec.rooms[0], path: '/private/other' }] }]) {
    await assert.rejects(fetchSshObservation({ ...spec, ...extra }, { runner, requestId: nonce }));
  }
  assert.equal(calls, 0);
});

test('SSH collection uses fixed host verification flags and sends the pinned request only through stdin', async () => {
  const { spec, source } = fixture();
  let call;
  const result = await fetchSshObservation(spec, { requestId: nonce, runner: async (executable, args, options) => {
    call = { executable, args, options }; return reply(source, spec);
  } });
  assert.equal(call.executable, 'ssh');
  assert.deepEqual(call.args.slice(0, -1), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', '-o', 'ClearAllForwardings=yes', '--', spec.destination]);
  assert.equal(call.args.length, 16);
  assert.deepEqual(JSON.parse(call.options.input), requestFor(spec));
  assert.equal(call.args.some(value => value.includes(nonce) || value.includes(spec.expectedNodeId) || value.includes(spec.rooms[0].manifestHash)), false);
  assert.equal(call.options.timeout, 12_000);
  assert.equal(call.options.maxOutput, 16 * 1024 * 1024);
  assert.equal(result.id, spec.id);
  assert.equal(result.label, spec.label);
  assert.equal(result.available, true);
  assert.equal(result.node.nodeId, spec.expectedNodeId);
});

test('SSH fixed command round-trips spaces, apostrophes and shell syntax without evaluating it', async () => {
  const { spec, source } = fixture();
  const strange = { ...spec, executable: "/opt/a'b/$(printf EXECUTED)/node", cli: "/opt/cli's folder/$(printf EXECUTED);literal.mjs",
    stateDir: "/srv/project's state/$(printf EXECUTED);literal" };
  await fetchSshObservation(strange, { requestId: nonce, runner: async (_, args) => {
    // `set --` parses the remote command as words without invoking the selected executable.
    const decoded = spawnSync('/bin/sh', ['-c', `set -- ${args.at(-1)}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
    assert.equal(decoded.status, 0);
    assert.deepEqual(decoded.stdout.split('\u0000').slice(0, -1), [strange.executable, strange.cli, 'view-export', '--state-dir', strange.stateDir]);
    return reply(source, strange);
  } });
});

test('SSH collection strips inherited harness and communication identities while retaining ordinary SSH authentication context', async t => {
  const { spec, source } = fixture();
  const original = { ...process.env };
  Object.assign(process.env, { HCOM_NAME: 'private-parent', HCOM_PROCESS_ID: 'private-parent', AGENT_DIALOGUE_STATE_DIR: '/private/state',
    AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: '/private/service.json', AGENT_DIALOGUE_SPACE: 'private', CODEX_HOME: '/private/codex',
    CODEX_THREAD_ID: 'private-thread', CODEX_SESSION_ID: 'private-session', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'private-origin',
    CLAUDE_SESSION_ID: 'private-session', SSH_AUTH_SOCK: '/test/ssh-agent.sock' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key]; Object.assign(process.env, original); });
  await fetchSshObservation(spec, { requestId: nonce, runner: async (_, args, { env, input }) => {
    for (const key of Object.keys(env)) assert.equal(/^(?:HCOM_|AGENT_DIALOGUE_|CODEX_|CLAUDE_)/.test(key), false, key);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.SSH_AUTH_SOCK, '/test/ssh-agent.sock');
    assert.equal(JSON.stringify(args).includes('private-parent'), false);
    assert.equal(input.includes('/private'), false);
    return reply(source, spec);
  } });
});

test('each default SSH request receives a fresh nonce and rejects an invalid supplied nonce before execution', async () => {
  const { spec, source } = fixture();
  const seen = [];
  const runner = async (_, __, { input }) => {
    const request = JSON.parse(input); seen.push(request.requestId);
    return { code: 0, stdout: JSON.stringify(exportObservation(source, request)) };
  };
  await fetchSshObservation(spec, { runner }); await fetchSshObservation(spec, { runner });
  assert.match(seen[0], /^[0-9a-f]{32}$/); assert.match(seen[1], /^[0-9a-f]{32}$/);
  assert.notEqual(seen[0], seen[1]);
  for (const requestId of ['', 'short', 'g'.repeat(32), nonce + '\n']) await assert.rejects(fetchSshObservation(spec, { runner, requestId }));
  assert.equal(seen.length, 2);
});

test('SSH errors never expose subprocess output, credentials, paths or exception text', async () => {
  const { spec } = fixture();
  const secret = 'PRIVATE_AUTH_TOKEN /private/secret-state message body';
  for (const runner of [async () => { throw new Error(secret); }, async () => ({ code: 255, stdout: secret, stderr: secret }),
    async () => ({ code: 0, stdout: secret, stderr: secret })]) {
    await assert.rejects(fetchSshObservation(spec, { runner, requestId: nonce }), noLeak(secret));
  }
});

test('SSH rejects oversized, malformed, extra-output, nonce, node and room-mismatched responses', async () => {
  const { spec, source } = fixture();
  const valid = responseFor(source, spec);
  const changedNonce = structuredClone(valid); changedNonce.requestId = 'f'.repeat(32);
  const changedNode = structuredClone(valid); changedNode.source.node.nodeId = 'n_' + 'f'.repeat(64);
  const changedRevision = structuredClone(valid); changedRevision.source.store.rooms[fixtureIDs.room].revision++;
  const changedManifest = structuredClone(valid); changedManifest.source.store.rooms[fixtureIDs.room].manifestHash = 'f'.repeat(64);
  const wrongType = structuredClone(valid); wrongType.type = 'node-receipt';
  const outputs = ['x'.repeat(16 * 1024 * 1024 + 1), '', 'null', '[]', '{}', `diagnostic prefix\n${JSON.stringify(valid)}`,
    JSON.stringify(valid) + '\n{}', ...[changedNonce, changedNode, changedRevision, changedManifest, wrongType].map(JSON.stringify)];
  for (const stdout of outputs) await assert.rejects(fetchSshObservation(spec, { requestId: nonce, runner: async () => ({ code: 0, stdout }) }), /SSH|observation/i);
});

test('SSH rejects invalid UTF-8 bytes instead of silently substituting a node display name', async () => {
  const { spec, source } = fixture();
  const stdout = Buffer.from(JSON.stringify(responseFor(source, spec)));
  const nameOffset = stdout.indexOf(source.node.name);
  assert.ok(nameOffset >= 0);
  stdout[nameOffset] = 0xff;
  await assert.rejects(fetchSshObservation(spec, { requestId: nonce, runner: async () => ({ code: 0, stdout }) }), /UTF-8/);
});

test('the actual SSH runner enforces its deadline and suppresses private child diagnostics', { timeout: 20_000 }, async t => {
  const { spec } = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'agent-dialogue-view-ssh-timeout-'));
  const originalPath = process.env.PATH;
  t.after(async () => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }); });
  const fakeSsh = join(directory, 'ssh');
  await writeFile(fakeSsh, `#!${process.execPath}\nprocess.stderr.write('PRIVATE_TIMEOUT_DIAGNOSTIC');setInterval(()=>{},1000);\n`);
  await chmod(fakeSsh, 0o700);
  process.env.PATH = `${directory}:${originalPath || ''}`;
  const start = Date.now();
  await assert.rejects(fetchSshObservation(spec, { requestId: nonce }), noLeak('PRIVATE_TIMEOUT_DIAGNOSTIC'));
  assert.ok(Date.now() - start < 16_000, 'A hung SSH child must be terminated near the 12-second deadline.');
});

test('remote reads return immediately, coalesce inflight work, and throttle independently for each source', async () => {
  const { spec, source } = fixture();
  let now = 1000;
  const jobs = [], calls = [];
  const reader = createSourceReader({ clock: () => now, remoteReader: async selected => {
    calls.push(selected.id); const job = deferred(); jobs.push(job); return job.promise;
  } });
  const first = await reader(spec);
  assert.equal(first.available, false);
  await reader(spec); await reader(spec);
  assert.deepEqual(calls, [spec.id], 'Pending SSH requests must not pile up on every viewer tick.');
  const other = { ...spec, id: 'remote-workstation', label: 'Workstation' };
  await reader(other);
  assert.deepEqual(calls, [spec.id, other.id]);
  jobs[0].resolve({ ...source, id: spec.id, label: spec.label });
  jobs[1].resolve({ ...source, id: other.id, label: other.label });
  await turn();
  assert.equal((await reader(spec)).available, true);
  now = 3999; await reader(spec); assert.equal(calls.length, 2);
  now = 4000; await reader(spec); assert.equal(calls.length, 3);
  jobs[2].resolve({ ...source, id: spec.id, label: spec.label }); await turn();
  await reader.close();
});

test('a hanging SSH source does not hold local observations or the model refresh loop', async () => {
  const { spec, source } = fixture();
  const pending = deferred(); let localCalls = 0;
  const localSpec = { id: 'local-node', label: 'Local', path: '/explicit/source' };
  const reader = createSourceReader({ localReader: async selected => { localCalls++; return { ...source, id: selected.id, label: selected.label }; }, remoteReader: () => pending.promise });
  const model = new ViewerModel([spec, localSpec], { reader });
  const result = await Promise.race([model.refresh().then(() => 'refreshed'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  assert.equal(result, 'refreshed');
  assert.equal(localCalls, 1);
  assert.equal(model.snapshot().sources.find(s => s.id === localSpec.id).available, true);
  pending.resolve({ ...source, id: spec.id, label: spec.label }); await turn();
  await model.close(); await reader.close();
});

test('remote failures preserve the last successful observation clock, recover fully, and suppress error details', async () => {
  const { spec, source } = fixture();
  let now = 0, fail = false;
  const reader = createSourceReader({ clock: () => now, intervalMs: 3000, remoteReader: async () => {
    if (fail) throw new Error('PRIVATE_REMOTE_ERROR /private/source');
    return structuredClone({ ...source, id: spec.id, label: spec.label });
  } });
  await reader(spec); await turn();
  const good = await reader(spec); assert.equal(good.available, true);
  now = 3000; fail = true; await reader(spec); await turn();
  const unavailable = await reader(spec);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.observedAt, good.observedAt);
  assert.equal(JSON.stringify(unavailable).includes('PRIVATE_REMOTE_ERROR'), false);
  now = 6000; fail = false; source.observedAt = '2026-10-18T00:01:00.000Z';
  await reader(spec); await turn();
  const recovered = await reader(spec);
  assert.equal(recovered.available, true);
  assert.equal(recovered.observedAt, source.observedAt);
  assert.equal(recovered.events.length, source.events.length);
  await reader.close();
});

test('a synchronous remote reader failure clears its pending request and permits the next scheduled retry', async () => {
  const { spec, source } = fixture();
  let now = 0, calls = 0;
  const reader = createSourceReader({ clock: () => now, remoteReader: () => {
    calls++;
    if (calls === 1) throw new Error('PRIVATE_SYNCHRONOUS_READER_ERROR');
    return Promise.resolve({ ...source, id: spec.id, label: spec.label });
  } });
  try {
    await reader(spec); await turn();
    const failed = await reader(spec);
    assert.equal(failed.available, false);
    assert.equal(JSON.stringify(failed).includes('PRIVATE_SYNCHRONOUS_READER_ERROR'), false);
    now = 3000;
    await reader(spec); await turn();
    const recovered = await reader(spec);
    assert.equal(calls, 2);
    assert.equal(recovered.available, true);
  } finally { await reader.close(); }
});

test('late remote receipts update evidence without creating duplicate logical messages or changing the source generation', async () => {
  const { spec, source } = fixture();
  let now = 0;
  const remote = responseFor(source, spec).source;
  const reader = createSourceReader({ clock: () => now, remoteReader: async () => structuredClone({ ...remote, id: spec.id, label: spec.label }) });
  const model = new ViewerModel([spec], { reader });
  await model.refresh(); await turn(); await model.refresh();
  const count = model.projection.messages.length, generation = model.sources[0].generation, revision = model.revision;
  assert.ok(count > 0);
  remote.store.inbox[fixtureIDs.reply].status = 'native-admitted';
  remote.store.inbox[fixtureIDs.reply].inputId = 'synthetic-late-admission';
  remote.workers.push({ bindingId: fixtureIDs.alice, status: 'ready', receipts: { 44: { status: 'admitted', inputId: 'synthetic-late-admission', at: '2026-10-18T00:00:20.000Z' } } });
  now = 3000; await model.refresh(); await turn(); await model.refresh();
  assert.equal(model.projection.messages.length, count);
  assert.equal(model.sources[0].generation, generation);
  assert.notEqual(model.revision, revision);
  assert.equal(model.epoch, 0);
  const replyMessage = model.projection.messages.find(message => message.globalMessageId === fixtureIDs.reply || message.evidence.some(e => e.localEventId === 44));
  assert.ok(replyMessage.statuses.includes('native-admitted'));
  await model.close(); await reader.close();
});

test('remote replacement, dropped events and reused event IDs force fresh client generations while normal appends do not', async () => {
  const { spec, source } = fixture();
  let now = 0;
  const remote = responseFor(source, spec).source;
  const reader = createSourceReader({ clock: () => now, remoteReader: async () => structuredClone({ ...remote, id: spec.id, label: spec.label }) });
  async function readNext() { now += 3000; await reader(spec); await turn(); return reader(spec); }
  await reader(spec); await turn();
  const initial = await reader(spec);
  const appended = structuredClone(remote.events.at(-1)); appended.id += 10;
  remote.events.push(appended);
  const afterAppend = await readNext();
  assert.equal(afterAppend.generation, initial.generation);
  remote.events[1].data.text += 'synthetic-rewrite';
  const afterRewrite = await readNext();
  assert.notEqual(afterRewrite.generation, afterAppend.generation, 'A reused local ID cannot keep an old browser history anchor.');
  remote.events.splice(1, 1);
  const afterDrop = await readNext();
  assert.notEqual(afterDrop.generation, afterRewrite.generation);
  remote.generation = '2'.repeat(32);
  const afterReplacement = await readNext();
  assert.notEqual(afterReplacement.generation, afterDrop.generation);
  await reader.close();
});

test('closing an observation reader aborts in-flight SSH and never schedules another remote process', async () => {
  const { spec } = fixture();
  let calls = 0, signal;
  const reader = createSourceReader({ remoteReader: async (_, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  await reader(spec);
  assert.equal(calls, 1);
  assert.ok(signal instanceof AbortSignal);
  await reader.close();
  assert.equal(signal.aborted, true);
  try { await reader(spec); } catch { /* A closed reader may explicitly reject further reads. */ }
  assert.equal(calls, 1);
});
