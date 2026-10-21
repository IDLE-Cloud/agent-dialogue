import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readSource } from '../lib/viewer/readers/local.mjs';

const BINDING = 'b_00000000-0000-4000-8000-000000000001';
const spec = path => ({ id: 'source-a', label: 'Synthetic A', path });
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'agent-dialogue-reader-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function database(path, { wal = false } = {}) {
  const db = new DatabaseSync(join(path, 'hcom.db'));
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, type TEXT NOT NULL, instance TEXT NOT NULL, data TEXT NOT NULL)');
  return db;
}
function insert(db, data, type = 'message') {
  return db.prepare('INSERT INTO events(timestamp,type,instance,data) VALUES(?,?,?,?)').run('2026-10-18T00:00:00Z', type, 'synthetic-agent', typeof data === 'string' ? data : JSON.stringify(data));
}
async function hashes(path) {
  const result = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await hashes(file))) result[`${entry.name}/${key}`] = value;
    else result[entry.name] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return result;
}
async function controls(path, receipt = {}) {
  await mkdir(join(path, 'dialogue'), { recursive: true });
  await writeFile(join(path, 'dialogue', 'node.json'), JSON.stringify({ version: 1, nodeId: 'n_synthetic', name: 'Synthetic', publicKey: 'public-key', privateKey: 'PRIVATE-KEY-SENTINEL' }));
  await writeFile(join(path, 'dialogue', 'store.json'), JSON.stringify({ version: 1, bindings: { writer: { id: BINDING, alias: 'writer', harness: 'codex-app-server', sessionId: 'synthetic-session', projectId: 'synthetic-project', revision: 1, active: false, directory: '/PRIVATE-DIRECTORY', origin: 'http://user:SERVICE-PASSWORD@localhost', serviceId: 'SERVICE-ID', nodeId: 'n_synthetic' } }, rooms: { room: { id: 'room', name: 'Synthetic', members: [{ alias: 'writer', bindingId: BINDING, revision: 1 }], manifestHash: 'hash', revision: 1 } }, peers: { peer: { nodeId: 'n_peer', name: 'Peer', publicKey: 'peer-public', transport: { privateKey: 'SSH-SECRET' } } }, inbox: { msg: { status: 'stored', eventId: 1, payloadHash: 'hash', secret: 'INBOX-SECRET' } }, outbox: {} }));
  await writeFile(join(path, 'dialogue', `${BINDING}.worker.json`), JSON.stringify({ pid: 123, token: 'WORKER-TOKEN', status: 'error', cursor: 1, error: 'https://user:NATIVE-PASSWORD@native/PRIVATE-PATH', receipts: receipt, pending: { eventId: 1, inputId: 'input-a', status: 'submitting', token: 'PENDING-TOKEN' } }));
}

test('viewer reader reports missing/empty sources without creating a ledger or directory', async t => {
  const path = await fixture(t), missing = join(path, 'not-created');
  const snapshot = await readSource(spec(missing));
  assert.equal(snapshot.available, false); assert.match(snapshot.error, /missing/);
  assert.deepEqual(await readdir(path), []);
  const empty = await readSource(spec(path));
  assert.equal(empty.available, false); assert.deepEqual(await readdir(path), []);
  assert.ok(!JSON.stringify(snapshot).includes(path));
});

test('viewer reader checks actual schema, never evaluates a fake events view', async t => {
  const path = await fixture(t), db = new DatabaseSync(join(path, 'hcom.db'));
  db.exec("CREATE VIEW events AS SELECT 1 AS id, 'x' AS timestamp, 'message' AS type, '{}' AS data"); db.close();
  const before = await hashes(path), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, false); assert.match(snapshot.error, /Unsupported ledger schema/);
  assert.deepEqual(await hashes(path), before);
});

test('viewer reader isolates bad JSON and whitelists control records and event metadata', async t => {
  const path = await fixture(t), db = database(path);
  insert(db, { from: 'writer', text: 'User content remains verbatim <script>not code</script>', thread: 'room', delivered_to: ['reader'], extraSecret: 'EVENT-METADATA-SECRET' });
  insert(db, '{broken'); insert(db, 'null'); insert(db, { text: 'non-message' }, 'life'); db.close();
  await controls(path, { 1: { status: 'rejected', reason: 'NATIVE-PASSWORD', at: '2026-10-18T00:00:00Z', token: 'RECEIPT-TOKEN' } });
  const before = await hashes(path), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, true); assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].id, 1); assert.match(snapshot.events[0].data.text, /<script>/);
  assert.equal(snapshot.store.bindings.writer.active, false);
  assert.equal(snapshot.diagnostics.filter(row => row.code === 'invalid-event-json').length, 2);
  const json = JSON.stringify(snapshot);
  for (const secret of ['PRIVATE-KEY-SENTINEL', 'PRIVATE-DIRECTORY', 'SERVICE-PASSWORD', 'SERVICE-ID', 'SSH-SECRET', 'INBOX-SECRET', 'WORKER-TOKEN', 'NATIVE-PASSWORD', 'PENDING-TOKEN', 'RECEIPT-TOKEN', 'EVENT-METADATA-SECRET', path]) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(await hashes(path), before);
});

test('viewer reader copies active WAL without modifying source DB, WAL, SHM or cursors', async t => {
  const path = await fixture(t), writer = database(path, { wal: true });
  t.after(() => writer.close());
  insert(writer, { from: 'writer', text: 'committed in WAL', thread: 'room' });
  await controls(path);
  let before = await hashes(path), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, true); assert.equal(snapshot.events[0].data.text, 'committed in WAL');
  assert.ok(Object.hasOwn(before, 'hcom.db-wal')); assert.ok(Object.hasOwn(before, 'hcom.db-shm'));
  assert.deepEqual(await hashes(path), before);
  const generation = snapshot.generation;
  insert(writer, { from: 'reader', text: 'later committed WAL message', thread: 'room' });
  before = await hashes(path); snapshot = await readSource(spec(path));
  assert.equal(snapshot.events.length, 2); assert.equal(snapshot.generation, generation);
  assert.deepEqual(await hashes(path), before);
  await controls(path, { 1: { status: 'admitted', inputId: 'late-input', sessionId: 'synthetic-session', at: '2026-10-18T00:00:01Z' } });
  before = await hashes(path); snapshot = await readSource(spec(path));
  assert.equal(snapshot.events.length, 2); assert.equal(snapshot.workers[0].receipts[1].inputId, 'late-input');
  assert.deepEqual(await hashes(path), before);
});

test('viewer reader rejects an active rollback journal and can recover after writer rollback', async t => {
  const path = await fixture(t), writer = database(path);
  t.after(() => writer.close()); insert(writer, { text: 'committed' });
  writer.exec('BEGIN IMMEDIATE'); insert(writer, { text: 'uncommitted' });
  const before = await hashes(path), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, false); assert.match(snapshot.error, /active rollback journal/);
  assert.deepEqual(await hashes(path), before);
  writer.exec('ROLLBACK');
  const recovered = await readSource(spec(path));
  assert.equal(recovered.available, true); assert.equal(recovered.events.length, 1);
});

test('viewer reader signals database replacement and handles keyset chunks beyond 1000 messages', async t => {
  const path = await fixture(t), db = database(path);
  db.exec('BEGIN'); for (let i = 0; i < 10005; i++) insert(db, { text: `synthetic ${i}`, thread: 'room' }); db.exec('COMMIT'); db.close();
  const before = await hashes(path), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, true); assert.equal(snapshot.events.length, 10005);
  assert.equal(snapshot.events.at(-1).id, 10005); assert.deepEqual(await hashes(path), before);
  await rename(join(path, 'hcom.db'), join(path, 'retired.db'));
  const replacement = database(path); insert(replacement, { text: 'replacement' }); replacement.close();
  const next = await readSource(spec(path));
  assert.notEqual(next.generation, snapshot.generation); assert.equal(next.events.length, 1);
});

test('viewer reader keeps ledger available when control JSON is absent or malformed', async t => {
  const path = await fixture(t), db = database(path); insert(db, { text: 'history' }); db.close();
  let snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, true); assert.equal(snapshot.events.length, 1);
  assert.ok(snapshot.diagnostics.some(row => row.code === 'missing-store'));
  await mkdir(join(path, 'dialogue')); await writeFile(join(path, 'dialogue', 'store.json'), '{broken');
  await writeFile(join(path, 'dialogue', `${BINDING}.worker.json`), '{broken');
  snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, true); assert.ok(snapshot.diagnostics.some(row => row.code === 'invalid-store'));
  assert.ok(snapshot.diagnostics.some(row => row.code === 'invalid-worker'));
});


test('viewer reader keeps generation stable when an empty source receives its first message', async t => {
  const path = await fixture(t), db = database(path);
  const before = await readSource(spec(path));
  insert(db, { text: 'first event' });
  const after = await readSource(spec(path));
  db.close();
  assert.equal(before.available, true); assert.equal(after.available, true);
  assert.equal(before.generation, after.generation);
});

test('viewer reader rejects a symlink ledger instead of following it into another source', async t => {
  const path = await fixture(t), target = await fixture(t), db = database(target);
  insert(db, { text: 'not in registered source' }); db.close();
  await symlink(join(target, 'hcom.db'), join(path, 'hcom.db'));
  const before = await hashes(target), snapshot = await readSource(spec(path));
  assert.equal(snapshot.available, false); assert.match(snapshot.error, /regular ledger file/);
  assert.deepEqual(await hashes(target), before);
});
