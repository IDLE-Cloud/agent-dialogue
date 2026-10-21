/**
 * Agent-dialogue's deliberately small local ledger, used where pinned hcom is
 * unavailable. This does not implement hcom hooks, launches, relay or identity
 * discovery. Strict bindings, rooms, signatures and admission stay in the bridge.
 */
import { lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const APPLICATION_ID = 0x41444c47; // ADLG. Never adopt a real hcom database.
const VERSION = 1;
const ENDPOINT = /^[a-z][a-z0-9_-]{0,79}$/;
const WIRE_ID = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = message => { throw new Error(`Embedded ledger: ${message}`); };
const json = value => JSON.stringify(value) + '\n';
const jsonRows = values => values.map(json).join('');

function endpoint(value) {
  if (typeof value !== 'string' || !ENDPOINT.test(value)) fail('invalid endpoint name.');
  return value;
}
function integer(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) fail(`${label} must be a bounded safe integer.`);
  return Number(value);
}
function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximum) fail(`invalid ${label}.`);
  return value;
}
function options(args, definitions) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!Object.hasOwn(definitions, flag) || Object.hasOwn(out, flag)) fail(`unsupported or repeated option ${String(flag)}.`);
    if (definitions[flag] === true) out[flag] = true;
    else {
      const value = args[++i];
      if (typeof value !== 'string' || value.startsWith('--')) fail(`${flag} requires a value.`);
      out[flag] = value;
    }
  }
  return out;
}
function parseQuery(sql) {
  if (sql === undefined) return null;
  let match = /^id = (\d+)$/.exec(sql);
  if (match) return { kind: 'id', id: integer(match[1], 'query ID', Number.MAX_SAFE_INTEGER, 1) };
  match = /^id IN \(SELECT id FROM events_v WHERE id > (\d+) AND type='message' ORDER BY id ASC LIMIT (\d+)\)$/.exec(sql);
  if (match) return { kind: 'cursor', after: integer(match[1], 'cursor'), count: integer(match[2], 'query limit', 1000, 1) };
  match = /^msg_text LIKE '%([^']+)%'$/.exec(sql);
  if (match && WIRE_ID.test(match[1])) return { kind: 'wire', id: match[1] };
  fail('unsupported SQL query; only fixed bridge event lookups are accepted.');
}
function parse(args) {
  if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) fail('command arguments must be strings.');
  const [command, ...rest] = args;
  if (command === '--version' && !rest.length) return { command };
  if (command === 'start') {
    const o = options(rest, { '--name': false });
    return { command, name: endpoint(o['--name']) };
  }
  if (command === 'stop' && rest.length === 1) return { command, name: endpoint(rest[0]) };
  if (command === 'list') { options(rest, { '--json': true }); return { command }; }
  if (command === 'send') {
    const separator = rest.indexOf('--');
    if (separator < 0 || separator !== rest.length - 2) fail('send requires exactly one literal body after --.');
    const head = rest.slice(0, separator), targets = head.filter(arg => arg.startsWith('@'));
    if (targets.length !== 1) fail('send requires one exact registered target.');
    const o = options(head.filter(arg => arg !== targets[0]), { '--json': true, '--name': false, '--from': false, '--thread': false, '--intent': false, '--reply-to': false });
    if (!o['--json'] || Boolean(o['--name']) === Boolean(o['--from'])) fail('send requires --json and exactly one --name or --from sender.');
    const intent = o['--intent'] || 'inform';
    if (!['request', 'inform', 'ack'].includes(intent)) fail('invalid intent.');
    return {
      command, name: endpoint(o['--name'] || o['--from']), external: o['--from'] !== undefined,
      target: endpoint(targets[0].slice(1)), body: text(rest[separator + 1], 'message body', 120000),
      thread: o['--thread'] === undefined ? null : text(o['--thread'], 'thread'), intent,
      replyTo: o['--reply-to'] === undefined ? null : integer(o['--reply-to'], 'reply ID', Number.MAX_SAFE_INTEGER, 1),
    };
  }
  if (command === 'events') {
    const o = options(rest, { '--full': true, '--type': false, '--last': false, '--sql': false, '--thread': false });
    if (o['--type'] !== undefined && o['--type'] !== 'message') fail('only message events are supported.');
    return { command, last: integer(o['--last'] ?? '20', 'event limit', 1000, 1), query: parseQuery(o['--sql']), thread: o['--thread'] === undefined ? null : text(o['--thread'], 'thread') };
  }
  if (command === 'listen') {
    const o = options(rest, { '--name': false, '--json': true, '--timeout': false });
    const timeout = o['--timeout'] ?? '1';
    if (!/^(?:\d+)(?:\.\d+)?$/.test(timeout) || !Number.isFinite(Number(timeout)) || Number(timeout) > 5) fail('listen timeout must be between 0 and 5 seconds.');
    return { command, name: endpoint(o['--name']), timeout: Number(timeout) * 1000 };
  }
  fail(`unsupported command ${command}; supports only strict bridge ledger operations.`);
}

async function regular(path, directory = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail(`expected a regular ${directory ? 'directory' : 'ledger file'}, not a symlink.`);
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ownedHeader(path) {
  // Even a SQLite read can update a WAL shared-memory read mark. Inspect the
  // fixed file header before SQLite opens any pre-existing database at all.
  const expected = await regular(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!expected || !info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) fail('ledger file changed during ownership inspection.');
    const header = Buffer.alloc(100), { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 100 || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || header.readUInt32BE(68) !== APPLICATION_ID) fail('foreign database is not owned by this backend; choose a new dedicated state directory.');
  } finally { await handle.close(); }
}
async function database(context, create) {
  if (typeof context?.stateDir !== 'string' || !context.stateDir.trim()) fail('a dedicated state directory is required.');
  const existingDirectory = await regular(context.stateDir, true);
  if (!existingDirectory) {
    if (!create) return null;
    await mkdir(context.stateDir, { recursive: true, mode: 0o700 });
    await regular(context.stateDir, true);
  }
  const path = join(context.stateDir, 'hcom.db');
  const existing = await regular(path);
  for (const suffix of ['-wal', '-shm', '-journal']) await regular(`${path}${suffix}`);
  if (!existing && !create) return null;
  let created = false;
  if (!existing) {
    try { const file = await open(path, 'wx', 0o600); await file.close(); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await regular(path); }
  }
  if (!created) await ownedHeader(path);
  const db = new DatabaseSync(path, { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
    const application = db.prepare('PRAGMA application_id').get().application_id;
    if (application !== APPLICATION_ID) {
      if (!created || application !== 0 || db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n !== 0) fail('foreign database is not owned by this backend; choose a new dedicated state directory.');
      db.exec(`BEGIN EXCLUSIVE;
        CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, type TEXT NOT NULL CHECK(type='message'), data TEXT NOT NULL);
        CREATE TABLE ad_endpoints(name TEXT PRIMARY KEY, registered_at TEXT NOT NULL);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}; COMMIT;`);
    }
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT name,type FROM sqlite_master WHERE name IN ('events','ad_endpoints') ORDER BY name").all();
    const cols = name => db.prepare(`PRAGMA table_info(${name})`).all(); // fixed internal table names only
    if (version !== VERSION || tables.length !== 2 || tables.some(row => row.type !== 'table') || cols('events').map(row => row.name).join(',') !== 'id,timestamp,type,data' || cols('ad_endpoints').map(row => row.name).join(',') !== 'name,registered_at') fail('unsupported or corrupt owned schema.');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    return db;
  } catch (error) { try { db.close(); } catch {} throw error; }
}

/** Explicit setup only. Viewer reads never call this function. */
export async function initializeEmbedded(context) {
  const db = await database(context, true);
  db.close();
  return { backend: 'embedded', version: VERSION, path: join(context.stateDir, 'hcom.db') };
}
function requireEndpoint(db, name, kind) {
  if (!db.prepare('SELECT name FROM ad_endpoints WHERE name=?').get(name)) fail(`${kind} endpoint is not registered: ${name}.`);
}
function readEvents(db, spec) {
  const q = spec.query, where = ["type='message'"], params = [];
  if (spec.thread !== null) { where.push("json_extract(data,'$.thread') = ?"); params.push(spec.thread); }
  if (q?.kind === 'id') { where.push('id = ?'); params.push(q.id); }
  if (q?.kind === 'cursor') { where.push('id > ?'); params.push(q.after); }
  if (q?.kind === 'wire') { where.push("instr(json_extract(data,'$.text'), ?) > 0"); params.push(q.id); }
  const ascending = q?.kind === 'cursor', limit = Math.min(spec.last, ascending ? q.count : 1000);
  const values = db.prepare(`SELECT id,timestamp,type,data FROM events WHERE ${where.join(' AND ')} ORDER BY id ${ascending ? 'ASC' : 'DESC'} LIMIT ?`).all(...params, limit);
  if (!ascending) values.reverse();
  return values.map(row => ({ ...row, data: JSON.parse(row.data) }));
}
export async function runEmbedded(context, args) {
  const spec = parse(args);
  if (spec.command === '--version') return 'agent-dialogue embedded-ledger/1\n';
  const db = await database(context, ['start', 'send', 'stop'].includes(spec.command));
  if (!db) {
    if (spec.command === 'list') return '[]\n';
    if (spec.command === 'events') return '';
    fail('endpoint is not registered.');
  }
  let closed = false;
  try {
    if (spec.command === 'start') {
      db.prepare('INSERT INTO ad_endpoints(name,registered_at) VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(spec.name, new Date().toISOString());
      return json({ name: spec.name, backend: 'embedded' });
    }
    if (spec.command === 'stop') {
      db.prepare('DELETE FROM ad_endpoints WHERE name=?').run(spec.name);
      return json({ name: spec.name, stopped: true });
    }
    if (spec.command === 'list') return json(db.prepare('SELECT name FROM ad_endpoints ORDER BY name').all().map(({ name }) => ({ name, base_name: name, is_remote: false, backend: 'embedded' })));
    if (spec.command === 'events') return jsonRows(readEvents(db, spec));
    if (spec.command === 'send') {
      db.exec('BEGIN IMMEDIATE');
      try {
        requireEndpoint(db, spec.target, 'target');
        if (!spec.external) requireEndpoint(db, spec.name, 'sender');
        if (spec.replyTo !== null && !db.prepare("SELECT id FROM events WHERE id=? AND type='message'").get(spec.replyTo)) fail('referenced reply message does not exist.');
        const data = { from: spec.name, sender_kind: spec.external ? 'external' : 'instance', text: spec.body, thread: spec.thread, intent: spec.intent, delivered_to: [spec.target], mentions: [spec.target], scope: 'direct' };
        if (spec.replyTo !== null) { data.reply_to = String(spec.replyTo); data.reply_to_local = String(spec.replyTo); }
        const result = db.prepare("INSERT INTO events(timestamp,type,data) VALUES(?,'message',?)").run(new Date().toISOString(), JSON.stringify(data));
        const id = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id < 1) fail('event ID exceeds the supported integer range.');
        db.exec('COMMIT');
        return json({ event_id: id, delivered_to: [spec.target], backend: 'embedded' });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (spec.command === 'listen') {
      requireEndpoint(db, spec.name, 'listener');
      // Wake-up aid only. The bridge recovers every event using its own durable
      // cursor, so this wait must never acknowledge or consume unread messages.
      db.close();
      closed = true;
      await delay(spec.timeout);
      return '';
    }
  } finally { if (!closed) db.close(); }
}
