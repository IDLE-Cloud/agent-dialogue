import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeEmbedded, runEmbedded } from '../lib/embedded-ledger.mjs';
import { createBinding, createRoom, encodeFrame, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { bridgeEnvironment, locked } from '../lib/bridge.mjs';

const workerPath = new URL('../bin/bridge-worker.mjs', import.meta.url);
async function until(fn, limit = 7000) {
  const deadline = Date.now() + limit;
  do { const value = await fn(); if (value) return value; await delay(20); } while (Date.now() < deadline);
  throw new Error('Fixture state did not arrive before deadline.');
}

test('a real worker preserves busy input, returns to ready after admission, and waits correctly on the next busy message', { timeout: 25000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ad-busy-recovery-'));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded', env: { ...process.env, AGENT_DIALOGUE_LEDGER: 'embedded' } };
  let busy = true, posts = 0, child, binding, childExit;
  const nativeMessages = new Map();
  const session = { id: 'ses_existing123', projectID: 'fixture-project', directory: resolve(root), title: 'Existing fixture chat', agent: 'review', model: { id: 'unchanged-model', providerID: 'unchanged-provider', variant: 'default' }, time: {} };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === null ? '' : JSON.stringify(value)); };
      if (req.headers.authorization !== `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`) return json({}, 401);
      if (url.pathname === '/global/health') return json({ healthy: true, version: '1.19.0' });
      assert.equal(url.searchParams.get('directory'), session.directory);
      if (url.pathname === '/config') return json({ shell: '/bin/sh' });
      if (url.pathname === `/session/${session.id}`) return json(session);
      if (url.pathname === '/session/status') return json({ [session.id]: { type: busy ? 'busy' : 'idle' } });
      if (url.pathname === `/session/${session.id}/message`) return json([...nativeMessages.values()]);
      if (url.pathname.startsWith(`/session/${session.id}/message/`)) {
        const value = nativeMessages.get(url.pathname.split('/').at(-1)); return json(value || {}, value ? 200 : 404);
      }
      if (url.pathname === `/session/${session.id}/prompt_async` && req.method === 'POST') {
        assert.equal(busy, false, 'A busy native chat must never receive POST.');
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); posts++;
        assert.deepEqual(body.model, { providerID: session.model.providerID, modelID: session.model.id });
        assert.equal(body.agent, session.agent); assert.equal(body.variant, 'default');
        nativeMessages.set(body.messageID, { info: { id: body.messageID, sessionID: session.id, role: 'user', agent: body.agent, model: { ...body.model, variant: body.variant } }, parts: [{ id: `prt_${posts}`, sessionID: session.id, messageID: body.messageID, type: 'text', text: body.parts[0].text }] });
        return json(null, 204);
      }
      return json({}, 404);
    } catch (error) { res.writeHead(500); res.end('Fixture protocol mismatch'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serviceFile = join(root, 'service.json'), origin = `http://127.0.0.1:${server.address().port}`;
  context.env.AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE = serviceFile;
  await writeFile(serviceFile, JSON.stringify({ id: 'fixture-owned-service', url: origin, version: '1.19.0', password: 'fixture-password', directory: session.directory, projectId: session.projectID, shell: '/bin/sh', commandShell: 'posix' }), { mode: 0o600 });
  t.after(async () => {
    if (child && child.exitCode === null) {
      if (binding) await locked(context, store => { store.bindings[binding.alias].active = false; });
      await Promise.race([childExit, delay(4000)]);
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([childExit, delay(1000)]);
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await initializeEmbedded(context); await loadOrCreateNode(context);
  const room = await withStore(context, store => {
    const options = alias => ({ alias, harness: 'opencode-v1', sessionId: alias === 'receiver' ? session.id : 'ses_sender', projectId: session.projectID, directory: session.directory, serviceId: 'fixture-owned-service', origin });
    createBinding(store, options('sender')); binding = createBinding(store, options('receiver'));
    return createRoom(store, { name: 'Busy fixture', members: ['sender', 'receiver'] });
  });
  child = spawn(process.execPath, [fileURLToPath(workerPath), binding.id, '--token', randomUUID()], { env: bridgeEnvironment(context), stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic += chunk; }); child.stdout.resume();
  childExit = new Promise(resolve => child.once('close', resolve));
  const runtime = async () => { try { return JSON.parse(await readFile(join(context.stateDir, 'dialogue', `${binding.id}.worker.json`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  await until(async () => { const state = await runtime(); assert.notEqual(state?.status, 'error', diagnostic || state?.error); return state?.status === 'ready'; });
  const send = async text => {
    const frame = encodeFrame({ version: 1, room: room.id, from: 'operator', to: binding.alias, fromBindingId: 'operator', toBindingId: binding.id, fromRevision: 1, toRevision: binding.revision, text, replyTo: null });
    return JSON.parse(await runEmbedded(context, ['send', '--json', '--from', 'dialogue-operator', `@${binding.hcomName}`, '--thread', room.id, '--intent', 'request', '--', frame])).event_id;
  };
  const first = await send('first literal fixture request');
  await until(async () => (await runtime())?.status === 'waiting-native');
  let state = await runtime();
  assert.equal(posts, 0); assert.ok(state.cursor < first); assert.equal(state.pending, null); assert.equal(state.receipts[first], undefined);
  busy = false;
  state = await until(async () => { const state = await runtime(); return state?.receipts[first]?.status === 'admitted' && state; });
  assert.equal(state.status, 'ready', 'Successful admission must clear a stale waiting-native status.');
  assert.equal(state.cursor, first); assert.equal(posts, 1); assert.equal(nativeMessages.size, 1); assert.equal(state.pending, undefined);
  busy = true;
  const second = await send('second literal fixture request');
  await until(async () => (await runtime())?.status === 'waiting-native');
  state = await runtime(); assert.equal(state.cursor, first); assert.equal(posts, 1); assert.equal(state.receipts[second], undefined);
  busy = false;
  state = await until(async () => { const state = await runtime(); return state?.receipts[second]?.status === 'admitted' && state; });
  assert.equal(state.status, 'ready'); assert.equal(state.cursor, second); assert.equal(posts, 2); assert.equal(nativeMessages.size, 2);
  assert.notEqual(state.receipts[first].inputId, state.receipts[second].inputId);
  await locked(context, store => { store.bindings.receiver.active = false; });
  await childExit;
  assert.equal((await runtime()).status, 'stopped');
});
