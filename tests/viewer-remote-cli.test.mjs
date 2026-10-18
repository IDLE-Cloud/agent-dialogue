import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { viewerOptions } from '../lib/viewer/cli.mjs';
import { ViewerModel } from '../lib/viewer/stream.mjs';
import { makeSources, fixtureIDs } from './fixtures/viewer-fixture.mjs';

const cli = resolve('bin/agent-dialogue.mjs');
async function directory(t) { const dir = await mkdtemp(join(tmpdir(), 'agent-dialogue-observer-cli-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function call(args, input = '', extra = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...extra }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function request(source) {
  const room = source.store.rooms[fixtureIDs.room];
  return { version: 1, type: 'viewer-observe', requestId: '1'.repeat(32), expectedNodeId: source.node.nodeId, rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] };
}
async function persist(dir, source) {
  const db = new DatabaseSync(join(dir, 'hcom.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp TEXT,type TEXT,instance TEXT,data TEXT)');
  for (const event of source.events) db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(event.id, event.timestamp, event.type, 'synthetic', JSON.stringify(event.data));
  await mkdir(join(dir, 'dialogue'));
  await writeFile(join(dir, 'dialogue', 'node.json'), JSON.stringify({ ...source.node, privateKey: 'CLI_PRIVATE_SENTINEL' }));
  await writeFile(join(dir, 'dialogue', 'store.json'), JSON.stringify(source.store));
  for (const worker of source.workers) await writeFile(join(dir, 'dialogue', `${worker.bindingId}.worker.json`), JSON.stringify({ ...worker, token: 'CLI_WORKER_SENTINEL' }));
  return db;
}
async function hashes(dir) {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(await hashes(path))) result[`${entry.name}/${name}`] = hash;
    else result[entry.name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
test('remote export CLI reads stdin scope and existing WAL without creating identity, invoking hcom or changing files', async t => {
  const dir = await directory(t), source = makeSources({ sealedManifest: true })[0], db = await persist(dir, source);
  t.after(() => db.close());
  const before = await hashes(dir);
  const result = await call(['view-export', '--state-dir', dir], JSON.stringify(request(source)), { AGENT_DIALOGUE_HCOM: '/does-not-exist-hcom', AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: '/does-not-read-native-service' });
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.type, 'viewer-observation'); assert.equal(envelope.source.node.nodeId, source.node.nodeId);
  assert.equal(envelope.source.events.length, 3);
  assert.ok(!result.stdout.includes('CLI_PRIVATE_SENTINEL')); assert.ok(!result.stdout.includes('CLI_WORKER_SENTINEL')); assert.ok(!result.stdout.includes(dir));
  assert.deepEqual(await hashes(dir), before);
});
test('remote export rejects missing state, bad request, wildcard and oversized stdin without initializing the source', async t => {
  const dir = await directory(t), missing = join(dir, 'missing');
  const source = makeSources({ sealedManifest: true })[0], valid = request(source);
  for (const input of ['bad-json', JSON.stringify({ ...valid, rooms: [] }), JSON.stringify({ ...valid, rooms: [{ id: '*', revision: 1, manifestHash: 'a'.repeat(64) }] }), JSON.stringify(valid), 'x'.repeat(17000)]) {
    const result = await call(['view-export', '--state-dir', missing], input);
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes(missing));
  }
  assert.deepEqual(await readdir(dir), []);
  const bad = await call(['view-export', '--state-dir', 'relative'], JSON.stringify(valid));
  assert.notEqual(bad.code, 0);
});
test('viewer config supports explicit local and pinned SSH sources, with stable opaque IDs and no implicit default', async t => {
  const dir = await directory(t), config = join(dir, 'viewer.json'), source = makeSources({ sealedManifest: true })[0];
  const remote = { kind: 'ssh', label: 'Workstation', destination: 'research-box', executable: '/usr/bin/node', cli: '/srv/agent-dialogue/bin/agent-dialogue.mjs', stateDir: '/srv/communication', expectedNodeId: source.node.nodeId, rooms: request(source).rooms };
  await writeFile(config, JSON.stringify({ version: 1, sources: [{ kind: 'local', label: 'Laptop', path: './local-state' }, remote] }));
  const first = await viewerOptions(['--config', config], '/unselected/default');
  const second = await viewerOptions(['--config', config], '/different/default');
  assert.equal(first.sources.length, 2); assert.equal(first.sources[0].path, join(dir, 'local-state'));
  assert.equal(first.sources[1].kind, 'ssh'); assert.deepEqual(first.sources.map(s => s.id), second.sources.map(s => s.id));
  assert.ok(first.sources.every(s => !s.id.includes('/')));
  const mixed = await viewerOptions(['--config', config, '--source', `Third=${join(dir, 'third')}`], '/unselected/default');
  assert.equal(mixed.sources.length, 3);
});
test('viewer config refuses arbitrary commands, unpinned rooms, duplicate endpoints and malformed/oversized files', async t => {
  const dir = await directory(t), config = join(dir, 'viewer.json'), source = makeSources({ sealedManifest: true })[0];
  const remote = { kind: 'ssh', label: 'Workstation', destination: 'research-box', executable: '/usr/bin/node', cli: '/srv/cli.mjs', stateDir: '/srv/state', expectedNodeId: source.node.nodeId, rooms: request(source).rooms };
  const badConfigs = [{ version: 2, sources: [remote] }, { version: 1, sources: [] }, { version: 1, sources: [{ ...remote, command: 'arbitrary-command' }] }, { version: 1, sources: [{ ...remote, rooms: [] }] }, { version: 1, sources: [remote, { ...remote, label: 'Same endpoint' }] }, { version: 1, sources: [{ kind: 'local', label: 'A', path: './same' }, { kind: 'local', label: 'B', path: './same' }] }];
  for (const configValue of badConfigs) { await writeFile(config, JSON.stringify(configValue)); await assert.rejects(viewerOptions(['--config', config], '/default')); }
  await writeFile(config, '{bad-json'); await assert.rejects(viewerOptions(['--config', config], '/default'));
  await writeFile(config, 'x'.repeat(70000)); await assert.rejects(viewerOptions(['--config', config], '/default'));
});
test('closing the viewer closes its observation reader so background collectors cannot keep the CLI alive', async () => {
  let closed = 0;
  const reader = async () => ({ id: 'synthetic', label: 'Synthetic', available: false, observedAt: null, events: [], store: {}, workers: [], diagnostics: [] });
  reader.close = async () => { closed++; };
  const model = new ViewerModel([{ id: 'synthetic', label: 'Synthetic', path: '/synthetic' }], { reader });
  await model.refresh(); await model.close();
  assert.equal(closed, 1);
});
