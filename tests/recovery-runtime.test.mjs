import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';
import { eventById, hcom, ledger, saveRuntime, workerRuntimeSnapshot } from '../lib/bridge.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { pauseBinding, withDispatch } from '../lib/lifecycle.mjs';
import { decodeSubmission, queueSubmission } from '../lib/submissions.mjs';
import { forwardQueued, reconcileSubmission } from '../lib/recovery.mjs';

// These are real control/runtime files and real embedded ledger events. The
// injected owner probe is synthetic; no fixture claims OS process ownership.
// Each case performs several real private-path ACL checks on Windows, including
// a complete fixture forward and two recovery checkpoints. Per-operation
// permission deadlines remain unchanged; this bounds the whole contract.
const options = { timeout: process.platform === 'win32' ? 180000 : 15000 };
const fakeDead = async () => 'confirmed-dead';
const interrupted = stage => Object.assign(new Error(`fixture interruption at ${stage}`), { code: 'FIXTURE_INTERRUPTED' });
const uncertain = error => error.code === 'FORWARDING_NEEDS_REVIEW' && error.uncertain === true;

async function fixture(t, { status = 'stopped' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-recovery-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { stateDir: directory, ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded' } };
  const node = await loadOrCreateNode(context);
  const { binding, room, peer } = await withStore(context, store => {
    store.version = 3; store.lifecycle = {}; store.forwardings = {};
    for (const alias of ['alice', 'bob']) {
      const b = createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'fixture-project', directory, serviceId: 'fixture-service', origin: 'http://127.0.0.1:1' });
      b.nodeId = node.nodeId;
    }
    return { binding: store.bindings.alice, peer: store.bindings.bob, room: createRoom(store, { name: 'Runtime recovery fixture', members: ['alice', 'bob'] }) };
  });
  for (const b of [binding, peer]) await hcom(context, ['start', '--name', b.hcomName]);
  const queued = await queueSubmission(context, { room: room.id, from: binding.alias, to: peer.alias, text: 'Preserve this exact queued project question.' });
  const event = await eventById(context, queued.event_id), request = decodeSubmission(event.data.text);
  const state = {
    cursor: 37, receipts: { 19: { status: 'admitted', inputId: 'synthetic-prior-input', sessionId: binding.sessionId, fixture: 'preserve-exactly' } },
    nativePending: { eventId: 41, inputId: 'synthetic-unrelated-pending', phase: 'prepared', fixture: ['preserve', 'all', 'fields'] },
    pending: { eventId: 43, status: 'prepared', fixture: 'unrelated-incoming' },
    fixture: { ownership: 'injected-probe-only', retained: true },
  };
  let appends = 0, nativeChecks = 0;
  await assert.rejects(forwardQueued(context, binding, request, event, state, {
    persist: value => saveRuntime(context, binding.id, value),
    nativeVerify: async () => { nativeChecks++; },
    appendLocalImpl: async (_, __, { defaultAppend }) => {
      appends++; await defaultAppend(); throw new Error('fixture loses the real formal append receipt');
    },
  }), uncertain);
  assert.equal(appends, 1); assert.equal(nativeChecks, 1);
  const events = await ledger(context), formalEventId = events.at(-1).id;
  assert.equal(events.length, 2);
  state.pid = 912345; state.token = randomUUID(); state.status = status;
  if (status === 'error') state.error = 'fixture uncertain append outcome';
  await saveRuntime(context, binding.id, state);
  await withStore(context, store => {
    store.workerLaunches = { [binding.id]: { version: 1, bindingRevision: binding.revision, token: state.token, pid: state.pid, phase: 'stopped' } };
  });
  await pauseBinding(context, binding.alias);
  const runtimePath = join(directory, 'dialogue', `${binding.id}.worker.json`), storePath = join(directory, 'dialogue', 'store.json');
  const runtime = async () => (await workerRuntimeSnapshot(context, binding.id)).state;
  const reconcile = (overrides = {}) => reconcileSubmission(context, binding.alias, request.id, { probe: fakeDead, ...overrides });
  const before = { state: structuredClone(state), runtime: await readFile(runtimePath), store: await readFile(storePath) };
  return { context, binding, peer, room, request, event, formalEventId, runtimePath, storePath, before, runtime, reconcile, get appends() { return appends; }, get nativeChecks() { return nativeChecks; } };
}

async function assertRepaired(f, { status = f.before.state.status } = {}) {
  const state = await f.runtime(), store = await readStore(f.context), row = store.forwardings[f.request.id];
  const expected = structuredClone(f.before.state);
  delete expected.outgoingPending; expected.receipts[f.event.id] = row.recovery.receipt;
  assert.deepEqual(state, expected);
  assert.equal(state.status, status); assert.equal(state.cursor, 37);
  assert.equal(state.outgoingPending, undefined);
  assert.deepEqual(state.nativePending, f.before.state.nativePending);
  assert.deepEqual(state.pending, f.before.state.pending);
  assert.deepEqual(state.receipts[19], f.before.state.receipts[19]);
  assert.equal(row.phase, 'forwarded'); assert.equal(row.formalEventId, f.formalEventId);
  assert.equal(row.recovery.phase, 'runtime-committed'); assert.equal(row.recovery.receipt.result.event_id, f.formalEventId);
  assert.equal(store.lifecycle[f.binding.id].desired, 'paused');
  assert.deepEqual(store.bindings[f.binding.alias], f.binding); assert.deepEqual(store.bindings[f.peer.alias], f.peer);
  assert.equal((await ledger(f.context)).length, 2); assert.equal(f.appends, 1); assert.equal(f.nativeChecks, 1);
}

test('runtime reconciliation repairs one exact lost receipt and repeat reconciliation is byte-idempotent', options, async t => {
  const f = await fixture(t), result = await f.reconcile();
  assert.deepEqual(result, { status: 'reconciled', submissionId: f.request.id, event_id: f.formalEventId, runtimeChanged: true, cursorPreserved: true, resumed: false });
  await assertRepaired(f);
  const runtime = await readFile(f.runtimePath), store = await readFile(f.storePath);
  assert.equal((await f.reconcile()).runtimeChanged, false);
  assert.deepEqual(await readFile(f.runtimePath), runtime); assert.deepEqual(await readFile(f.storePath), store);
  await assertRepaired(f);
});

test('confirmed-dead error runtime is repairable without clearing the worker error or advancing its cursor', options, async t => {
  const f = await fixture(t, { status: 'error' });
  assert.equal((await f.reconcile()).status, 'reconciled');
  await assertRepaired(f, { status: 'error' });
  assert.equal((await f.runtime()).error, 'fixture uncertain append outcome');
});

for (const stage of ['control-committed', 'runtime-published']) {
  test(`interruption after ${stage} preserves a retryable two-file checkpoint without a second append`, options, async t => {
    const f = await fixture(t), hooks = [];
    await assert.rejects(f.reconcile({ checkpointHook: async point => {
      hooks.push(point); if (point === stage) throw interrupted(stage);
    } }), { code: 'FIXTURE_INTERRUPTED' });
    const store = await readStore(f.context), row = store.forwardings[f.request.id];
    assert.equal(row.phase, 'forwarded'); assert.equal(row.recovery.phase, 'runtime-prepared');
    assert.equal(hooks.at(-1), stage);
    if (stage === 'control-committed') assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
    else { assert.equal((await f.runtime()).outgoingPending, undefined); assert.equal((await f.runtime()).cursor, 37); }
    const checkpoint = structuredClone(row.recovery);
    const result = await f.reconcile(); assert.equal(result.runtimeChanged, stage === 'control-committed');
    await assertRepaired(f);
    const committed = (await readStore(f.context)).forwardings[f.request.id].recovery;
    assert.deepEqual(committed, { ...checkpoint, phase: 'runtime-committed' });
    assert.equal((await f.reconcile()).runtimeChanged, false); await assertRepaired(f);
  });
}

test('reconciliation owns source D while short control transactions remain available between checkpoints', options, async t => {
  const f = await fixture(t); let checked = 0;
  await f.reconcile({ checkpointHook: async stage => {
    if (stage !== 'control-committed') return;
    await assert.rejects(withDispatch(f.context, f.binding, () => assert.fail('source dispatch must remain held'), { allowPaused: true, timeoutMs: 0 }), { code: 'DISPATCH_BUSY' });
    await withStore(f.context, store => { assert.equal(store.forwardings[f.request.id].recovery.phase, 'runtime-prepared'); });
    checked++;
  } });
  assert.equal(checked, 1); await assertRepaired(f);
});

test('a runtime changed after control commit is preserved and cannot be overwritten by recovery', options, async t => {
  const f = await fixture(t); let changed;
  await assert.rejects(f.reconcile({ checkpointHook: async stage => {
    if (stage !== 'control-committed') return;
    changed = await f.runtime(); changed.cursor++; changed.fixture.externalChange = 'preserve-tampered-runtime';
    await saveRuntime(f.context, f.binding.id, changed);
  } }), uncertain);
  assert.deepEqual(await f.runtime(), changed);
  const store = await readFile(f.storePath), runtime = await readFile(f.runtimePath);
  await assert.rejects(f.reconcile(), uncertain);
  assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(f.runtimePath), runtime);
  assert.equal((await ledger(f.context)).length, 2); assert.equal(f.appends, 1);
});

test('a runtime changed after publication prevents checkpoint completion and is preserved on retry', options, async t => {
  const f = await fixture(t); let changed;
  await assert.rejects(f.reconcile({ checkpointHook: async stage => {
    if (stage !== 'runtime-published') return;
    changed = await f.runtime(); changed.nativePending.fixture.push('external-change-after-publication');
    await saveRuntime(f.context, f.binding.id, changed);
  } }), uncertain);
  assert.deepEqual(await f.runtime(), changed);
  assert.equal((await readStore(f.context)).forwardings[f.request.id].recovery.phase, 'runtime-prepared');
  const store = await readFile(f.storePath), runtime = await readFile(f.runtimePath);
  await assert.rejects(f.reconcile(), uncertain);
  assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(f.runtimePath), runtime);
  assert.equal((await ledger(f.context)).length, 2);
});

test('runtime publication failure preserves the original preimage and the same checkpoint can be retried', options, async t => {
  const f = await fixture(t); let publications = 0;
  await assert.rejects(f.reconcile({ publishRuntime: async () => { publications++; throw interrupted('runtime-write'); } }), { code: 'FIXTURE_INTERRUPTED' });
  assert.equal(publications, 1); assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
  assert.equal((await readStore(f.context)).forwardings[f.request.id].recovery.phase, 'runtime-prepared');
  await f.reconcile(); await assertRepaired(f);
});

test('live and unknown synthetic owner probes reject stopped and error runtimes without any repair', options, async t => {
  for (const status of ['stopped', 'error']) {
    const f = await fixture(t, { status });
    for (const evidence of ['owned-live', 'different-live', 'unknown']) {
      await assert.rejects(f.reconcile({ probe: async () => evidence }), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
      assert.deepEqual(await readFile(f.runtimePath), f.before.runtime); assert.deepEqual(await readFile(f.storePath), f.before.store);
      assert.equal((await ledger(f.context)).length, 2);
    }
  }
});

test('owner evidence becoming unknown after control commit blocks runtime publication', options, async t => {
  const f = await fixture(t); let probes = 0;
  await assert.rejects(f.reconcile({ probe: async () => ++probes < 3 ? 'confirmed-dead' : 'unknown' }), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
  assert.equal(probes, 3); assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
  assert.equal((await readStore(f.context)).forwardings[f.request.id].recovery.phase, 'runtime-prepared');
  await f.reconcile(); await assertRepaired(f);
});

test('a lifecycle nonce change after control commit blocks publication and preserves its checkpoint', options, async t => {
  const f = await fixture(t); let changedStore;
  await assert.rejects(f.reconcile({ checkpointHook: async stage => {
    if (stage !== 'control-committed') return;
    await withStore(f.context, store => { const lc = store.lifecycle[f.binding.id]; lc.generation++; lc.changeNonce = randomUUID(); });
    changedStore = await readFile(f.storePath);
  } }), uncertain);
  assert.deepEqual(await readFile(f.runtimePath), f.before.runtime); assert.deepEqual(await readFile(f.storePath), changedStore);
  await assert.rejects(f.reconcile(), uncertain);
  assert.deepEqual(await readFile(f.runtimePath), f.before.runtime); assert.deepEqual(await readFile(f.storePath), changedStore);
  assert.equal((await ledger(f.context)).length, 2);
});

for (const evidence of ['worker-lock', 'scheduled-launch']) {
  test(`${evidence} appearing after control commit blocks runtime publication and retains the evidence`, options, async t => {
    const f = await fixture(t);
    const path = evidence === 'worker-lock'
      ? join(f.context.stateDir, 'dialogue', `${f.binding.id}.worker.lock`)
      : join(f.context.stateDir, 'dialogue', 'windows-workers', `${f.binding.id}.${f.before.state.token}.launch.json`);
    await assert.rejects(f.reconcile({ checkpointHook: async stage => {
      if (stage === 'control-committed') await mkdir(path, { recursive: true, mode: 0o700 });
    } }), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
    assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
    const store = await readFile(f.storePath);
    await assert.rejects(f.reconcile(), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
    assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
    assert.equal((await ledger(f.context)).length, 2);
  });
}

test('a mismatched stopped launch token cannot authorize repair of the original runtime', options, async t => {
  const f = await fixture(t);
  await withStore(f.context, store => { store.workerLaunches[f.binding.id].token = randomUUID(); });
  const store = await readFile(f.storePath);
  await assert.rejects(f.reconcile(), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
  assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
  assert.equal((await ledger(f.context)).length, 2);
});

test('missing or unsupported stopped launch version cannot authorize runtime repair', options, async t => {
  const f = await fixture(t);
  for (const version of [undefined, 2]) {
    await withStore(f.context, store => {
      const launch = store.workerLaunches[f.binding.id];
      if (version === undefined) delete launch.version;
      else launch.version = version;
    });
    const store = await readFile(f.storePath);
    await assert.rejects(f.reconcile(), { code: 'RECOVERY_WORKER_NOT_STOPPED' });
    assert.deepEqual(await readFile(f.storePath), store); assert.deepEqual(await readFile(f.runtimePath), f.before.runtime);
    assert.equal((await ledger(f.context)).length, 2);
  }
});
