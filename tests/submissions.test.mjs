import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { decodeSubmission, ensureSubmissionEndpoint, isSubmission, queueEndpoint, queueSubmission, validateSubmission } from '../lib/submissions.mjs';

const prefix = 'agent-dialogue/submit/1\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-submission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: root, binary: '/missing/native-and-hcom', env: { AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: '/missing/service.json', AGENT_DIALOGUE_CODEX_SOCKET: '/missing/native.sock' } };
  const node = await loadOrCreateNode(context);
  const store = await withStore(context, store => {
    const make = alias => createBinding(store, { alias, harness: 'codex-app-server', sessionId: `session-${alias}`, projectId: `project-${alias}`, directory: '/work/project', serviceId: 'unreachable-service', origin: 'unix:/missing/native.sock' });
    make('alice').nodeId = node.nodeId;
    make('bob').nodeId = node.nodeId;
    make('outsider').nodeId = node.nodeId;
    createRoom(store, { name: 'Existing project', members: ['alice', 'bob'] });
    return store;
  });
  const alice = store.bindings.alice, bob = store.bindings.bob, room = Object.values(store.rooms)[0];
  const request = { version: 1, id: `q_${randomUUID()}`, room: room.id, from: 'alice', to: 'bob', fromBindingId: alice.id, toBindingId: bob.id, fromRevision: 1, toRevision: 1, expectedSession: bob.sessionId, replyTo: null, text: 'Use the existing project context.' };
  const event = { id: 42, type: 'message', data: { from: alice.hcomName, sender_kind: 'instance', delivered_to: [queueEndpoint(node)], thread: room.id, intent: 'request', text: prefix + JSON.stringify(request) } };
  return { context, node, store, alice, bob, room, request, event };
}

test('queues literal text using only the local ledger when every native service is offline', async t => {
  const f = await fixture(t), calls = [];
  const controlPath = join(f.context.stateDir, 'dialogue', 'store.json');
  const before = await readFile(controlPath, 'utf8');
  const text = "Keep '$HOME', `commands`, $(commands), newlines\nand 中文 literal.";
  const hcomImpl = async (context, args) => { assert.equal(context, f.context); calls.push(args); return args[0] === 'send' ? '{"event_id":77}' : ''; };
  const result = await queueSubmission(f.context, { room: f.room.id, from: 'alice', to: 'bob', text }, { hcomImpl });
  assert.deepEqual(calls[0], ['start', '--name', queueEndpoint(f.node)]);
  assert.deepEqual(calls[1].slice(0, 11), ['send', '--json', '--name', f.alice.hcomName, `@${queueEndpoint(f.node)}`, '--thread', f.room.id, '--intent', 'request', '--', calls[1][10]]);
  const request = decodeSubmission(calls[1][10]);
  assert.equal(request.text, text);
  assert.equal(request.expectedSession, f.bob.sessionId);
  assert.equal(request.fromBindingId, f.alice.id);
  assert.equal(request.toBindingId, f.bob.id);
  assert.equal(request.replyTo, null);
  assert.deepEqual(result, { status: 'queued', submissionId: request.id, event_id: 77 });
  assert.equal(await readFile(controlPath, 'utf8'), before, 'message body and send state must not be written to the control store');
  assert.deepEqual(await readStore(f.context), f.store);
});

test('endpoint creation is local, stable and separately usable by attach', async t => {
  const f = await fixture(t), calls = [];
  assert.equal(await ensureSubmissionEndpoint(f.context, { hcomImpl: async (_, args) => calls.push(args) }), queueEndpoint(f.node));
  assert.deepEqual(calls, [['start', '--name', queueEndpoint(f.node)]]);
  assert.equal(queueEndpoint(f.node), `submit${f.node.nodeId.slice(2, 18)}`);
  for (const node of [{}, { nodeId: 'n_short' }, { nodeId: [f.node.nodeId] }, { nodeId: `${f.node.nodeId}\n` }]) assert.throws(() => queueEndpoint(node), /valid local node/);
});

test('queueing pins the current destination and refuses operator, remote or wrong-node sources before append', async t => {
  const f = await fixture(t);
  const options = { room: f.room.id, from: 'alice', to: 'bob', text: 'Question' };
  let calls = 0;
  const hcomImpl = async () => { calls++; return '{"event_id":1}'; };
  await assert.rejects(queueSubmission(f.context, { ...options, from: 'operator' }, { hcomImpl }), /Operator/);
  await assert.rejects(queueSubmission(f.context, { ...options, expectedSession: 'different-session' }, { hcomImpl }), /Expected session/);
  await assert.rejects(queueSubmission(f.context, { ...options, from: 'outsider' }, { hcomImpl }), /not a member/);
  await withStore(f.context, store => { store.bindings.alice.remote = true; });
  await assert.rejects(queueSubmission(f.context, options, { hcomImpl }), /different node/);
  await withStore(f.context, store => { delete store.bindings.alice.remote; store.bindings.alice.nodeId = `n_${'0'.repeat(64)}`; });
  await assert.rejects(queueSubmission(f.context, options, { hcomImpl }), /different node/);
  assert.equal(calls, 0);
});

test('submission schema rejects unknown fields, malformed identifiers, invalid revisions and oversized text', async t => {
  const f = await fixture(t);
  assert.equal(isSubmission(prefix + 'bad json'), true, 'malformed queue frames must be handled as submissions and rejected');
  assert.equal(isSubmission('agent-dialogue/1\n{}'), false);
  assert.deepEqual(decodeSubmission(prefix + JSON.stringify(f.request)), f.request);
  for (const patch of [
    { extra: true }, { version: 2 }, { id: `m_${randomUUID()}` }, { id: [f.request.id] },
    { room: `${f.room.id}\n` }, { fromBindingId: 'b_wrong' }, { toBindingId: null },
    { from: 'operator' }, { from: 'Alice' }, { from: 'alice\n' }, { to: 'bob\n' }, { to: 'alice' },
    { fromRevision: 0 }, { toRevision: 1.1 }, { expectedSession: '' },
    { text: ' ' }, { text: 'x'.repeat(40001) }, { text: 'hidden\0text' },
    { replyTo: '' }, { replyTo: 42 },
  ]) assert.throws(() => decodeSubmission(prefix + JSON.stringify({ ...f.request, ...patch })), undefined, JSON.stringify(patch));
  const missing = { ...f.request }; delete missing.replyTo;
  assert.throws(() => decodeSubmission(prefix + JSON.stringify(missing)), /fields/);
  assert.throws(() => decodeSubmission('wrong protocol'), /Unframed/);
  assert.throws(() => decodeSubmission(prefix + '{'), /JSON/);
  assert.throws(() => decodeSubmission(prefix + ' '.repeat(120000)), /120000 bytes/);
});

test('encoded UTF-8 and JSON escaping limits reject oversized argv before any hcom operation', async t => {
  const f = await fixture(t);
  let calls = 0;
  const hcomImpl = async () => { calls++; return '{"event_id":1}'; };
  for (const text of ['中'.repeat(40000), '\u0001'.repeat(30000)]) {
    assert.ok(text.length <= 40000);
    const encoded = prefix + JSON.stringify({ ...f.request, text });
    assert.ok(Buffer.byteLength(encoded, 'utf8') > 120000);
    assert.throws(() => decodeSubmission(encoded), /120000 bytes/);
    await assert.rejects(queueSubmission(f.context, { room: f.room.id, from: 'alice', to: 'bob', text }, { hcomImpl }), /120000 bytes/);
  }
  assert.equal(calls, 0);
});

test('source worker validates exact current source, destination, room and actual ledger sender', async t => {
  const f = await fixture(t);
  assert.deepEqual(validateSubmission(f.store, f.alice, f.request, f.event), { room: f.room.id, from: 'alice', to: 'bob', text: f.request.text, expectedSession: f.bob.sessionId, replyTo: null });
  for (const field of ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId', 'remote']) {
    const changed = { ...f.alice, [field]: field === 'revision' ? 2 : field === 'active' ? false : field === 'remote' ? true : 'changed' };
    assert.throws(() => validateSubmission(f.store, changed, f.request, f.event), /different|stale|remote|node/, field);
  }
  for (const patch of [{ from: f.bob.hcomName }, { sender_kind: 'external' }, { delivered_to: [] }, { delivered_to: 'not-an-array' }, { delivered_to: ['somewhere-else'] }, { thread: 'wrong-room' }, { intent: 'inform' }]) {
    assert.throws(() => validateSubmission(f.store, f.alice, f.request, { ...f.event, data: { ...f.event.data, ...patch } }), /sender|addressed|room\/intent/);
  }
  assert.throws(() => validateSubmission(f.store, f.alice, f.request, { ...f.event, type: 'status' }), /sender/);
  for (const patch of [{ fromBindingId: `b_${randomUUID()}` }, { toBindingId: `b_${randomUUID()}` }, { fromRevision: 2 }, { toRevision: 2 }, { expectedSession: 'new-session' }, { from: 'outsider' }, { to: 'outsider' }, { room: `r_${randomUUID()}` }]) {
    assert.throws(() => validateSubmission(f.store, f.alice, { ...f.request, ...patch }, f.event), /stale|mismatched|session|member|Unknown/);
  }
});

test('a live route that changed after queue append cannot authorize old requests', async t => {
  const f = await fixture(t);
  for (const alter of [
    store => { store.bindings.alice.active = false; },
    store => { store.bindings.alice.remote = true; },
    store => { store.bindings.alice.origin = 'changed-service-origin'; },
    store => { store.bindings.bob.revision++; },
    store => { store.bindings.bob.sessionId = 'different-session'; },
    store => { store.rooms[f.room.id].members = store.rooms[f.room.id].members.filter(member => member.alias !== 'alice'); },
  ]) {
    const store = structuredClone(f.store); alter(store);
    assert.throws(() => validateSubmission(store, f.alice, f.request, f.event));
  }
});

test('native and remote reply identifiers are preserved for the later full send gate', async t => {
  const f = await fixture(t);
  for (const replyTo of ['42', `m_${randomUUID()}`]) {
    const request = { ...f.request, replyTo };
    assert.equal(decodeSubmission(prefix + JSON.stringify(request)).replyTo, replyTo);
    assert.equal(validateSubmission(f.store, f.alice, request, f.event).replyTo, replyTo);
  }
});

test('queue append errors are surfaced without native fallback or automatic retries', async t => {
  const f = await fixture(t), options = { room: f.room.id, from: 'alice', to: 'bob', text: 'Question' };
  let appends = 0;
  await assert.rejects(queueSubmission(f.context, options, { hcomImpl: async (_, args) => { if (args[0] === 'send') { appends++; throw new Error('Lost local append response'); } return ''; } }), /Lost local append/);
  assert.equal(appends, 1);
  await assert.rejects(queueSubmission(f.context, options, { hcomImpl: async (_, args) => args[0] === 'send' ? '{"event_id":"wrong"}' : '' }), /invalid event ID/);
});
