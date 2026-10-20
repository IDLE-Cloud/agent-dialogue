import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from '../lib/inspect.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';

const fixed = '2026-10-19T08:00:00.000Z';
const clock = () => new Date(fixed);
const codes = report => report.checks.map(row => row.code);
async function snapshot(path) {
  let info; try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (info.isDirectory()) return Object.fromEntries(await Promise.all((await readdir(path)).sort().map(async name => [name, await snapshot(join(path, name))])));
  if (info.isSymbolicLink()) return { link: true };
  return { bytes: createHash('sha256').update(await readFile(path)).digest('hex'), mode: info.mode, mtime: info.mtimeMs };
}
async function fixture(t, { present = true, node = false, harness = 'opencode-v2' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), runtimeDir: join(root, 'cache', 'runtime'), binary: join(root, 'cache', 'hcom'), ledgerBackend: 'embedded', env: { PATH: '' } };
  if (present) await mkdir(join(context.stateDir, 'dialogue'), { recursive: true, mode: 0o700 });
  const binding = { alias: 'selected', id: `b_${randomUUID()}`, revision: 1, harness, sessionId: 'ses_selected', projectId: 'project-selected', directory: join(root, 'project'), serviceId: 'service-selected', origin: 'http://127.0.0.1:4567', hcomName: 'd012345678901', active: true };
  const peer = { ...binding, alias: 'peer', id: `b_${randomUUID()}`, sessionId: 'ses_peer', hcomName: 'd987654321098' };
  const room = { id: `r_${randomUUID()}`, name: 'Synthetic project', members: [binding, peer].map(b => ({ alias: b.alias, bindingId: b.id, revision: b.revision })) };
  const store = { version: 1, bindings: { selected: binding, peer }, rooms: { [room.id]: room } };
  const save = () => writeFile(join(context.stateDir, 'dialogue', 'store.json'), JSON.stringify(store), { mode: 0o600 });
  if (present) await save();
  let identity;
  if (node) identity = await loadOrCreateNode(context, { name: 'Fixture node' });
  return { root, context, binding, peer, room, store, save, identity };
}
function nativeFor(f, extra = {}) {
  const calls = [];
  const client = { identity: { serviceId: f.binding.serviceId, origin: f.binding.origin, version: 'verified-fixture' }, capabilities: { existingAttach: true },
    session: async id => { calls.push(['session', id]); return { id, projectID: f.binding.projectId, location: { directory: f.binding.directory }, time: {}, nativeStatus: 'idle' }; },
    prompt: async () => { throw new Error('must not submit'); }, inbox: async () => { throw new Error('must not read inbox'); }, messages: async () => { throw new Error('must not read messages'); }, close: () => { calls.push(['close']); }, ...extra };
  return { client, calls, factory: async () => { calls.push(['discover']); return client; } };
}

test('missing paths stay absent and yield an explicit unconfigured report without native calls', async t => {
  const f = await fixture(t, { present: false }), before = await snapshot(f.root);
  const report = await inspect(f.context, {}, { clock, nativeFactory: () => { throw new Error('native discovery forbidden'); } });
  assert.equal(report.schemaVersion, 1); assert.equal(report.overall, 'unconfigured'); assert.equal(report.exitCode, 0);
  assert.equal(report.observedAt, fixed); assert.ok(codes(report).includes('STATE_NOT_INITIALIZED'));
  assert.equal(report.effects.sourceWrites, false); assert.equal(report.effects.nativeContact, false); assert.equal(report.effects.sshContact, false); assert.equal(report.effects.modelTurns, false);
  assert.deepEqual(await snapshot(f.root), before);
});

test('default inspection preserves all files and exposes exact selected pins without claiming native liveness', async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  const report = await inspect(f.context, { binding: f.binding.alias, room: f.room.id }, { clock, nativeFactory: () => { throw new Error('forbidden'); } });
  assert.equal(report.exitCode, 0); assert.equal(report.overall, 'ready-local');
  assert.equal(report.bindings.length, 1); for (const key of ['id', 'revision', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin']) assert.equal(report.bindings[0][key], f.binding[key]);
  assert.equal(report.rooms[0].id, f.room.id); assert.ok(codes(report).includes('NATIVE_NOT_PROBED')); assert.ok(codes(report).includes('WORKER_PROCESS_NOT_PROBED'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('local legacy rooms remain inspectable without initializing a node identity', async t => {
  const f = await fixture(t); const report = await inspect(f.context, { room: f.room.id });
  assert.equal(report.exitCode, 0); assert.ok(codes(report).includes('NODE_MISSING'));
  assert.equal(await snapshot(join(f.context.stateDir, 'dialogue', 'node.json')), null);
});

test('existing complete node signing identity is validated without exposing its private key or changing it', async t => {
  const f = await fixture(t, { node: true }), before = await snapshot(f.root);
  const report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.node.nodeId, f.identity.nodeId); assert.equal(report.node.signingKeyValidated, true);
  assert.equal(JSON.stringify(report).includes(f.identity.privateKey), false); assert.equal(JSON.stringify(report).includes('privateKey'), false);
  assert.deepEqual(await snapshot(f.root), before);
});

test('malformed and too-large store files fail closed without echoing source secrets', async t => {
  const f = await fixture(t), path = join(f.context.stateDir, 'dialogue', 'store.json');
  for (const [body, code] of [['{"password":"SOURCE-SECRET", broken', 'STORE_INVALID'], ['x'.repeat(4 * 1024 * 1024 + 1), 'FILE_TOO_LARGE']]) {
    await writeFile(path, body); const before = await snapshot(f.root), report = await inspect(f.context, {});
    assert.equal(report.exitCode, 1); assert.ok(codes(report).includes(code), JSON.stringify(report)); assert.equal(JSON.stringify(report).includes('SOURCE-SECRET'), false); assert.deepEqual(await snapshot(f.root), before);
  }
});

test('symlinked store or state root is rejected and the target is preserved', async t => {
  const f = await fixture(t), target = join(f.root, 'target.json'), path = join(f.context.stateDir, 'dialogue', 'store.json');
  await writeFile(target, JSON.stringify(f.store)); await rm(path);
  try { await symlink(target, path, 'file'); } catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  const before = await snapshot(f.root), report = await inspect(f.context);
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('STATE_UNSAFE_PATH')); assert.deepEqual(await snapshot(f.root), before);
  await rm(path); await rm(f.context.stateDir, { recursive: true }); await mkdir(join(f.root, 'other'));
  await symlink(join(f.root, 'other'), f.context.stateDir, 'dir');
  assert.ok(codes(await inspect(f.context)).includes('STATE_UNSAFE_PATH'));
});

test('invalid UTF8 store is rejected as invalid metadata without changing source', async t => {
  const f = await fixture(t); await writeFile(join(f.context.stateDir, 'dialogue', 'store.json'), Buffer.from([0xff, 0xfe]));
  const report = await inspect(f.context); assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('STORE_INVALID'));
});

test('ledger header inspection never creates or opens SQLite sidecars and distinguishes backend mismatch', async t => {
  const f = await fixture(t), header = Buffer.alloc(100); header.write('SQLite format 3\0'); header.writeUInt32BE(0x41444c47, 68); header.writeUInt32BE(1, 60);
  await writeFile(join(f.context.stateDir, 'hcom.db'), header); await writeFile(join(f.context.stateDir, 'hcom.db-wal'), 'unchanged-wal');
  let before = await snapshot(f.root), report = await inspect(f.context);
  assert.ok(codes(report).includes('LEDGER_HEADER_VALID')); assert.ok(codes(report).includes('LEDGER_SCHEMA_NOT_PROBED')); assert.deepEqual(await snapshot(f.root), before);
  header.writeUInt32BE(0, 68); await writeFile(join(f.context.stateDir, 'hcom.db'), header); before = await snapshot(f.root); report = await inspect(f.context);
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('LEDGER_BACKEND_MISMATCH')); assert.deepEqual(await snapshot(f.root), before);
});

test('stale room pins and missing paired remote nodes are reported as blockers', async t => {
  const f = await fixture(t); f.room.members[0].revision = 999; await f.save();
  assert.ok(codes(await inspect(f.context, { room: f.room.id })).includes('ROOM_STALE_BINDING'));
  f.room.members[0].revision = 1; f.peer.remote = true; f.peer.nodeId = 'n_' + 'a'.repeat(64); f.room.members[1].nodeId = f.peer.nodeId; await f.save();
  const report = await inspect(f.context, { room: f.room.id }); assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('ROOM_PEER_UNPAIRED'));
});

test('control and worker ownership locks are preserved, classified and never echoed', async t => {
  const f = await fixture(t); await mkdir(join(f.context.stateDir, 'dialogue', '.lock'));
  const lock = join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.lock`); await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 4321, token: 'WORKER-SECRET' }));
  await writeFile(join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.json`), JSON.stringify({ pid: 4321, token: 'OTHER-SECRET', status: 'ready', cursor: 7, error: 'RAW-SECRET', receipts: {} }));
  const before = await snapshot(f.root), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('CONTROL_LOCK_PRESENT')); assert.ok(codes(report).includes('WORKER_OWNER_MISMATCH'));
  for (const secret of ['WORKER-SECRET', 'OTHER-SECRET', 'RAW-SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await snapshot(f.root), before);
});

test('all uncertain layers retain their original IDs and are classified without replay', async t => {
  const f = await fixture(t); f.store.outbox = { ['m_' + randomUUID()]: { status: 'unknown', peerNodeId: 'n_' + 'a'.repeat(64) } }; f.store.mcpSends = { hash: { status: 'preparing', requestKey: 'not-exposed-secret' } }; await f.save();
  await writeFile(join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.json`), JSON.stringify({ cursor: 9, status: 'error', pending: { eventId: 9, inputId: 'msg_original', status: 'preparing' }, outgoingPending: { eventId: 7, submissionId: 'q_original', status: 'forwarding' }, receipts: {} }));
  const before = await snapshot(f.root), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.exitCode, 1); for (const code of ['NATIVE_PENDING', 'OUTGOING_PENDING', 'OUTBOX_UNKNOWN', 'MCP_SEND_PREPARING']) assert.ok(codes(report).includes(code), code);
  assert.deepEqual(await snapshot(f.root), before); assert.equal(JSON.stringify(report).includes('not-exposed-secret'), false);
});

test('unselected chat is explicit and detached bindings are not described as running', async t => {
  const f = await fixture(t); let report = await inspect(f.context); assert.ok(codes(report).includes('BINDING_NOT_SELECTED'));
  f.binding.active = false; await f.save(); report = await inspect(f.context, { binding: f.binding.alias }); assert.ok(codes(report).includes('BINDING_DETACHED')); assert.equal(report.effects.nativeContact, false);
});

test('deep native probe uses only the selected exact session and closes the client', async t => {
  const f = await fixture(t), n = nativeFor(f), before = await snapshot(f.root);
  const report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: n.factory });
  assert.equal(report.exitCode, 0); assert.ok(codes(report).includes('NATIVE_SESSION_MATCH')); assert.equal(report.effects.nativeContact, true); assert.equal(report.effects.mayUpdateNativeMetadata, true);
  assert.deepEqual(n.calls, [['discover'], ['session', f.binding.sessionId], ['close']]); assert.deepEqual(await snapshot(f.root), before);
});

test('native identity and exact directory mismatches block; raw native errors never enter reports', async t => {
  const f = await fixture(t);
  for (const n of [nativeFor(f, { identity: { serviceId: 'different', origin: f.binding.origin } }), nativeFor(f, { session: async () => ({ id: f.binding.sessionId, projectID: f.binding.projectId, location: { directory: join(f.root, 'other') } }) })]) {
    const report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: n.factory }); assert.equal(report.exitCode, 1); assert.ok(codes(report).some(code => ['NATIVE_IDENTITY_CHANGED', 'NATIVE_SESSION_MISMATCH'].includes(code)));
  }
  const report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: async () => { throw new Error('TOKEN-SECRET raw credentials'); } });
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('NATIVE_SERVICE_UNAVAILABLE')); assert.equal(JSON.stringify(report).includes('TOKEN-SECRET'), false);
});

test('Kimi deep inspection is completely skipped until allow-session-load is explicit', async t => {
  const f = await fixture(t, { harness: 'kimi-code' }); let factories = 0;
  let report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: () => { factories++; throw new Error('forbidden'); } });
  assert.equal(factories, 0); assert.equal(report.exitCode, 0); assert.equal(report.effects.nativeContact, false); assert.ok(codes(report).includes('KIMI_SESSION_LOAD_NOT_REQUESTED'));
  const n = nativeFor(f); report = await inspect(f.context, { binding: f.binding.alias, native: true, allowSessionLoad: true }, { nativeFactory: n.factory });
  assert.ok(codes(report).includes('NATIVE_SESSION_MATCH')); assert.equal(report.effects.mayLoadSession, true);
});

test('ZCode probe reports only the saved registration, never desktop liveness or native admission', async t => {
  const f = await fixture(t, { harness: 'zcode-tools' }), n = nativeFor(f, { capabilities: { toolInbox: true, autoWake: false } });
  const report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: n.factory });
  assert.equal(report.exitCode, 0); assert.equal(report.effects.nativeContact, false); assert.ok(codes(report).includes('ZCODE_REGISTRATION_OBSERVED')); assert.ok(codes(report).includes('ZCODE_NATIVE_LIVENESS_UNAVAILABLE'));
  assert.equal(JSON.stringify(report).includes('native-admitted'), false);
});

test('remote native probe does not call local factory or SSH and reports owner requirement', async t => {
  const f = await fixture(t); f.binding.remote = true; f.binding.nodeId = 'n_' + 'b'.repeat(64); await f.save();
  const report = await inspect(f.context, { binding: f.binding.alias, native: true }, { nativeFactory: () => { throw new Error('forbidden'); } });
  assert.equal(report.effects.nativeContact, false); assert.equal(report.effects.sshContact, false); assert.ok(codes(report).includes('NATIVE_REQUIRES_OWNER_INSPECTION'));
});

test('invalid calls reject safely before reading metadata or invoking native services', async t => {
  const f = await fixture(t);
  for (const options of [{ native: true }, { allowSessionLoad: true }, { binding: '../other' }, { room: '' }, { native: 'yes' }, { allowSessionLoad: 'yes' }]) await assert.rejects(inspect(f.context, options), /Inspect|inspect/);
});

test('closed reports drop source extras and provide only structured non-secret action argv', async t => {
  const f = await fixture(t); f.store.secret = 'STORE-SECRET'; f.binding.password = 'BINDING-SECRET'; f.binding.title = 'CHAT-BODY-SECRET'; f.room.secret = 'ROOM-SECRET'; await f.save();
  const report = await inspect(f.context, { binding: f.binding.alias, room: f.room.id });
  for (const secret of ['STORE-SECRET', 'BINDING-SECRET', 'CHAT-BODY-SECRET', 'ROOM-SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
  for (const row of report.checks) for (const action of row.actions) { assert.ok(Array.isArray(action.command)); assert.ok(action.command.every(arg => typeof arg === 'string')); assert.equal(typeof action.mutates, 'boolean'); }
  assert.deepEqual(Object.keys(report.summary).sort(), ['blocked', 'needsReview', 'notProbed', 'ok', 'warn']);
});

test('foreign or permissive node identity fails closed without regeneration', async t => {
  const f = await fixture(t, { node: true }), path = join(f.context.stateDir, 'dialogue', 'node.json');
  if (process.platform !== 'win32') await chmod(path, 0o644); else await writeFile(path, '{malformed');
  const before = await snapshot(f.root), report = await inspect(f.context);
  assert.equal(report.exitCode, 1); assert.ok(codes(report).some(code => ['NODE_PRIVATE_INVALID', 'NODE_IDENTITY_INVALID'].includes(code))); assert.deepEqual(await snapshot(f.root), before);
});


test('future control schema is rejected without guessing lifecycle or modifying source', async t => {
  const f = await fixture(t); f.store.version = 5; f.store.lifecycle = { [f.binding.id]: { version: 1, bindingRevision: 1, desired: 'paused', generation: 1, updatedAt: fixed } }; await f.save();
  const before = await snapshot(f.root), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('STORE_SCHEMA_UNSUPPORTED')); assert.deepEqual(await snapshot(f.root), before);
});

test('credentialed origins and malformed manifest extras never enter a fixed-field report', async t => {
  const f = await fixture(t); f.binding.origin = 'http://owner:ORIGIN-SECRET@127.0.0.1:4567'; f.room.manifestHash = { privateKey: 'MANIFEST-SECRET' }; f.room.ownerNodeId = { token: 'OWNER-SECRET' }; f.room.revision = { password: 'REVISION-SECRET' }; await f.save();
  const report = await inspect(f.context, { binding: f.binding.alias, room: f.room.id });
  assert.equal(report.exitCode, 1); for (const secret of ['ORIGIN-SECRET', 'MANIFEST-SECRET', 'OWNER-SECRET', 'REVISION-SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(report.bindings.length, 0);
});

test('blocked local routing metadata prevents even explicitly requested native probes', async t => {
  const f = await fixture(t); f.room.members[0].revision = 999; await f.save(); let called = false;
  const report = await inspect(f.context, { binding: f.binding.alias, room: f.room.id, native: true }, { nativeFactory: () => { called = true; throw new Error('must not probe'); } });
  assert.equal(called, false); assert.equal(report.effects.nativeContact, false); assert.ok(codes(report).includes('NATIVE_BLOCKED_BY_LOCAL_CHECKS'));
});

test('control characters in selection identifiers are rejected before any metadata read', async t => {
  const f = await fixture(t);
  for (const options of [{ binding: 'selected\n' }, { room: f.room.id + '\n' }]) await assert.rejects(inspect(f.context, options), /Inspect/);
});

test('unknown worker and queue statuses require review without exporting their raw values', async t => {
  const f = await fixture(t); f.store.outbox = { ['m_' + randomUUID()]: { status: 'FUTURE-SECRET' } }; f.store.mcpSends = { hash: { status: 'MCP-SECRET' } }; await f.save();
  await writeFile(join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.json`), JSON.stringify({ status: 'WORKER-SECRET', cursor: 0, receipts: {} }));
  const before = await snapshot(f.root), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.exitCode, 1); for (const code of ['WORKER_RUNTIME_INVALID', 'CONTROL_STATUS_UNSUPPORTED']) assert.ok(codes(report).includes(code));
  for (const secret of ['FUTURE-SECRET', 'MCP-SECRET', 'WORKER-SECRET']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await snapshot(f.root), before);
});

test('valid cross-node-format room hashes are recomputed from exact pins and tampering blocks inspection', async t => {
  const f = await fixture(t, { node: true }); const { payloadHash } = await import('../lib/node-identity.mjs');
  f.binding.nodeId = f.peer.nodeId = f.identity.nodeId; f.room.revision = 1; f.room.ownerNodeId = f.identity.nodeId;
  f.room.members.forEach(member => { member.nodeId = f.identity.nodeId; });
  f.room.manifestHash = payloadHash({ type: 'room', version: 1, id: f.room.id, name: f.room.name, revision: 1, ownerNodeId: f.identity.nodeId, members: f.room.members }); await f.save();
  let report = await inspect(f.context, { binding: f.binding.alias, room: f.room.id }); assert.equal(report.exitCode, 0); assert.ok(codes(report).includes('ROOM_PINS_VALID'));
  f.room.name = 'Tampered project'; await f.save(); report = await inspect(f.context, { room: f.room.id }); assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('ROOM_MANIFEST_INVALID'));
});

test('prepared inbox entries require review with their original message ID even when a ledger event exists', async t => {
  const f = await fixture(t), messageId = 'm_' + randomUUID();
  for (const eventId of [undefined, 17]) {
    f.store.inbox = { [messageId]: { status: 'preparing', ...(eventId === undefined ? {} : { eventId }), senderNodeId: 'n_' + 'a'.repeat(64), roomId: f.room.id } }; await f.save();
    const before = await snapshot(f.root), report = await inspect(f.context, { binding: f.binding.alias }, { nativeFactory: () => { throw new Error('must not call'); } });
    assert.equal(report.exitCode, 1); assert.equal(report.overall, 'needs-review');
    const pending = report.checks.find(row => row.code === 'INBOX_PENDING'); assert.ok(pending); assert.equal(pending.scope.messageId, messageId);
    assert.equal(report.effects.nativeContact, false); assert.equal(report.effects.sshContact, false); assert.deepEqual(await snapshot(f.root), before);
  }
  for (const status of ['stored', 'native-admitted']) {
    f.store.inbox = { [messageId]: { status, eventId: 17, senderNodeId: 'n_' + 'a'.repeat(64), roomId: f.room.id } }; await f.save();
    const report = await inspect(f.context, { binding: f.binding.alias }); assert.equal(report.exitCode, 0); assert.equal(codes(report).includes('INBOX_PENDING'), false);
  }
});

test('valid metadata beyond the bounded control-record count is classified as a read limit, never corruption', async t => {
  const f = await fixture(t); f.store.inbox = Object.fromEntries(Array.from({ length: 1001 }, () => ['m_' + randomUUID(), { status: 'stored', eventId: 1 }])); await f.save();
  const before = await snapshot(f.root), report = await inspect(f.context, {});
  assert.equal(report.exitCode, 1); assert.ok(codes(report).includes('CONTROL_RECORD_LIMIT_EXCEEDED')); assert.equal(codes(report).includes('STORE_INVALID'), false);
  assert.match(report.checks.find(row => row.code === 'CONTROL_RECORD_LIMIT_EXCEEDED').message, /limit|bounded/i);
  assert.deepEqual(await snapshot(f.root), before);
});
