import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createBinding, createRoom, withStore } from '../lib/bridge-store.mjs';
import { forwardSubmission, deliveryPrompt } from '../lib/bridge.mjs';

async function fixture(t) {
  const context = { stateDir: await mkdtemp(join(tmpdir(), 'dialogue-forward-')) };
  t.after(() => rm(context.stateDir, { recursive: true, force: true }));
  const nodeId = 'n_' + '1'.repeat(64);
  const [a, b, room] = await withStore(context, store => {
    const make = alias => {
      const binding = createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'p', directory: '/tmp/project', serviceId: 'service', origin: 'http://127.0.0.1:1234' });
      binding.nodeId = nodeId; return binding;
    };
    const a = make('alice'), b = make('bob');
    return [a, b, createRoom(store, { name: 'Project', members: ['alice', 'bob'] })];
  });
  const request = { version: 1, id: `q_${randomUUID()}`, room: room.id, from: a.alias, to: b.alias, fromBindingId: a.id, toBindingId: b.id, fromRevision: 1, toRevision: 1, expectedSession: b.sessionId, replyTo: null, text: 'Project question' };
  const event = { id: 42, type: 'message', data: { from: a.hcomName, sender_kind: 'instance', thread: room.id, intent: 'request', delivered_to: [`submit${nodeId.slice(2, 18)}`] } };
  return { context, binding: a, request, event };
}

test('background forwarding persists before native or network work and records a receipt', async t => {
  const f = await fixture(t), state = { receipts: {} }, calls = [], snapshots = [];
  const result = await forwardSubmission(f.context, f.binding, f.request, f.event, state, {
    persist: async value => { calls.push('persist'); snapshots.push(structuredClone(value)); },
    send: async (_context, options) => { calls.push('send'); assert.equal(options.from, 'alice'); assert.equal(options.to, 'bob'); return { event_id: 99 }; },
  });
  assert.deepEqual(calls, ['persist', 'send', 'persist']);
  assert.equal(snapshots[0].outgoingPending.submissionId, f.request.id);
  assert.equal(JSON.stringify(snapshots).includes(f.request.text), false);
  assert.equal(state.outgoingPending, undefined);
  assert.equal(state.receipts[42].status, 'forwarded');
  assert.deepEqual(result, { event_id: 99 });
  await forwardSubmission(f.context, f.binding, f.request, f.event, state, { persist: async () => assert.fail(), send: async () => assert.fail() });
});

test('uncertain forwarding and failed persistence never trigger a second send', async t => {
  const f = await fixture(t), state = { receipts: {} }; let sends = 0;
  const options = { persist: async () => {}, send: async () => { sends++; throw new Error('Disconnected'); } };
  await assert.rejects(forwardSubmission(f.context, f.binding, f.request, f.event, state, options), error => error.uncertain === true);
  await assert.rejects(forwardSubmission(f.context, f.binding, f.request, f.event, state, options), error => error.uncertain === true);
  assert.equal(sends, 1); assert.ok(state.outgoingPending);
  const fresh = { receipts: {} };
  await assert.rejects(forwardSubmission(f.context, f.binding, f.request, f.event, fresh, { persist: async () => { throw new Error('Disk unavailable'); }, send: async () => assert.fail() }), /no forwarding was attempted/);
});

test('forged source and stale request are rejected before saving forwarding intent', async t => {
  const f = await fixture(t), options = { persist: async () => assert.fail(), send: async () => assert.fail() };
  await assert.rejects(forwardSubmission(f.context, f.binding, f.request, { ...f.event, data: { ...f.event.data, sender_kind: 'external' } }, { receipts: {} }, options));
  await assert.rejects(forwardSubmission(f.context, f.binding, { ...f.request, toRevision: 2 }, f.event, { receipts: {} }, options));
});

test('Codex peer instructions use the local-only queue rather than native API access', () => {
  const text = deliveryPrompt({ stateDir: '/tmp/project/communication', env: {} }, { alias: 'codex-a', harness: 'codex-app-server', sessionId: 'example' }, { room: 'r_example', from: 'peer', text: 'Question', replyTo: null }, { id: 10 });
  assert.match(text, /collab send --queue/);
  assert.match(text, /background bridge performs native checks and network delivery/);
  assert.match(text, /not peer delivery/);
});
