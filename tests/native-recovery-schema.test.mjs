import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBinding, createRoom, readStore, validateStore, withStore } from '../lib/bridge-store.mjs';
import { lifecycleState, pauseBinding, upgradeStoreOffline, withDispatch } from '../lib/lifecycle.mjs';
import { inspect } from '../lib/inspect.mjs';
import { readSource } from '../lib/viewer/readers/local.mjs';
import { acceptObservation, exportObservation } from '../lib/viewer/observation.mjs';
import { makeObservationFixture } from './fixtures/viewer-observation-fixture.mjs';
import { inputId } from '../lib/native-admission.mjs';
import { appendSubmission, prepareSubmission, validatePreparedSubmission } from '../lib/submissions.mjs';
import { createDialogueMcpTools, createMcpScope } from '../lib/mcp-tools.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { sealRoom } from '../lib/nodes.mjs';
import { hcom, ledger } from '../lib/bridge.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';

// Windows runs real permission checks. This whole-test budget is provisional
// until platform evidence; the production private-path deadline stays unchanged.
const options = { timeout: process.platform === 'win32' ? 180000 : 15000 };
async function fixture(t, version = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-native-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { stateDir: join(directory, 'state'), cacheDir: join(directory, 'cache'), ledgerBackend: 'embedded', env: { PATH: '' } };
  const value = await withStore(context, store => {
    if (version >= 2) { store.version = version; store.lifecycle = {}; }
    if (version >= 3) store.forwardings = {};
    if (version >= 4) store.nativeIntents = {};
    const make = alias => createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'fixture-project', directory, serviceId: 'fixture-service', origin: 'http://127.0.0.1:4567' });
    const binding = make('selected'); make('peer'); const room = createRoom(store, { name: 'Native schema fixture', members: ['selected', 'peer'] });
    return { binding, room };
  });
  return { context, directory, path: join(context.stateDir, 'dialogue', 'store.json'), ...value };
}
function row(binding, room, phase = 'prepared') {
  const id = inputId(binding, 17);
  return { version: 1, inputId: id, eventId: 17, bindingId: binding.id, bindingRevision: binding.revision, roomId: room.id, eventHash: 'a'.repeat(64), frameHash: 'b'.repeat(64), bindingHash: 'c'.repeat(64), routeHash: 'd'.repeat(64), promptHash: 'e'.repeat(64), rendererVersion: 1, phase, attemptId: randomUUID(), attempt: 1, createdAt: '2026-10-20T00:00:00.000Z', receipt: phase === 'admitted' ? { status: 'admitted', inputId: id, reconciled: true, sessionId: binding.sessionId, at: '2026-10-20T00:00:01.000Z' } : null, recovery: null };
}
function checkpoint(record) {
  return { version: 1, id: randomUUID(), phase: 'runtime-prepared', preHash: '1'.repeat(64), postHash: '2'.repeat(64), pendingHash: '3'.repeat(64), ownerHash: '4'.repeat(64), lifecycleGeneration: 1, lifecycleNonce: randomUUID(), receipt: structuredClone(record.receipt) };
}
const save = (f, store) => writeFile(f.path, JSON.stringify(store), { mode: 0o600 });
const codes = report => report.checks.map(value => value.code);

async function mcpFixture(t, { storeVersion = 4, appendImpl } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-native-schema-mcp-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceFile = join(directory, 'private', 'zcode.json'); await createZCodeService({ path: serviceFile, directory, zcodeVersion: '3.14.3' });
  const client = await ZCodeToolsClient.discover({ serviceFile }), main = { session_id: 'sess_native_schema_mcp', workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' }, requestMeta = { ...main, 'com.zcode/request-context': { ...main } }, session = await client.register(requestMeta);
  const context = { stateDir: join(directory, 'state'), cacheDir: join(directory, 'cache'), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile } };
  await initializeEmbedded(context); const node = await loadOrCreateNode(context); let self, peer, room;
  await withStore(context, store => {
    self = createBinding(store, { alias: 'self', harness: 'zcode-tools', sessionId: session.id, projectId: session.projectID, directory, serviceId: client.identity.serviceId, origin: client.identity.origin });
    peer = createBinding(store, { alias: 'peer', harness: 'opencode-v2', sessionId: 'ses_peer', projectId: 'fixture-peer', directory, serviceId: 'fixture-peer', origin: 'http://127.0.0.1:4567' });
    self.nodeId = peer.nodeId = node.nodeId; room = createRoom(store, { name: 'Native compatibility MCP fixture', members: ['self', 'peer'] });
  });
  room = await sealRoom(context, room); await withStore(context, store => { store.version = storeVersion; store.lifecycle = {}; store.forwardings = {}; if (storeVersion === 4) store.nativeIntents = {}; });
  for (const binding of [self, peer]) await hcom(context, ['start', '--name', binding.hcomName]);
  const scopeFile = join(directory, 'private', 'scope.json'); await writeFile(scopeFile, JSON.stringify(await createMcpScope(context, { room: room.id, from: self.alias })), { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(scopeFile);
  const tools = await createDialogueMcpTools(context, { scopeFile, serviceFile, appendImpl }), args = { to: peer.alias, message: 'Keep one exact queued submission', requestKey: 'schema-compatible' };
  return { context, self, args, call: () => tools.callTool('dialogue_send', args, { requestMeta }) };
}

for (const version of [1, 2, 3]) test(`explicit v${version} to v4 preserves all old maps and runtime pending without fabricating native intent`, options, async t => {
  const f = await fixture(t, version), store = await readStore(f.context);
  store.mcpSends = { historical: { status: 'preparing', requestKey: 'legacy-private' } }; store.outbox = { historical: { status: 'unknown' } }; await save(f, store);
  const runtimePath = join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.json`), runtimeBytes = '{"status":"stopped","pending":{"eventId":17,"inputId":"legacy-without-hashes"},"receipts":{}}\n';
  await writeFile(runtimePath, runtimeBytes, { mode: 0o600 });
  assert.deepEqual(await upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 }), { version: 4, upgraded: true });
  const upgraded = await readStore(f.context);
  assert.deepEqual(upgraded, { ...store, version: 4, lifecycle: store.lifecycle ?? {}, forwardings: store.forwardings ?? {}, nativeIntents: {} });
  assert.equal(await readFile(runtimePath, 'utf8'), runtimeBytes);
  const before = await readFile(f.path);
  assert.deepEqual(await upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 }), { version: 4, upgraded: false });
  assert.deepEqual(await readFile(f.path), before);
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true }), { code: 'STATE_DOWNGRADE_UNSUPPORTED' });
  assert.deepEqual(await readFile(f.path), before);
});

test('v4 is explicit, rejects legacy nativeIntents conflicts and retains all offline lock and launch gates', options, async t => {
  const f = await fixture(t), store = await readStore(f.context); store.nativeIntents = { unknown: { text: 'PRIVATE_LEGACY_NATIVE' } }; await save(f, store);
  const before = await readFile(f.path);
  await assert.rejects(upgradeStoreOffline(f.context, { targetVersion: 4 }), { code: 'OFFLINE_REQUIRED' });
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 }), { code: 'STATE_FEATURE_CONFLICT' });
  assert.deepEqual(await readFile(f.path), before); delete store.nativeIntents; await save(f, store);
  for (const suffix of ['dispatch.lock', 'worker.lock']) {
    const path = join(f.context.stateDir, 'dialogue', `${f.binding.id}.${suffix}`); await mkdir(path);
    await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 }), { code: 'STATE_NOT_QUIESCENT' }); await rm(path, { recursive: true });
  }
  await withStore(f.context, live => { live.workerLaunches = { [f.binding.id]: { phase: 'launching' } }; });
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 }, { assertQuiescent: async () => {} }), { code: 'STATE_NOT_QUIESCENT' });
});

test('v4 requires closed native intent maps and validators reject unsupported future versions', options, async t => {
  const f = await fixture(t), value = { ...await readStore(f.context), version: 4, nativeIntents: {} };
  assert.equal(validateStore(value), value);
  for (const change of [v => { delete v.nativeIntents; }, v => { v.nativeIntents = null; }, v => { v.nativeIntents = []; }, v => { v.version = 5; }]) { const bad = structuredClone(value); change(bad); assert.throws(() => validateStore(bad)); }
});

test('native intent phase, ID, hash, attempt and receipt contracts are closed and pure', options, async t => {
  const f = await fixture(t), { validateNativeIntents } = await import('../lib/native-record.mjs');
  for (const phase of ['prepared', 'submit-started', 'not-submitted', 'admitted']) { const record = row(f.binding, f.room, phase); assert.equal(validateNativeIntents({ [record.inputId]: record })[record.inputId], record); }
  const good = row(f.binding, f.room, 'admitted'); good.receipt.globalMessageId = `m_${randomUUID()}`; good.recovery = checkpoint(good);
  // Deep equality of these primitive closed receipt fields is order independent.
  good.recovery.receipt = Object.fromEntries(Object.entries(good.receipt).reverse()); validateNativeIntents({ [good.inputId]: good });
  good.recovery.phase = 'runtime-committed'; validateNativeIntents({ [good.inputId]: good });
  const changes = [v => { v.extra = 'PRIVATE_NATIVE_SECRET'; }, v => { delete v.frameHash; }, v => { v.version = 2; }, v => { v.rendererVersion = 2; }, v => { v.inputId += '\n'; }, v => { v.bindingId = 'bad'; }, v => { v.roomId = 'bad'; }, v => { v.bindingRevision = 0; }, v => { v.eventId = '17'; }, v => { v.eventHash += '\n'; }, v => { v.promptHash = 'bad'; }, v => { v.createdAt = '2026-10-20'; }, v => { v.attemptId += '\n'; }, v => { v.attempt = 0; }, v => { v.phase = 'unknown'; }, v => { v.receipt.extra = true; }, v => { v.receipt.reconciled = 1; }, v => { v.receipt.inputId = 'msg_' + 'f'.repeat(32); }, v => { v.receipt.sessionId = ''; }, v => { v.receipt.globalMessageId = 'bad'; }, v => { v.recovery.extra = true; }, v => { v.recovery.receipt.at = '2026-10-20T00:00:02.000Z'; }, v => { v.recovery.lifecycleNonce += '\n'; }, v => { v.recovery.lifecycleGeneration = 0; }];
  for (const change of changes) { const bad = structuredClone(good); change(bad); assert.throws(() => validateNativeIntents({ [good.inputId]: bad }), { code: 'NATIVE_INTENT_INVALID' }); }
  assert.throws(() => validateNativeIntents({ ['msg_' + 'f'.repeat(32)]: good }), { code: 'NATIVE_INTENT_INVALID' });
  for (const phase of ['prepared', 'submit-started', 'not-submitted']) { const bad = { ...structuredClone(good), phase }; assert.throws(() => validateNativeIntents({ [bad.inputId]: bad }), { code: 'NATIVE_INTENT_INVALID' }); }
  const missing = { ...structuredClone(good), receipt: null }; assert.throws(() => validateNativeIntents({ [missing.inputId]: missing }), { code: 'NATIVE_INTENT_INVALID' });
});

test('v4 uses the same private lifecycle and persistent paused dispatch gate', options, async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true, targetVersion: 4 });
  const result = await pauseBinding(f.context, f.binding.alias); assert.equal(result.lifecycle.desired, 'paused');
  assert.equal(lifecycleState(await readStore(f.context), f.binding).desired, 'paused');
  await assert.rejects(withDispatch(f.context, f.binding, () => assert.fail('paused native dispatch')), { code: 'BINDING_PAUSED' });
});

test('inspect v4 publishes only closed phase counts and unfinished checkpoint diagnostics', options, async t => {
  const f = await fixture(t), store = { ...await readStore(f.context), version: 4, nativeIntents: {} };
  const record = row(f.binding, f.room, 'admitted'); record.recovery = checkpoint(record); store.nativeIntents[record.inputId] = record; store.privateNotes = { body: 'PRIVATE_NATIVE_BODY', token: 'PRIVATE_NATIVE_TOKEN' }; await save(f, store);
  const before = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
  assert.ok(codes(report).includes('STORE_VALID')); assert.ok(codes(report).includes('NATIVE_RECOVERY_PENDING')); assert.equal(report.overall, 'needs-review');
  assert.deepEqual(report.nativeIntents, { version: 1, total: 1, phases: { prepared: 0, 'submit-started': 0, 'not-submitted': 0, admitted: 1 }, unrecognized: 0 });
  for (const secret of [record.inputId, record.attemptId, record.promptHash, record.recovery.lifecycleNonce, 'PRIVATE_NATIVE_BODY', 'PRIVATE_NATIVE_TOKEN']) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await readFile(f.path), before);
  store.nativeIntents[record.inputId].attempt = 0; await save(f, store); const invalid = await inspect(f.context);
  assert.ok(codes(invalid).includes('NATIVE_INTENT_INVALID')); assert.equal(invalid.overall, 'blocked');
});

test('local v4 viewer and scoped observation omit raw native records, hashes and unscoped summaries', options, async t => {
  const f = await fixture(t), store = { ...await readStore(f.context), version: 4, nativeIntents: {} }, record = row(f.binding, f.room);
  store.nativeIntents[record.inputId] = record; await save(f, store);
  const db = new DatabaseSync(join(f.context.stateDir, 'hcom.db')); db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, instance TEXT, data TEXT)'); db.close();
  const before = await readFile(f.path), source = await readSource({ id: 'fixture', label: 'Fixture', path: f.context.stateDir });
  assert.equal(source.store.version, 4); assert.equal(source.store.nativeIntents, undefined); assert.equal(source.store.nativeIntentSummary.total, 1); assert.equal(JSON.stringify(source).includes(record.inputId), false); assert.deepEqual(await readFile(f.path), before);
  const observed = makeObservationFixture(1), binding = observed.source.store.bindings.bob, native = row(binding, observed.room);
  Object.assign(observed.source.store, { version: 4, lifecycle: {}, forwardings: {}, nativeIntents: { [native.inputId]: native }, nativeIntentSummary: { total: 999 } });
  const envelope = exportObservation(observed.source, observed.request), accepted = acceptObservation(envelope, observed.request);
  assert.equal(accepted.store.version, 4); assert.equal(accepted.store.nativeIntents, undefined); assert.equal(accepted.store.nativeIntentSummary, undefined); assert.equal(JSON.stringify(envelope).includes(native.inputId), false);
  observed.source.store.nativeIntents[native.inputId].attempt = 0; assert.throws(() => exportObservation(observed.source, observed.request));
});

test('prepared submissions remain bound to exact initial schema when both v3 and v4 are supported', options, async t => {
  const f = await fixture(t), store = await readStore(f.context), node = { nodeId: 'n_' + 'a'.repeat(64) };
  for (const binding of Object.values(store.bindings)) binding.nodeId = node.nodeId;
  const prepared = prepareSubmission(store, node, { room: f.room.id, from: 'selected', to: 'peer', text: 'Exact schema guard' }, { submissionId: `q_${randomUUID()}` });
  assert.equal(validatePreparedSubmission(store, node, prepared).storeVersion, 3);
  const upgraded = { ...store, version: 4, nativeIntents: {} }; assert.throws(() => validatePreparedSubmission(upgraded, node, prepared), /schema changed/i);
  const next = prepareSubmission(upgraded, node, { room: f.room.id, from: 'selected', to: 'peer', text: 'Exact schema guard' }, { submissionId: prepared.request.id });
  assert.equal(validatePreparedSubmission(upgraded, node, next).storeVersion, 4);
});

test('v4 MCP keeps one durable fixed q and retains tool-pull behavior without inventing native intents', options, async t => {
  let calls = 0;
  const f = await mcpFixture(t, { appendImpl: async (context, prepared, options) => { calls++; assert.equal(prepared.storeVersion, 4); return appendSubmission(context, prepared, options); } });
  const first = await f.call(), repeated = await f.call(); assert.equal(first.isError, undefined); assert.deepEqual(repeated, first); assert.equal(calls, 1);
  const store = await readStore(f.context), records = Object.values(store.mcpSends);
  assert.equal(records.length, 1); assert.equal(records[0].version, 2); assert.equal(records[0].status, 'queued'); assert.equal(records[0].submissionId, first.structuredContent.submissionId); assert.deepEqual(store.nativeIntents, {}); assert.equal((await ledger(f.context)).length, 1);
});

test('a v3 MCP assigned snapshot cannot cross the supported v4 schema fence before its initial claim', options, async t => {
  let calls = 0; const f = await mcpFixture(t, { storeVersion: 3, appendImpl: async () => { calls++; assert.fail('stale schema must not append'); } });
  const original = ZCodeToolsClient.prototype.session; let changed = false;
  ZCodeToolsClient.prototype.session = async function(id) { const result = await original.call(this, id); if (id === f.self.sessionId && !changed) { changed = true; await withStore(f.context, store => { store.version = 4; store.nativeIntents = {}; }); } return result; };
  t.after(() => { ZCodeToolsClient.prototype.session = original; });
  assert.equal((await f.call()).isError, true); assert.equal(calls, 0); assert.deepEqual((await readStore(f.context)).mcpSends ?? {}, {}); assert.equal((await ledger(f.context)).length, 0);
});

test('a claimed v3 MCP append cannot cross to v4 and later retries preserve its original unknown q', options, async t => {
  let calls = 0;
  const f = await mcpFixture(t, { storeVersion: 3, appendImpl: async (context, prepared, options) => { calls++; await withStore(context, store => { store.version = 4; store.nativeIntents = {}; }); return appendSubmission(context, prepared, options); } });
  assert.equal((await f.call()).structuredContent.status, 'pending');
  const record = Object.values((await readStore(f.context)).mcpSends)[0]; assert.equal(record.status, 'append-started');
  assert.equal((await f.call()).structuredContent.status, 'pending'); assert.equal(calls, 1); assert.deepEqual(Object.values((await readStore(f.context)).mcpSends)[0], record); assert.equal((await ledger(f.context)).length, 0);
});
