import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, chmod, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';
import { lifecycleState, requireEnabled, withDispatch, pauseBinding, resumeSnapshot, resumeBinding, upgradeStoreOffline } from '../lib/lifecycle.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';

async function fixture(t, upgrade = true) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-lifecycle-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir };
  const binding = await withStore(context, store => {
    const a = createBinding(store, { alias: 'first', harness: 'test', serviceId: 'service', sessionId: 'one', projectId: 'project', directory: '/project', origin: 'test' });
    createBinding(store, { alias: 'second', harness: 'test', serviceId: 'service', sessionId: 'two', projectId: 'project', directory: '/project', origin: 'test' });
    createRoom(store, { name: 'test', members: ['first', 'second'] });
    return structuredClone(a);
  });
  if (process.platform === 'win32') await protectWindowsPrivatePath(join(stateDir, 'dialogue'), { directory: true });
  if (upgrade) await upgradeStoreOffline(context, { offline: true });
  return { context, binding, stateDir, dialogue: join(stateDir, 'dialogue') };
}

test('legacy stores remain readable and enabled but cannot pause without explicit upgrade', async t => {
  const { context, binding } = await fixture(t, false);
  assert.equal((await readStore(context)).version, 1);
  assert.equal(lifecycleState(await readStore(context), binding).desired, 'enabled');
  await withDispatch(context, binding, ({ binding: live }) => assert.equal(live.id, binding.id));
  await assert.rejects(pauseBinding(context, 'first'), { code: 'LIFECYCLE_UPGRADE_REQUIRED' });
  assert.equal((await readStore(context)).version, 1);
});

test('offline migration is explicit, idempotent, and preserves identities and room pins', async t => {
  const { context, binding } = await fixture(t, false);
  const before = await readStore(context);
  await assert.rejects(upgradeStoreOffline(context, {}), { code: 'OFFLINE_REQUIRED' });
  await upgradeStoreOffline(context, { offline: true });
  const after = await readStore(context);
  assert.equal(after.version, 2); assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.rooms, before.rooms);
  assert.deepEqual(after.lifecycle, {}); assert.equal(requireEnabled(after, binding).id, binding.id);
  await upgradeStoreOffline(context, { offline: true });
  assert.deepEqual(await readStore(context), after);
});

test('migration refuses known runtime evidence and live launch reservations without touching source', async t => {
  const { context, binding, dialogue } = await fixture(t, false);
  const runtime = join(dialogue, `${binding.id}.worker.json`);
  await writeFile(runtime, JSON.stringify({ status: 'ready', pid: 999999 }));
  const before = await readFile(join(dialogue, 'store.json'), 'utf8');
  await assert.rejects(upgradeStoreOffline(context, { offline: true }), { code: 'STATE_NOT_QUIESCENT' });
  assert.equal(await readFile(join(dialogue, 'store.json'), 'utf8'), before);
  let checked = false;
  await upgradeStoreOffline(context, { offline: true }, { assertQuiescent: async () => { checked = true; } });
  assert.equal(checked, true);
  await withStore(context, store => { store.workerLaunches = { [binding.id]: { phase: 'launching' } }; });
  await assert.rejects(upgradeStoreOffline(context, { offline: true }, { assertQuiescent: async () => {} }), { code: 'STATE_NOT_QUIESCENT' });
});

test('v1 lifecycle smuggling and malformed v2 lifecycle rows fail closed', async t => {
  const { context, binding, dialogue } = await fixture(t, false);
  const path = join(dialogue, 'store.json'), original = await readStore(context);
  for (const value of [
    { ...original, lifecycle: {} },
    { ...original, version: 2 },
    { ...original, version: 2, lifecycle: { [binding.id]: { version: 1, desired: 'paused' } } },
    { ...original, version: 2, lifecycle: {}, workerLaunches: [] },
  ]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readStore(context), /Invalid dialogue control store/);
  }
});

test('pause is idempotent, preserves binding/room/runtime bytes and blocks only selected binding', async t => {
  const { context, binding, dialogue } = await fixture(t);
  const runtime = join(dialogue, `${binding.id}.worker.json`), bytes = '{"cursor":37,"pending":{"eventId":38},"receipts":{}}\n';
  await writeFile(runtime, bytes);
  const before = await readStore(context);
  const paused = await pauseBinding(context, 'first');
  assert.equal(paused.lifecycle.desired, 'paused'); assert.equal(paused.lifecycle.generation, 1);
  const state = await readStore(context);
  assert.deepEqual(state.bindings, before.bindings); assert.deepEqual(state.rooms, before.rooms);
  assert.equal(await readFile(runtime, 'utf8'), bytes);
  assert.deepEqual(await pauseBinding(context, 'first'), paused);
  await assert.rejects(withDispatch(context, binding, () => assert.fail('paused callback ran')), { code: 'BINDING_PAUSED' });
  await withDispatch(context, 'second', ({ binding: live }) => assert.equal(live.alias, 'second'));
});

test('pause waits for the preceding bounded action and prevents all subsequent actions', async t => {
  const { context, binding } = await fixture(t);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let entered; const firstEntered = new Promise(resolve => { entered = resolve; });
  const events = [];
  const first = withDispatch(context, binding, async () => { events.push('first-start'); entered(); await waiting; events.push('first-end'); });
  await firstEntered;
  const pause = pauseBinding(context, 'first').then(() => events.push('paused'));
  await new Promise(resolve => setTimeout(resolve, 40)); assert.deepEqual(events, ['first-start']);
  release(); await Promise.all([first, pause]);
  await assert.rejects(withDispatch(context, binding, () => events.push('late')), { code: 'BINDING_PAUSED' });
  assert.deepEqual(events, ['first-start', 'first-end', 'paused']);
});

test('dispatch busy is bounded, never steals stale locks, and keeps pause uncommitted', async t => {
  const { context, binding, dialogue } = await fixture(t);
  let release, entered; const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const running = withDispatch(context, binding, async () => { entered(); await gate; });
  await ready;
  await assert.rejects(pauseBinding(context, 'first', { timeoutMs: 15 }), { code: 'DISPATCH_BUSY' });
  assert.equal(lifecycleState(await readStore(context), binding).desired, 'enabled');
  release(); await running;
  const lock = join(dialogue, `${binding.id}.dispatch.lock`); await mkdir(lock);
  await assert.rejects(withDispatch(context, binding, () => {}, { timeoutMs: 5 }), { code: 'DISPATCH_BUSY' });
  assert.ok((await readdir(dialogue)).includes(`${binding.id}.dispatch.lock`));
});

test('opaque dispatch permits are scope-bound and cannot be forged or used for another binding', async t => {
  const { context, binding } = await fixture(t);
  let expired;
  await withDispatch(context, binding, async ({ permit }) => {
    expired = permit;
    await withDispatch(context, binding, ({ binding: live }) => assert.equal(live.id, binding.id), { permit });
    await assert.rejects(withDispatch(context, 'second', () => {}, { permit }), { code: 'INVALID_DISPATCH_PERMIT' });
    await assert.rejects(withDispatch(context, binding, () => {}, { permit: {} }), { code: 'INVALID_DISPATCH_PERMIT' });
  });
  await assert.rejects(withDispatch(context, binding, () => {}, { permit: expired }), { code: 'INVALID_DISPATCH_PERMIT' });
});

test('dispatch and control locks retain changed owner evidence instead of deleting it', async t => {
  const { context, binding, dialogue } = await fixture(t);
  const dispatch = join(dialogue, `${binding.id}.dispatch.lock`, 'owner.json');
  await assert.rejects(withDispatch(context, binding, async () => {
    const owner = JSON.parse(await readFile(dispatch, 'utf8')); owner.nonce = 'someone-else';
    await writeFile(dispatch, JSON.stringify(owner));
  }), { code: 'LOCK_OWNERSHIP_CHANGED' });
  assert.equal(JSON.parse(await readFile(dispatch, 'utf8')).nonce, 'someone-else');
  const control = join(dialogue, '.lock', 'owner.json');
  await assert.rejects(withStore(context, async () => {
    const owner = JSON.parse(await readFile(control, 'utf8')); owner.nonce = 'someone-else'; await writeFile(control, JSON.stringify(owner));
  }), { code: 'LOCK_OWNERSHIP_CHANGED' });
  assert.equal(JSON.parse(await readFile(control, 'utf8')).nonce, 'someone-else');
});

test('resume CAS validates identity, room pins and generation after asynchronous verification', async t => {
  const { context, binding } = await fixture(t);
  await pauseBinding(context, 'first');
  const snapshot = resumeSnapshot(await readStore(context), binding);
  let verified = false;
  await resumeBinding(context, 'first', { snapshot, verify: async ({ binding: live, store }) => { verified = true; assert.equal(live.id, binding.id); assert.equal(lifecycleState(store, live).desired, 'paused'); } });
  assert.equal(verified, true); assert.equal(lifecycleState(await readStore(context), binding).desired, 'enabled');
  await pauseBinding(context, 'first');
  await assert.rejects(resumeBinding(context, 'first', { snapshot }), { code: 'LIFECYCLE_CHANGED' });
  const current = resumeSnapshot(await readStore(context), binding);
  await assert.rejects(resumeBinding(context, 'first', { snapshot: current, verify: async () => { throw new Error('pending requires review'); } }), /pending requires review/);
  assert.equal(lifecycleState(await readStore(context), binding).desired, 'paused');
  await assert.rejects(resumeBinding(context, 'first', { snapshot: current, verify: async () => {
    await withStore(context, store => { Object.values(store.rooms)[0].name = 'harmless-name-change'; Object.values(store.rooms)[0].members[0].revision++; });
  } }), { code: 'LIFECYCLE_CHANGED' });
});

test('resume CAS preserves pause when signed room manifest or owner changes during verification', async t => {
  const { context, binding } = await fixture(t);
  await withStore(context, store => {
    const room = Object.values(store.rooms)[0];
    room.revision = 1; room.ownerNodeId = `n_${'1'.repeat(64)}`; room.manifestHash = 'a'.repeat(64);
  });
  await pauseBinding(context, 'first');
  const before = await readStore(context), room = Object.values(before.rooms)[0];
  for (const [field, value] of [['manifestHash', 'b'.repeat(64)], ['ownerNodeId', `n_${'2'.repeat(64)}`]]) {
    const snapshot = resumeSnapshot(await readStore(context), binding);
    await assert.rejects(resumeBinding(context, 'first', { snapshot, verify: () => withStore(context, store => {
      store.rooms[room.id][field] = value;
    }) }), { code: 'LIFECYCLE_CHANGED' });
    const after = await readStore(context);
    assert.deepEqual(after.lifecycle[binding.id], before.lifecycle[binding.id]);
    assert.deepEqual(after.bindings, before.bindings);
    await withStore(context, store => { store.rooms[room.id][field] = room[field]; });
  }
});

test('remote, detached, and changed exact binding identities cannot acquire local dispatch', async t => {
  const { context, binding } = await fixture(t);
  await assert.rejects(withDispatch(context, { ...binding, sessionId: 'different' }, () => {}), { code: 'BINDING_CHANGED' });
  await withStore(context, store => { store.bindings.first.remote = true; });
  await assert.rejects(pauseBinding(context, 'first'), { code: 'REMOTE_LIFECYCLE_UNSUPPORTED' });
});

test('row schema rejects mismatched revision, unknown enums, invalid generations, extra fields and noncanonical dates', async t => {
  const { context, binding, dialogue } = await fixture(t);
  await pauseBinding(context, 'first');
  const original = await readStore(context), path = join(dialogue, 'store.json');
  const invalid = [
    { bindingRevision: 2 }, { desired: 'stopped' }, { generation: 0 }, { generation: 1.5 },
    { changeNonce: 'guessable' }, { changeNonce: original.lifecycle[binding.id].changeNonce + '\n' }, { changedAt: '2026-10-19' }, { reason: 'arbitrary-text' }, { secret: 'extra' },
  ];
  for (const fields of invalid) {
    const store = structuredClone(original); Object.assign(store.lifecycle[binding.id], fields);
    await writeFile(path, JSON.stringify(store));
    await assert.rejects(readStore(context), /Invalid dialogue control store/);
  }
  const unknown = structuredClone(original); unknown.lifecycle.b_unknown = structuredClone(unknown.lifecycle[binding.id]);
  await writeFile(path, JSON.stringify(unknown));
  await assert.rejects(readStore(context), /Invalid dialogue control store/);
});

test('throwing an admitted callback releases only its own locks and does not alter lifecycle', async t => {
  const { context, binding, dialogue } = await fixture(t);
  await assert.rejects(withDispatch(context, binding, async () => { throw new Error('owned action failed'); }), /owned action failed/);
  assert.deepEqual((await readdir(dialogue)).filter(name => name.endsWith('.lock') || name === '.lock'), []);
  await pauseBinding(context, 'first');
  assert.equal(lifecycleState(await readStore(context), binding).desired, 'paused');
});

test('unawaited nested permit action cannot outlive dispatch lock', async t => {
  const { context, binding } = await fixture(t);
  let outerReturn, innerStarted, innerRelease, nested;
  const outerGate = new Promise(resolve => { outerReturn = resolve; });
  const ready = new Promise(resolve => { innerStarted = resolve; });
  const innerGate = new Promise(resolve => { innerRelease = resolve; });
  const outer = withDispatch(context, binding, async ({ permit }) => {
    nested = withDispatch(context, binding, async () => { innerStarted(); await innerGate; }, { permit });
    await outerGate;
  });
  await ready; outerReturn();
  await assert.rejects(pauseBinding(context, 'first', { timeoutMs: 15 }), { code: 'DISPATCH_BUSY' });
  innerRelease(); await Promise.all([outer, nested]);
  await pauseBinding(context, 'first');
});

test('v2 and dispatch reject broadened POSIX parent permissions without silently repairing', { skip: process.platform === 'win32' }, async t => {
  const { context, binding, dialogue } = await fixture(t);
  await chmod(dialogue, 0o755);
  await assert.rejects(withDispatch(context, binding, () => {}), { code: 'INVALID_LOCK_PATH' });
  await assert.rejects(withStore(context, () => {}), { code: 'INVALID_LOCK_PATH' });
  assert.equal((await lstat(dialogue)).mode & 0o777, 0o755);
});

test('offline upgrade rejects existing dispatch/worker lock evidence even with a custom process verifier', async t => {
  const { context, binding, dialogue } = await fixture(t, false);
  for (const suffix of ['worker.lock', 'dispatch.lock']) {
    const path = join(dialogue, `${binding.id}.${suffix}`); await mkdir(path);
    await assert.rejects(upgradeStoreOffline(context, { offline: true }, { assertQuiescent: async () => {} }), { code: 'STATE_NOT_QUIESCENT' });
    await rm(path, { recursive: true });
  }
});

test('control store symbolic links are refused without reading or modifying their target', { skip: process.platform === 'win32' }, async t => {
  const { context, dialogue } = await fixture(t, false);
  const path = join(dialogue, 'store.json'), target = join(dialogue, 'other.json');
  const bytes = await readFile(path); await writeFile(target, bytes); await rm(path); await symlink(target, path);
  await assert.rejects(readStore(context), /Invalid dialogue control store/);
  assert.deepEqual(await readFile(target), bytes);
});

test('read-only lifecycle observations retain detached binding history while dispatch remains blocked', async t => {
  const { context } = await fixture(t);
  await pauseBinding(context, 'first');
  await withStore(context, store => { store.bindings.first.active = false; });
  const store = await readStore(context);
  assert.equal(lifecycleState(store, store.bindings.first).desired, 'paused');
  await assert.rejects(withDispatch(context, 'first', () => {}), /inactive binding/);
});

test('conditional pause rolls back only the exact resumed generation and preserves newer operator changes', async t => {
  const { context, binding } = await fixture(t);
  await pauseBinding(context, 'first');
  const resumed = await resumeBinding(context, 'first', { snapshot: resumeSnapshot(await readStore(context), binding) });
  const rollback = await pauseBinding(context, 'first', { expectedChangeNonce: resumed.lifecycle.changeNonce });
  assert.equal(rollback.lifecycle.desired, 'paused');
  await assert.rejects(pauseBinding(context, 'first', { expectedChangeNonce: resumed.lifecycle.changeNonce }), { code: 'LIFECYCLE_CHANGED' });
  assert.deepEqual(lifecycleState(await readStore(context), binding), rollback.lifecycle);
});
