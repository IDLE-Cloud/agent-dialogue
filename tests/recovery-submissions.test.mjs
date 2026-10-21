import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode, payloadHash } from '../lib/node-identity.mjs';
import * as submissions from '../lib/submissions.mjs';
import * as mcpRecords from '../lib/mcp-send-record.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-recovery-submission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: root, binary: '/missing/native-and-hcom', env: {} };
  const node = await loadOrCreateNode(context);
  const store = await withStore(context, store => {
    for (const alias of ['alice', 'bob']) {
      const binding = createBinding(store, { alias, harness: 'codex-app-server', sessionId: `session-${alias}`, projectId: 'project', directory: '/work/project', serviceId: 'offline-service', origin: 'unix:/missing.sock' });
      binding.nodeId = node.nodeId;
    }
    createRoom(store, { name: 'Pinned recovery project', members: ['alice', 'bob'] });
    return store;
  });
  const room = Object.values(store.rooms)[0];
  const message = { room: room.id, from: 'alice', to: 'bob', text: 'A fixed recovery submission', expectedSession: store.bindings.bob.sessionId, replyTo: null };
  const submissionId = `q_${randomUUID()}`;
  return { context, node, store, room, message, submissionId };
}

test('preparation is pure, fixes one strict q ID, hashes the decoded request and pins both full identities and room', async t => {
  const f = await fixture(t);
  assert.equal(typeof submissions.prepareSubmission, 'function');
  const before = await readFile(join(f.context.stateDir, 'dialogue', 'store.json'));
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  assert.deepEqual(submissions.decodeSubmission(prepared.encoded), prepared.request);
  assert.equal(prepared.request.id, f.submissionId);
  assert.equal(prepared.submissionHash, payloadHash(prepared.request));
  assert.equal(prepared.endpoint, submissions.queueEndpoint(f.node));
  assert.deepEqual(prepared.pins.room, f.room);
  for (const key of ['id', 'revision', 'sessionId', 'directory', 'projectId', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId']) {
    assert.equal(prepared.pins.from[key], f.store.bindings.alice[key]);
    assert.equal(prepared.pins.to[key], f.store.bindings.bob[key]);
  }
  assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', 'store.json')), before);
  for (const submissionId of ['q_bad', `${f.submissionId}\n`, undefined]) {
    assert.throws(() => submissions.prepareSubmission(f.store, f.node, f.message, { submissionId }));
  }
});

test('fixed append reuses encoded q without allocation and reruns the external gate before each ledger operation', async t => {
  const f = await fixture(t), operations = [];
  assert.equal(typeof submissions.appendSubmission, 'function');
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  const before = await readFile(join(f.context.stateDir, 'dialogue', 'store.json'));
  const result = await submissions.appendSubmission(f.context, prepared, {
    beforeAppend: async () => { operations.push('verify'); await readStore(f.context); },
    hcomImpl: async (_, args) => { operations.push(args[0]); if (args[0] === 'send') assert.equal(args.at(-1), prepared.encoded); return args[0] === 'send' ? '{"event_id":17}' : ''; },
  });
  assert.deepEqual(operations, ['verify', 'start', 'verify', 'send']);
  assert.deepEqual(result, { status: 'queued', submissionId: f.submissionId, event_id: 17 });
  assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', 'store.json')), before);
});

test('every route identity and room pin is revalidated before fixed append', async t => {
  const f = await fixture(t);
  assert.equal(typeof submissions.prepareSubmission, 'function');
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  let calls = 0;
  const hcomImpl = async () => { calls++; return '{"event_id":1}'; };
  const changes = [
    store => { store.bindings.alice.origin = 'changed'; },
    store => { store.bindings.alice.projectId = 'changed'; },
    store => { store.bindings.bob.serviceId = 'changed'; },
    store => { store.bindings.bob.directory = '/work/changed'; },
    store => { store.rooms[f.room.id].manifestHash = '1'.repeat(64); },
    store => { store.rooms[f.room.id].ownerNodeId = `n_${'1'.repeat(64)}`; },
    store => { store.rooms[f.room.id].members[0].nodeId = `n_${'2'.repeat(64)}`; },
  ];
  for (const change of changes) {
    await withStore(f.context, store => { Object.assign(store, structuredClone(f.store)); change(store); });
    await assert.rejects(submissions.appendSubmission(f.context, prepared, { hcomImpl }), /pin|changed|stale|snapshot/i);
  }
  assert.equal(calls, 0);
});

test('a pin change between endpoint start and append prevents the send and retains the original fixed request', async t => {
  const f = await fixture(t), calls = [];
  assert.equal(typeof submissions.appendSubmission, 'function');
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  let verified = 0;
  await assert.rejects(submissions.appendSubmission(f.context, prepared, {
    beforeAppend: async () => { if (++verified === 2) await withStore(f.context, store => { store.bindings.bob.serviceId = 'changed-after-start'; }); },
    hcomImpl: async (_, args) => { calls.push(args[0]); return ''; },
  }), /pin|changed|stale|snapshot/i);
  assert.deepEqual(calls, ['start']); assert.equal(prepared.request.id, f.submissionId);
});

test('fixed append rejects altered body, hash, endpoint or pins before any local side effect', async t => {
  const f = await fixture(t);
  assert.equal(typeof submissions.prepareSubmission, 'function');
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  let calls = 0;
  const hcomImpl = async () => { calls++; return '{"event_id":1}'; };
  for (const change of [
    value => { value.request.text = 'altered'; },
    value => { value.encoded += ' '; },
    value => { value.submissionHash = '0'.repeat(64); },
    value => { value.endpoint = 'different'; },
    value => { value.pins.from.serviceId = 'different'; },
  ]) {
    const altered = structuredClone(prepared); change(altered);
    await assert.rejects(submissions.appendSubmission(f.context, altered, { hcomImpl }));
  }
  assert.equal(calls, 0);
});

test('durable MCP v2 records have a closed schema and exact source, room, q and receipt association', async t => {
  const f = await fixture(t);
  assert.equal(typeof mcpRecords.validateMcpSends, 'function');
  f.room.revision = 1; f.room.ownerNodeId = f.node.nodeId; f.room.manifestHash = '1'.repeat(64);
  for (const member of f.room.members) member.nodeId = f.node.nodeId;
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  const requestKey = 'fixed-record';
  const key = payloadHash({ bindingId: f.store.bindings.alice.id, revision: 1, requestKey });
  const row = { version: 2, bindingId: f.store.bindings.alice.id, bindingRevision: 1, roomId: f.room.id, requestKey, payloadHash: payloadHash(f.message), status: 'prepared', at: new Date().toISOString(), submissionId: f.submissionId, submissionHash: prepared.submissionHash, pins: prepared.pins };
  assert.deepEqual(mcpRecords.validateMcpSends({ [key]: row }), { [key]: row });
  const started = { ...row, status: 'append-started' }; mcpRecords.validateMcpSends({ [key]: started });
  const queued = { ...row, status: 'queued', result: { status: 'queued', submissionId: f.submissionId, event_id: 1, requestKey, dispatch: 'paused' } };
  mcpRecords.validateMcpSends({ [key]: queued });
  for (const alter of [
    value => { value.extra = true; },
    value => { delete value.submissionId; },
    value => { value.submissionId += '\n'; },
    value => { value.submissionHash = 'wrong'; },
    value => { value.status = 'unknown'; },
    value => { value.at = '2026-10-20'; },
    value => { value.bindingId = `b_${randomUUID()}`; },
    value => { value.pins.from.origin = ''; },
    value => { delete value.pins.from.sessionId; },
    value => { value.pins.from.extra = true; },
    value => { value.pins.room.members.pop(); },
    value => { value.pins.room.members[0].nodeId = `n_${'2'.repeat(64)}`; },
    value => { value.result.event_id = '1'; },
    value => { value.result.submissionId = `q_${randomUUID()}`; },
    value => { value.result.requestKey = 'different'; },
    value => { value.result.nativeAdmitted = true; },
  ]) {
    const changed = structuredClone(queued); alter(changed);
    assert.throws(() => mcpRecords.validateMcpSends({ [key]: changed }));
  }
  assert.throws(() => mcpRecords.validateMcpSends({ ['0'.repeat(64)]: row }));
  assert.throws(() => mcpRecords.validateMcpSends({ [key]: { ...row, result: queued.result } }));
  const historical = { legacy: { status: 'preparing', payloadHash: 'historical-without-q' } };
  assert.deepEqual(mcpRecords.validateMcpSends(historical), historical);
  assert.equal(mcpRecords.validateMcpSends(undefined), undefined);
});

test('an offline control-schema change after preparation cannot reuse old dispatch authorization', async t => {
  const f = await fixture(t), calls = [];
  const prepared = submissions.prepareSubmission(f.store, f.node, f.message, { submissionId: f.submissionId });
  let verified = 0;
  await assert.rejects(submissions.appendSubmission(f.context, prepared, {
    beforeAppend: async () => { if (++verified === 2) await withStore(f.context, store => { store.version = 2; store.lifecycle = {}; }); },
    hcomImpl: async (_, args) => { calls.push(args[0]); return '{"event_id":1}'; },
  }), /schema|version|changed/i);
  assert.deepEqual(calls, ['start']);
});
