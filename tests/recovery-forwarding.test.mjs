import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardQueued, verifyForwardingEvidence } from '../lib/recovery.mjs';
import { createBinding, createRoom, readStore, withStore, decodeFrame } from '../lib/bridge-store.mjs';
import { hcom, eventById, ledger } from '../lib/bridge.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { queueSubmission, decodeSubmission } from '../lib/submissions.mjs';
import { withDispatch } from '../lib/lifecycle.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ad-provenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const context = { stateDir: dir, ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded' } };
  const node = await loadOrCreateNode(context);
  const [binding, room] = await withStore(context, store => {
    store.version = 3; store.lifecycle = {}; store.forwardings = {};
    for (const alias of ['alice', 'bob']) {
      const b = createBinding(store, { alias, harness: 'opencode-v2', sessionId: `s_${alias}`, projectId: 'p', directory: dir, serviceId: 'fixture', origin: 'http://127.0.0.1:1' }); b.nodeId = node.nodeId;
    }
    return [store.bindings.alice, createRoom(store, { name: 'Fixture', members: ['alice', 'bob'] })];
  });
  await hcom(context, ['start', '--name', binding.hcomName]);
  await hcom(context, ['start', '--name', (await readStore(context)).bindings.bob.hcomName]);
  const queued = await queueSubmission(context, { room: room.id, from: 'alice', to: 'bob', text: 'One exact project question' });
  const event = await eventById(context, queued.event_id), request = decodeSubmission(event.data.text), state = { cursor: 0, receipts: {} };
  const persist = async () => {}; // This file tests forwarding; runtime publication has separate contracts.
  const forward = options => withDispatch(context, binding, ({ permit }) => forwardQueued(context, binding, request, event, state, { persist, nativeVerify: async () => {}, permit, ...options }));
  return { context, binding, room, event, request, state, forward };
}
test('v3 forwarding persists exact provenance before one formal append and keeps bodies out of metadata', async t => {
  const f = await fixture(t); let appended = 0;
  const result = await f.forward({ appendLocalImpl: async (context, args, { defaultAppend }) => {
    appended++; const row = (await readStore(context)).forwardings[f.request.id];
    assert.equal(row.phase, 'append-started'); assert.equal(f.state.outgoingPending.dispatchId, row.dispatchId);
    return defaultAppend();
  } });
  const row = (await readStore(f.context)).forwardings[f.request.id];
  assert.equal(row.phase, 'forwarded'); assert.equal(row.formalEventId, result.event_id); assert.equal(appended, 1);
  assert.equal(JSON.stringify(row).includes(f.request.text), false); assert.equal(f.state.outgoingPending, undefined);
  assert.equal(decodeFrame((await eventById(f.context, result.event_id)).data.text).forwardingId, row.dispatchId);
  await f.forward({ appendLocalImpl: async () => assert.fail('no second append') });
});
test('lost append response leaves one formal event and read-only evidence recovers the exact association', async t => {
  const f = await fixture(t); let appended = 0;
  await assert.rejects(f.forward({ appendLocalImpl: async (_, __, { defaultAppend }) => { appended++; await defaultAppend(); throw Error('lost response'); } }), e => e.uncertain);
  const row = (await readStore(f.context)).forwardings[f.request.id];
  assert.equal(row.phase, 'append-started'); assert.ok(f.state.outgoingPending);
  const proof = await verifyForwardingEvidence(f.context, f.binding, row);
  assert.equal(proof.status, 'verified'); assert.equal(proof.result.event_id, (await ledger(f.context)).at(-1).id);
  await assert.rejects(f.forward(), e => e.uncertain); assert.equal(appended, 1);
});
test('runtime persistence failure prevents formal append, while old unassociated pending stays untouched', async t => {
  const f = await fixture(t);
  await assert.rejects(f.forward({ persist: async () => { throw Error('disk failed'); }, appendLocalImpl: async () => assert.fail() }), e => e.uncertain);
  assert.equal((await readStore(f.context)).forwardings[f.request.id].phase, 'prepared');
  assert.equal((await ledger(f.context)).length, 1);
  const before = structuredClone(f.state); await assert.rejects(f.forward(), e => e.uncertain); assert.deepEqual(f.state, before);
});
