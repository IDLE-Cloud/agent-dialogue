import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detach } from '../lib/bridge.mjs';
import { createBinding, createRoom, readStore, withStore } from '../lib/bridge-store.mjs';

const budget = { timeout: process.platform === 'win32' ? 120000 : 15000 };
const posix = { ...budget, skip: process.platform === 'win32' };
const failure = code => Object.assign(new Error('Owned detach signal fixture: ' + code), { code });
async function fixture(t, { remote = false } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ad-detach-race-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir }; let selected, peer;
  await withStore(context, store => {
    const input = alias => ({ alias, harness: 'opencode-v1', sessionId: 'ses_' + alias, projectId: 'owned-detach-fixture', directory: stateDir, serviceId: 'owned-fake-service', origin: 'http://127.0.0.1:1' });
    selected = createBinding(store, input('selected')); peer = createBinding(store, input('peer')); selected.remote = remote;
    createRoom(store, { name: 'Owned detach room', members: [selected.alias, peer.alias] });
  });
  const state = { pid: 912351, token: randomUUID(), lifecycleProtocol: 1, status: 'ready', cursor: 17, receipts: { 17: { status: 'admitted', sessionId: selected.sessionId, inputId: 'msg_retained' } } };
  const peerState = { ...state, pid: 912352, token: randomUUID(), receipts: {} };
  const runtimePath = binding => join(stateDir, 'dialogue', binding.id + '.worker.json');
  await writeFile(runtimePath(selected), JSON.stringify(state) + '\n', { mode: 0o600 });
  await writeFile(runtimePath(peer), JSON.stringify(peerState) + '\n', { mode: 0o600 });
  const before = await readStore(context), original = await readFile(runtimePath(selected)), peerOriginal = await readFile(runtimePath(peer));
  const preserved = async () => {
    const after = await readStore(context);
    assert.deepEqual(after, { ...before, bindings: { ...before.bindings, [selected.alias]: { ...before.bindings[selected.alias], active: false } } });
    assert.deepEqual(await readFile(runtimePath(selected)), original);
    assert.deepEqual(await readFile(runtimePath(peer)), peerOriginal);
  };
  return { context, selected, peer, state, preserved };
}

test('detach accepts ESRCH only after an exact owned-live probe and preserves other bindings and native state', posix, async t => {
  const f = await fixture(t), probes = [], signals = [];
  const result = await detach(f.context, f.selected.alias, {
    probe: async (...args) => { probes.push(args); assert.equal((await readStore(f.context)).bindings[f.selected.alias].active, false); return 'owned-live'; },
    signal: (pid, name) => { signals.push([pid, name]); throw failure('ESRCH'); },
  });
  assert.deepEqual(probes, [[f.state.pid, f.state.token, f.selected.id]]);
  assert.deepEqual(signals, [[f.state.pid, 'SIGTERM']]);
  assert.deepEqual(result, { alias: f.selected.alias, detached: true, nativeSessionPreserved: true });
  await f.preserved();
});

test('detach sends one SIGTERM only to the exact owned-live worker', posix, async t => {
  const f = await fixture(t), signals = [];
  await detach(f.context, f.selected.alias, { probe: async (...args) => { assert.deepEqual(args, [f.state.pid, f.state.token, f.selected.id]); return 'owned-live'; }, signal: (...args) => { signals.push(args); } });
  assert.deepEqual(signals, [[f.state.pid, 'SIGTERM']]); await f.preserved();
});

test('detach propagates EPERM and other signal errors after exact ownership verification', posix, async t => {
  for (const code of ['EPERM', 'EIO']) {
    const f = await fixture(t), expected = failure(code); let signals = 0;
    await assert.rejects(detach(f.context, f.selected.alias, { probe: async () => 'owned-live', signal: () => { signals++; throw expected; } }), error => error === expected);
    assert.equal(signals, 1); await f.preserved();
  }
});

test('detach never signals unknown or already confirmed-dead owners', posix, async t => {
  for (const evidence of ['unknown', 'confirmed-dead']) {
    const f = await fixture(t); let probes = 0, signals = 0;
    await detach(f.context, f.selected.alias, { probe: async (...args) => { probes++; assert.deepEqual(args, [f.state.pid, f.state.token, f.selected.id]); return evidence; }, signal: () => { signals++; throw failure('ESRCH'); } });
    assert.equal(probes, 1); assert.equal(signals, 0); await f.preserved();
  }
});

test('detaching a remote descriptor performs no local process probe or signal', budget, async t => {
  const f = await fixture(t, { remote: true }); let probes = 0, signals = 0;
  await detach(f.context, f.selected.alias, { probe: async () => { probes++; throw failure('EIO'); }, signal: () => { signals++; throw failure('EIO'); } });
  assert.equal(probes, 0); assert.equal(signals, 0); await f.preserved();
});

test('Windows detach leaves its worker to observe active=false without a process signal', { ...budget, skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let probes = 0, signals = 0;
  await detach(f.context, f.selected.alias, { probe: async () => { probes++; return 'owned-live'; }, signal: () => { signals++; throw failure('EIO'); } });
  assert.equal(probes, 0); assert.equal(signals, 0); await f.preserved();
});
