import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { join } from 'node:path';
import { createMcpScope, createDialogueMcpTools } from '../lib/mcp-tools.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { withStore, createBinding, createRoom, readStore, encodeFrame } from '../lib/bridge-store.mjs';
import { sealRoom } from '../lib/nodes.mjs';
import { hcom, ledger } from '../lib/bridge.mjs';

function meta(id, directory) {
  const value = { session_id: id, workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' };
  return { ...value, 'com.zcode/request-context': { ...value } };
}
async function fixture(t, { scope = true, queueImpl, ledgerImpl } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'ad-mcp-tools-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'native workspace'); await mkdir(directory);
  const serviceFile = join(temp, 'private', 'zcode.private.json');
  await createZCodeService({ path: serviceFile, directory, zcodeVersion: '3.14.3' });
  const client = await ZCodeToolsClient.discover({ serviceFile });
  const requestMeta = meta('sess_selected_chat', directory);
  const session = await client.register(requestMeta);
  const context = { stateDir: join(temp, 'state'), cacheDir: join(temp, 'cache'), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile } };
  await initializeEmbedded(context); const node = await loadOrCreateNode(context);
  let self, peer, room;
  await withStore(context, store => {
    self = createBinding(store, { alias: 'zcode-self', harness: 'zcode-tools', sessionId: session.id, projectId: session.projectID, directory, serviceId: client.identity.serviceId, origin: client.identity.origin });
    peer = createBinding(store, { alias: 'peer-agent', harness: 'opencode-v2', sessionId: 'ses_peer', projectId: 'peer-project', directory, serviceId: 'peer-service', origin: 'http://127.0.0.1:4500' });
    self.nodeId = peer.nodeId = node.nodeId;
    room = createRoom(store, { name: 'MCP synthetic project', members: [self.alias, peer.alias] });
  });
  room = await sealRoom(context, room);
  for (const name of [self.hcomName, peer.hcomName]) await hcom(context, ['start', '--name', name]);
  const scopeFile = join(temp, 'private', 'context.private.json');
  if (scope) await writeFile(scopeFile, JSON.stringify(await createMcpScope(context, { room: room.id, from: self.alias })), { mode: 0o600 });
  if (scope && process.platform === 'win32') await protectWindowsPrivatePath(scopeFile);
  const tools = await createDialogueMcpTools(context, { scopeFile, serviceFile, queueImpl, ledgerImpl });
  const call = (name, args = {}, actualMeta = requestMeta, id = 1) => tools.callTool(name, args, { requestMeta: actualMeta, requestId: id });
  return { temp, directory, serviceFile, client, context, node, self, peer, room, scopeFile, requestMeta, tools, call };
}
function value(result) { assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text); }

test('a scoped MCP context is read-only and exports selected identity without credentials', async t => {
  const f = await fixture(t); const before = await readFile(join(f.context.stateDir, 'dialogue', 'store.json'));
  const scope = await createMcpScope(f.context, { room: f.room.id, from: f.self.alias, to: f.peer.alias });
  assert.equal(scope.self.sessionId, f.self.sessionId); assert.equal(scope.peers.length, 1);
  assert.equal(scope.room.manifestHash, f.room.manifestHash);
  assert.equal(JSON.stringify(scope).includes('privateKey'), false);
  assert.deepEqual(await readFile(join(f.context.stateDir, 'dialogue', 'store.json')), before);
  const exposed = value(await f.call('dialogue_context'));
  assert.equal(exposed.self.sessionId, f.self.sessionId); assert.equal(exposed.deliveryMode, 'tool-pull'); assert.equal(exposed.autoWake, false);
});

test('MCP identity registers only real runtime metadata before an operator assigns a room', async t => {
  const f = await fixture(t, { scope: false });
  const identity = value(await f.call('dialogue_identity')); assert.equal(identity.sessionId, f.self.sessionId);
  const rejected = await f.call('dialogue_send', { to: f.peer.alias, message: 'question', requestKey: 'before-assignment' });
  assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /scope|context|assigned/i);
});

test('wrong chat, subagent, workspace, missing or contradictory host metadata cannot use the scope', async t => {
  const f = await fixture(t);
  const subagent = meta(f.self.sessionId, f.directory); subagent.runtime_scope = subagent['com.zcode/request-context'].runtime_scope = 'subagent';
  const conflict = meta(f.self.sessionId, f.directory); conflict['com.zcode/request-context'].session_id = 'another';
  for (const actual of [null, {}, meta('sess_other_chat', f.directory), meta(f.self.sessionId, join(f.temp, 'other')), subagent, conflict]) {
    const result = await f.call('dialogue_context', {}, actual); assert.equal(result.isError, true);
  }
  const result = await f.call('dialogue_context', { sessionId: f.self.sessionId }, {}); assert.equal(result.isError, true);
});

test('MCP send fixes self, room and expected peer session and reuses a durable request key', async t => {
  let calls = 0, captured;
  const f = await fixture(t, { queueImpl: async (_context, message) => { calls++; captured = message; return { status: 'queued', submissionId: 'q_123', event_id: 12 }; } });
  const args = { to: f.peer.alias, message: 'Review the project contract', requestKey: 'request-one' };
  const first = value(await f.call('dialogue_send', args)); const second = value(await f.call('dialogue_send', args));
  assert.equal(calls, 1); assert.deepEqual(first, second);
  assert.equal(captured.from, f.self.alias); assert.equal(captured.room, f.room.id); assert.equal(captured.expectedSession, f.peer.sessionId);
  assert.equal(first.status, 'queued'); assert.equal(first.nativeAdmitted, undefined);
  const changed = await f.call('dialogue_send', { ...args, message: 'different' }); assert.equal(changed.isError, true); assert.equal(calls, 1);
  assert.equal((await f.call('dialogue_send', { ...args, from: 'operator' })).isError, true);
  assert.equal((await f.call('dialogue_send', { ...args, to: 'not-assigned' })).isError, true);
});

test('an uncertain MCP queue result is retained and never automatically dispatched twice', async t => {
  let calls = 0;
  const f = await fixture(t, { queueImpl: async () => { calls++; throw new Error('PRIVATE_TOKEN secret native body'); } });
  const args = { to: f.peer.alias, message: 'bounded request', requestKey: 'uncertain-one' };
  for (let n = 0; n < 2; n++) {
    const result = await f.call('dialogue_send', args); assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false); assert.match(result.content[0].text, /pending|uncertain|unknown/i);
  }
  assert.equal(calls, 1);
});

test('MCP sends append one actual embedded queue request without native or network access', async t => {
  const f = await fixture(t); const args = { to: f.peer.alias, message: 'project fact', requestKey: 'embedded-one' };
  const first = value(await f.call('dialogue_send', args)); const second = value(await f.call('dialogue_send', args));
  assert.deepEqual(first, second); assert.match(first.submissionId, /^q_/);
  const events = await ledger(f.context); assert.equal(events.length, 1); assert.match(events[0].data.text, /agent-dialogue\/submit\/1/);
});

test('MCP inbox reads only addressed valid room events and records tool-read without native admission', async t => {
  const f = await fixture(t);
  const frame = { version: 1, room: f.room.id, from: f.peer.alias, to: f.self.alias, fromBindingId: f.peer.id, toBindingId: f.self.id, fromRevision: 1, toRevision: 1, text: 'What changed in the project?', replyTo: null };
  const sent = JSON.parse(await hcom(f.context, ['send', '--json', '--name', f.peer.hcomName, `@${f.self.hcomName}`, '--thread', f.room.id, '--intent', 'request', '--', encodeFrame(frame)]));
  const result = value(await f.call('dialogue_inbox', { after: 0, limit: 10 }));
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].text, frame.text); assert.equal(result.messages[0].messageId, String(sent.event_id));
  assert.equal(result.deliveryMode, 'tool-pull'); assert.equal(result.nativeAdmitted, false);
  assert.ok(result.nextCursor >= sent.event_id);
  const store = await readStore(f.context); const seen = store.toolReads[`${f.self.id}:${sent.event_id}`];
  assert.equal(seen.status, 'tool-read'); assert.equal(seen.sessionId, f.self.sessionId); assert.equal(seen.inputId, undefined);
  assert.equal(value(await f.call('dialogue_inbox', { after: result.nextCursor })).messages.length, 0);
});

test('an unsigned local frame cannot promote invented global message or reply identifiers', async t => {
  const f = await fixture(t);
  const frame = { version: 1, room: f.room.id, from: f.peer.alias, to: f.self.alias, fromBindingId: f.peer.id, toBindingId: f.self.id, fromRevision: 1, toRevision: 1, text: 'local finding', replyTo: null, globalMessageId: 'm_11111111-1111-4111-8111-111111111111', replyToMessageId: 'm_22222222-2222-4222-8222-222222222222' };
  const sent = JSON.parse(await hcom(f.context, ['send', '--json', '--name', f.peer.hcomName, `@${f.self.hcomName}`, '--thread', f.room.id, '--intent', 'request', '--', encodeFrame(frame)]));
  const result = value(await f.call('dialogue_inbox'));
  assert.equal(result.messages[0].messageId, String(sent.event_id));
  assert.equal(result.messages[0].replyToMessageId, null);
  const seen = (await readStore(f.context)).toolReads[`${f.self.id}:${sent.event_id}`];
  assert.equal(seen.globalMessageId, undefined);
});

test('scope changes, detach and stale room pins fail closed before queue writes', async t => {
  let calls = 0; const f = await fixture(t, { queueImpl: async () => { calls++; } });
  value(await f.call('dialogue_context'));
  const scope = JSON.parse(await readFile(f.scopeFile)); scope.self.sessionId = 'other'; await writeFile(f.scopeFile, JSON.stringify(scope));
  assert.equal((await f.call('dialogue_context')).isError, true);
  await writeFile(f.scopeFile, JSON.stringify(await createMcpScope(f.context, { room: f.room.id, from: f.self.alias })));
  await withStore(f.context, store => { store.bindings[f.self.alias].active = false; });
  assert.equal((await f.call('dialogue_send', { to: f.peer.alias, message: 'question', requestKey: 'after-detach' })).isError, true);
  assert.equal(calls, 0);
});

test('invalid inbox bounds or tool arguments never expose another chat or private exception', async t => {
  const f = await fixture(t);
  for (const args of [{ after: -1 }, { limit: 101 }, { limit: '2' }, { room: 'other' }, { from: 'operator' }]) assert.equal((await f.call('dialogue_inbox', args)).isError, true);
  assert.equal((await f.call('not_a_tool')).isError, true);
  const status = value(await f.call('dialogue_status')); assert.equal(status.self.alias, f.self.alias); assert.equal(status.autoWake, false);
});

test('MCP request and reply identifiers reject terminal newlines before queue or intent writes', async t => {
  let calls = 0;
  const f = await fixture(t, { queueImpl: async () => { calls++; return { status: 'queued', submissionId: 'q_exact', event_id: 1 }; } });
  const valid = { to: f.peer.alias, message: 'A bounded project message', requestKey: 'exact-request' };
  for (const changed of [{ requestKey: 'exact-request\n' }, { requestKey: 'numeric-reply', replyTo: '1\n' }, { requestKey: 'global-reply', replyTo: 'm_11111111-1111-4111-8111-111111111111\n' }]) assert.equal((await f.call('dialogue_send', { ...valid, ...changed })).isError, true);
  assert.equal(calls, 0); assert.deepEqual((await readStore(f.context)).mcpSends ?? {}, {});
});
