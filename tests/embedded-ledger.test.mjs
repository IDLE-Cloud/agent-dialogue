import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { initializeEmbedded, runEmbedded } from '../lib/embedded-ledger.mjs';
import { readSource } from '../lib/viewer/readers/local.mjs';
import { createBinding, createRoom, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode, signObject, verifyObject } from '../lib/node-identity.mjs';
import { acceptRoom, exportNode, exportRoom, flushMessage, nodeStatus, pairPeer, receiveEnvelope, sealRoom, sendRemote } from '../lib/nodes.mjs';

const execute = promisify(execFile);
const rows = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-embedded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state') };
  const call = (...args) => runEmbedded(context, args);
  const start = name => call('start', '--name', name);
  const send = (text, extra = []) => call('send', '--json', '--name', 'alice', '@bob', '--thread', 'r_room', '--intent', 'request', ...extra, '--', text);
  return { root, context, call, start, send };
}

test('embedded ledger identifies its limited backend and rejects hook/launch commands before writes', async t => {
  const f = await fixture(t);
  assert.match(await f.call('--version'), /agent-dialogue embedded-ledger\/1/);
  for (const command of ['launch', 'run', 'kill', 'config', 'relay', 'reset', 'update', 'transcript']) {
    await assert.rejects(f.call(command), /unsupported|supports only/i);
  }
  await assert.rejects(lstat(f.context.stateDir), { code: 'ENOENT' });
});

test('explicit setup creates an owned SQLite ledger compatible with the viewer events schema', async t => {
  const f = await fixture(t);
  await initializeEmbedded(f.context);
  const db = new DatabaseSync(join(f.context.stateDir, 'hcom.db'), { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(events)').all();
    assert.deepEqual(columns.map(row => row.name), ['id', 'timestamp', 'type', 'data']);
    assert.equal(columns[0].pk, 1);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.notEqual(db.prepare('PRAGMA application_id').get().application_id, 0);
  } finally { db.close(); }
});

test('endpoint registration is idempotent; stopping retains messages and allows explicit restart', async t => {
  const f = await fixture(t);
  await f.start('alice'); await f.start('alice'); await f.start('bob');
  assert.deepEqual(JSON.parse(await f.call('list', '--json')).map(row => row.name), ['alice', 'bob']);
  await f.send('preserved');
  await f.call('stop', 'alice');
  assert.deepEqual(JSON.parse(await f.call('list', '--json')).map(row => row.name), ['bob']);
  await assert.rejects(f.send('not registered'), /sender.*registered|sender.*active/i);
  await f.start('alice');
  assert.equal(rows(await f.call('events', '--full', '--type', 'message', '--last', '10')).length, 1);
});

test('literal Unicode and shell syntax survive append with exact instance and external sender metadata', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  const text = "中文\n`command` '$HOME' $(command) \\ \"quoted\"";
  assert.equal(JSON.parse(await f.send(text)).event_id, 1);
  assert.equal(JSON.parse(await f.call('send', '--json', '--from', 'dialogue-operator', '@bob', '--thread', 'r_room', '--intent', 'inform', '--', 'external')).event_id, 2);
  const events = rows(await f.call('events', '--full', '--type', 'message', '--last', '10'));
  assert.equal(events[0].data.text, text);
  assert.equal(events[0].data.from, 'alice');
  assert.equal(events[0].data.sender_kind, 'instance');
  assert.deepEqual(events[0].data.delivered_to, ['bob']);
  assert.equal(events[0].data.thread, 'r_room');
  assert.equal(events[0].data.intent, 'request');
  assert.equal(events[1].data.sender_kind, 'external');
  assert.match(events[0].timestamp, /^\d{4}-.*Z$/);
});

test('only registered exact local targets receive a message and malformed send flags cannot append', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  const invalid = [
    ['send', '--json', '--name', 'alice', '@missing', '--', 'text'],
    ['send', '--json', '--name', 'alice', '--from', 'forged', '@bob', '--', 'text'],
    ['send', '--json', '--name', 'alice', '@bob', '@alice', '--', 'text'],
    ['send', '--json', '--name', 'alice', '@bob', '--unknown', 'x', '--', 'text'],
    ['send', '--json', '--name', 'alice', '@bob', '--intent', 'execute', '--', 'text'],
    ['send', '--json', '--name', 'alice', '@bob', '--', ''],
    ['send', '--json', '--name', 'alice', '@bob', '--', 'x'.repeat(120001)],
  ];
  for (const args of invalid) await assert.rejects(runEmbedded(f.context, args));
  assert.deepEqual(rows(await f.call('events', '--full', '--type', 'message', '--last', '10')), []);
});

test('supported fixed queries cover cursor windows, event IDs, wire IDs and exact threads', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  const id = 'm_30000000-0000-4000-8000-000000000001';
  for (const text of ['first', id, 'third', 'fourth']) await f.send(text);
  const query = sql => f.call('events', '--full', '--type', 'message', '--last', '2', '--sql', sql);
  assert.deepEqual(rows(await query("id IN (SELECT id FROM events_v WHERE id > 1 AND type='message' ORDER BY id ASC LIMIT 2)")).map(e => e.id), [2, 3]);
  assert.deepEqual(rows(await query('id = 2')).map(e => e.id), [2]);
  assert.deepEqual(rows(await query(`msg_text LIKE '%${id}%'`)).map(e => e.id), [2]);
  assert.deepEqual(rows(await f.call('events', '--full', '--type', 'message', '--last', '2')).map(e => e.id), [3, 4]);
  assert.deepEqual(rows(await f.call('events', '--full', '--type', 'message', '--last', '2', '--thread', 'other')), []);
});

test('query parser rejects arbitrary SQL, multiple statements, nonmessage types and invalid bounds', async t => {
  const f = await fixture(t); await f.start('bob');
  for (const sql of ['1=1', 'id = 1; DROP TABLE events', "msg_text LIKE '%' OR 1=1--'", 'id = -1', 'id = 9007199254740992', "id IN (SELECT id FROM events_v WHERE id > 0 AND type='message' ORDER BY id ASC LIMIT 1001)"]) {
    await assert.rejects(f.call('events', '--full', '--type', 'message', '--last', '1', '--sql', sql), /query|SQL|cursor|limit|integer/i);
  }
  for (const args of [['events', '--type', 'command'], ['events', '--last', '0'], ['events', '--last', '1001'], ['start', '--name', '../bad'], ['list', '--name', 'bob']]) await assert.rejects(runEmbedded(f.context, args));
});

test('numeric replies reference an existing message and preserve the original local ID', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  await f.send('question');
  await f.send('answer', ['--reply-to', '1']);
  const events = rows(await f.call('events', '--full', '--type', 'message', '--last', '10'));
  assert.equal(String(events[1].data.reply_to), '1');
  await assert.rejects(f.send('unknown', ['--reply-to', '99']), /reply|referenced/i);
  await assert.rejects(f.send('injected', ['--reply-to', '1;DROP']), /reply|integer/i);
});

test('listen is a bounded wait without consuming or committing the bridge ledger cursor', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  await f.send('durable');
  const start = Date.now();
  await f.call('listen', '--name', 'bob', '--json', '--timeout', '0.02');
  assert.ok(Date.now() - start < 500);
  assert.equal(rows(await f.call('events', '--full', '--type', 'message', '--last', '10')).length, 1);
  await assert.rejects(f.call('listen', '--name', 'missing', '--json', '--timeout', '0'), /registered|active/i);
  await assert.rejects(f.call('listen', '--name', 'bob', '--json', '--timeout', '600'), /timeout/i);
});

test('existing foreign hcom database and corrupt owned schema are rejected without mutation', async t => {
  const f = await fixture(t); await mkdir(f.context.stateDir);
  const path = join(f.context.stateDir, 'hcom.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, data TEXT); INSERT INTO events VALUES(1,\'old\',\'message\',\'{}\');');
  db.close();
  const before = await readFile(path);
  await assert.rejects(initializeEmbedded(f.context), /foreign|owned|backend/i);
  assert.deepEqual(await readFile(path), before);
  await rm(path); await initializeEmbedded(f.context);
  const owned = new DatabaseSync(path); owned.exec('DROP TABLE events'); owned.close();
  await assert.rejects(f.start('bob'), /schema/i);
});

test('foreign WAL ledgers are rejected before SQLite can touch live shared-memory read marks', async t => {
  const f = await fixture(t); await mkdir(f.context.stateDir);
  const path = join(f.context.stateDir, 'hcom.db'), foreign = new DatabaseSync(path);
  try {
    foreign.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, data TEXT); INSERT INTO events VALUES(1,'old','message','{}');");
    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(f.context.stateDir)).sort().map(async name => [name, await readFile(join(f.context.stateDir, name))])));
    const before = await snapshot();
    assert.ok(before['hcom.db-wal']); assert.ok(before['hcom.db-shm']);
    await assert.rejects(initializeEmbedded(f.context), /foreign|owned|backend/i);
    assert.deepEqual(await snapshot(), before);
  } finally { foreign.close(); } // Close before fixture cleanup; Windows cannot unlink an open database.
});

test('symlink state directories and ledger files are never followed', async t => {
  const f = await fixture(t), target = join(f.root, 'target'); await mkdir(target);
  try { await symlink(target, f.context.stateDir, 'junction'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows account lacks symlink permission'); throw error; }
  await assert.rejects(initializeEmbedded(f.context), /symlink|directory/i);
  await rm(f.context.stateDir); await mkdir(f.context.stateDir);
  const file = join(target, 'foreign'); await writeFile(file, 'untouched');
  try { await symlink(file, join(f.context.stateDir, 'hcom.db'), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows account lacks symlink permission'); throw error; }
  await assert.rejects(initializeEmbedded(f.context), /symlink|regular/i);
  assert.equal(await readFile(file, 'utf8'), 'untouched');
});

test('independent processes append monotonically without overwriting concurrent events', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob');
  const moduleURL = new URL('../lib/embedded-ledger.mjs', import.meta.url).href;
  const script = `import { runEmbedded } from ${JSON.stringify(moduleURL)}; console.log(await runEmbedded({stateDir:process.argv[1]},['send','--json','--name','alice','@bob','--thread','r_room','--intent','inform','--',process.argv[2]]));`;
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => execute(process.execPath, ['--input-type=module', '-e', script, f.context.stateDir, `message-${i}`], { timeout: 15000 })));
  const ids = responses.map(r => JSON.parse(r.stdout).event_id).sort((a,b) => a-b);
  assert.deepEqual(ids, [1,2,3,4,5,6,7,8]);
  const events = rows(await f.call('events', '--full', '--type', 'message', '--last', '10'));
  assert.equal(new Set(events.map(e => e.data.text)).size, 8);
});

test('the existing viewer reads an embedded ledger without modifying the source database', async t => {
  const f = await fixture(t); await f.start('alice'); await f.start('bob'); await f.send('viewer evidence');
  await loadOrCreateNode(f.context, { name: 'Embedded test' });
  await withStore(f.context, () => {});
  const path = join(f.context.stateDir, 'hcom.db'), before = await readFile(path);
  const source = await readSource({ id: 'embedded-source', label: 'Embedded', path: f.context.stateDir });
  assert.equal(source.available, true);
  assert.equal(source.events.length, 1);
  assert.equal(source.events[0].data.text, 'viewer evidence');
  assert.equal(source.node.name, 'Embedded test');
  assert.deepEqual(await readFile(path), before);
});

test('strict signed-node ingress retains replay and receipt-loss protection with the embedded backend', async t => {
  const f = await fixture(t);
  const context = stateDir => ({ stateDir, ledgerBackend: 'embedded', binary: '/missing/not-hcom', env: { ...process.env, AGENT_DIALOGUE_LEDGER: 'embedded' } });
  const a = context(f.context.stateDir), b = context(join(f.root, 'beta'));
  await initializeEmbedded(a); await initializeEmbedded(b);
  const input = alias => ({ alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: `project-${alias}`, directory: '/synthetic/project', serviceId: `service-${alias}`, origin: 'http://127.0.0.1:9876' });
  await withStore(a, store => createBinding(store, input('alice')));
  const bob = await withStore(b, store => createBinding(store, input('bob')));
  const nodeA = await loadOrCreateNode(a), nodeB = await loadOrCreateNode(b);
  const transport = c => ({ kind: 'local-process', executable: process.execPath, args: [], stateDir: c.stateDir });
  await pairPeer(a, await exportNode(b), transport(b));
  await pairPeer(b, await exportNode(a), transport(a));
  const room = await withStore(a, store => createRoom(store, { name: 'Embedded strict room', members: ['alice', 'bob'] }));
  await sealRoom(a, room); await acceptRoom(b, await exportRoom(a, room.id));
  await runEmbedded(b, ['start', '--name', bob.hcomName]);
  let messageId, original;
  await assert.rejects(sendRemote(a, { room: room.id, from: 'operator', to: 'bob', text: 'signed literal message', expectedSession: bob.sessionId }, {
    exchangeImpl: async (_, envelope) => { original = envelope; await receiveEnvelope(b, envelope); throw new Error('Controlled lost receipt'); },
  }), error => { messageId = error.messageId; return error.uncertain === true && Boolean(messageId); });
  const retry = await flushMessage(a, messageId, { exchangeImpl: async (_, envelope) => receiveEnvelope(b, envelope) });
  assert.equal(retry.status, 'remote-stored');
  const ledger = c => runEmbedded(c, ['events', '--full', '--type', 'message', '--last', '10']);
  assert.equal(rows(await ledger(a)).length, 1);
  assert.equal(rows(await ledger(b)).length, 1);
  const receipt = verifyObject(await receiveEnvelope(b, original), nodeB.publicKey);
  assert.equal(receipt.eventId, 1);
  await assert.rejects(receiveEnvelope(b, signObject(nodeA, { ...original.payload, text: 'same ID changed body' })), /reused with different/i);
  await assert.rejects(sendRemote(a, { room: room.id, from: 'operator', to: 'bob', text: 'wrong session', expectedSession: 'ses_other' }), /session/i);
  assert.equal(rows(await ledger(a)).length, 1);
  assert.equal(rows(await ledger(b)).length, 1);
  assert.equal((await nodeStatus(b)).inbox[messageId].eventId, 1);
});
