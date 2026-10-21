import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';
import { loadOrCreateNode, signObject } from '../lib/node-identity.mjs';
import { acceptRoom, exportNode, exportRoom, flushMessage, pairPeer, receiveEnvelope, sealRoom, sendRemote } from '../lib/nodes.mjs';
import { hcom, ledger } from '../lib/bridge.mjs';
import { queueSubmission } from '../lib/submissions.mjs';
import { createDialogueMcpTools, createMcpScope } from '../lib/mcp-tools.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const value = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent; };
function meta(id, directory) {
  const context = { session_id: id, workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' };
  return { ...context, 'com.zcode/request-context': { ...context } };
}
async function fixture(t, { beforeCleanup } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lifecycle-delivery-'));
  t.after(async () => { await beforeCleanup?.(); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'native project'); await mkdir(directory);
  const serviceFile = join(root, 'private', 'zcode.json');
  await createZCodeService({ path: serviceFile, directory, zcodeVersion: '3.14.3' });
  const client = await ZCodeToolsClient.discover({ serviceFile });
  const make = async alias => {
    const session = await client.register(meta(`sess_${alias}`, directory));
    const context = { stateDir: join(root, alias), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile } };
    await initializeEmbedded(context); const node = await loadOrCreateNode(context);
    const binding = await withStore(context, store => {
      const binding = createBinding(store, { alias, harness: 'zcode-tools', sessionId: session.id, projectId: session.projectID, directory, serviceId: client.identity.serviceId, origin: client.identity.origin });
      binding.nodeId = node.nodeId; return binding;
    });
    await hcom(context, ['start', '--name', binding.hcomName]);
    return { context, binding, node };
  };
  const a = await make('alice'), b = await make('bob');
  const transport = target => ({ kind: 'local-process', executable: process.execPath, args: [], stateDir: target.context.stateDir });
  await pairPeer(a.context, await exportNode(b.context), transport(b));
  await pairPeer(b.context, await exportNode(a.context), transport(a));
  let room = await withStore(a.context, store => createRoom(store, { name: 'Lifecycle fixture', members: ['alice', 'bob'] }));
  room = await sealRoom(a.context, room); await acceptRoom(b.context, await exportRoom(a.context, room.id));
  const message = (source = a, target = b) => ({ room: room.id, from: source.binding.alias, to: target.binding.alias, expectedSession: target.binding.sessionId, text: `Project message from ${source.binding.alias}` });
  return { root, directory, serviceFile, client, a, b, room, message };
}
async function paused(context, binding) {
  return withStore(context, store => {
    store.version = 2; store.lifecycle ||= {};
    store.lifecycle[binding.id] = { version: 1, bindingRevision: binding.revision, desired: 'paused', generation: 1, changeNonce: randomUUID(), changedAt: new Date().toISOString(), reason: 'operator-pause' };
  });
}
async function pauseBarrier(context, binding) {
  const { withDispatch } = await import('../lib/lifecycle.mjs');
  return withDispatch(context, binding, () => paused(context, binding), { allowPaused: true });
}

test('a paused source rejects direct remote send and exact flush without changing uncertain evidence', async t => {
  const f = await fixture(t); let exchanges = 0;
  await assert.rejects(sendRemote(f.a.context, f.message(), { exchangeImpl: async () => { exchanges++; throw new Error('lost receipt'); } }), /unknown/);
  const before = await readStore(f.a.context), messageId = Object.keys(before.outbox)[0];
  await paused(f.a.context, f.a.binding);
  await assert.rejects(sendRemote(f.a.context, f.message(), { exchangeImpl: async () => { exchanges++; } }), error => error.code === 'BINDING_PAUSED');
  await assert.rejects(flushMessage(f.a.context, messageId, { exchangeImpl: async () => { exchanges++; } }), error => error.code === 'BINDING_PAUSED');
  const after = await readStore(f.a.context);
  assert.deepEqual(after.outbox, before.outbox); assert.equal(exchanges, 1);
  assert.equal((await ledger(f.a.context)).length, 1);
});

test('paused destinations continue signed ledger ingress and local submissions explicitly remain paused', async t => {
  const f = await fixture(t); await paused(f.b.context, f.b.binding);
  const result = await sendRemote(f.a.context, f.message(), { exchangeImpl: (_peer, envelope) => receiveEnvelope(f.b.context, envelope) });
  assert.equal(result.status, 'remote-stored'); assert.equal((await ledger(f.b.context)).length, 1);
  const queued = await queueSubmission(f.b.context, f.message(f.b, f.a));
  assert.equal(queued.status, 'queued'); assert.equal(queued.dispatch, 'paused');
  assert.equal((await ledger(f.b.context)).length, 2);
});

test('two sources exchange concurrently while both receivers can acquire control locks', { timeout: process.platform === 'win32' ? 30000 : 15000 }, async t => {
  const f = await fixture(t), gate = deferred(); let entered = 0;
  const exchangeTo = destination => async (_peer, envelope) => {
    if (++entered === 2) gate.resolve(); await gate.promise;
    return receiveEnvelope(destination.context, envelope);
  };
  const results = await Promise.all([
    sendRemote(f.a.context, f.message(), { exchangeImpl: exchangeTo(f.b) }),
    sendRemote(f.b.context, f.message(f.b, f.a), { exchangeImpl: exchangeTo(f.a) }),
  ]);
  assert.ok(results.every(result => result.status === 'remote-stored'));
  assert.equal((await ledger(f.a.context)).length, 2); assert.equal((await ledger(f.b.context)).length, 2);
});

test('a blocked native source query leaves the receiver control path available', { timeout: process.platform === 'win32' ? 120000 : 20000 }, async t => {
  const started = performance.now();
  const stage = name => { if (process.platform === 'win32') t.diagnostic(JSON.stringify({ stage: name, elapsedMs: Math.round(performance.now() - started) })); };
  const entered = deferred(), release = deferred(), original = ZCodeToolsClient.prototype.session;
  let source, receiving;
  const f = await fixture(t, { beforeCleanup: async () => {
    release.resolve();
    await Promise.allSettled([source, receiving].filter(Boolean));
    ZCodeToolsClient.prototype.session = original;
  } });
  stage('fixture-ready');
  ZCodeToolsClient.prototype.session = async function (id) {
    if (id === f.a.binding.sessionId) { entered.resolve(); await release.promise; }
    return original.call(this, id);
  };
  source = sendRemote(f.a.context, f.message(), { exchangeImpl: (_peer, envelope) => receiveEnvelope(f.b.context, envelope) });
  await entered.promise;
  stage('native-query-blocked');
  const incoming = signObject(f.b.node, {
    type: 'message', version: 1, messageId: `m_${randomUUID()}`, roomId: f.room.id, roomRevision: f.room.revision,
    manifestHash: f.room.manifestHash, from: { nodeId: f.b.node.nodeId, bindingId: f.b.binding.id, revision: 1, alias: 'bob' },
    to: { nodeId: f.a.node.nodeId, bindingId: f.a.binding.id, revision: 1, alias: 'alice' },
    text: 'Ingress while source metadata is blocked', replyToMessageId: null, createdAt: new Date().toISOString(),
  });
  receiving = receiveEnvelope(f.a.context, incoming);
  let deadline;
  const receivedBeforeNativeReleased = await Promise.race([receiving.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), 5000); })]);
  clearTimeout(deadline);
  stage(receivedBeforeNativeReleased ? 'receiver-completed-with-native-blocked' : 'receiver-race-expired');
  release.resolve(); await Promise.all([source, receiving]);
  assert.equal(receivedBeforeNativeReleased, true, 'native metadata must not hold the receiver control lock');
});

test('remote send rechecks complete source identity and room pins after the native query', async t => {
  const f = await fixture(t), original = ZCodeToolsClient.prototype.session;
  let change = () => {};
  ZCodeToolsClient.prototype.session = async function (id) {
    const result = await original.call(this, id);
    if (id === f.a.binding.sessionId) await withStore(f.a.context, change);
    return result;
  };
  t.after(() => { ZCodeToolsClient.prototype.session = original; });
  const source = await readStore(f.a.context);
  for (const alter of [store => { store.bindings.alice.projectId = 'changed-project'; }, store => { store.rooms[f.room.id].manifestHash = 'f'.repeat(64); }]) {
    change = alter;
    await assert.rejects(sendRemote(f.a.context, f.message(), { exchangeImpl: () => assert.fail('changed route must not exchange') }), error => error.code === 'BINDING_CHANGED');
    assert.deepEqual((await readStore(f.a.context)).outbox ?? {}, {});
    assert.equal((await ledger(f.a.context)).length, 0);
    await withStore(f.a.context, store => { store.bindings = structuredClone(source.bindings); store.rooms = structuredClone(source.rooms); });
  }
});

test('pause waits for an admitted source exchange then forbids any new send', { timeout: process.platform === 'win32' ? 30000 : 15000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let pausedFinished = false;
  const sending = sendRemote(f.a.context, f.message(), { exchangeImpl: async (_peer, envelope) => { entered.resolve(); await release.promise; return receiveEnvelope(f.b.context, envelope); } });
  await entered.promise;
  const pausing = pauseBarrier(f.a.context, f.a.binding).then(() => { pausedFinished = true; });
  await delay(40); assert.equal(pausedFinished, false);
  release.resolve(); await sending; await pausing;
  await assert.rejects(sendRemote(f.a.context, f.message(), { exchangeImpl: () => assert.fail('paused exchange') }), error => error.code === 'BINDING_PAUSED');
  assert.equal((await ledger(f.a.context)).length, 1);
});

async function mcpFixture(t, { ledgerImpl } = {}) {
  const f = await fixture(t), scopeFile = join(f.root, 'private', 'context.json');
  await writeFile(scopeFile, JSON.stringify(await createMcpScope(f.a.context, { room: f.room.id, from: 'alice' })), { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(scopeFile);
  const tools = await createDialogueMcpTools(f.a.context, { scopeFile, serviceFile: f.serviceFile, ledgerImpl });
  const call = (name, args = {}) => tools.callTool(name, args, { requestMeta: meta(f.a.binding.sessionId, f.directory) });
  const append = async () => {
    const frame = { version: 1, room: f.room.id, from: 'operator', to: 'alice', fromBindingId: 'operator', toBindingId: f.a.binding.id, fromRevision: 1, toRevision: 1, text: 'PRIVATE_PROJECT_BODY', replyTo: null };
    return JSON.parse(await hcom(f.a.context, ['send', '--json', '--from', 'dialogue-operator', `@${f.a.binding.hcomName}`, '--thread', f.room.id, '--intent', 'inform', '--', encodeFrame(frame)]));
  };
  return { ...f, scopeFile, tools, call, append };
}

test('paused MCP inbox returns no body and advances no observation; status and queue remain available', async t => {
  let ledgerCalls = 0;
  const f = await mcpFixture(t, { ledgerImpl: async (...args) => { ledgerCalls++; return ledger(...args); } });
  await f.append(); await paused(f.a.context, f.a.binding);
  const before = await readStore(f.a.context), result = await f.call('dialogue_inbox');
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_PROJECT_BODY'), false);
  assert.equal(result.structuredContent.code, 'BINDING_PAUSED'); assert.equal(ledgerCalls, 0);
  assert.deepEqual((await readStore(f.a.context)).toolReads, before.toolReads);
  assert.equal(value(await f.call('dialogue_status')).lifecycle.desired, 'paused');
  assert.equal(value(await f.call('dialogue_context')).lifecycle.desired, 'paused');
  const args = { to: 'bob', message: 'A queued project follow-up', requestKey: 'paused-send' };
  const queued = value(await f.call('dialogue_send', args));
  assert.equal(queued.status, 'queued'); assert.equal(queued.dispatch, 'paused');
  assert.deepEqual(value(await f.call('dialogue_send', args)), queued);
  assert.equal((await ledger(f.a.context)).length, 2);
});

test('MCP inbox owns destination dispatch through reading and observation commit', { timeout: process.platform === 'win32' ? 60000 : 15000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await mcpFixture(t, { ledgerImpl: async (...args) => { entered.resolve(); await release.promise; return ledger(...args); } });
  const sent = await f.append();
  const inbox = f.call('dialogue_inbox'); await entered.promise;
  let finished = false; const pausing = pauseBarrier(f.a.context, f.a.binding).then(() => { finished = true; });
  await delay(40); assert.equal(finished, false);
  release.resolve(); const received = value(await inbox); await pausing;
  assert.equal(received.messages.length, 1); assert.equal(received.messages[0].text, 'PRIVATE_PROJECT_BODY');
  assert.equal((await readStore(f.a.context)).toolReads[`${f.a.binding.id}:${sent.event_id}`].status, 'tool-read');
  const next = await f.call('dialogue_inbox'); assert.equal(next.isError, true); assert.equal(JSON.stringify(next).includes('PRIVATE_PROJECT_BODY'), false);
});

test('MCP inbox rechecks operator scope after a suspended ledger read before exposing a body', { timeout: process.platform === 'win32' ? 30000 : 15000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await mcpFixture(t, { ledgerImpl: async (...args) => { entered.resolve(); await release.promise; return ledger(...args); } });
  await f.append();
  const inbox = f.call('dialogue_inbox'); await entered.promise;
  const changed = JSON.parse(await readFile(f.scopeFile, 'utf8')); changed.room.revision++;
  await writeFile(f.scopeFile, JSON.stringify(changed));
  release.resolve(); const result = await inbox;
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_PROJECT_BODY'), false);
  assert.deepEqual((await readStore(f.a.context)).toolReads, undefined);
});
