import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBinding, createRoom, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { initializeEmbedded, runEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode, payloadHash } from '../lib/node-identity.mjs';
import { pauseBinding, upgradeStoreOffline } from '../lib/lifecycle.mjs';
import { bridgeEnvironment, startBridge, stopBridge } from '../lib/bridge.mjs';
import { nativeEvidence, reconcileNative } from '../lib/native-recovery.mjs';

async function ownedWorker(t, { lostReceipt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-v4-owned-worker-'));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { ...process.env, AGENT_DIALOGUE_LEDGER: 'embedded' } };
  let child, closed, binding, stderr = '', posts = 0, observed, reveal = !lostReceipt;
  const saved = new Map(), shell = process.platform === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : '/bin/sh';
  const harness = lostReceipt ? 'opencode-v1' : 'opencode-v2';
  const runtime = async () => JSON.parse(await readFile(join(context.stateDir, 'dialogue', binding.id + '.worker.json'), 'utf8'));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/global/health') return json({ healthy: true, version: '1.19.0' });
    if (path === '/config') return json({ shell });
    if (path === '/session/status') return json({});
    if (path === '/session/ses_selected') return json({ id: 'ses_selected', projectID: 'p', directory: resolve(root), agent: 'fixture', model: { id: 'fixture-model', providerID: 'fixture-provider' }, time: {} });
    if (path.startsWith('/session/ses_selected/message/')) {
      const message = reveal && saved.get(path.split('/').at(-1));
      if (message) return json(message); res.writeHead(404); return res.end('{}');
    }
    if (path === '/api/info') return json({ version: '2.0.20' });
    if (path === '/api/session/ses_selected') return json({ data: { id: 'ses_selected', projectID: 'p', location: { directory: resolve(root) }, time: {} } });
    if (['/api/session/ses_selected/prompt', '/session/ses_selected/prompt_async'].includes(path) && req.method === 'POST') {
      const chunks = []; for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks)), request = lostReceipt ? { id: body.messageID, text: body.parts[0].text } : body; posts++;
      try {
        observed = { request, row: (await readStore(context)).nativeIntents[request.id], runtime: await runtime() };
        if (lostReceipt) {
          saved.set(request.id, { info: { id: request.id, sessionID: 'ses_selected', role: 'user', agent: body.agent, model: { ...body.model, variant: body.variant } }, parts: [{ id: 'prt_fixture', sessionID: 'ses_selected', messageID: request.id, type: 'text', text: request.text }] });
          req.socket.destroy(); return;
        }
        return json({ data: { id: request.id, sessionID: 'ses_selected', type: 'user', text: request.text } });
      } catch (error) { observed = { error: error.message }; res.writeHead(500); return res.end('{}'); }
    }
    if (path.endsWith('/message') || path.endsWith('/inbox')) return json({ data: [] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    if (child?.exitCode === null && binding) await stopBridge(context, binding.alias, { timeoutMs: process.platform === 'win32' ? 60000 : 10000 }).catch(() => {});
    if (child?.exitCode === null) child.kill('SIGTERM');
    if (closed) await Promise.race([closed, delay(2000, undefined, { ref: false })]);
    if (child?.exitCode === null) { child.kill('SIGKILL'); await closed; }
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const serviceFile = join(root, 'service.json'), origin = `http://127.0.0.1:${server.address().port}`;
  context.env[lostReceipt ? 'AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE' : 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE'] = serviceFile;
  await writeFile(serviceFile, JSON.stringify({ id: 'owned-v4-fixture', url: origin, password: 'synthetic-fixture-password', version: lostReceipt ? '1.19.0' : '2.0.20', ...(lostReceipt ? { directory: resolve(root), projectId: 'p', shell, commandShell: process.platform === 'win32' ? 'powershell' : 'posix' } : {}) }), { mode: 0o600 });
  const node = await loadOrCreateNode(context); await initializeEmbedded(context);
  const room = await withStore(context, store => {
    binding = createBinding(store, { alias: 'selected', harness, sessionId: 'ses_selected', projectId: 'p', directory: resolve(root), serviceId: 'owned-v4-fixture', origin }); binding.nodeId = node.nodeId;
    const peer = createBinding(store, { alias: 'peer', harness, sessionId: 'ses_peer', projectId: 'p', directory: resolve(root), serviceId: 'owned-v4-fixture', origin }); peer.nodeId = node.nodeId;
    return createRoom(store, { name: 'Owned v4 worker wiring', members: [binding.alias, peer.alias] });
  });
  await upgradeStoreOffline(context, { offline: true, targetVersion: 4 });
  const launchImpl = async (_context, { bindingId, token, workerPath }) => {
    child = spawn(process.execPath, [workerPath, bindingId, '--token', token], { env: bridgeEnvironment(context), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-8192); });
    closed = new Promise(done => child.once('close', done)); return { accepted: true };
  };
  const started = await startBridge(context, binding.alias, { launchImpl, timeoutMs: process.platform === 'win32' ? 90000 : 10000 });
  assert.equal(started.pid, child.pid);
  const frame = { version: 1, room: room.id, from: 'operator', to: binding.alias, fromBindingId: 'operator', toBindingId: binding.id, fromRevision: 1, toRevision: binding.revision, text: 'Literal input for an owned loopback fixture.', replyTo: null };
  const eventId = JSON.parse(await runEmbedded(context, ['send', '--json', '--from', 'dialogue-operator', '@' + binding.hcomName, '--thread', room.id, '--intent', 'request', '--', encodeFrame(frame)])).event_id;
  if (lostReceipt) {
    await Promise.race([closed, delay(process.platform === 'win32' ? 90000 : 15000, undefined, { ref: false }).then(() => { throw new Error('Owned worker did not stop after unknown receipt: ' + stderr); })]);
    const before = await runtime();
    assert.equal(before.status, 'error'); assert.equal(before.pending.eventId, eventId); assert.equal(before.receipts?.[eventId], undefined);
    assert.equal(posts, 1); assert.equal(observed.row.phase, 'submit-started'); assert.equal(observed.runtime.pending.inputId, observed.request.id);
    reveal = true;
    await pauseBinding(context, binding.alias);
    const proof = await nativeEvidence(context, binding.alias, eventId, { native: true });
    assert.equal(proof.status, 'verified');
    assert.equal((await reconcileNative(context, binding.alias, eventId)).status, 'reconciled');
    const after = await runtime();
    assert.equal(after.cursor, before.cursor); assert.equal(after.pending, undefined); assert.equal(after.receipts[eventId].inputId, observed.request.id);
    const expected = structuredClone(before); delete expected.pending; expected.receipts[eventId] = after.receipts[eventId]; assert.deepEqual(after, expected);
    assert.equal((await readStore(context)).nativeIntents[observed.request.id].recovery.phase, 'runtime-committed'); assert.equal(posts, 1);
    assert.equal((await reconcileNative(context, binding.alias, eventId)).runtimeChanged, false); assert.deepEqual(await runtime(), after);
    return;
  }
  let after; const until = Date.now() + (process.platform === 'win32' ? 90000 : 10000);
  while (Date.now() < until) { after = await runtime(); if (after.receipts?.[eventId]?.status === 'admitted') break; if (child.exitCode !== null) assert.fail('Owned v4 worker exited: ' + stderr); await delay(30); }
  assert.equal(after.receipts?.[eventId]?.status, 'admitted', stderr);
  assert.equal(posts, 1); assert.equal(observed.error, undefined);
  assert.equal(observed.row.phase, 'submit-started'); assert.equal(observed.row.promptHash, payloadHash(observed.request.text));
  assert.equal(observed.runtime.pending.inputId, observed.request.id); assert.equal(observed.runtime.pending.eventId, eventId);
  const row = (await readStore(context)).nativeIntents[observed.request.id];
  assert.equal(row.phase, 'admitted'); assert.deepEqual(row.receipt, after.receipts[eventId]);
  assert.equal(after.pending, undefined); assert.equal(after.cursor, eventId); assert.equal(after.pid, child.pid);
}

// Windows whole-contract budgets are provisional until actual CI measurement;
// no production process/ACL/HTTP deadline is changed by these fixtures.
const budget = { timeout: process.platform === 'win32' ? 300000 : 45000 };
test('real owned v4 worker persists intent and pending before one loopback prompt, then saves receipt and cursor', budget, ownedWorker);
test('real owned v4 worker lost receipt is repaired using exact V1 loopback evidence and confirmed-dead process without resubmission', budget, t => ownedWorker(t, { lostReceipt: true }));
