import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpScope, createDialogueMcpTools } from '../lib/mcp-tools.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode, payloadHash } from '../lib/node-identity.mjs';
import { withStore, createBinding, createRoom, readStore } from '../lib/bridge-store.mjs';
import { sealRoom } from '../lib/nodes.mjs';
import { hcom, ledger } from '../lib/bridge.mjs';
import { appendSubmission, prepareSubmission, queueEndpoint, queueSubmission } from '../lib/submissions.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function meta(id, directory) {
  const value = { session_id: id, workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous' };
  return { ...value, 'com.zcode/request-context': { ...value } };
}
async function fixture(t, { appendImpl, queueImpl, ledgerImpl, storeVersion = 3 } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'ad-recovery-mcp-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'native workspace'); await mkdir(directory);
  const serviceFile = join(temp, 'private', 'zcode.private.json');
  await createZCodeService({ path: serviceFile, directory, zcodeVersion: '3.14.3' });
  const client = await ZCodeToolsClient.discover({ serviceFile });
  const requestMeta = meta('sess_exact_recovery_chat', directory);
  const session = await client.register(requestMeta);
  const context = { stateDir: join(temp, 'state'), cacheDir: join(temp, 'cache'), ledgerBackend: 'embedded', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: serviceFile } };
  await initializeEmbedded(context); const node = await loadOrCreateNode(context);
  let self, peer, room;
  await withStore(context, store => {
    self = createBinding(store, { alias: 'self-agent', harness: 'zcode-tools', sessionId: session.id, projectId: session.projectID, directory, serviceId: client.identity.serviceId, origin: client.identity.origin });
    peer = createBinding(store, { alias: 'peer-agent', harness: 'opencode-v2', sessionId: 'ses_peer', projectId: 'peer-project', directory, serviceId: 'peer-service', origin: 'http://127.0.0.1:4500' });
    self.nodeId = peer.nodeId = node.nodeId;
    room = createRoom(store, { name: 'MCP durable recovery project', members: [self.alias, peer.alias] });
  });
  room = await sealRoom(context, room);
  if (storeVersion > 1) await withStore(context, store => { store.version = storeVersion; store.lifecycle = {}; if (storeVersion === 3) store.forwardings = {}; });
  for (const name of [self.hcomName, peer.hcomName]) await hcom(context, ['start', '--name', name]);
  const scopeFile = join(temp, 'private', 'context.private.json');
  await writeFile(scopeFile, JSON.stringify(await createMcpScope(context, { room: room.id, from: self.alias })), { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(scopeFile);
  const tools = await createDialogueMcpTools(context, { scopeFile, serviceFile, queueImpl, appendImpl, ledgerImpl });
  const call = (args, actualMeta = requestMeta) => tools.callTool('dialogue_send', args, { requestMeta: actualMeta });
  const args = { to: peer.alias, message: 'Review the persisted project fact', requestKey: 'durable-one' };
  const id = args => payloadHash({ bindingId: self.id, revision: self.revision, requestKey: args.requestKey });
  return { temp, directory, serviceFile, client, context, node, self, peer, room, scopeFile, requestMeta, tools, call, args, id };
}
function value(result) { assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent; }
function pending(result) { assert.equal(result.isError, true); assert.equal(result.structuredContent?.status, 'pending', JSON.stringify(result)); }
function eventFor(f, prepared, id = 1) {
  return { id, type: 'message', data: { from: f.self.hcomName, sender_kind: 'instance', delivered_to: [queueEndpoint(f.node)], thread: f.room.id, intent: 'request', text: prepared.encoded } };
}

test('v3 MCP durably claims fixed q and full pins before the single append and omits message bodies from control', async t => {
  let calls = 0, captured, record;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => {
    calls++; captured = prepared; record = Object.values((await readStore(context)).mcpSends)[0];
    assert.equal(record.version, 2); assert.equal(record.status, 'append-started');
    assert.equal(record.submissionId, prepared.request.id); assert.equal(record.submissionHash, payloadHash(prepared.request));
    assert.deepEqual(record.pins, prepared.pins); assert.equal(Object.hasOwn(record, 'text'), false); assert.equal(Object.hasOwn(record, 'encoded'), false);
    await options.beforeAppend(); return appendSubmission(context, prepared, options);
  } });
  const first = value(await f.call(f.args)), second = value(await f.call(f.args));
  assert.deepEqual(first, second); assert.equal(calls, 1); assert.equal(first.submissionId, captured.request.id);
  assert.equal((await readStore(f.context)).mcpSends[f.id(f.args)].status, 'queued');
  assert.equal((await ledger(f.context)).length, 1);
});

test('a lost append response recovers only the unique exact q from complete history without appending again', async t => {
  let calls = 0;
  const f = await fixture(t, {
    appendImpl: async (context, prepared, options) => { calls++; await appendSubmission(context, prepared, options); throw new Error('PRIVATE_TOKEN lost append response'); },
    // The legacy seam exercises the historical response-loss behavior when
    // this same test is run against an isolated pre-recovery MCP module.
    queueImpl: async (context, message) => { calls++; await queueSubmission(context, message); throw new Error('PRIVATE_TOKEN lost append response'); },
  });
  const first = await f.call(f.args); pending(first); assert.equal(JSON.stringify(first).includes('PRIVATE_TOKEN'), false);
  const before = await readStore(f.context); assert.equal(before.mcpSends[f.id(f.args)].status, 'append-started');
  const recovered = value(await f.call(f.args)); assert.equal(calls, 1); assert.equal(recovered.event_id, 1);
  assert.equal(recovered.submissionId, before.mcpSends[f.id(f.args)].submissionId);
  assert.deepEqual(value(await f.call(f.args)), recovered); assert.equal((await ledger(f.context)).length, 1);
});

test('an append-started q with no durable evidence stays pending and never gets appended again', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async () => { calls++; throw new Error('Stopped before actual append'); } });
  pending(await f.call(f.args)); pending(await f.call(f.args)); pending(await f.call(f.args));
  assert.equal(calls, 1); assert.equal((await ledger(f.context)).length, 0);
  const record = (await readStore(f.context)).mcpSends[f.id(f.args)]; assert.equal(record.status, 'append-started');
});

test('two durable events with the same q remain pending even when both payloads are exact', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => { calls++; await appendSubmission(context, prepared, options); await appendSubmission(context, prepared, options); throw new Error('Duplicate evidence fixture'); } });
  pending(await f.call(f.args)); pending(await f.call(f.args));
  assert.equal(calls, 1); assert.equal((await ledger(f.context)).length, 2);
  assert.equal((await readStore(f.context)).mcpSends[f.id(f.args)].status, 'append-started');
});

test('same-q wrong body, sender, endpoint, intent and duplicate forged candidates cannot become a receipt', async t => {
  let captured, calls = 0, rows = [];
  const f = await fixture(t, { appendImpl: async (_, prepared) => { calls++; captured = prepared; throw new Error('Uncertain'); }, ledgerImpl: async (_, after, count) => rows.filter(event => event.id > after).slice(0, count) });
  const corruptions = [
    event => { const request = JSON.parse(event.data.text.split('\n').slice(1).join('\n')); request.text = 'different'; event.data.text = 'agent-dialogue/submit/1\n' + JSON.stringify(request); },
    event => { event.data.from = 'other-instance'; },
    event => { event.data.sender_kind = 'external'; },
    event => { event.data.delivered_to = ['elsewhere']; },
    event => { event.data.thread = 'other-room'; },
    event => { event.data.intent = 'inform'; },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const args = { ...f.args, requestKey: `corrupt-${index}` }; pending(await f.call(args));
    const bad = eventFor(f, captured); corrupt(bad); rows = [bad]; pending(await f.call(args));
    rows = [eventFor(f, captured), { ...bad, id: 2 }]; pending(await f.call(args));
  }
  assert.equal(calls, corruptions.length);
});

test('recovery scans past the first thousand rows and requires the final page proving history ended', async t => {
  let captured, calls = 0, requests = [], rows = [];
  const f = await fixture(t, { appendImpl: async (_, prepared) => { calls++; captured = prepared; throw new Error('Uncertain'); }, ledgerImpl: async (_, after, count) => { requests.push({ after, count }); return rows.filter(event => event.id > after).slice(0, count); } });
  pending(await f.call(f.args));
  rows = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, type: 'message', data: { text: 'unrelated project history' } }));
  rows.push(eventFor(f, captured, 1001));
  const recovered = value(await f.call(f.args)); assert.equal(recovered.event_id, 1001); assert.equal(calls, 1);
  assert.deepEqual(requests, [{ after: 0, count: 1000 }, { after: 1000, count: 1000 }]);
});

test('an incomplete bounded history or malformed cursor order stays pending without receipt or retry', async t => {
  let captured, calls = 0, rows = [];
  const f = await fixture(t, { appendImpl: async (_, prepared) => { calls++; captured = prepared; throw new Error('Uncertain'); }, ledgerImpl: async (_, after, count) => rows.filter(event => event.id > after).slice(0, count) });
  pending(await f.call(f.args));
  rows = Array.from({ length: 10001 }, (_, index) => ({ id: index + 1, type: 'message', data: { text: 'unrelated history' } })); rows[0] = eventFor(f, captured);
  pending(await f.call(f.args));
  rows = [eventFor(f, captured, 2), eventFor(f, captured, 1)]; pending(await f.call(f.args));
  assert.equal(calls, 1); assert.equal((await readStore(f.context)).mcpSends[f.id(f.args)].status, 'append-started');
});

test('two concurrent callers for one request key admit a single append claim', { timeout: process.platform === 'win32' ? 60000 : 15000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let calls = 0;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => { calls++; entered.resolve(); await release.promise; return appendSubmission(context, prepared, options); } });
  const first = f.call(f.args); await entered.promise;
  pending(await f.call(f.args)); assert.equal(calls, 1); release.resolve();
  const result = value(await first); assert.deepEqual(value(await f.call(f.args)), result); assert.equal(calls, 1);
});

test('a legacy preparing record without fixed q remains pending in v3 and cannot be guessed from body', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async () => { calls++; throw new Error('must not append'); } });
  const message = { room: f.room.id, from: f.self.alias, to: f.peer.alias, expectedSession: f.peer.sessionId, text: f.args.message, replyTo: null };
  await withStore(f.context, store => { store.mcpSends = { [f.id(f.args)]: { bindingId: f.self.id, bindingRevision: f.self.revision, roomId: f.room.id, requestKey: f.args.requestKey, payloadHash: payloadHash(message), status: 'preparing', at: new Date().toISOString() } }; });
  const before = await readStore(f.context); pending(await f.call(f.args));
  assert.equal(calls, 0); assert.deepEqual((await readStore(f.context)).mcpSends, before.mcpSends);
});

test('a route or scope change during history scan prevents recovery commit and saved receipt exposure', async t => {
  let captured, calls = 0, rows = [], mutate;
  const f = await fixture(t, { appendImpl: async (_, prepared) => { calls++; captured = prepared; throw new Error('Uncertain'); }, ledgerImpl: async () => { if (mutate) { const change = mutate; mutate = null; await change(); } return rows; } });
  pending(await f.call(f.args)); rows = [eventFor(f, captured)];
  mutate = async () => { const scope = JSON.parse(await readFile(f.scopeFile)); scope.self.sessionId = 'other-chat'; await writeFile(f.scopeFile, JSON.stringify(scope)); };
  assert.equal((await f.call(f.args)).isError, true); assert.equal(calls, 1);
  assert.equal((await readStore(f.context)).mcpSends[f.id(f.args)].status, 'append-started');
});

test('paused v3 MCP can queue and reconcile while dispatch remains paused', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => { calls++; await appendSubmission(context, prepared, options); throw new Error('Lost paused receipt'); } });
  await withStore(f.context, store => { store.lifecycle[f.self.id] = { version: 1, bindingRevision: f.self.revision, desired: 'paused', generation: 1, changeNonce: randomUUID(), changedAt: new Date().toISOString(), reason: 'operator-pause' }; });
  pending(await f.call(f.args)); const result = value(await f.call(f.args));
  assert.equal(result.dispatch, 'paused'); assert.equal(calls, 1);
  assert.equal((await readStore(f.context)).lifecycle[f.self.id].desired, 'paused');
});

test('a persisted prepared record left before append admission is claimed once with its original q', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => { calls++; return appendSubmission(context, prepared, options); } });
  const message = { room: f.room.id, from: f.self.alias, to: f.peer.alias, expectedSession: f.peer.sessionId, text: f.args.message, replyTo: null };
  const prepared = prepareSubmission(await readStore(f.context), f.node, message, { submissionId: `q_${randomUUID()}` });
  await withStore(f.context, store => { store.mcpSends = { [f.id(f.args)]: { version: 2, bindingId: f.self.id, bindingRevision: f.self.revision, roomId: f.room.id, requestKey: f.args.requestKey, payloadHash: payloadHash(message), status: 'prepared', at: new Date().toISOString(), submissionId: prepared.request.id, submissionHash: prepared.submissionHash, pins: prepared.pins } }; });
  const first = value(await f.call(f.args)); assert.equal(first.submissionId, prepared.request.id);
  assert.deepEqual(value(await f.call(f.args)), first); assert.equal(calls, 1); assert.equal((await ledger(f.context)).length, 1);
});

test('a new MCP connection recovers the original q after the first connection loses the append response', async t => {
  let calls = 0;
  const f = await fixture(t, { appendImpl: async (context, prepared, options) => { calls++; await appendSubmission(context, prepared, options); throw new Error('Lost connection receipt'); } });
  pending(await f.call(f.args));
  const replacement = await createDialogueMcpTools(f.context, { scopeFile: f.scopeFile, serviceFile: f.serviceFile, appendImpl: async () => { calls++; throw new Error('Must not append again'); } });
  const result = value(await replacement.callTool('dialogue_send', f.args, { requestMeta: f.requestMeta }));
  assert.equal(result.event_id, 1); assert.equal(calls, 1); assert.equal((await ledger(f.context)).length, 1);
});

test('scope changes after endpoint start block the append through the repeated external host gate', async t => {
  let f, starts = 0, sends = 0;
  f = await fixture(t, { appendImpl: (context, prepared, options) => appendSubmission(context, prepared, {
    ...options, hcomImpl: async (context, args) => {
      if (args[0] === 'start') {
        starts++; const result = await hcom(context, args);
        const scope = JSON.parse(await readFile(f.scopeFile)); scope.self.sessionId = 'other-chat'; await writeFile(f.scopeFile, JSON.stringify(scope));
        return result;
      }
      sends++; return hcom(context, args);
    },
  }) });
  pending(await f.call(f.args)); assert.equal(starts, 1); assert.equal(sends, 0); assert.equal((await ledger(f.context)).length, 0);
  assert.equal((await readStore(f.context)).mcpSends[f.id(f.args)].status, 'append-started');
});

test('an immutable durable q or pin change during recovery cannot overwrite the changed record', async t => {
  let captured, f;
  f = await fixture(t, { appendImpl: async (_, prepared) => { captured = prepared; throw new Error('Lost receipt'); }, ledgerImpl: async () => {
    await withStore(f.context, store => { store.mcpSends[f.id(f.args)].submissionId = `q_${randomUUID()}`; });
    return [eventFor(f, captured)];
  } });
  pending(await f.call(f.args)); pending(await f.call(f.args));
  const record = (await readStore(f.context)).mcpSends[f.id(f.args)];
  assert.equal(record.status, 'append-started'); assert.notEqual(record.submissionId, captured.request.id); assert.equal(record.result, undefined);
});

test('a legacy assigned snapshot cannot create an unfenced preparing record after control upgrades to v3', async t => {
  let calls = 0;
  const f = await fixture(t, { storeVersion: 2, queueImpl: async () => { calls++; return { status: 'queued', submissionId: `q_${randomUUID()}`, event_id: 1 }; } });
  const original = ZCodeToolsClient.prototype.session; let upgraded = false;
  ZCodeToolsClient.prototype.session = async function(id) {
    if (id === f.self.sessionId && !upgraded) {
      upgraded = true; await withStore(f.context, store => { store.version = 3; store.forwardings = {}; });
    }
    return original.call(this, id);
  };
  t.after(() => { ZCodeToolsClient.prototype.session = original; });
  assert.equal((await f.call(f.args)).isError, true); assert.equal(calls, 0);
  assert.deepEqual((await readStore(f.context)).mcpSends ?? {}, {}); assert.equal((await ledger(f.context)).length, 0);
});

test('the legacy queue seam receives a version fence and cannot append after preparing-to-v3 upgrade', async t => {
  let calls = 0, options;
  const f = await fixture(t, { storeVersion: 2, queueImpl: async (context, message, actualOptions) => {
    calls++; options = actualOptions;
    await withStore(context, store => { store.version = 3; store.forwardings = {}; });
    return queueSubmission(context, message, actualOptions);
  } });
  pending(await f.call(f.args)); assert.equal(calls, 1); assert.equal(options?.expectedStoreVersion, 2);
  assert.equal((await ledger(f.context)).length, 0);
  const record = (await readStore(f.context)).mcpSends[f.id(f.args)]; assert.equal(record.status, 'preparing'); assert.equal(record.submissionId, undefined);
});

test('an oversized v3 preparing commit preserves original store bytes and performs no q append', async t => {
  let appends = 0;
  const f = await fixture(t, { appendImpl: async () => { appends++; throw new Error('Uncommitted preparation must never reach append'); } });
  const limit = 16 * 1024 * 1024, reserved = 512;
  await withStore(f.context, store => {
    store.controlCapacityFixture = '';
    const gap = limit - reserved - Buffer.byteLength(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
    // Mixed UTF-8 padding exercises the actual byte ceiling without changing
    // a production constant or storing a project message in control metadata.
    store.controlCapacityFixture = '界'.repeat(Math.floor(gap / 3)) + 'x'.repeat(gap % 3);
  });
  const path = join(f.context.stateDir, 'dialogue', 'store.json'), before = await readFile(path);
  assert.equal(before.length, limit - reserved);
  assert.equal((await f.call({ ...f.args, requestKey: 'capacity-no-append' })).isError, true);
  assert.equal(appends, 0);
  assert.ok((await readFile(path)).equals(before), 'Failed preparing persistence must preserve the exact original control-store bytes.');
  assert.deepEqual((await readStore(f.context)).mcpSends ?? {}, {});
  assert.equal((await ledger(f.context)).length, 0);
});
