import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, decodeFrame, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { hcom, ledger } from '../lib/bridge.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode, signObject, verifyObject } from '../lib/node-identity.mjs';
import { acceptRoom, exportNode, exportRoom, pairPeer, receiveEnvelope, sealRoom, sendRemote } from '../lib/nodes.mjs';
import { createDialogueMcpTools, createMcpScope } from '../lib/mcp-tools.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';

function metadata(sessionId, directory) {
  const context = { session_id: sessionId, workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' };
  return { ...context, 'com.zcode/request-context': { ...context } };
}
function result(response) { assert.equal(response.isError, undefined, JSON.stringify(response)); return response.structuredContent; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-zcode-ingress-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'desktop-workspace'); await mkdir(directory);
  const serviceFile = join(root, 'private', 'zcode.json'); await createZCodeService({ path: serviceFile, directory });
  const client = await ZCodeToolsClient.discover({ serviceFile }), requestMeta = metadata('sess_actual_desktop_context', directory);
  const observed = await client.register(requestMeta);
  const context = name => ({ stateDir: join(root, name), cacheDir: join(root, `${name}-cache`), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile } });
  const a = context('source'), b = context('desktop');
  await initializeEmbedded(a); await initializeEmbedded(b);
  const nodeA = await loadOrCreateNode(a), nodeB = await loadOrCreateNode(b);
  let alice, charlie, self, localPeer;
  await withStore(a, store => {
    const common = { harness: 'opencode-v2', directory, projectId: 'fixture-project', serviceId: 'fixture-source-service', origin: 'http://127.0.0.1:4500' };
    alice = createBinding(store, { ...common, alias: 'alice', sessionId: 'ses_alice' }); alice.nodeId = nodeA.nodeId;
    charlie = createBinding(store, { ...common, alias: 'charlie', sessionId: 'ses_charlie' }); charlie.nodeId = nodeA.nodeId;
  });
  await withStore(b, store => {
    self = createBinding(store, { alias: 'zcode-self', harness: 'zcode-tools', sessionId: observed.id, projectId: observed.projectID, directory, serviceId: client.identity.serviceId, origin: client.identity.origin }); self.nodeId = nodeB.nodeId;
    localPeer = createBinding(store, { alias: 'local-peer', harness: 'opencode-v2', sessionId: 'ses_local_peer', projectId: 'fixture-local-project', directory, serviceId: 'fixture-local-service', origin: 'http://127.0.0.1:4501' }); localPeer.nodeId = nodeB.nodeId;
  });
  const transport = target => ({ kind: 'local-process', executable: process.execPath, args: [], stateDir: target.stateDir });
  await pairPeer(a, await exportNode(b), transport(b)); await pairPeer(b, await exportNode(a), transport(a));
  async function room(name) {
    const created = await withStore(b, store => createRoom(store, { name, members: [self.alias, alice.alias, charlie.alias, localPeer.alias] }));
    const sealed = await sealRoom(b, created); await acceptRoom(a, await exportRoom(b, sealed.id)); return sealed;
  }
  const primary = await room('Assigned project'), other = await room('Other project');
  for (const [target, bindings] of [[a, [alice, charlie]], [b, [self, localPeer]]]) for (const binding of bindings) await hcom(target, ['start', '--name', binding.hcomName]);
  const scopeFile = join(root, 'private', 'mcp-context.json');
  await writeFile(scopeFile, JSON.stringify(await createMcpScope(b, { room: primary.id, from: self.alias, to: alice.alias })), { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(scopeFile);
  async function tools(ledgerImpl) { return createDialogueMcpTools(b, { scopeFile, serviceFile, ...(ledgerImpl ? { ledgerImpl } : {}) }); }
  const initial = await tools();
  const call = (name, args = {}, selected = initial) => selected.callTool(name, args, { requestMeta });
  const endpoint = (binding, node) => ({ nodeId: node.nodeId, bindingId: binding.id, revision: binding.revision, alias: binding.alias });
  function wire({ source = alice, selectedRoom = primary, text = 'Signed project fact', ...changes } = {}) {
    return signObject(nodeA, { type: 'message', version: 1, messageId: `m_${randomUUID()}`, roomId: selectedRoom.id, roomRevision: selectedRoom.revision, manifestHash: selectedRoom.manifestHash, from: endpoint(source, nodeA), to: endpoint(self, nodeB), text, replyToMessageId: null, createdAt: new Date().toISOString(), ...changes });
  }
  return { root, directory, a, b, self, alice, charlie, localPeer, primary, other, nodeA, nodeB, requestMeta, scopeFile, tools, call, wire };
}

test('MCP inbox derives the global ID only from real accepted signed ingress', async t => {
  const f = await fixture(t), message = f.wire();
  const receipt = verifyObject(await receiveEnvelope(f.b, message), f.nodeB.publicKey);
  const page = result(await f.call('dialogue_inbox', { after: 0 }));
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].messageId, message.payload.messageId);
  assert.equal(page.messages[0].localEventId, receipt.eventId); assert.equal(page.messages[0].replyToMessageId, null);
  assert.equal(page.messages[0].text, message.payload.text); assert.equal(page.nativeAdmitted, false);
  const store = await readStore(f.b), read = store.toolReads[`${f.self.id}:${receipt.eventId}`];
  assert.equal(read.globalMessageId, message.payload.messageId); assert.equal(read.status, 'tool-read'); assert.equal(read.inputId, undefined);
  assert.equal(store.inbox[message.payload.messageId].status, 'stored');
});

test('MCP signed replies preserve the actual global parent and do not substitute local replyTo', async t => {
  const f = await fixture(t);
  const parent = await sendRemote(f.b, { room: f.primary.id, from: f.self.alias, to: f.alice.alias, text: 'Question from the exact contextual desktop binding' }, { exchangeImpl: async (_peer, envelope) => receiveEnvelope(f.a, envelope) });
  const response = f.wire({ text: 'Signed correlated answer', replyToMessageId: parent.messageId });
  const stored = verifyObject(await receiveEnvelope(f.b, response), f.nodeB.publicKey);
  const page = result(await f.call('dialogue_inbox'));
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].messageId, response.payload.messageId);
  assert.equal(page.messages[0].replyToMessageId, parent.messageId); assert.equal(page.messages[0].localEventId, stored.eventId);
  const nativeFrame = decodeFrame((await ledger(f.b)).find(row => row.id === stored.eventId).data.text);
  assert.equal(nativeFrame.replyTo, null); assert.equal(nativeFrame.wireEnvelope.payload.replyToMessageId, parent.messageId);
});

test('bad signatures and signed-payload changes are rejected before ingress and no tool-read is recorded', async t => {
  const f = await fixture(t), message = f.wire();
  for (const bad of [{ ...message, signature: Buffer.alloc(64).toString('base64') }, { ...message, payload: { ...message.payload, text: 'Tampered signed body' } }]) await assert.rejects(receiveEnvelope(f.b, bad), /signature/);
  assert.deepEqual(await ledger(f.b), []); assert.deepEqual(result(await f.call('dialogue_inbox')).messages, []);
  const store = await readStore(f.b); assert.deepEqual(store.inbox ?? {}, {}); assert.deepEqual(store.toolReads ?? {}, {});
});

test('MCP revalidates stored signature, complete text, sender, mapping and global parent before a tool-read', async t => {
  const f = await fixture(t), message = f.wire(); await receiveEnvelope(f.b, message);
  const original = (await ledger(f.b))[0];
  const transformations = [
    frame => { frame.wireEnvelope.signature = Buffer.alloc(64).toString('base64'); },
    frame => { frame.text = 'Locally replaced exact body'; },
    frame => { frame.globalMessageId = `m_${randomUUID()}`; },
    frame => { frame.replyToMessageId = `m_${randomUUID()}`; },
    (_frame, event) => { event.id += 100; },
    (_frame, event) => { event.data.from = 'forged-local-source'; },
  ];
  for (const transform of transformations) {
    const modified = structuredClone(original), frame = decodeFrame(modified.data.text); transform(frame, modified); modified.data.text = encodeFrame(frame);
    const selected = await f.tools(async () => [modified]);
    const rejected = await f.call('dialogue_inbox', {}, selected);
    assert.equal(rejected.isError, true); assert.deepEqual((await readStore(f.b)).toolReads ?? {}, {});
  }
  assert.deepEqual((await ledger(f.b))[0], original);
});

test('MCP refuses malformed string recipients even when they contain the exact binding name', async t => {
  const f = await fixture(t), message = f.wire(); await receiveEnvelope(f.b, message);
  const row = structuredClone((await ledger(f.b))[0]); row.data.delivered_to = `other-${f.self.hcomName}-endpoint`;
  const selected = await f.tools(async () => [row]);
  const page = result(await f.call('dialogue_inbox', {}, selected));
  assert.deepEqual(page.messages, []); assert.deepEqual((await readStore(f.b)).toolReads ?? {}, {});
});

test('MCP does not disclose another accepted room or an unassigned peer in the same room', async t => {
  const f = await fixture(t);
  const otherRoom = f.wire({ selectedRoom: f.other, text: 'PRIVATE_OTHER_ROOM' });
  const otherPeer = f.wire({ source: f.charlie, text: 'PRIVATE_UNASSIGNED_PEER' });
  const selected = f.wire({ text: 'Allowed project message' });
  for (const message of [otherRoom, otherPeer, selected]) await receiveEnvelope(f.b, message);
  const page = result(await f.call('dialogue_inbox', { limit: 100 }));
  assert.deepEqual(page.messages.map(message => message.messageId), [selected.payload.messageId]);
  assert.ok(!JSON.stringify(page).includes('PRIVATE_'));
  const reads = Object.values((await readStore(f.b)).toolReads ?? {});
  assert.equal(reads.length, 1); assert.equal(reads[0].globalMessageId, selected.payload.messageId);
});

test('MCP scans at most 1000 raw events and advances over unrelated rows without skipping the next message', async t => {
  const f = await fixture(t);
  await hcom(f.b, ['start', '--name', 'unrelated-fixture']);
  for (let n = 0; n < 1000; n++) await hcom(f.b, ['send', '--json', '--from', 'fixture-generator', '@unrelated-fixture', '--intent', 'inform', '--', `Unrelated bounded row ${n}`]);
  const message = f.wire({ text: 'First signed event after the 1000 raw-row boundary' });
  const receipt = verifyObject(await receiveEnvelope(f.b, message), f.nodeB.publicKey);
  assert.equal(receipt.eventId, 1001);
  const first = result(await f.call('dialogue_inbox', { after: 0, limit: 2 }));
  assert.deepEqual(first.messages, []); assert.equal(first.nextCursor, 1000); assert.equal(first.hasMore, true);
  const second = result(await f.call('dialogue_inbox', { after: first.nextCursor, limit: 2 }));
  assert.deepEqual(second.messages.map(item => item.messageId), [message.payload.messageId]); assert.equal(second.nextCursor, 1001); assert.equal(second.hasMore, false);
  const third = result(await f.call('dialogue_inbox', { after: second.nextCursor, limit: 2 }));
  assert.deepEqual(third.messages, []); assert.equal(third.nextCursor, 1001); assert.equal(third.hasMore, false);
});

test('MCP count pagination preserves addressed events and never returns one twice with the returned cursor', async t => {
  const f = await fixture(t), messages = Array.from({ length: 3 }, (_, n) => f.wire({ text: `Ordered project fact ${n}` }));
  for (const message of messages) await receiveEnvelope(f.b, message);
  const first = result(await f.call('dialogue_inbox', { limit: 2 }));
  assert.deepEqual(first.messages.map(item => item.messageId), messages.slice(0, 2).map(message => message.payload.messageId)); assert.equal(first.nextCursor, 2); assert.equal(first.hasMore, true);
  const second = result(await f.call('dialogue_inbox', { after: first.nextCursor, limit: 2 }));
  assert.deepEqual(second.messages.map(item => item.messageId), [messages[2].payload.messageId]); assert.equal(second.nextCursor, 3); assert.equal(second.hasMore, false);
});

test('MCP JSON budget pages two synthetic 40k Chinese local records without skipping the deferred event', async t => {
  const f = await fixture(t);
  await writeFile(f.scopeFile, JSON.stringify(await createMcpScope(f.b, { room: f.primary.id, from: f.self.alias, to: f.localPeer.alias })));
  // Deliberately inject logical rows: 40k Chinese characters exceed the signed
  // transport argv budget. Real receiveEnvelope and its limits are tested above.
  const rows = [1, 2].map(id => ({ id, type: 'message', data: { from: f.localPeer.hcomName, sender_kind: 'instance', delivered_to: [f.self.hcomName], thread: f.primary.id, text: encodeFrame({ version: 1, room: f.primary.id, from: f.localPeer.alias, to: f.self.alias, fromBindingId: f.localPeer.id, toBindingId: f.self.id, fromRevision: 1, toRevision: 1, text: '中'.repeat(40_000), replyTo: null }) } }));
  const selected = await f.tools(async (_context, after, count) => rows.filter(row => row.id > after).slice(0, count));
  const first = result(await f.call('dialogue_inbox', { after: 0, limit: 20 }, selected));
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].localEventId, 1); assert.equal(first.nextCursor, 1); assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first.messages)) <= 192 * 1024);
  const second = result(await f.call('dialogue_inbox', { after: first.nextCursor, limit: 20 }, selected));
  assert.equal(second.messages.length, 1); assert.equal(second.messages[0].localEventId, 2); assert.equal(second.nextCursor, 2); assert.equal(second.hasMore, false);
  assert.ok(Buffer.byteLength(JSON.stringify(second.messages)) <= 192 * 1024);
  const reads = Object.values((await readStore(f.b)).toolReads ?? {}); assert.deepEqual(reads.map(read => read.eventId).sort(), [1, 2]);
});

test('MCP JSON budget pages five real accepted signed 18k Chinese messages within transport and output bounds', async t => {
  const f = await fixture(t), messages = Array.from({ length: 5 }, (_, n) => f.wire({ text: `${n}:` + '中'.repeat(18_000) }));
  for (const message of messages) await receiveEnvelope(f.b, message);
  const actualRows = await ledger(f.b); assert.equal(actualRows.length, 5);
  assert.ok(actualRows.every(row => Buffer.byteLength(row.data.text) <= 120_000));
  const first = result(await f.call('dialogue_inbox', { after: 0, limit: 20 }));
  assert.deepEqual(first.messages.map(message => message.messageId), messages.slice(0, 3).map(message => message.payload.messageId));
  assert.equal(first.nextCursor, 3); assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first.messages)) <= 192 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(first) }], structuredContent: first })) < 524288);
  const firstReads = Object.values((await readStore(f.b)).toolReads ?? {}); assert.equal(firstReads.length, 3);
  const second = result(await f.call('dialogue_inbox', { after: first.nextCursor, limit: 20 }));
  assert.deepEqual(second.messages.map(message => message.messageId), messages.slice(3).map(message => message.payload.messageId));
  assert.equal(second.nextCursor, 5); assert.equal(second.hasMore, false);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(second) }], structuredContent: second })) < 524288);
  assert.equal(Object.keys((await readStore(f.b)).toolReads).length, 5);
});

test('MCP output budget counts the extra content JSON escaping for real local ledger messages', async t => {
  const f = await fixture(t);
  await writeFile(f.scopeFile, JSON.stringify(await createMcpScope(f.b, { room: f.primary.id, from: f.self.alias, to: f.localPeer.alias })));
  for (let n = 0; n < 3; n++) {
    const text = encodeFrame({ version: 1, room: f.primary.id, from: f.localPeer.alias, to: f.self.alias, fromBindingId: f.localPeer.id, toBindingId: f.self.id, fromRevision: 1, toRevision: 1, text: '\\'.repeat(32_000), replyTo: null });
    assert.ok(Buffer.byteLength(text) <= 120_000);
    await hcom(f.b, ['send', '--json', '--name', f.localPeer.hcomName, `@${f.self.hcomName}`, '--thread', f.primary.id, '--intent', 'inform', '--', text]);
  }
  const selected = await f.tools();
  const firstResponse = await f.call('dialogue_inbox', { after: 0, limit: 20 }, selected), first = result(firstResponse);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'escaping-budget', result: firstResponse })) < 524288);
  assert.equal(first.messages.length, 2); assert.equal(first.nextCursor, 2); assert.equal(first.hasMore, true);
  const secondResponse = await f.call('dialogue_inbox', { after: first.nextCursor, limit: 20 }, selected), second = result(secondResponse);
  assert.equal(second.messages.length, 1); assert.equal(second.messages[0].localEventId, 3); assert.equal(second.nextCursor, 3); assert.equal(second.hasMore, false);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'escaping-budget-next', result: secondResponse })) < 524288);
});
