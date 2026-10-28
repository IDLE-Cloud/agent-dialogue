import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const id = prefix => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const bad = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const requireThat = (condition, status, code, message) => { if (!condition) bad(status, code, message); };
function text(value, name, max = 256) {
  requireThat(typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value), 400, 'invalid_input', `Invalid ${name}.`);
  return value;
}
function identifier(value, prefix) {
  requireThat(typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,100}$`).test(value), 400, 'invalid_input', `Invalid ${prefix} ID.`);
  return value;
}
function object(value) { requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_input', 'Expected an object.'); return value; }
function detail(value) { return value === undefined ? null : text(value, 'status detail', 512); }
function paging(after = 0, limit = 50) {
  after = Number(after); limit = Number(limit);
  requireThat(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100, 400, 'invalid_input', 'Invalid pagination.');
  return { after, limit };
}

export class LiteStore {
  constructor({ dbPath, adminToken }) {
    text(adminToken, 'admin token', 512);
    requireThat(adminToken.length >= 24, 400, 'invalid_input', 'Admin token must contain at least 24 characters.');
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      if (!existsSync(dbPath)) closeSync(openSync(dbPath, 'wx', 0o600));
      if (process.platform !== 'win32') requireThat((statSync(dbPath).mode & 0o077) === 0, 400, 'private_file', 'Hub database must be private to its owner (mode 0600).');
    }
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      requireThat(version === 0 || version === 1, 409, 'schema_version', 'Unsupported Lite database schema; stop and use a compatible package.');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, label TEXT NOT NULL, run_id TEXT, last_seen TEXT);
        CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), alias TEXT NOT NULL, harness TEXT NOT NULL, mode TEXT NOT NULL, binding TEXT NOT NULL, binding_key TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, UNIQUE(node_id,binding_key));
        CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, label TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_members (room TEXT NOT NULL REFERENCES rooms(id), agent_id TEXT NOT NULL REFERENCES agents(id), PRIMARY KEY(room,agent_id));
        CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT, rooms TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS enrollments (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id), sender TEXT NOT NULL REFERENCES agents(id), recipients TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT REFERENCES messages(id), created_at TEXT NOT NULL, seq INTEGER UNIQUE);
        CREATE TABLE IF NOT EXISTS deliveries (message_id TEXT NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL, detail TEXT, grant_hash TEXT, run_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(message_id,agent_id));
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, message_id TEXT, agent_id TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS inbox_agent ON deliveries(agent_id,state);
        CREATE INDEX IF NOT EXISTS history_room ON messages(room,seq);
        PRAGMA user_version=1;
      `);
      const saved = this.db.prepare("SELECT value FROM meta WHERE key='admin_hash'").get();
      if (saved) requireThat(timingSafeEqual(Buffer.from(saved.value), Buffer.from(hash(adminToken))), 401, 'invalid_admin', 'Admin token does not match the existing Hub.');
      else this.db.prepare("INSERT INTO meta(key,value) VALUES('admin_hash',?)").run(hash(adminToken));
      this.adminHash = hash(adminToken);
      // A previous Hub process may have died between admission and receipt. Never replay.
      this.tx(() => {
        for (const row of this.db.prepare("SELECT * FROM deliveries WHERE state='delivering'").all()) {
          this.updateDelivery(row.message_id, row.agent_id, 'unknown', 'Hub restarted during submission; inspect the native chat.');
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  event(kind, messageId = null, agentId = null) { return Number(this.db.prepare('INSERT INTO events(kind,message_id,agent_id,created_at) VALUES(?,?,?,?)').run(kind, messageId, agentId, now()).lastInsertRowid); }
  credential(kind, owner = null, rooms = []) { const value = token(); this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?)').run(hash(value), kind, owner, json(rooms)); return value; }
  authenticate(value) {
    requireThat(typeof value === 'string' && value.length <= 512, 401, 'unauthorized', 'A valid credential is required.');
    const digest = hash(value);
    if (timingSafeEqual(Buffer.from(digest), Buffer.from(this.adminHash))) return { kind: 'admin' };
    const row = this.db.prepare('SELECT kind,owner,rooms FROM credentials WHERE hash=?').get(digest);
    requireThat(row, 401, 'unauthorized', 'A valid credential is required.');
    return { kind: row.kind, id: row.owner, rooms: parse(row.rooms) };
  }
  role(auth, ...kinds) { requireThat(auth && kinds.includes(auth.kind), 403, 'forbidden', 'This credential cannot perform that operation.'); }
  roomVisible(auth, room) {
    this.role(auth, 'admin', 'scope', 'viewer');
    requireThat(this.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(room), 404, 'not_found', 'Room not found.');
    requireThat(auth.kind === 'admin' || auth.rooms.includes(room), 403, 'forbidden', 'Room is outside this credential scope.');
    if (auth.kind === 'scope') requireThat(this.member(room, auth.id), 403, 'forbidden', 'Agent is not a room member.');
  }
  member(room, agentId) { return !!this.db.prepare('SELECT 1 FROM room_members WHERE room=? AND agent_id=?').get(room, agentId); }
  agent(agentId) {
    const row = this.db.prepare('SELECT a.*, n.label node_label, n.last_seen FROM agents a JOIN nodes n ON a.node_id=n.id WHERE a.id=?').get(agentId);
    requireThat(row, 404, 'not_found', 'Agent not found.');
    return { id: row.id, nodeId: row.node_id, nodeLabel: row.node_label, alias: row.alias, harness: row.harness, mode: row.mode, binding: parse(row.binding), state: row.state, detail: row.detail, lastSeen: row.last_seen };
  }
  ownAgent(auth, agentId) { this.role(auth, 'node'); const agent = this.agent(agentId); requireThat(agent.nodeId === auth.id, 403, 'forbidden', 'Agent belongs to another node.'); return agent; }
  message(messageId) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    requireThat(row, 404, 'not_found', 'Message not found.');
    return { id: row.id, room: row.room, sender: row.sender, to: parse(row.recipients), text: row.text, replyTo: row.reply_to, createdAt: row.created_at, seq: row.seq };
  }
  delivery(messageId, agentId) {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND agent_id=?').get(messageId, agentId);
    requireThat(row, 404, 'not_found', 'Delivery not found.');
    return { messageId: row.message_id, agentId: row.agent_id, state: row.state, detail: row.detail, updatedAt: row.updated_at };
  }
  deliveries(messageId) { return this.db.prepare('SELECT agent_id FROM deliveries WHERE message_id=? ORDER BY agent_id').all(messageId).map(row => this.delivery(messageId, row.agent_id)); }
  updateDelivery(messageId, agentId, state, note = null, eventKind = state) {
    this.db.prepare('UPDATE deliveries SET state=?,detail=?,updated_at=? WHERE message_id=? AND agent_id=?').run(state, note, now(), messageId, agentId);
    this.event(eventKind, messageId, agentId);
    return this.delivery(messageId, agentId);
  }
  visibleMessage(auth, messageId) {
    const message = this.message(messageId);
    this.roomVisible(auth, message.room);
    requireThat(auth.kind !== 'scope' || message.sender === auth.id || message.to.includes(auth.id), 403, 'forbidden', 'Message is outside this agent conversation.');
    return message;
  }
  createEnrollment(auth) { this.role(auth, 'admin'); const code = token(); this.db.prepare('INSERT INTO enrollments VALUES(?,?)').run(hash(code), Date.now() + 10 * 60_000); return { code }; }
  enroll(body) {
    object(body); text(body.code, 'enrollment code', 512); const label = text(body.label, 'node label');
    return this.tx(() => {
      const code = this.db.prepare('SELECT expires FROM enrollments WHERE hash=?').get(hash(body.code));
      requireThat(code && code.expires >= Date.now(), 401, 'invalid_enrollment', 'Enrollment code is invalid, expired, or already used.');
      this.db.prepare('DELETE FROM enrollments WHERE hash=?').run(hash(body.code));
      const node = { id: id('node'), label };
      this.db.prepare('INSERT INTO nodes(id,label) VALUES(?,?)').run(node.id, label);
      return { node, token: this.credential('node', node.id) };
    });
  }
  createRoom(auth, body) { this.role(auth, 'admin'); object(body); const room = { id: id('room'), label: text(body.label, 'room label') }; this.db.prepare('INSERT INTO rooms VALUES(?,?)').run(room.id, room.label); return room; }
  registerAgent(auth, body) {
    this.role(auth, 'node'); object(body);
    const alias = text(body.alias, 'agent alias'), harness = text(body.harness, 'harness', 64);
    requireThat(['native-push', 'tool-pull'].includes(body.mode), 400, 'invalid_input', 'Invalid agent receiving mode.');
    const b = object(body.binding), service = object(b.serviceIdentity);
    const binding = { serviceIdentity: { serviceId: text(service.serviceId, 'service ID'), origin: text(service.origin, 'service origin', 1024), ...(service.version === undefined ? {} : { version: text(service.version, 'service version', 64) }) }, sessionId: text(b.sessionId, 'session ID', 512), projectDirectory: text(b.projectDirectory, 'project directory', 4096), ...(b.projectId === undefined ? {} : { projectId: text(b.projectId, 'project ID', 512) }) };
    requireThat(posix.isAbsolute(binding.projectDirectory) || win32.isAbsolute(binding.projectDirectory), 400, 'invalid_input', 'Project directory must be absolute.');
    if (body.mode === 'native-push') {
      let url;
      try { url = new URL(binding.serviceIdentity.origin); } catch { bad(400, 'invalid_input', 'Native service origin must be loopback.'); }
      const host = url.hostname.replace(/^\[|\]$/g, '');
      requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && (host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)), 400, 'invalid_input', 'Native service origin must be an uncredentialed loopback origin.');
      binding.serviceIdentity.origin = url.origin;
    }
    const bindingKey = hash(json({ harness, mode: body.mode, binding }));
    return this.tx(() => {
      const prior = this.db.prepare('SELECT id FROM agents WHERE node_id=? AND binding_key=?').get(auth.id, bindingKey);
      if (prior) { this.db.prepare('UPDATE agents SET alias=? WHERE id=?').run(alias, prior.id); return this.agent(prior.id); }
      const agentId = id('agent');
      this.db.prepare('INSERT INTO agents(id,node_id,alias,harness,mode,binding,binding_key,state) VALUES(?,?,?,?,?,?,?,?)').run(agentId, auth.id, alias, harness, body.mode, json(binding), bindingKey, body.mode === 'tool-pull' ? 'tool-pull' : 'unavailable');
      this.event('agent', null, agentId);
      return this.agent(agentId);
    });
  }
  addMember(auth, body) { this.role(auth, 'admin'); object(body); this.roomVisible(auth, identifier(body.room, 'room')); this.agent(identifier(body.agentId, 'agent')); this.db.prepare('INSERT OR IGNORE INTO room_members VALUES(?,?)').run(body.room, body.agentId); return { ok: true }; }
  issueScope(auth, body, viewer = false) {
    this.role(auth, 'admin'); object(body);
    requireThat(Array.isArray(body.rooms) && body.rooms.length >= 1 && body.rooms.length <= 100 && new Set(body.rooms).size === body.rooms.length, 400, 'invalid_input', 'Select 1–100 distinct rooms.');
    if (!viewer) this.agent(identifier(body.agentId, 'agent'));
    for (const room of body.rooms) { this.roomVisible(auth, identifier(room, 'room')); requireThat(viewer || this.member(room, body.agentId), 403, 'forbidden', 'Join the agent to each room before granting a scope.'); }
    return { token: this.credential(viewer ? 'viewer' : 'scope', viewer ? null : body.agentId, body.rooms), ...(viewer ? {} : { agentId: body.agentId }), rooms: body.rooms };
  }
  context(auth) {
    this.role(auth, 'admin', 'scope', 'viewer');
    const rows = this.db.prepare('SELECT * FROM rooms ORDER BY rowid').all().filter(room => auth.kind === 'admin' || auth.rooms.includes(room.id));
    return { ...(auth.kind === 'scope' ? { self: this.agent(auth.id), identityAssurance: 'operator-assigned' } : {}), rooms: rows.map(room => ({ ...room, members: this.db.prepare('SELECT agent_id FROM room_members WHERE room=? ORDER BY rowid').all(room.id).map(row => this.agent(row.agent_id)) })) };
  }
  send(auth, body) {
    this.role(auth, 'scope'); object(body);
    const messageId = identifier(body.id, 'msg'), room = identifier(body.room, 'room');
    requireThat(!Object.hasOwn(body, 'from') && !Object.hasOwn(body, 'sender'), 400, 'invalid_input', 'Sender comes from the authenticated scope.');
    requireThat(typeof body.text === 'string' && !!body.text.trim() && Buffer.byteLength(body.text) <= 65536, 400, 'invalid_input', 'Message text must contain 1–65536 UTF-8 bytes.');
    requireThat(Array.isArray(body.to) && body.to.length >= 1 && body.to.length <= 16 && new Set(body.to).size === body.to.length, 400, 'invalid_input', 'Select 1–16 distinct recipients.');
    const to = body.to.map(value => identifier(value, 'agent')).sort(), replyTo = body.replyTo ?? null;
    if (replyTo !== null) identifier(replyTo, 'msg');
    return this.tx(() => {
      this.roomVisible(auth, room);
      for (const recipient of to) requireThat(this.member(room, recipient), 403, 'forbidden', 'Recipient is not a room member.');
      if (replyTo) requireThat(this.visibleMessage(auth, replyTo).room === room, 400, 'invalid_reply', 'Reply must belong to the same room.');
      const prior = this.db.prepare('SELECT id FROM messages WHERE id=?').get(messageId);
      if (prior) {
        const original = this.message(messageId);
        requireThat(original.sender === auth.id && original.room === room && json(original.to) === json(to) && original.text === body.text && original.replyTo === replyTo, 409, 'message_conflict', 'Message ID already exists with different content or sender.');
        return { accepted: true, message: original, deliveries: this.deliveries(messageId) };
      }
      const createdAt = now();
      this.db.prepare('INSERT INTO messages(id,room,sender,recipients,text,reply_to,created_at) VALUES(?,?,?,?,?,?,?)').run(messageId, room, auth.id, json(to), body.text, replyTo, createdAt);
      const seq = this.event('accepted', messageId);
      this.db.prepare('UPDATE messages SET seq=? WHERE id=?').run(seq, messageId);
      for (const recipient of to) this.db.prepare('INSERT INTO deliveries(message_id,agent_id,state,updated_at) VALUES(?,?,?,?)').run(messageId, recipient, 'queued', createdAt);
      return { accepted: true, message: this.message(messageId), deliveries: this.deliveries(messageId) };
    });
  }
  inbox(auth, query = {}) {
    this.role(auth, 'scope'); const { after, limit } = paging(query.after, query.limit);
    return this.tx(() => {
      const rows = this.db.prepare('SELECT m.id,m.seq FROM messages m JOIN deliveries d ON m.id=d.message_id WHERE d.agent_id=? AND m.seq>? ORDER BY m.seq').all(auth.id, after).filter(row => auth.rooms.includes(this.message(row.id).room)).slice(0, limit);
      const agent = this.agent(auth.id);
      const items = rows.map(row => {
        if (agent.mode === 'tool-pull' && this.delivery(row.id, auth.id).state === 'queued') this.updateDelivery(row.id, auth.id, 'tool-read');
        return { seq: row.seq, message: this.message(row.id), delivery: this.delivery(row.id, auth.id) };
      });
      return { items, cursor: items.at(-1)?.seq ?? after };
    });
  }
  status(auth, messageId) { const message = this.visibleMessage(auth, identifier(messageId, 'msg')); return { message, deliveries: this.deliveries(message.id) }; }
  history(auth, query) {
    this.role(auth, 'admin', 'viewer'); const room = identifier(query.room, 'room'); this.roomVisible(auth, room); const { after, limit } = paging(query.after, query.limit);
    const items = this.db.prepare('SELECT id FROM messages WHERE room=? AND seq>? ORDER BY seq LIMIT ?').all(room, after, limit).map(row => ({ ...this.message(row.id), deliveries: this.deliveries(row.id) }));
    return { items, cursor: items.at(-1)?.seq ?? after };
  }
  heartbeat(auth, body) {
    this.role(auth, 'node'); object(body); text(body.runId, 'node run ID', 128);
    requireThat(Array.isArray(body.statuses) && body.statuses.length <= 1000, 400, 'invalid_input', 'Invalid node statuses.');
    const statuses = body.statuses.map(item => { object(item); this.ownAgent(auth, identifier(item.agentId, 'agent')); requireThat(['ready', 'busy', 'unavailable', 'blocked', 'tool-pull'].includes(item.state), 400, 'invalid_input', 'Invalid agent state.'); return { ...item, detail: detail(item.detail) }; });
    return this.tx(() => {
      const node = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(auth.id);
      if (node.run_id !== body.runId) {
        const stranded = this.db.prepare("SELECT d.message_id,d.agent_id FROM deliveries d JOIN agents a ON d.agent_id=a.id WHERE a.node_id=? AND d.state='delivering'").all(auth.id);
        for (const row of stranded) this.updateDelivery(row.message_id, row.agent_id, 'unknown', 'Node run changed during submission; inspect the native chat.');
      }
      this.db.prepare('UPDATE nodes SET run_id=?,last_seen=? WHERE id=?').run(body.runId, now(), auth.id);
      for (const item of statuses) {
        this.db.prepare('UPDATE agents SET state=?,detail=? WHERE id=?').run(item.state, item.detail, item.agentId);
        if (item.state === 'blocked' && item.uncertain === true) {
          const stranded = this.db.prepare("SELECT message_id FROM deliveries WHERE agent_id=? AND run_id=? AND state='delivering'").all(item.agentId, body.runId);
          for (const row of stranded) this.updateDelivery(row.message_id, item.agentId, 'unknown', 'Submission result is unknown; inspect the native chat.');
        }
      }
      return { ok: true };
    });
  }
  poll(auth) {
    this.role(auth, 'node');
    requireThat(this.db.prepare('SELECT run_id FROM nodes WHERE id=?').get(auth.id)?.run_id, 409, 'heartbeat_required', 'Heartbeat before polling.');
    const agents = this.db.prepare('SELECT id FROM agents WHERE node_id=? ORDER BY rowid').all(auth.id).map(row => this.agent(row.id));
    const rows = this.db.prepare("SELECT d.message_id,d.agent_id FROM deliveries d JOIN agents a ON d.agent_id=a.id JOIN messages m ON d.message_id=m.id WHERE a.node_id=? AND a.mode='native-push' AND d.state='queued' AND NOT EXISTS(SELECT 1 FROM deliveries x WHERE x.agent_id=a.id AND x.state IN ('delivering','unknown')) AND NOT EXISTS(SELECT 1 FROM deliveries q JOIN messages qm ON q.message_id=qm.id WHERE q.agent_id=a.id AND q.state='queued' AND qm.seq<m.seq) ORDER BY m.seq LIMIT 100").all(auth.id);
    return { agents, deliveries: rows.map(row => ({ message: this.message(row.message_id), delivery: this.delivery(row.message_id, row.agent_id) })) };
  }
  begin(auth, body) {
    this.role(auth, 'node'); object(body); const agent = this.ownAgent(auth, identifier(body.agentId, 'agent')); identifier(body.messageId, 'msg'); text(body.runId, 'node run ID', 128);
    requireThat(agent.mode === 'native-push', 409, 'wrong_mode', 'Tool-pull agents do not use native dispatch.');
    return this.tx(() => {
      const node = this.db.prepare('SELECT run_id FROM nodes WHERE id=?').get(auth.id);
      requireThat(node.run_id === body.runId, 409, 'node_run_changed', 'Node run changed; stop this executor.');
      const delivery = this.delivery(body.messageId, body.agentId);
      if (delivery.state !== 'queued' || this.db.prepare("SELECT 1 FROM deliveries WHERE agent_id=? AND state IN ('delivering','unknown')").get(body.agentId)) return { granted: false, delivery };
      const grant = token();
      this.db.prepare('UPDATE deliveries SET grant_hash=?,run_id=? WHERE message_id=? AND agent_id=?').run(hash(grant), body.runId, body.messageId, body.agentId);
      return { granted: true, delivery: this.updateDelivery(body.messageId, body.agentId, 'delivering'), grant };
    });
  }
  result(auth, body) {
    this.role(auth, 'node'); object(body); this.ownAgent(auth, identifier(body.agentId, 'agent')); identifier(body.messageId, 'msg'); text(body.grant, 'submission grant', 512);
    requireThat(['delivered', 'unknown', 'failed', 'queued'].includes(body.state), 400, 'invalid_input', 'Invalid submission result.');
    if (body.state === 'queued') requireThat(body.notSubmitted === true, 400, 'submission_proof', 'Requeue requires an explicit notSubmitted assertion.');
    const note = detail(body.detail);
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM deliveries WHERE message_id=? AND agent_id=?').get(body.messageId, body.agentId);
      requireThat(row && row.grant_hash === hash(body.grant), 403, 'invalid_grant', 'Submission grant does not match.');
      if (row.state === body.state) return { delivery: this.delivery(body.messageId, body.agentId) };
      requireThat(row.state === 'delivering' || row.state === 'unknown' && body.state === 'delivered', 409, 'delivery_settled', 'Delivery is already settled; inspect it before further action.');
      const delivery = this.updateDelivery(body.messageId, body.agentId, body.state, note);
      if (body.state === 'queued') this.db.prepare('UPDATE deliveries SET grant_hash=NULL,run_id=NULL WHERE message_id=? AND agent_id=?').run(body.messageId, body.agentId);
      return { delivery };
    });
  }
  resolve(auth, body) {
    this.role(auth, 'admin'); object(body);
    const messageId = identifier(body.messageId, 'msg'), agentId = identifier(body.agentId, 'agent');
    requireThat(['delivered', 'failed'].includes(body.state), 400, 'invalid_input', 'Operator resolution must be delivered or failed.');
    requireThat(body.executorStopped === true, 400, 'executor_stop_required', 'Stop the previous executor and inspect the native chat before resolving.');
    const note = text(body.note, 'operator verification note', 512);
    return this.tx(() => {
      const delivery = this.delivery(messageId, agentId);
      if (delivery.state === body.state && delivery.detail === note && this.db.prepare("SELECT 1 FROM events WHERE kind='operator-resolved' AND message_id=? AND agent_id=?").get(messageId, agentId)) return { delivery };
      requireThat(delivery.state === 'unknown', 409, 'not_unknown', 'Only an unknown delivery may be resolved by the operator.');
      return { delivery: this.updateDelivery(messageId, agentId, body.state, note, 'operator-resolved') };
    });
  }
}
