import { createHash } from 'node:crypto';
import { open, lstat, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cache = new Map();
const MAX_JSON = 64 * 1024 * 1024;
const MAX_DB = 512 * 1024 * 1024;
const MAX_CACHED_SOURCES = 32;
const BINDING_FILE = /^(b_[0-9a-f-]{36})\.worker\.json$/;
const emptyStore = () => ({ version: 1, bindings: {}, rooms: {}, peers: {}, inbox: {}, outbox: {} });
const selected = (value, keys) => Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null).map(key => [key, value[key]]));
const mapSelected = (value, keys) => object(value) ? Object.fromEntries(Object.entries(value).filter(([, row]) => object(row)).map(([key, row]) => [key, selected(row, keys)])) : {};
function note(diagnostics, code, message, extra = {}) { diagnostics.push({ code, message, ...extra }); }
function sourceError(code) {
  if (code === 'ENOENT') return 'Source or ledger is missing; no source was initialized.';
  if (code === 'EACCES' || code === 'EPERM') return 'Source cannot be read with the current permissions.';
  if (code === 'BUSY_SNAPSHOT') return 'Ledger is changing or has an active rollback journal; retrying a stable snapshot.';
  if (code === 'UNSUPPORTED_SCHEMA') return 'Unsupported ledger schema; expected the hcom events table.';
  if (code === 'TOO_LARGE') return 'Source file exceeds the local viewer read limit.';
  if (code === 'NOT_REGULAR') return 'Expected a regular ledger file.';
  return 'Ledger could not be read; inspect the selected source locally.';
}
function fault(code) { return Object.assign(new Error(code), { code }); }
function fingerprint(info) { return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : '-'; }
async function regularInfo(path, limit = MAX_DB, optional = false) {
  let info;
  try { info = await lstat(path, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile()) throw fault('NOT_REGULAR');
  if (info.size > BigInt(limit)) throw fault('TOO_LARGE');
  return info;
}
async function sourceFiles(path) {
  const [db, wal, journal] = await Promise.all([
    regularInfo(join(path, 'hcom.db')), regularInfo(join(path, 'hcom.db-wal'), MAX_DB, true),
    regularInfo(join(path, 'hcom.db-journal'), MAX_DB, true),
  ]);
  // Reading a database mid-rollback transaction cannot be proven safe by copying its main file.
  if (journal?.size > 0n) throw fault('BUSY_SNAPSHOT');
  return { db, wal, signature: `${fingerprint(db)}|${fingerprint(wal)}` };
}
async function sourceBytes(path, info, name) {
  const handle = await open(join(path, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (fingerprint(before) !== fingerprint(info) || !before.isFile()) throw fault('BUSY_SNAPSHOT');
    const bytes = await handle.readFile();
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(info)) throw fault('BUSY_SNAPSHOT');
    return bytes;
  } finally { await handle.close(); }
}
function schemaSupported(db) {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name = 'events'").get();
  if (table?.type !== 'table') return false;
  const columns = db.prepare('PRAGMA table_info(events)').all();
  const byName = new Map(columns.map(row => [row.name, row]));
  return ['id', 'timestamp', 'type', 'data'].every(name => byName.has(name)) &&
    byName.get('id').pk === 1 && /INT/i.test(byName.get('id').type) &&
    ['timestamp', 'type', 'data'].every(name => /TEXT/i.test(byName.get(name).type));
}
async function readLedger(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let privateDirectory;
    try {
      const before = await sourceFiles(path);
      const old = cache.get(path);
      if (old?.signature === before.signature) return old;
      const bytes = await sourceBytes(path, before.db, 'hcom.db');
      const wal = before.wal ? await sourceBytes(path, before.wal, 'hcom.db-wal') : null;
      const after = await sourceFiles(path);
      if (before.signature !== after.signature) throw fault('BUSY_SNAPSHOT');
      // A read-only SQLite connection can update source WAL shared-memory read marks.
      // SQLite therefore opens only this disposable copy, never the live ledger.
      privateDirectory = await mkdtemp(join(tmpdir(), 'agent-dialogue-view-'));
      const localPath = join(privateDirectory, 'hcom.db');
      await writeFile(localPath, bytes, { mode: 0o600 });
      if (wal) await writeFile(`${localPath}-wal`, wal, { mode: 0o600 });
      const db = new DatabaseSync(localPath, { readOnly: true, allowExtension: false });
      const events = [], diagnostics = [];
      let anchor = '', firstId = null;
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED;');
        if (!schemaSupported(db)) throw fault('UNSUPPORTED_SCHEMA');
        const first = db.prepare('SELECT id, timestamp, type, data FROM events ORDER BY id ASC LIMIT 1').get();
        anchor = createHash('sha256').update(JSON.stringify(first || null)).digest('hex').slice(0, 16);
        firstId = first?.id ?? null;
        const query = db.prepare("SELECT id, timestamp, type, data FROM events WHERE type = 'message' AND id > ? ORDER BY id ASC LIMIT 1000");
        let cursor = 0;
        for (;;) {
          const rows = query.all(cursor);
          if (!rows.length) break;
          for (const row of rows) {
            cursor = row.id;
            if (!Number.isSafeInteger(row.id) || row.id < 1) { note(diagnostics, 'invalid-event-id', 'A ledger event has an unsupported identity.'); continue; }
            let data;
            try { data = JSON.parse(row.data); }
            catch { note(diagnostics, 'invalid-event-json', 'A message event has invalid JSON and was skipped.', { eventId: row.id }); continue; }
            if (!object(data)) { note(diagnostics, 'invalid-event-json', 'A message event has invalid data and was skipped.', { eventId: row.id }); continue; }
            const safe = selected(data, ['from', 'text', 'thread', 'intent', 'scope', 'sender_kind', 'reply_to', 'reply_to_local']);
            for (const key of ['delivered_to', 'mentions']) if (Array.isArray(data[key])) safe[key] = data[key].filter(value => typeof value === 'string');
            events.push({ id: row.id, type: 'message', timestamp: row.timestamp, data: safe });
          }
          if (rows.length < 1000) break;
        }
        db.exec('COMMIT');
      } finally { db.close(); }
      const baseGeneration = `${before.db.dev}:${before.db.ino}:${before.db.birthtimeNs}`;
      const maxId = events.at(-1)?.id || 0;
      const reset = old?.baseGeneration === baseGeneration && (maxId < old.maxId || (old.firstId !== null && old.anchor !== anchor));
      const epoch = old?.baseGeneration === baseGeneration ? (old.epoch || 0) + Number(reset) : 0;
      const generation = createHash('sha256').update(`${baseGeneration}:${epoch}`).digest('hex').slice(0, 32);
      const result = { signature: before.signature, generation, baseGeneration, epoch, maxId, anchor, firstId, events, diagnostics };
      cache.set(path, result);
      if (cache.size > MAX_CACHED_SOURCES) cache.delete(cache.keys().next().value);
      return result;
    } catch (error) {
      lastError = error;
      if (error.code !== 'BUSY_SNAPSHOT') throw error;
    } finally { if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true }); }
  }
  throw lastError;
}
async function jsonFile(path) {
  const info = await regularInfo(path, MAX_JSON);
  const bytes = await sourceBytes(dirname(path), info, basename(path));
  return JSON.parse(bytes.toString('utf8'));
}
function sanitizeStore(raw) {
  if (!object(raw) || raw.version !== 1 || !object(raw.bindings) || !object(raw.rooms)) throw fault('UNSUPPORTED_STORE');
  const store = emptyStore();
  store.bindings = mapSelected(raw.bindings, ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'hcomName', 'active', 'nodeId', 'remote', 'resumeRequested']);
  store.rooms = mapSelected(raw.rooms, ['id', 'name', 'revision', 'ownerNodeId', 'manifestHash']);
  for (const [id, room] of Object.entries(store.rooms)) room.members = Array.isArray(raw.rooms[id].members) ? raw.rooms[id].members.filter(object).map(member => selected(member, ['alias', 'bindingId', 'revision', 'nodeId'])) : [];
  store.peers = mapSelected(raw.peers, ['nodeId', 'name', 'publicKey', 'cardHash']);
  store.inbox = mapSelected(raw.inbox, ['payloadHash', 'senderNodeId', 'roomId', 'status', 'eventId', 'inputId', 'sessionId']);
  store.outbox = mapSelected(raw.outbox, ['payloadHash', 'peerNodeId', 'roomId', 'fromActor', 'status', 'eventId', 'remoteEventId']);
  return store;
}
function sanitizeWorker(raw, bindingId) {
  if (!object(raw)) throw fault('INVALID_RUNTIME');
  const worker = { bindingId, ...selected(raw, ['status', 'cursor']), receipts: {} };
  if (raw.error) worker.error = 'Worker reported an error; inspect its runtime locally for details.';
  if (object(raw.pending)) worker.pending = selected(raw.pending, ['eventId', 'inputId', 'bindingRevision', 'status']);
  if (object(raw.outgoingPending)) worker.outgoingPending = selected(raw.outgoingPending, ['eventId', 'submissionId', 'status']);
  for (const [id, receipt] of Object.entries(object(raw.receipts) ? raw.receipts : {})) {
    if (!/^\d+$/.test(id) || !object(receipt)) continue;
    const safe = selected(receipt, ['status', 'inputId', 'reconciled', 'sessionId', 'at', 'globalMessageId', 'submissionId']);
    if (receipt.reason) safe.reason = 'Bridge rejected this event; inspect its runtime locally for details.';
    if (object(receipt.result)) safe.result = selected(receipt.result, ['event_id', 'messageId', 'status', 'remoteEventId']);
    worker.receipts[id] = safe;
  }
  return worker;
}

/** Read only an explicitly registered local source. No hcom/native API or source writes. */
export async function readSource(spec) {
  if (!spec || typeof spec.id !== 'string' || typeof spec.label !== 'string' || typeof spec.path !== 'string') throw new TypeError('Viewer source requires an id, label, and local path.');
  const snapshot = { id: spec.id, label: spec.label, available: false, observedAt: new Date().toISOString(), generation: null, error: null, node: null, events: [], store: emptyStore(), workers: [], diagnostics: [] };
  const path = resolve(spec.path);
  try {
    const ledger = await readLedger(path);
    snapshot.available = true; snapshot.generation = ledger.generation; snapshot.events = ledger.events;
    snapshot.diagnostics.push(...ledger.diagnostics);
  } catch (error) { snapshot.error = sourceError(error.code); return snapshot; }
  try {
    const node = await jsonFile(join(path, 'dialogue', 'node.json'));
    if (!object(node) || typeof node.nodeId !== 'string' || typeof node.name !== 'string' || typeof node.publicKey !== 'string') throw fault('INVALID_NODE');
    snapshot.node = selected(node, ['nodeId', 'name', 'publicKey']);
  } catch (error) { note(snapshot.diagnostics, error.code === 'ENOENT' ? 'missing-node' : 'invalid-node', 'Public node identity is unavailable.'); }
  try { snapshot.store = sanitizeStore(await jsonFile(join(path, 'dialogue', 'store.json'))); }
  catch (error) { note(snapshot.diagnostics, error.code === 'ENOENT' ? 'missing-store' : 'invalid-store', 'Dialogue control metadata is unavailable or unsupported.'); }
  try {
    const entries = await readdir(join(path, 'dialogue'));
    for (const name of entries.sort()) {
      const match = BINDING_FILE.exec(name); if (!match) continue;
      try { snapshot.workers.push(sanitizeWorker(await jsonFile(join(path, 'dialogue', name)), match[1])); }
      catch { note(snapshot.diagnostics, 'invalid-worker', 'A worker runtime could not be read.', { bindingId: match[1] }); }
    }
  } catch (error) { if (error.code !== 'ENOENT') note(snapshot.diagnostics, 'unreadable-workers', 'Worker runtimes could not be listed.'); }
  return snapshot;
}
