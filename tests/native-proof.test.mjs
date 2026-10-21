import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { payloadHash } from '../lib/node-identity.mjs';
import * as proof from '../lib/native-proof.mjs';
import { OpenCodeV1Client } from '../lib/opencode-v1.mjs';
import { KimiClient } from '../lib/kimi.mjs';

const binding = { id: 'b_11111111-1111-4111-8111-111111111111', revision: 1, alias: 'alice', harness: 'kimi-code', sessionId: 'session_exact', projectId: 'project', directory: resolve('/work/project'), serviceId: 'selected-service', origin: 'http://127.0.0.1:4871', active: true };
const inputId = 'msg_exact_proof', text = 'The full rendered prompt\nincluding commands and 中文 content.', promptHash = payloadHash(text);
const session = () => ({ id: binding.sessionId, projectID: binding.projectId, location: { directory: binding.directory } });
function fixture({ evidence, sessionImpl } = {}) {
  const calls = [];
  const record = evidence === undefined ? { sessionId: binding.sessionId, inputId, role: 'user', text, storage: 'persisted' } : evidence;
  const client = { identity: { serviceId: binding.serviceId, origin: binding.origin }, session: async id => { calls.push(['session', id]); return sessionImpl ? sessionImpl(id) : session(); }, inputEvidence: async (id, input) => { calls.push(['inputEvidence', id, input]); return record; } };
  return { calls, client };
}

test('full persisted user input, exact binding and durable full prompt hash produce a closed positive proof', async () => {
  assert.equal(typeof proof.nativeInputEvidence, 'function');
  const f = fixture(), result = await proof.nativeInputEvidence(f.client, binding, { inputId, text, promptHash });
  assert.deepEqual(result, { status: 'verified', source: 'persisted-user-message', inputId, promptHash });
  assert.deepEqual(f.calls, [['session', binding.sessionId], ['inputEvidence', binding.sessionId, inputId]]);
  assert.equal(JSON.stringify(result).includes(text), false);
});

test('durable promptHash can verify old complete native text without re-rendering installation paths', async () => {
  const f = fixture();
  assert.equal((await proof.nativeInputEvidence(f.client, binding, { inputId, promptHash })).status, 'verified');
});

test('invalid expected hash or mismatched supplied text cannot query or turn an ID match into evidence', async () => {
  const f = fixture();
  for (const change of [{ promptHash: undefined }, { promptHash: 'bad' }, { inputId: inputId + '\n' }, { text: 'different' }, { text: '' }]) {
    assert.deepEqual(await proof.nativeInputEvidence(f.client, binding, { inputId, text, promptHash, ...change }), { status: 'needs-review', reason: 'invalid-expectation' });
  }
  assert.deepEqual(f.calls, []);
});

test('service, session, project and directory mismatch remain closed needs-review results', async () => {
  const service = fixture(); service.client.identity.serviceId = 'other-service';
  assert.deepEqual(await proof.nativeInputEvidence(service.client, binding, { inputId, promptHash }), { status: 'needs-review', reason: 'binding-mismatch' });
  assert.deepEqual(service.calls, []);
  for (const patch of [{ id: 'b_other' }, { revision: 0 }, { active: false }, { remote: true }, { projectId: '' }, { directory: 'relative' }]) {
    const f = fixture();
    assert.deepEqual(await proof.nativeInputEvidence(f.client, { ...binding, ...patch }, { inputId, promptHash }), { status: 'needs-review', reason: 'binding-mismatch' });
    assert.deepEqual(f.calls, []);
  }
  for (const patch of [{ id: 'session_other' }, { projectID: 'other-project' }, { location: { directory: resolve('/other') } }, { time: { archived: 1 } }]) {
    const f = fixture({ sessionImpl: async () => ({ ...session(), ...patch }) });
    assert.equal((await proof.nativeInputEvidence(f.client, binding, { inputId, promptHash })).status, 'needs-review');
    assert.equal(f.calls.some(call => call[0] === 'inputEvidence'), false);
  }
});

test('missing independent strong lookup is unsupported and does not fall back to legacy ID projections', async () => {
  const f = fixture(); delete f.client.inputEvidence;
  f.client.input = async () => assert.fail('legacy input fallback is not an independent proof');
  f.client.inbox = async () => assert.fail('legacy inbox ID projection is not strong evidence');
  f.client.messages = async () => assert.fail('last-N ID projection is not strong evidence');
  assert.deepEqual(await proof.nativeInputEvidence(f.client, binding, { inputId, promptHash }), { status: 'needs-review', reason: 'unsupported-adapter' });
  assert.deepEqual(f.calls, []);
});

test('absent, partial, foreign, non-user, in-memory and contradictory evidence cannot authorize a receipt', async () => {
  const valid = { sessionId: binding.sessionId, inputId, role: 'user', text, storage: 'persisted' };
  const absent = fixture({ evidence: null });
  assert.deepEqual(await proof.nativeInputEvidence(absent.client, binding, { inputId, promptHash }), { status: 'needs-review', reason: 'input-not-found' });
  for (const record of [true, { id: inputId }, { ...valid, sessionId: 'session_other' }, { ...valid, inputId: 'msg_other' }, { ...valid, role: 'assistant' }, { ...valid, text: text.slice(0, -1) }, { ...valid, text: text + ' ' }, { ...valid, storage: 'queued-in-memory' }, { ...valid, nativeAdmitted: true }]) {
    const f = fixture({ evidence: record });
    assert.deepEqual(await proof.nativeInputEvidence(f.client, binding, { inputId, promptHash }), { status: 'needs-review', reason: 'input-mismatch' });
  }
});

test('unavailable native lookups redact the original response and never invoke any mutating capability', async () => {
  const f = fixture();
  f.client.inputEvidence = async () => { throw new Error('PRIVATE_NATIVE_BODY token'); };
  for (const key of ['prompt', 'resumeThread', 'drain', 'createThread']) f.client[key] = async () => assert.fail('proof must not mutate');
  assert.deepEqual(await proof.nativeInputEvidence(f.client, binding, { inputId, promptHash }), { status: 'needs-review', reason: 'native-unavailable' });
});

test('the Kimi and OpenCode V1 independent evidence wrappers use their full persisted exact-input contracts', async () => {
  assert.equal(typeof KimiClient.prototype.inputEvidence, 'function'); assert.equal(typeof OpenCodeV1Client.prototype.inputEvidence, 'function');
  const kimi = Object.create(KimiClient.prototype); let kimiReads = 0;
  kimi.input = async (sessionId, input) => { kimiReads++; assert.equal(sessionId, binding.sessionId); assert.equal(input, inputId); return { id: inputId, session_id: binding.sessionId, role: 'user', content: [{ type: 'text', text }] }; };
  assert.deepEqual(await kimi.inputEvidence(binding.sessionId, inputId), { sessionId: binding.sessionId, inputId, role: 'user', text, storage: 'persisted' });
  assert.equal(kimiReads, 1); kimi.input = async () => null; assert.equal(await kimi.inputEvidence(binding.sessionId, inputId), null);
  const v1 = Object.create(OpenCodeV1Client.prototype);
  v1.input = async () => ({ info: { id: inputId, sessionID: binding.sessionId, role: 'user' }, parts: [{ type: 'text', text, sessionID: binding.sessionId, messageID: inputId }] });
  assert.deepEqual(await v1.inputEvidence(binding.sessionId, inputId), { sessionId: binding.sessionId, inputId, role: 'user', text, storage: 'persisted' });
  v1.input = async () => null; assert.equal(await v1.inputEvidence(binding.sessionId, inputId), null);
});

test('Kimi strong proof traverses the real adapter GET contract and never accepts its in-memory prompt queue', async () => {
  const identity = { serviceId: binding.serviceId, origin: binding.origin, version: '2.2.0' }, calls = [];
  const native = { id: binding.sessionId, workspace_id: 'workspace', metadata: { cwd: binding.directory }, archived: false, busy: false, main_turn_active: false, pending_interaction: 'none', created_at: '2026-10-20T00:00:00.000Z', updated_at: '2026-10-20T00:00:00.000Z' };
  let stored = { id: inputId, session_id: binding.sessionId, role: 'user', content: [{ type: 'text', text }] };
  const client = new KimiClient({ identity, token: 'fixture-private-token', directory: binding.directory, workspaceId: 'workspace', sessionIds: [binding.sessionId], commandShell: 'posix', fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method }); assert.equal(options.method, 'GET');
    if (url.pathname === '/api/v1/meta') return { ok: true, status: 200, json: async () => ({ code: 0, data: { server_id: identity.serviceId, server_version: identity.version, backend: 'v2', dangerous_bypass_auth: false } }) };
    if (url.pathname === `/api/v1/sessions/${binding.sessionId}`) return { ok: true, status: 200, json: async () => ({ code: 0, data: native }) };
    if (url.pathname === `/api/v1/sessions/${binding.sessionId}/messages/${inputId}`) return { ok: true, status: 200, json: async () => ({ code: stored ? 0 : 40403, data: stored }) };
    assert.fail('Strong Kimi proof may not read the queue or last-N history.');
  } });
  const selected = { ...binding, projectId: (await client.session(binding.sessionId)).projectID };
  assert.equal((await proof.nativeInputEvidence(client, selected, { inputId, promptHash })).status, 'verified');
  stored.content.push({ type: 'text', text: 'Extra hidden segment' });
  assert.equal((await proof.nativeInputEvidence(client, selected, { inputId, promptHash })).status, 'needs-review');
  stored = null; assert.deepEqual(await proof.nativeInputEvidence(client, selected, { inputId, promptHash }), { status: 'needs-review', reason: 'input-not-found' });
  assert.ok(calls.some(call => call.path.endsWith(`/messages/${inputId}`)));
});

test('OpenCode V1 strong proof uses the exact persisted full part and refuses partial storage without POST', async () => {
  const identity = { serviceId: binding.serviceId, origin: binding.origin, version: '1.19.0' }, selected = { ...binding, harness: 'opencode-v1', sessionId: 'ses_exact' }, calls = [];
  let stored = { info: { id: inputId, sessionID: selected.sessionId, role: 'user' }, parts: [{ sessionID: selected.sessionId, messageID: inputId, type: 'text', text }] };
  const client = new OpenCodeV1Client({ identity, password: 'fixture-private-password', directory: selected.directory, projectId: selected.projectId, shell: '/bin/bash', commandShell: 'posix', fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method }); assert.equal(options.method, 'GET');
    if (url.pathname === '/global/health') return { ok: true, status: 200, json: async () => ({ healthy: true, version: identity.version }) };
    if (url.pathname === '/config') return { ok: true, status: 200, json: async () => ({ shell: '/bin/bash' }) };
    if (url.pathname === `/session/${selected.sessionId}`) return { ok: true, status: 200, json: async () => ({ id: selected.sessionId, projectID: selected.projectId, directory: selected.directory }) };
    if (url.pathname === `/session/${selected.sessionId}/message/${inputId}`) return { ok: !!stored, status: stored ? 200 : 404, json: async () => stored };
    assert.fail('Strong V1 proof may not submit, resume or scan last-N history.');
  } });
  assert.equal((await proof.nativeInputEvidence(client, selected, { inputId, promptHash })).status, 'verified');
  stored.parts = []; assert.equal((await proof.nativeInputEvidence(client, selected, { inputId, promptHash })).status, 'needs-review');
  stored = null; assert.deepEqual(await proof.nativeInputEvidence(client, selected, { inputId, promptHash }), { status: 'needs-review', reason: 'input-not-found' });
  assert.ok(calls.some(call => call.path.endsWith(`/message/${inputId}`)));
});
