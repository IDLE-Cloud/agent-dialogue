import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSourceReader, fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';
import { createViewer } from '../lib/viewer/server.mjs';
import { makeSources, fixtureIDs } from './fixtures/viewer-fixture.mjs';

const CLI = resolve('bin/agent-dialogue.mjs');
const SECRET = 'SSH_INTEGRATION_PRIVATE_SENTINEL';

async function hashes(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(await hashes(file))) result[`${entry.name}/${name}`] = value;
    else result[entry.name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}

async function persist(directory, source) {
  await mkdir(join(directory, 'dialogue'), { recursive: true });
  const db = new DatabaseSync(join(directory, 'hcom.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp TEXT,type TEXT,instance TEXT,data TEXT)');
  for (const event of source.events) db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.id, event.timestamp, event.type, 'synthetic', JSON.stringify(event.data));
  await writeFile(join(directory, 'dialogue', 'node.json'), JSON.stringify({ ...source.node, privateKey: SECRET }));
  await writeFile(join(directory, 'dialogue', 'store.json'), JSON.stringify(source.store));
  for (const worker of source.workers) await writeWorker(directory, worker);
  return db;
}

async function writeWorker(directory, worker) {
  await writeFile(join(directory, 'dialogue', `${worker.bindingId}.worker.json`), JSON.stringify({ ...worker, token: SECRET, error: `${SECRET}/private/runtime` }));
}

/** A transport substitute only: execute the actual fixed remote export CLI locally. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-dialogue-ssh-integration-'));
  const bin = join(directory, 'bin'), offline = join(directory, 'offline'), requests = join(directory, 'requests.jsonl');
  await mkdir(bin);
  const fake = join(bin, 'ssh');
  await writeFile(fake, `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
let input = '';
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ args: process.argv.slice(2), request: JSON.parse(input) }) + '\\n');
if (existsSync(${JSON.stringify(offline)})) {
  process.stderr.write(${JSON.stringify(`${SECRET} offline /private/ssh/auth`)});
  process.exit(255);
}
const child = spawn('/bin/sh', ['-c', process.argv.at(-1)], { shell: false, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {}); child.stdin.end(input);
child.once('error', () => process.exit(254));
child.once('close', code => process.exit(code ?? 253));
`);
  await chmod(fake, 0o755);
  const original = { PATH: process.env.PATH, AGENT_DIALOGUE_HCOM: process.env.AGENT_DIALOGUE_HCOM, AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.AGENT_DIALOGUE_HCOM = '/does-not-exist-hcom';
  process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = '/does-not-exist-native-service';
  let remoteDb, localDb, viewer, closed = false;
  const close = async () => { if (viewer && !closed) { closed = true; await viewer.close(); } };
  t.after(async () => {
    await close(); remoteDb?.close(); localDb?.close();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  const [remote, local] = makeSources({ sealedManifest: true });
  remote.events.push({ id: 99, type: 'message', timestamp: '2026-10-18T00:00:09.000Z', data: { text: SECRET, thread: fixtureIDs.room } });
  remote.events.find(event => event.id === 50).data.text = remote.events.find(event => event.id === 50).data.text.replace('Can we inspect a detached conversation?', SECRET);
  remote.store.bindings.alice.directory = `${SECRET}/private/project`;
  remote.store.peers[local.node.nodeId].transport = { privateKey: SECRET, destination: 'private-unselected-host' };
  remote.workers[0].receipts[99] = { status: 'admitted', inputId: SECRET, sessionId: SECRET };
  const remoteDir = join(directory, "remote state with apostrophe's"), localDir = join(directory, 'local state');
  remoteDb = await persist(remoteDir, remote); localDb = await persist(localDir, local);
  const room = remote.store.rooms[fixtureIDs.room];
  const specs = [
    { kind: 'ssh', id: 'remote-alpha', label: 'Selected remote laptop', destination: 'synthetic-host', executable: process.execPath, cli: CLI, stateDir: remoteDir, expectedNodeId: remote.node.nodeId, rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] },
    { kind: 'local', id: 'local-beta', label: 'Local workstation', path: localDir },
  ];
  const attempts = [];
  const reader = createSourceReader({ intervalMs: 0, remoteReader: async (spec, options) => {
    const attempt = { startedAt: Date.now(), status: 'pending', elapsedMs: null };
    attempts.push(attempt);
    try {
      const result = await fetchSshObservation(spec, options);
      attempt.status = 'accepted'; return result;
    } catch (error) {
      attempt.status = options.signal.aborted ? 'cancelled' : 'rejected'; throw error;
    } finally { attempt.elapsedMs = Date.now() - attempt.startedAt; }
  } });
  viewer = await createViewer({ sources: specs, reader, pollMs: 60000 });
  const auth = await fetch(viewer.url, { redirect: 'manual' });
  assert.equal(auth.status, 303);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = path => fetch(`${viewer.origin}${path}`, { headers: { Cookie: cookie } });
  return { viewer, remote, remoteDb, remoteDir, localDir, offline, requests, attempts, get, close, diagnostic: value => t.diagnostic(JSON.stringify(value)) };
}

async function until(fixture, predicate, message, { initial = false } = {}) {
  const startedAt = Date.now();
  // The actual transport permits a 12-second request plus bounded termination. This
  // assertion tests eventual synchronization, not a 2.5-second spawn benchmark.
  const deadline = startedAt + 15_000;
  while (Date.now() < deadline) {
    await fixture.viewer.model.refresh();
    // A malformed scope/response or export failure must fail the initial check;
    // extra wall-clock budget must not hide a rejection by silently retrying it.
    if (initial && fixture.attempts.some(attempt => attempt.status === 'rejected')) break;
    if (predicate()) {
      const elapsedMs = Date.now() - startedAt;
      if (initial) fixture.diagnostic({ scenario: 'initial-fake-ssh-observation', elapsedMs, exceededFormer2500msBudget: elapsedMs > 2500,
        acceptedAttemptMs: fixture.attempts.find(attempt => attempt.status === 'accepted')?.elapsedMs ?? null,
        rejectedAttempts: fixture.attempts.filter(attempt => attempt.status === 'rejected').length });
      return;
    }
    await new Promise(done => setTimeout(done, 15));
  }
  const attempts = fixture.attempts.map(({ status, elapsedMs }) => ({ status, elapsedMs }));
  const remote = fixture.viewer.model.sources.find(source => source.id === 'remote-alpha');
  assert.fail(`${message}; ${JSON.stringify({ elapsedMs: Date.now() - startedAt, remoteAvailable: remote?.available ?? false, attempts })}`);
}

test('fake SSH runs the real readonly export CLI and merges only the pinned room with a local source', async t => {
  const f = await fixture(t), remoteBefore = await hashes(f.remoteDir), localBefore = await hashes(f.localDir);
  await until(f, () => f.viewer.model.sources.find(source => source.id === 'remote-alpha')?.available, 'real export CLI did not produce a remote observation', { initial: true });
  const projection = f.viewer.model.projection;
  assert.equal(projection.rooms.length, 1, 'raw hcom and legacy rooms must stay outside remote export');
  assert.equal(projection.messages.length, 2, 'queued request folds into its actual message and two-node copies deduplicate');
  const question = projection.messages.find(message => message.evidence.some(evidence => evidence.messageId === fixtureIDs.question));
  const reply = projection.messages.find(message => message.evidence.some(evidence => evidence.messageId === fixtureIDs.reply));
  assert.ok(question && reply);
  assert.deepEqual(question.sourceIds, ['local-beta', 'remote-alpha']);
  assert.deepEqual(reply.sourceIds, ['local-beta', 'remote-alpha']);
  assert.ok(question.statuses.includes('forwarded')); assert.ok(question.statuses.includes('native-admitted'));
  assert.equal(reply.replyTo.id, question.id); assert.equal(reply.replyTo.missing, false);
  assert.equal(question.from.harness, 'codex-app-server'); assert.equal(question.to.harness, 'opencode-v2');
  assert.equal(question.to.sessionId, 'synthetic-session-bob');
  const snapshot = await (await f.get('/api/snapshot')).json();
  const exported = await (await f.get(`/api/export?room=${projection.rooms[0].id}`)).json();
  const json = JSON.stringify({ snapshot, exported, remote: f.viewer.model.sources.find(source => source.id === 'remote-alpha') });
  for (const secret of [SECRET, f.remoteDir, f.localDir, 'private-unselected-host', 'synthetic-session-carol', 'synthetic-session-dave']) assert.equal(json.includes(secret), false, secret);
  assert.equal((await f.get('/api/snapshot?destination=unregistered-host')).status, 400);
  assert.equal((await f.get('/api/snapshot?stateDir=/unregistered/path')).status, 400);
  assert.deepEqual(await hashes(f.remoteDir), remoteBefore, 'remote DB/WAL/SHM and control files remain unchanged');
  assert.deepEqual(await hashes(f.localDir), localBefore, 'local DB/WAL/SHM and control files remain unchanged');
  assert.ok(Object.hasOwn(remoteBefore, 'hcom.db-wal')); assert.ok(Object.hasOwn(remoteBefore, 'hcom.db-shm'));
  const calls = (await readFile(f.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length >= 1); assert.equal(calls[0].request.type, 'viewer-observe');
  assert.equal(calls[0].request.rooms.length, 1); assert.equal(calls[0].request.rooms[0].id, fixtureIDs.room);
});

test('fake SSH disconnect retains history, reconnect uses fresh requests, late receipts update in place and rewrites reset generation', async t => {
  const f = await fixture(t);
  const remote = () => f.viewer.model.sources.find(source => source.id === 'remote-alpha');
  await until(f, () => remote()?.available, 'initial remote observation did not arrive', { initial: true });
  const count = f.viewer.model.projection.messages.length, previousAt = remote().observedAt;
  await writeFile(f.offline, 'offline');
  await until(f, () => remote() && !remote().available, 'offline source was not marked stale');
  assert.equal(f.viewer.model.projection.messages.length, count);
  assert.ok(Date.parse(remote().observedAt) >= Date.parse(previousAt), 'the last successful in-flight snapshot may finish before the disconnect is observed');
  const staleAt = remote().observedAt;
  await f.viewer.model.refresh();
  assert.equal(remote().observedAt, staleAt, 'failed collection does not refresh the last successful observation time');
  assert.ok(!JSON.stringify(await (await f.get('/api/snapshot')).json()).includes(SECRET), 'stderr is never returned by the API');
  f.remote.workers[0].receipts[44] = { status: 'admitted', inputId: 'late-synthetic-admission', sessionId: 'synthetic-session-alice', at: '2026-10-18T00:00:12.000Z' };
  await writeWorker(f.remoteDir, f.remote.workers[0]);
  await rm(f.offline);
  await until(f, () => remote()?.available && f.viewer.model.projection.messages.some(message => message.evidence.some(evidence => evidence.inputId === 'late-synthetic-admission')), 'recovery or late receipt observation did not arrive');
  assert.equal(f.viewer.model.projection.messages.length, count, 'receipt updates and reconnect do not duplicate messages');
  const calls = (await readFile(f.requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(new Set(calls.map(call => call.request.requestId)).size, calls.length, 'each full request has a fresh nonce');
  const beforeGeneration = remote().generation, beforeEpoch = f.viewer.model.epoch;
  f.remoteDb.prepare('UPDATE events SET timestamp=? WHERE id=42').run('2026-10-18T00:00:01.500Z');
  await until(f, () => remote()?.generation !== beforeGeneration, 'same-inode existing event rewrite did not reset the observation generation');
  assert.ok(f.viewer.model.epoch > beforeEpoch); assert.equal(f.viewer.model.ring.at(-1).type, 'reset');
  assert.equal(f.viewer.model.projection.messages.length, count);
  await f.close();
  const afterClose = (await readFile(f.requests, 'utf8')).trim().split('\n').length;
  await new Promise(done => setTimeout(done, 50));
  assert.equal((await readFile(f.requests, 'utf8')).trim().split('\n').length, afterClose, 'closed observer launches no further SSH processes');
});
