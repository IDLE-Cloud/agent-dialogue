import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createViewer } from '../lib/viewer/server.mjs';
import { encodeFrame } from '../lib/bridge-store.mjs';
import { makeSources, makeLargeSources, fixtureIDs } from '../tests/fixtures/viewer-fixture.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = process.argv[2] || `viewer-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-v1`;
if (!/^viewer-[0-9]{8}-v[1-9][0-9]*$/.test(run)) throw new Error('Use a fresh viewer-YYYYMMDD-vN run ID.');
const output = join(project, 'verification', run), privateRoot = join(project, '.state', run);
for (const directory of [output, privateRoot]) {
  try { await stat(directory); throw new Error(`Run already exists. Choose a new version: ${run}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(output, { recursive: true }); await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const results = [], durations = {}, writers = [];
let viewer;
async function record(name, fn) {
  const start = performance.now();
  try { const detail = await fn(); results.push({ name, passed: true, durationMs: +(performance.now() - start).toFixed(2), ...(detail ? { detail } : {}) }); }
  catch (error) { results.push({ name, passed: false, durationMs: +(performance.now() - start).toFixed(2), error: error.message.replaceAll(project, '<project>').replaceAll(privateRoot, '<private-fixture>') }); throw error; }
}
async function hashes(path) {
  const result = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) for (const [key, hash] of Object.entries(await hashes(join(path, entry.name)))) result[`${entry.name}/${key}`] = hash;
    else result[entry.name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
  }
  return result;
}
async function controls(path, source) {
  const directory = join(path, 'dialogue'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'node.json'), JSON.stringify({ ...source.node, version: 1, privateKey: 'VIEWER_PRIVATE_KEY_SENTINEL' }), { mode: 0o600 });
  const store = structuredClone(source.store);
  for (const binding of Object.values(store.bindings)) { binding.serviceId = 'VIEWER_SERVICE_SECRET_SENTINEL'; binding.origin = 'https://user:VIEWER_PASSWORD_SENTINEL@native.invalid'; }
  for (const peer of Object.values(store.peers || {})) peer.transport = { privateKey: 'VIEWER_SSH_SECRET_SENTINEL' };
  await writeFile(join(directory, 'store.json'), JSON.stringify(store), { mode: 0o600 });
  for (const worker of source.workers) await workerFile(path, worker);
}
async function workerFile(path, worker) {
  await writeFile(join(path, 'dialogue', `${worker.bindingId}.worker.json`), JSON.stringify({ ...worker, token: 'VIEWER_WORKER_TOKEN_SENTINEL' }), { mode: 0o600 });
}
function append(db, event) {
  db.prepare('INSERT INTO events(id,timestamp,type,instance,data) VALUES(?,?,?,?,?)').run(event.id, event.timestamp, event.type, event.data.from || 'synthetic', JSON.stringify(event.data));
}
async function persist(source, name, wal = false) {
  const path = join(privateRoot, name); await mkdir(path, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(path, 'hcom.db'));
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, type TEXT NOT NULL, instance TEXT NOT NULL, data TEXT NOT NULL); BEGIN;');
  for (const event of source.events) append(db, event);
  db.exec('COMMIT'); await controls(path, source);
  if (wal) writers.push(db); else db.close();
  return { spec: { id: source.id, label: source.label, path }, db: wal ? db : null };
}
async function until(fn, timeout = 5000) {
  const deadline = performance.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(25); } while (performance.now() < deadline);
  throw new Error('Timed out waiting for an observation update.');
}
async function streamChunk(get, lastId) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await get('/api/events', { signal: controller.signal, headers: { 'Last-Event-ID': lastId } });
    assert.equal(response.status, 200);
    return new TextDecoder().decode((await response.body.getReader().read()).value);
  } finally { clearTimeout(timer); controller.abort(); }
}
const base = makeSources(), large = makeLargeSources(10000);
// Retain signed cross-node question/reply copies and the queue/result association beside 10k local messages.
for (let i = 0; i < 2; i++) {
  const example = structuredClone(base[i]);
  example.events = example.events.filter(event => event.id < 50);
  for (const event of example.events) { event.id += 10000; large[i].events.push(event); }
  for (const worker of example.workers) {
    worker.cursor += 10000;
    worker.receipts = Object.fromEntries(Object.entries(worker.receipts).map(([id, receipt]) => {
      if (receipt.result?.event_id) receipt.result.event_id += 10000;
      if (receipt.result?.remoteEventId) receipt.result.remoteEventId += 10000;
      return [Number(id) + 10000, receipt];
    }));
  }
  for (const map of [example.store.inbox, example.store.outbox]) for (const row of Object.values(map)) {
    if (row.eventId) row.eventId += 10000; if (row.remoteEventId) row.remoteEventId += 10000;
  }
  large[i].workers = example.workers; large[i].store.inbox = example.store.inbox; large[i].store.outbox = example.store.outbox;
}
const fixture = await Promise.all(large.map((source, i) => persist(source, `performance-${i ? 'beta' : 'alpha'}`, true)));
const demos = await Promise.all(base.map((source, i) => persist(source, `demo-${i ? 'beta' : 'alpha'}`)));
const config = { version: 1, scenario: 'synthetic-local-read-only-viewer', realModelTraffic: false, sources: 2, performanceLogicalMessages: 10002, performanceLocalMessages: 10000, signedWireLogicalMessages: 2, signedWireLedgerCopies: 4, queueEvents: 1, pollMs: 750, historyPageLimit: 100, startupTargetMs: 3000, updateTargetMs: 2000, sourceStorage: 'SQLite WAL with live owned fixture writers', node: process.version, platform: process.platform, arch: process.arch, baseCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim() };
await writeFile(join(output, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
const probe = { provenance: 'Previously executed controlled development probes, 2026-10-18; this verifier records their findings. The source-hash/WAL assertions in metrics.json are freshly executed by this run.', hcomVersion: '0.7.30', platform: 'darwin-arm64', command: 'hcom events --full --type message --last 1', controlledTempSourcesOnly: true, observed: [{ source: 'empty', exitCode: 0, created: ['hcom.db', '.tmp/flags/update_check.attempt', '.tmp/logs/hcom.log'] }, { source: 'copied-existing', exitCode: 0, changedMainDatabaseHash: true, created: ['.tmp/flags/update_check.attempt', '.tmp/logs/hcom.log'] }, { source: 'active-WAL-copy', exitCode: 0, returnedLatestCommittedWalMessage: true, changedMainDatabaseHash: true, removed: ['hcom.db-wal', 'hcom.db-shm'] }], directReadOnlySqliteProbe: { dbHashUnchanged: true, walHashUnchanged: true, shmHashUnchanged: false }, chosenReader: 'stable byte copies of DB/WAL into disposable private temp directory; read-only SQLite only on copied ledger; source opened O_RDONLY and never SQLite-opened', activeRollbackJournalPolicy: 'source temporarily unavailable until a stable snapshot can be copied', modelCalls: 0 };
await writeFile(join(output, 'reader-probe.json'), `${JSON.stringify(probe, null, 2)}\n`);
let failure;
try {
  const before = await Promise.all(fixture.map(item => hashes(item.spec.path)));
  let get, firstPage;
  await record('actual_reader_startup_first_page_with_10002_logical_messages', async () => {
    const start = performance.now();
    viewer = await createViewer({ sources: fixture.map(item => item.spec), pollMs: config.pollMs, ringSize: 3 });
    const bootstrap = await fetch(viewer.url, { redirect: 'manual' }); assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    get = (path, init = {}) => fetch(`${viewer.origin}${path}`, { ...init, headers: { cookie, ...init.headers } });
    const snapshot = await (await get('/api/snapshot')).json();
    assert.equal(viewer.model.projection.messages.length, 10002);
    const room = snapshot.rooms.find(room => room.messageCount >= 5000); assert.ok(room);
    firstPage = await (await get(`/api/messages?room=${encodeURIComponent(room.id)}`)).json();
    durations.startupFirstPageMs = +(performance.now() - start).toFixed(2);
    assert.equal(firstPage.messages.length, 100); assert.ok(firstPage.hasMore);
    assert.ok(durations.startupFirstPageMs <= config.startupTargetMs, `Startup took ${durations.startupFirstPageMs}ms`);
    return { logicalMessages: viewer.model.projection.messages.length, firstPageMessages: firstPage.messages.length, elapsedMs: durations.startupFirstPageMs };
  });
  const wireRoom = viewer.model.projection.rooms.find(room => room.roomId === fixtureIDs.room);
  assert.ok(wireRoom);
  await record('cross_source_wire_dedup_queue_mapping_reply_and_exact_identity', async () => {
    const page = await (await get(`/api/messages?room=${encodeURIComponent(wireRoom.id)}`)).json();
    assert.equal(page.messages.length, 2);
    assert.equal(page.messages.filter(message => message.kind === 'submission').length, 0);
    assert.ok(page.messages.every(message => message.sourceIds.length === 2));
    assert.ok(page.messages.every(message => message.from.sessionId && message.to.sessionId));
    assert.ok(page.messages.some(message => message.statuses.includes('forwarded')));
    assert.ok(page.messages.some(message => message.statuses.includes('reply-linked')));
    assert.ok(page.messages.some(message => message.replyTo?.id || message.replyTo?.messageId || message.replyTo?.targetId));
    return { logicalMessages: 2, sourceCopies: 4 };
  });
  await record('scoped_json_markdown_export_and_secret_field_exclusion', async () => {
    const json = await (await get(`/api/export?room=${encodeURIComponent(wireRoom.id)}&participant=alice`)).json();
    assert.equal(json.scope.count, 2); assert.equal(json.messages.length, 2);
    const markdown = await (await get(`/api/export?room=${encodeURIComponent(wireRoom.id)}&format=markdown`)).text();
    assert.ok(markdown.includes('<script>window.viewerXss = true</script>'));
    const serial = JSON.stringify(json);
    for (const secret of ['VIEWER_PRIVATE_KEY_SENTINEL', 'VIEWER_SERVICE_SECRET_SENTINEL', 'VIEWER_PASSWORD_SENTINEL', 'VIEWER_SSH_SECRET_SENTINEL', 'VIEWER_WORKER_TOKEN_SENTINEL', privateRoot]) assert.ok(!serial.includes(secret));
    return { exportedLogicalMessages: json.scope.count, scope: 'selected-room-and-participant' };
  });
  await record('full_source_hashes_unchanged_after_observation_and_export', async () => {
    for (let i = 0; i < fixture.length; i++) assert.deepEqual(await hashes(fixture[i].spec.path), before[i]);
    return { sources: 2, includes: ['main-db', 'wal', 'shm', 'control-store', 'worker-receipts', 'worker-cursors', 'node-identity'] };
  });
  await record('receipt_only_update_visible_without_new_ledger_event', async () => {
    const worker = large[0].workers[0];
    worker.receipts[10044] = { status: 'admitted', inputId: 'synthetic-late-reply-input', sessionId: 'synthetic-session-alice', at: '2026-10-18T00:00:20Z' };
    const eventCount = viewer.model.sources.reduce((sum, source) => sum + source.events.length, 0), start = performance.now();
    await workerFile(fixture[0].spec.path, worker);
    const expected = await hashes(fixture[0].spec.path);
    await until(() => viewer.model.projection.messages.find(message => message.evidence.some(item => item.inputId === 'synthetic-late-reply-input')));
    durations.receiptLatencyMs = +(performance.now() - start).toFixed(2);
    assert.ok(durations.receiptLatencyMs <= config.updateTargetMs, `Receipt took ${durations.receiptLatencyMs}ms`);
    assert.equal(viewer.model.sources.reduce((sum, source) => sum + source.events.length, 0), eventCount);
    assert.deepEqual(await hashes(fixture[0].spec.path), expected);
    return { elapsedMs: durations.receiptLatencyMs, newLedgerEvents: 0 };
  });
  const reconnectFrom = viewer.model.revision;
  await record('new_committed_wal_message_visible_without_duplicate_history', async () => {
    const event = { id: 20000, type: 'message', timestamp: '2026-10-18T00:00:21Z', data: { thread: fixtureIDs.legacyRoom, text: encodeFrame({ version: 1, room: fixtureIDs.legacyRoom, from: 'carol', to: 'dave', fromBindingId: fixtureIDs.carol, toBindingId: fixtureIDs.dave, fromRevision: 1, toRevision: 1, text: 'Synthetic live replay: the viewer did not send this message.', replyTo: null }) } };
    const start = performance.now(); append(fixture[0].db, event);
    const expected = await hashes(fixture[0].spec.path);
    await until(() => viewer.model.projection.messages.length === 10003);
    durations.messageLatencyMs = +(performance.now() - start).toFixed(2);
    assert.ok(durations.messageLatencyMs <= config.updateTargetMs, `Message took ${durations.messageLatencyMs}ms`);
    assert.equal(new Set(viewer.model.projection.messages.map(message => message.id)).size, 10003);
    assert.deepEqual(await hashes(fixture[0].spec.path), expected);
    return { elapsedMs: durations.messageLatencyMs, logicalMessages: 10003 };
  });
  await record('SSE_reconnect_replays_known_revision_and_resets_unknown_server', async () => {
    const replay = await streamChunk(get, reconnectFrom);
    assert.match(replay, /event: change/); assert.ok(!replay.includes('event: reset'));
    const reset = await streamChunk(get, 'previous-server:1');
    assert.match(reset, /event: reset/); assert.match(reset, /history-expired-or-server-restarted/);
    return { replay: 'change', unknownHistory: 'explicit-reset' };
  });
  await record('database_replacement_resets_observer_generation', async () => {
    const oldRevision = viewer.model.revision, oldEpoch = viewer.model.epoch;
    fixture[1].db.close(); writers.splice(writers.indexOf(fixture[1].db), 1); fixture[1].db = null;
    await rename(join(fixture[1].spec.path, 'hcom.db'), join(fixture[1].spec.path, 'retired-ledger.db'));
    const db = new DatabaseSync(join(fixture[1].spec.path, 'hcom.db'));
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, instance TEXT NOT NULL, data TEXT NOT NULL)');
    for (const event of large[1].events) append(db, event); db.close();
    await until(() => viewer.model.epoch > oldEpoch);
    const stream = await streamChunk(get, oldRevision); assert.match(stream, /event: reset/); assert.match(stream, /source-replaced/);
    return { reset: 'source-replaced' };
  });
} catch (error) { failure = error; }
finally {
  await viewer?.close();
  for (const writer of writers) writer.close();
  const files = ['lib/viewer/readers/local.mjs', 'lib/viewer/projection.mjs', 'lib/viewer/stream.mjs', 'lib/viewer/server.mjs', 'scripts/viewer-verify.mjs'];
  const sourceDigest = createHash('sha256'); for (const path of files) sourceDigest.update(path).update(await readFile(join(project, path)));
  const metrics = { version: 1, scenario: config.scenario, recordedAt: new Date().toISOString(), realModelTraffic: false, modelCalls: 0, baseCommit: config.baseCommit, implementationSha256: sourceDigest.digest('hex'), passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, completed: !failure, targets: { startupMs: 3000, updateMs: 2000 }, observed: durations, assertions: results };
  await writeFile(join(output, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify({ output: relative(project, output), privateFixture: relative(project, privateRoot), demoSources: demos.map(item => item.spec), passed: metrics.passed, failed: metrics.failed, completed: metrics.completed, observed: durations }, null, 2));
}
if (failure) { console.error(failure); process.exitCode = 1; }
