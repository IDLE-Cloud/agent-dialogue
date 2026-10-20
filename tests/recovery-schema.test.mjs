import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createBinding, createRoom, readStore, validateStore, withStore } from '../lib/bridge-store.mjs';
import { lifecycleState, pauseBinding, resumeBinding, resumeSnapshot, upgradeStoreOffline, withDispatch } from '../lib/lifecycle.mjs';
import { inspect } from '../lib/inspect.mjs';
import { readSource } from '../lib/viewer/readers/local.mjs';
import { exportObservation, acceptObservation } from '../lib/viewer/observation.mjs';
import { makeObservationFixture } from './fixtures/viewer-observation-fixture.mjs';
import { payloadHash } from '../lib/node-identity.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-recovery-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { PATH: '' } };
  const saved = await withStore(context, store => {
    const make = alias => createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'fixture-project', directory: join(root, 'project'), serviceId: 'fixture-service', origin: 'http://127.0.0.1:4567' });
    const binding = make('selected'); make('peer');
    const room = createRoom(store, { name: 'Recovery fixture', members: ['selected', 'peer'] });
    return { binding, room };
  });
  const directory = join(context.stateDir, 'dialogue'), path = join(directory, 'store.json');
  return { root, context, directory, path, ...saved };
}
const row = (binding, room, phase = 'prepared') => {
  const complete = phase === 'forwarded', stored = complete || phase === 'local-stored';
  return { version: 1, submissionId: `q_${randomUUID()}`, submissionEventId: 17, submissionHash: 'a'.repeat(64), bindingId: binding.id, bindingRevision: binding.revision,
    roomId: room.id, routeHash: 'b'.repeat(64), kind: 'local', dispatchId: randomUUID(), phase, frameHash: 'c'.repeat(64), formalEventId: stored ? 29 : null,
    result: complete ? { event_id: 29 } : null, createdAt: '2026-10-20T00:00:00.000Z', messageId: null, payloadHash: null, recovery: null };
};
const stateV3 = async f => ({ ...await readStore(f.context), version: 3, lifecycle: {}, forwardings: {} });
const save = (f, store) => writeFile(f.path, JSON.stringify(store), { mode: 0o600 });
const codes = report => report.checks.map(check => check.code);
const paused = binding => ({ version: 1, bindingRevision: binding.revision, desired: 'paused', generation: 3, changeNonce: randomUUID(), changedAt: '2026-10-20T00:00:00.000Z', reason: 'operator-pause' });
function mcpRecord(store, binding, room, status) {
  const nodeId = 'n_' + 'a'.repeat(64), requestKey = 'recovery-fixture';
  const from = { ...binding, nodeId }, to = { ...store.bindings.peer, nodeId };
  const pins = { from, to, room: { ...room, revision: 1, ownerNodeId: nodeId, manifestHash: 'f'.repeat(64), members: room.members.map(member => ({ ...member, nodeId })) } };
  const record = { version: 2, bindingId: binding.id, bindingRevision: binding.revision, roomId: room.id, requestKey, payloadHash: 'd'.repeat(64), status, at: '2026-10-20T00:00:00.000Z', submissionId: `q_${randomUUID()}`, submissionHash: 'e'.repeat(64), pins };
  if (status === 'queued') record.result = { status, submissionId: record.submissionId, event_id: 31, requestKey };
  return [payloadHash({ bindingId: binding.id, revision: binding.revision, requestKey }), record];
}

test('target 3 is explicit and preserves exact legacy identity, pending, receipts and external file bytes', async t => {
  const f = await fixture(t), original = await readStore(f.context);
  original.mcpSends = { historical: { status: 'preparing', requestKey: 'legacy-key', payloadHash: 'd'.repeat(64) } };
  original.outbox = { historical: { status: 'unknown', eventId: 19 } }; await save(f, original);
  const runtime = join(f.directory, `${f.binding.id}.worker.json`), node = join(f.directory, 'node.json');
  const runtimeBytes = '{"cursor":12,"status":"stopped","pending":{"eventId":13},"outgoingPending":{"eventId":17,"submissionId":"legacy"},"receipts":{"11":{"status":"forwarded"}}}\n';
  const nodeBytes = '{"preserved":"opaque original identity bytes"}\n';
  await writeFile(runtime, runtimeBytes); await writeFile(node, nodeBytes);
  await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 });
  const upgraded = await readStore(f.context);
  assert.equal(upgraded.version, 3); assert.deepEqual(upgraded.lifecycle, {}); assert.deepEqual(upgraded.forwardings, {});
  for (const key of ['bindings', 'rooms', 'outbox', 'mcpSends']) assert.deepEqual(upgraded[key], original[key]);
  assert.equal(await readFile(runtime, 'utf8'), runtimeBytes); assert.equal(await readFile(node, 'utf8'), nodeBytes);
});

test('default target remains 2; v2 to v3 keeps lifecycle and repeat v3 is idempotent without permitting downgrade', async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true });
  assert.equal((await readStore(f.context)).version, 2);
  await pauseBinding(f.context, 'selected'); const before = await readStore(f.context);
  assert.deepEqual(await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }), { version: 3, upgraded: true });
  const upgraded = await readStore(f.context); assert.deepEqual(upgraded.lifecycle, before.lifecycle);
  const bytes = await readFile(f.path);
  assert.deepEqual(await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }), { version: 3, upgraded: false });
  assert.deepEqual(await readFile(f.path), bytes);
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true }), { code: 'STATE_DOWNGRADE_UNSUPPORTED' });
  assert.deepEqual(await readFile(f.path), bytes);
});

test('v3 rejects missing/malformed lifecycle or provenance maps and malformed forwarding rows without guessing', async t => {
  const f = await fixture(t), valid = await stateV3(f), forward = row(f.binding, f.room);
  valid.forwardings[forward.submissionId] = forward;
  assert.equal(validateStore(valid), valid);
  for (const change of [s => { delete s.lifecycle; }, s => { s.lifecycle = []; }, s => { delete s.forwardings; }, s => { s.forwardings = null; }, s => { s.forwardings = []; }, s => { s.forwardings[forward.submissionId].dispatchId = 'not-a-uuid'; }, s => { s.forwardings[forward.submissionId].token = 'PRIVATE_TOKEN'; }]) {
    const value = structuredClone(valid); change(value);
    assert.throws(() => validateStore(value));
  }
});

test('a preexisting legacy provenance field is a feature conflict rather than silently cleared or trusted', async t => {
  const f = await fixture(t), original = await readStore(f.context);
  original.forwardings = { unproven: { body: 'UNPROVEN_PRIVATE_BODY', phase: 'prepared' } }; await save(f, original);
  const bytes = await readFile(f.path);
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }), { code: 'STATE_FEATURE_CONFLICT' });
  assert.deepEqual(await readFile(f.path), bytes);
});

test('offline target validation and existing lock/launch/worker evidence cannot be bypassed by target 3', async t => {
  const f = await fixture(t), bytes = await readFile(f.path);
  await assert.rejects(upgradeStoreOffline(f.context, { targetVersion: 3 }), { code: 'OFFLINE_REQUIRED' });
  for (const targetVersion of [1, 4, '3', null]) await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion }), { code: 'INVALID_UPGRADE_TARGET' });
  for (const suffix of ['worker.lock', 'dispatch.lock']) {
    const path = join(f.directory, `${f.binding.id}.${suffix}`); await mkdir(path);
    await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }), { code: 'STATE_NOT_QUIESCENT' });
    await rm(path, { recursive: true });
  }
  await withStore(f.context, store => { store.workerLaunches = { [f.binding.id]: { phase: 'launching' } }; });
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }, { assertQuiescent: async () => {} }), { code: 'STATE_NOT_QUIESCENT' });
  await withStore(f.context, store => { delete store.workerLaunches; });
  const runtime = join(f.directory, `${f.binding.id}.worker.json`); await writeFile(runtime, '{"pid":912345,"status":"ready"}');
  await assert.rejects(upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 }), { code: 'STATE_NOT_QUIESCENT' });
  assert.deepEqual(await readFile(f.path), bytes);
});

test('v3 keeps persistent pause/resume generation and dispatch gates instead of defaulting to enabled', async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 });
  const original = await readStore(f.context), pausedResult = await pauseBinding(f.context, 'selected');
  assert.equal(pausedResult.lifecycle.desired, 'paused');
  await assert.rejects(withDispatch(f.context, f.binding, () => assert.fail('paused dispatch')), { code: 'BINDING_PAUSED' });
  const snapshot = resumeSnapshot(await readStore(f.context), f.binding);
  await resumeBinding(f.context, 'selected', { snapshot });
  const after = await readStore(f.context);
  assert.equal(lifecycleState(after, f.binding).desired, 'enabled'); assert.equal(lifecycleState(after, f.binding).generation, 2);
  assert.deepEqual(after.bindings, original.bindings); assert.deepEqual(after.rooms, original.rooms);
});

test('v3 transactions retain private-directory enforcement', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 });
  const before = await readFile(f.path); await chmod(f.directory, 0o755);
  await assert.rejects(withStore(f.context, () => {}), { code: 'INVALID_LOCK_PATH' });
  assert.deepEqual(await readFile(f.path), before);
});

test('oversize UTF-8 control metadata is rejected before publication and retains the original store and unrelated evidence', async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 });
  const limit = 16 * 1024 * 1024, original = await readFile(f.path), evidence = join(f.directory, '.store-unrelated.tmp');
  await writeFile(evidence, 'UNRELATED_PRIVATE_EVIDENCE', { mode: 0o600 });
  const padding = '\u754c'.repeat(Math.ceil(limit / 3)); let appendCalls = 0;
  assert.ok(padding.length < limit); assert.ok(Buffer.byteLength(padding, 'utf8') >= limit);
  await assert.rejects((async () => {
    await withStore(f.context, store => { store.privatePadding = padding; });
    appendCalls++;
  })(), { code: 'CONTROL_STORE_TOO_LARGE' });
  assert.equal(appendCalls, 0); assert.deepEqual(await readFile(f.path), original);
  assert.equal(await readFile(evidence, 'utf8'), 'UNRELATED_PRIVATE_EVIDENCE');
  assert.deepEqual((await readdir(f.directory)).filter(name => name === '.lock' || name.startsWith('.store-')).sort(), ['.store-unrelated.tmp']);
  assert.equal((await readStore(f.context)).version, 3);
});

test('the full serialized UTF-8 control store accepts exactly 16 MiB and rejects the next byte without replacing it', async t => {
  const f = await fixture(t); await upgradeStoreOffline(f.context, { offline: true, targetVersion: 3 });
  const limit = 16 * 1024 * 1024, candidate = await readStore(f.context); candidate.privatePadding = '';
  const padding = 'a'.repeat(limit - Buffer.byteLength(JSON.stringify(candidate, null, 2) + '\n', 'utf8'));
  await withStore(f.context, store => { store.privatePadding = padding; });
  assert.equal((await stat(f.path)).size, limit); assert.equal((await readStore(f.context)).privatePadding, padding);
  const original = await readFile(f.path);
  await assert.rejects(withStore(f.context, store => { store.privatePadding += 'a'; }), { code: 'CONTROL_STORE_TOO_LARGE' });
  assert.deepEqual(await readFile(f.path), original);
  assert.deepEqual((await readdir(f.directory)).filter(name => name === '.lock' || name.startsWith('.store-')), []);
});

test('inspect v3 exposes only closed forwarding phase counts and preserves source bytes', async t => {
  const f = await fixture(t), store = await stateV3(f); store.lifecycle[f.binding.id] = paused(f.binding);
  for (const phase of ['prepared', 'append-started', 'local-stored', 'forwarded']) { const value = row(f.binding, f.room, phase); store.forwardings[value.submissionId] = value; }
  store.privateRecoveryNotes = { token: 'PRIVATE_RECOVERY_TOKEN', text: 'PRIVATE_RECOVERY_BODY' }; await save(f, store);
  const bytes = await readFile(f.path), report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('FORWARDING_PENDING'));
  assert.deepEqual(report.forwardings, { version: 1, total: 4, phases: { prepared: 1, 'append-started': 1, 'local-stored': 1, forwarded: 1 }, unrecognized: 0 });
  assert.equal(report.bindings[0].lifecycle.desired, 'paused');
  const serialized = JSON.stringify(report);
  for (const secret of ['PRIVATE_RECOVERY_TOKEN', 'PRIVATE_RECOVERY_BODY', store.lifecycle[f.binding.id].changeNonce, ...Object.keys(store.forwardings)]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(await readFile(f.path), bytes); assert.equal(report.effects.sourceWrites, false); assert.equal(report.effects.nativeContact, false);
});

test('inspect recognizes v3 MCP prepared/append-started as pending while preserving legacy preparing semantics', async t => {
  const f = await fixture(t), store = await stateV3(f);
  store.privateRecoveryNotes = { token: 'PRIVATE_MCP_TOKEN', text: 'PRIVATE_MCP_BODY' };
  for (const status of ['prepared', 'append-started', 'queued', 'preparing']) {
    const [key, record] = status === 'preparing' ? ['privateKey', { status, token: 'PRIVATE_MCP_TOKEN', text: 'PRIVATE_MCP_BODY' }] : mcpRecord(store, f.binding, f.room, status);
    store.mcpSends = { [key]: record }; await save(f, store);
    const report = await inspect(f.context);
    assert.ok(codes(report).includes('STORE_VALID'));
    assert.ok(!codes(report).includes('CONTROL_STATUS_UNSUPPORTED'));
    if (['prepared', 'append-started'].includes(status)) assert.ok(codes(report).includes('MCP_SEND_PENDING'));
    if (status === 'preparing') assert.ok(codes(report).includes('MCP_SEND_PREPARING'));
    for (const secret of ['PRIVATE_MCP_TOKEN', 'PRIVATE_MCP_BODY', 'privateKey']) assert.equal(JSON.stringify(report).includes(secret), false);
  }
});

test('malformed v3 MCP provenance blocks with its own fixed diagnostic and preserves private evidence', async t => {
  const f = await fixture(t), store = await stateV3(f), [key, record] = mcpRecord(store, f.binding, f.room, 'prepared');
  record.text = 'PRIVATE_INVALID_MCP_BODY'; store.mcpSends = { [key]: record }; await save(f, store);
  const before = await readFile(f.path), report = await inspect(f.context);
  assert.equal(report.overall, 'blocked'); assert.ok(codes(report).includes('MCP_SEND_INVALID'));
  for (const secret of [key, record.submissionId, record.text]) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await readFile(f.path), before);
});

test('a forwarded result with a runtime-prepared checkpoint stays needs-review without exposing checkpoint identities', async t => {
  const f = await fixture(t), store = await stateV3(f), forward = row(f.binding, f.room, 'forwarded');
  forward.recovery = { version: 1, id: randomUUID(), phase: 'runtime-prepared', preHash: '1'.repeat(64), postHash: '2'.repeat(64), pendingHash: '3'.repeat(64), ownerHash: '4'.repeat(64), lifecycleGeneration: 1, lifecycleNonce: randomUUID(), receipt: { status: 'forwarded', submissionId: forward.submissionId, result: { event_id: 29 }, at: '2026-10-20T00:00:00.000Z' } };
  store.forwardings[forward.submissionId] = forward; await save(f, store); const before = await readFile(f.path);
  const report = await inspect(f.context, { binding: f.binding.alias });
  assert.equal(report.overall, 'needs-review'); assert.ok(codes(report).includes('FORWARDING_RECOVERY_PENDING'));
  assert.equal(report.forwardings.phases.forwarded, 1);
  for (const secret of [forward.recovery.id, forward.recovery.lifecycleNonce, forward.recovery.preHash, forward.submissionId]) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual(await readFile(f.path), before);
});

test('local viewer reads v3 with closed counts and lifecycle without publishing raw provenance', async t => {
  const f = await fixture(t), store = await stateV3(f); store.lifecycle[f.binding.id] = paused(f.binding);
  const forward = row(f.binding, f.room); store.forwardings[forward.submissionId] = forward; await save(f, store);
  const database = new DatabaseSync(join(f.context.stateDir, 'hcom.db'));
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp TEXT, type TEXT, instance TEXT, data TEXT)'); database.close();
  const bytes = await readFile(f.path), source = await readSource({ id: 'fixture', label: 'Fixture', path: f.context.stateDir });
  assert.equal(source.available, true); assert.ok(!source.diagnostics.some(row => row.code === 'invalid-store'));
  assert.equal(source.store.version, 3); assert.equal(source.store.lifecycle[f.binding.id].desired, 'paused');
  assert.equal(source.store.forwardingSummary.total, 1); assert.equal(source.store.forwardings, undefined);
  assert.equal(JSON.stringify(source).includes(forward.submissionId), false); assert.equal(JSON.stringify(source).includes(store.lifecycle[f.binding.id].changeNonce), false);
  assert.deepEqual(await readFile(f.path), bytes);
});

test('scoped v3 observation preserves lifecycle but exports neither raw provenance nor unscoped activity counts', () => {
  const f = makeObservationFixture(1), binding = f.source.store.bindings.bob;
  f.source.store.version = 3; f.source.store.lifecycle = { [binding.id]: paused(binding) };
  const forward = row(binding, f.room); f.source.store.forwardings = { [forward.submissionId]: forward };
  f.source.store.forwardingSummary = { version: 1, total: 99, phases: { prepared: 99, 'append-started': 0, 'local-stored': 0, forwarded: 0 }, unrecognized: 0 };
  const envelope = exportObservation(f.source, f.request), accepted = acceptObservation(envelope, f.request);
  assert.equal(accepted.store.version, 3); assert.equal(accepted.store.lifecycle[binding.id].desired, 'paused');
  assert.equal(accepted.store.forwardings, undefined); assert.equal(accepted.store.forwardingSummary, undefined);
  assert.equal(JSON.stringify(envelope).includes(forward.submissionId), false); assert.equal(JSON.stringify(envelope).includes(f.source.store.lifecycle[binding.id].changeNonce), false);
});
