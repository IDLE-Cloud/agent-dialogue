import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeEmbedded, runEmbedded } from '../lib/embedded-ledger.mjs';
import { createBinding, createRoom, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import * as bridge from '../lib/bridge.mjs';

async function until(fn, timeout = process.platform === 'win32' ? 60000 : 15000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(30); } while (Date.now() < end);
  throw new Error('Owned lifecycle fixture did not reach the expected state.');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lifecycle-worker-'));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { ...process.env, AGENT_DIALOGUE_LEDGER: 'embedded' } };
  const children = [], messages = new Map(); let posts = 0, launches = 0, serviceId = 'owned-fixture', bindings = [], promptGate;
  const sessions = new Map(['alice', 'bob'].map(alias => [`ses_${alias}`, { id: `ses_${alias}`, projectID: 'p', location: { directory: resolve(root) }, time: {} }]));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/api/info') return json({ version: '2.0.20' });
    const match = path.match(/^\/api\/session\/(ses_[a-z]+)(?:\/(.*))?$/);
    if (!match || !sessions.has(match[1])) return json({}, 404);
    const id = match[1];
    if (!match[2]) return json({ data: sessions.get(id) });
    if (match[2] === 'prompt' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); posts++;
      if (promptGate && id === 'ses_alice') {
        const gate = promptGate; promptGate = undefined; gate.enter(); await gate.released;
      }
      messages.set(body.id, { id: body.id, sessionID: id, type: 'user', text: body.text });
      return json({ data: messages.get(body.id) });
    }
    if (['message', 'inbox'].includes(match[2])) return json({ data: [...messages.values()].filter(row => row.sessionID === id) });
    return json({}, 404);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    promptGate?.release();
    for (const b of bindings) {
      if (children.some(({ child }) => child.exitCode === null)) await bridge.stopBridge?.(context, b.alias, { timeoutMs: 15000 }).catch(() => {});
    }
    for (const { child, closed } of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([closed, delay(2000)]);
    }
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`, serviceFile = join(root, 'service.json');
  context.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = serviceFile;
  const saveService = () => writeFile(serviceFile, JSON.stringify({ id: serviceId, url: origin, password: 'fixture-password', version: '2.0.20' }), { mode: 0o600 });
  await saveService(); await initializeEmbedded(context);
  const { upgradeStoreOffline } = await import('../lib/lifecycle.mjs');
  bindings = await withStore(context, store => ['alice', 'bob'].map(alias => createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'p', directory: resolve(root), serviceId, origin })));
  const room = await withStore(context, store => createRoom(store, { name: 'Owned lifecycle fixture', members: ['alice', 'bob'] }));
  if (process.platform === 'win32') await (await import('../lib/private-files.mjs')).protectWindowsPrivatePath(join(context.stateDir, 'dialogue'), { directory: true });
  await upgradeStoreOffline(context, { offline: true });
  const runtime = async alias => { try { return JSON.parse(await readFile(join(context.stateDir, 'dialogue', `${bindings.find(b => b.alias === alias).id}.worker.json`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const launchImpl = async (_context, { bindingId, token, workerPath }) => {
    launches++;
    const child = spawn(process.execPath, [workerPath, bindingId, '--token', token], { env: bridge.bridgeEnvironment(context), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.resume();
    const closed = new Promise(done => child.once('close', done)); children.push({ child, closed });
    return { accepted: true };
  };
  const send = async alias => {
    const binding = bindings.find(b => b.alias === alias);
    return JSON.parse(await runEmbedded(context, ['send', '--json', '--from', 'dialogue-operator', `@${binding.hcomName}`, '--thread', room.id, '--intent', 'request', '--', encodeFrame({ version: 1, room: room.id, from: 'operator', to: alias, fromBindingId: 'operator', toBindingId: binding.id, fromRevision: 1, toRevision: 1, text: 'Literal owned fixture input.', replyTo: null })])).event_id;
  };
  return { context, root, bindings, room, runtime, launchImpl, send, get posts() { return posts; }, get launches() { return launches; }, changeService: async () => { serviceId = 'different-owned-service'; await saveService(); }, holdNextPrompt() {
    let enter, release;
    const entered = new Promise(done => { enter = done; }), released = new Promise(done => { release = done; });
    promptGate = { enter, released, release }; t.after(release);
    return { entered, release };
  } };
}

test('pause and resume preserve exact chat, pins, cursor and single real owned worker; another binding continues', { timeout: process.platform === 'win32' ? 300000 : 60000 }, async t => {
  const f = await fixture(t);
  await Promise.all(['alice', 'bob'].map(alias => bridge.startBridge(f.context, alias, { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 })));
  const before = await f.runtime('alice'), controlBefore = await readStore(f.context);
  const result = await bridge.pauseBridge(f.context, 'alice');
  assert.equal(result.newDispatchBlocked, true);
  await until(async () => (await f.runtime('alice'))?.status === 'paused');
  const waiting = await f.send('alice'), other = await f.send('bob');
  await until(async () => (await f.runtime('bob'))?.receipts[other]?.status === 'admitted');
  const paused = await f.runtime('alice');
  assert.equal(paused.cursor, before.cursor); assert.equal(paused.receipts[waiting], undefined); assert.equal(f.posts, 1);
  const during = await readStore(f.context);
  assert.deepEqual(during.bindings.alice, controlBefore.bindings.alice); assert.deepEqual(during.rooms, controlBefore.rooms);
  await assert.rejects(bridge.startBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 }), error => error.code === 'BINDING_PAUSED');
  await bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  await until(async () => (await f.runtime('alice'))?.receipts[waiting]?.status === 'admitted');
  const after = await f.runtime('alice');
  assert.equal(after.pid, before.pid); assert.equal(after.token, before.token); assert.equal(f.launches, 2); assert.equal(f.posts, 2);
  await bridge.pauseBridge(f.context, 'alice'); await bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  assert.equal(f.posts, 2); assert.equal(f.launches, 2);
});

test('parallel starts reserve one launch and cooperative stop preserves the active binding and pending evidence', { timeout: process.platform === 'win32' ? 300000 : 60000 }, async t => {
  const f = await fixture(t);
  const started = await Promise.all(Array.from({ length: 3 }, () => bridge.startBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 })));
  assert.equal(f.launches, 1); assert.equal(new Set(started.map(row => row.pid)).size, 1);
  const before = await readStore(f.context), runtimeBefore = await f.runtime('alice');
  const stopped = await bridge.stopBridge(f.context, 'alice');
  assert.equal(stopped.stopped, true);
  assert.equal((await f.runtime('alice')).status, 'stopped');
  const after = await readStore(f.context);
  assert.deepEqual(after.bindings.alice, before.bindings.alice); assert.deepEqual(after.rooms, before.rooms);
  assert.equal((await f.runtime('alice')).cursor, runtimeBefore.cursor);
  await bridge.startBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  assert.equal(f.launches, 2); assert.equal((await f.runtime('alice')).cursor, runtimeBefore.cursor);
});

test('pause waits for an owned native admission in flight and blocks the next input until resume', { timeout: process.platform === 'win32' ? 300000 : 60000 }, async t => {
  const f = await fixture(t);
  await bridge.startBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  const gate = f.holdNextPrompt(), first = await f.send('alice');
  await gate.entered;
  let committed = false;
  const pausing = bridge.pauseBridge(f.context, 'alice').then(result => { committed = true; return result; });
  await delay(100);
  assert.equal(committed, false); assert.equal(f.posts, 1);
  gate.release();
  const result = await pausing;
  assert.equal(result.newDispatchBlocked, true); assert.equal(result.nativeExecutionCancelled, false);
  const completed = await f.runtime('alice');
  assert.equal(completed.receipts[first]?.status, 'admitted');
  const next = await f.send('alice');
  await until(async () => (await f.runtime('alice'))?.status === 'paused');
  assert.equal((await f.runtime('alice')).receipts[next], undefined); assert.equal(f.posts, 1);
  await bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  await until(async () => (await f.runtime('alice'))?.receipts[next]?.status === 'admitted');
  assert.equal(f.posts, 2); assert.equal(f.launches, 1);
});

test('resume refuses a changed native service and unresolved outgoing state without clearing the pause', { timeout: process.platform === 'win32' ? 300000 : 60000 }, async t => {
  const f = await fixture(t);
  await bridge.startBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 });
  await bridge.pauseBridge(f.context, 'alice'); await bridge.stopBridge(f.context, 'alice');
  const path = join(f.context.stateDir, 'dialogue', `${f.bindings[0].id}.worker.json`), saved = await f.runtime('alice');
  saved.outgoingPending = { eventId: 42, submissionId: 'q_preserve', status: 'forwarding' }; await writeFile(path, JSON.stringify(saved));
  await assert.rejects(bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 }), error => error.code === 'BRIDGE_NEEDS_REVIEW');
  assert.deepEqual((await f.runtime('alice')).outgoingPending, saved.outgoingPending); assert.equal(f.launches, 1);
  delete saved.outgoingPending; await writeFile(path, JSON.stringify(saved)); await f.changeService();
  await assert.rejects(bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 }));
  const state = await readStore(f.context);
  assert.equal(state.lifecycle[f.bindings[0].id].desired, 'paused'); assert.equal(f.launches, 1); assert.equal(f.posts, 0);
});

test('a recorded runtime without a valid process owner is never treated as a fresh missing runtime', async t => {
  const f = await fixture(t), path = join(f.context.stateDir, 'dialogue', `${f.bindings[0].id}.worker.json`);
  await writeFile(path, JSON.stringify({ status: 'ready', cursor: 17, receipts: {}, token: 'unverified-owner' }));
  await assert.rejects(bridge.startBridge(f.context, 'alice', { launchImpl: async () => assert.fail('invalid evidence must not launch'), timeoutMs: 20 }), error => error.code === 'WORKER_OWNER_UNVERIFIED');
  await assert.rejects(bridge.stopBridge(f.context, 'alice'), error => error.code === 'WORKER_OWNER_UNVERIFIED');
  assert.equal((await f.runtime('alice')).cursor, 17);
  await rm(path);
  for (const row of [null, false, 0, { version: 1, bindingRevision: 1, phase: 'ready', token: '12345678-1234-4234-8234-123456789abc\n' }]) {
    await withStore(f.context, store => { store.workerLaunches = { [f.bindings[0].id]: row }; });
    await assert.rejects(bridge.startBridge(f.context, 'alice', { launchImpl: async () => assert.fail('malformed reservation must not launch') }), error => error.code === 'WORKER_OWNER_UNVERIFIED');
    await assert.rejects(bridge.prepareGuarded(f.context, f.bindings[0], '12345678-1234-4234-8234-123456789abc', async () => assert.fail('malformed reservation must not prepare native')), error => error.code === 'WORKER_OWNER_UNVERIFIED');
  }
});

test('an unknown launch keeps its original reservation and cannot launch a second worker', async t => {
  const f = await fixture(t); let launches = 0;
  const launchImpl = async () => { launches++; throw new Error('scheduler response disappeared'); };
  await assert.rejects(bridge.startBridge(f.context, 'alice', { launchImpl }), error => error.code === 'WORKER_START_PENDING');
  const original = (await readStore(f.context)).workerLaunches[f.bindings[0].id];
  await assert.rejects(bridge.startBridge(f.context, 'alice', { launchImpl }), error => error.code === 'WORKER_START_PENDING');
  assert.equal(launches, 1); assert.deepEqual((await readStore(f.context)).workerLaunches[f.bindings[0].id], original);
});

test('resume preserves the pause when this source owns an unknown outbox message', { timeout: process.platform === 'win32' ? 300000 : 60000 }, async t => {
  const f = await fixture(t), binding = f.bindings[0];
  await bridge.pauseBridge(f.context, 'alice');
  await withStore(f.context, store => { store.outbox = { m_fixture: { fromActor: binding.hcomName, status: 'unknown', eventId: 19 } }; });
  await assert.rejects(bridge.resumeBridge(f.context, 'alice', { launchImpl: f.launchImpl, timeoutMs: process.platform === 'win32' ? 60000 : 10000 }), error => error.code === 'BRIDGE_NEEDS_REVIEW');
  const store = await readStore(f.context);
  assert.equal(store.lifecycle[binding.id].desired, 'paused'); assert.equal(f.launches, 0);
  assert.equal(store.outbox.m_fixture.status, 'unknown');
});

test('prepare and rejected-event bookkeeping respect pause and cooperative-stop barriers', async t => {
  const f = await fixture(t), binding = f.bindings[0], token = '12345678-1234-4234-8234-123456789abc';
  const state = { cursor: 7, receipts: {}, token };
  await bridge.pauseBridge(f.context, 'alice');
  assert.equal(await bridge.prepareGuarded(f.context, binding, token, async () => assert.fail('paused metadata preparation')), 'paused');
  await assert.rejects(bridge.rejectWorkerEvent(f.context, binding, { id: 9 }, state, new Error('invalid frame'), async () => assert.fail('paused cursor persistence')), error => error.code === 'BINDING_PAUSED');
  assert.equal(state.cursor, 7); assert.deepEqual(state.receipts, {});
  const { resumeBinding, resumeSnapshot } = await import('../lib/lifecycle.mjs');
  const store = await readStore(f.context);
  await resumeBinding(f.context, 'alice', { snapshot: resumeSnapshot(store, binding) });
  await withStore(f.context, store => { store.workerLaunches = { [binding.id]: { version: 1, bindingRevision: 1, token, phase: 'stop-requested' } }; });
  assert.equal(await bridge.prepareGuarded(f.context, binding, token, async () => assert.fail('stopped metadata preparation')), 'stopped');
  await assert.rejects(bridge.rejectWorkerEvent(f.context, binding, { id: 9 }, state, new Error('invalid frame'), async () => assert.fail('stopped cursor persistence')), error => error.code === 'BRIDGE_STOP_REQUESTED');
  assert.equal(state.cursor, 7);
});

test('process query failure for an existing PID is unknown and status preserves detached history', async t => {
  assert.equal(await bridge.processEvidence(process.pid, 'fixture-token', 'b_fixture', { runner: async () => ({ code: 143, stdout: '' }) }), 'unknown');
  const f = await fixture(t);
  await withStore(f.context, store => { store.bindings.alice.active = false; });
  const result = await bridge.bridgeStatus(f.context);
  assert.equal(result.bindings.find(b => b.alias === 'alice').active, false);
  assert.equal(result.bindings.find(b => b.alias === 'bob').worker.ownershipEvidence, 'not-recorded');
});
