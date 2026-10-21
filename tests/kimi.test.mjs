import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KimiClient } from '../lib/kimi.mjs';

const identity = { serviceId: 'owned-kimi-server', origin: 'http://127.0.0.1:4567', version: '2.1.1' };
const directory = 'E:\\Knowledgebase\\Project';
const native = { id: 'session_test-123', workspace_id: 'wd_test_123', metadata: { cwd: directory }, title: 'Existing server chat', archived: false, busy: false, main_turn_active: false, pending_interaction: 'none', created_at: '2026-10-19T00:00:00.000Z', updated_at: '2026-10-19T00:01:00.000Z', agent_config: { model: '' } };
const meta = { server_id: identity.serviceId, server_version: identity.version, backend: 'v2', dangerous_bypass_auth: false };
const msg = (id = 'msg_stable1', text = 'Project question') => ({ id, session_id: native.id, role: 'user', content: [{ type: 'text', text }], created_at: native.created_at });
const json = (data, code = 0, status = 200) => ({ ok: status < 400, status, json: async () => ({ code, data, msg: 'withheld private upstream details' }) });
function fixture(overrides = {}, options = {}) {
  const calls = [], saved = new Map();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (overrides[url.pathname]) return overrides[url.pathname](url, init, saved);
    if (url.pathname === '/api/v1/meta') return json(meta);
    if (url.pathname === `/api/v1/sessions/${native.id}`) return json(structuredClone(native));
    if (url.pathname === `/api/v1/sessions/${native.id}/messages`) return json({ items: [...saved.values()].reverse(), has_more: false });
    if (url.pathname === `/api/v1/sessions/${native.id}/prompts`) {
      if (init.method === 'GET') return json({ active: null, queued: [] });
      const body = JSON.parse(init.body); saved.set(body.prompt_id, msg(body.prompt_id, body.content[0].text));
      return json({ prompt_id: body.prompt_id, user_message_id: body.prompt_id, content: body.content, status: 'running', created_at: native.created_at });
    }
    if (url.pathname.startsWith(`/api/v1/sessions/${native.id}/messages/`)) return saved.has(url.pathname.split('/').at(-1)) ? json(saved.get(url.pathname.split('/').at(-1))) : json(null, 40403);
    assert.fail(`Unexpected Kimi request: ${init.method} ${url.pathname}`);
  };
  const client = new KimiClient({ identity, token: 'private-token', directory, workspaceId: native.workspace_id, sessionIds: [native.id], commandShell: 'posix', fetchImpl, receiptTimeoutMs: 5, pollIntervalMs: 1, ...options });
  return { client, calls, saved, fetchImpl };
}

test('Kimi rejects unsafe service origins, unsupported versions and incomplete owner scope', () => {
  for (const origin of ['http://example.com', 'http://u:p@localhost:4567', 'http://localhost:4567/x', 'file:///tmp/server']) assert.throws(() => fixture({}, { identity: { ...identity, origin } }), /loopback|Invalid/);
  for (const value of [{ identity: { ...identity, version: '1.0.0' } }, { token: '' }, { directory: 'relative' }, { workspaceId: '' }, { sessionIds: [] }, { sessionIds: [native.id, native.id] }, { commandShell: 'powershell' }, { receiptTimeoutMs: 0 }]) assert.throws(() => fixture({}, value), /Invalid|Unsupported|missing|scope|version/);
});

test('Kimi advertises idle-only stable input and POSIX tool command semantics', () => {
  const { client } = fixture();
  assert.deepEqual(client.capabilities, { existingAttach: true, queue: false, stableInputId: true, resume: false, idleOnly: true, commandShell: 'posix' });
  assert.ok(!JSON.stringify(client).includes('private-token'));
});

test('Kimi lists only owner-selected exact sessions without loading native history', async () => {
  const { client, calls } = fixture();
  const items = await client.sessions({ directory: 'E:/Knowledgebase/Project' });
  assert.equal(items.length, 1); assert.equal(items[0].id, native.id);
  assert.equal(items[0].location.directory, directory); assert.match(items[0].projectID, /^kimi_[a-f0-9]{32}$/);
  assert.equal(items[0].model, undefined);
  assert.ok(calls.every(({ init }) => init.method === 'GET'));
  assert.ok(calls.every(({ url }) => url.pathname === '/api/v1/meta' || url.pathname === `/api/v1/sessions/${native.id}`));
  await assert.rejects(client.sessions({ directory: 'C:/Other' }), /scope/);
});

test('Kimi exact session validates native ID, workspace, directory and archive state', async () => {
  for (const delta of [{ id: 'session_other' }, { workspace_id: 'wd_other' }, { metadata: { cwd: 'C:/Other' } }, { archived: true }, { busy: 'false' }, { pending_interaction: 'unexpected' }]) {
    const { client } = fixture({ [`/api/v1/sessions/${native.id}`]: () => json({ ...native, ...delta }) });
    await assert.rejects(client.session(native.id), /session|scope|archived|Invalid/);
  }
});

test('Kimi rejects unselected sessions and invalid API paths before native calls', async () => {
  const { client, calls } = fixture();
  for (const id of ['latest', 'session_other', 'session_bad/slash']) await assert.rejects(client.session(id), /Invalid|owner/);
  for (const path of ['/api/v1/config', '/api/v1/oauth/userinfo', '/api/v1/sessions', '//other', `/api/v1/sessions/${native.id}?x=1`]) await assert.rejects(client.request('GET', path), /Invalid/);
  await assert.rejects(client.request('POST', `/api/v1/sessions/${native.id}/profile`, {}), /Invalid/);
  assert.equal(calls.length, 0);
});

test('Kimi never coerces array or object identifiers into selected strings', async () => {
  const { client, calls } = fixture();
  for (const id of [[native.id], { toString: () => native.id }]) {
    await assert.rejects(client.session(id), /Invalid/);
    await assert.rejects(client.prompt(native.id, { id, text: 'Question' }), error => error.notSubmitted === true);
    assert.throws(() => fixture({}, { sessionIds: [id] }), /scope/);
  }
  await assert.rejects(client.input(native.id, ['msg_stable1']), /Invalid/);
  await assert.rejects(client.request('GET', [`/api/v1/sessions/${native.id}`]), /Invalid/);
  assert.equal(calls.length, 0);
});

test('Kimi validates authoritative meta identity, version and backend on every operation', async () => {
  for (const delta of [{ server_id: 'other' }, { server_version: '2.0.0' }, { backend: 'v1' }, { dangerous_bypass_auth: true }]) {
    const { client } = fixture({ '/api/v1/meta': () => json({ ...meta, ...delta }) });
    await assert.rejects(client.session(native.id), /identity|version|backend|authentication/);
  }
});

test('Kimi posts only stable prompt ID and text, retaining native model and permission', async () => {
  const { client, calls } = fixture();
  const result = await client.prompt(native.id, { id: 'msg_stable1', text: 'Project question', metadata: { room: 'r_one' } });
  assert.equal(result.status, 'persisted'); assert.equal(result.sessionID, native.id);
  const posts = calls.filter(({ init }) => init.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), { prompt_id: 'msg_stable1', content: [{ type: 'text', text: 'Project question' }] });
  assert.equal(posts[0].init.headers.authorization, 'Bearer private-token'); assert.equal(posts[0].init.redirect, 'error');
  assert.ok(posts[0].init.signal instanceof AbortSignal);
});

test('Kimi busy, approval and question sessions retain local queue without native POST', async () => {
  for (const delta of [{ busy: true }, { main_turn_active: true }, { pending_interaction: 'approval' }, { pending_interaction: 'question' }]) {
    const { client, calls } = fixture({ [`/api/v1/sessions/${native.id}`]: () => json({ ...native, ...delta }) });
    await assert.rejects(client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' }), error => error.notSubmitted === true && error.retryable === true && error.nativeBusy === true);
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
  }
});

test('Kimi catches existing queued/blocked prompts before a new native submission', async () => {
  const { client, calls } = fixture({ [`/api/v1/sessions/${native.id}/prompts`]: () => json({ active: null, queued: [{ prompt_id: 'msg_other', user_message_id: 'msg_other', status: 'blocked', content: [{ type: 'text', text: 'Another question' }], created_at: native.created_at }] }) });
  await assert.rejects(client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' }), error => error.notSubmitted === true && error.nativeBusy === true);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
});

test('Kimi rejects nonqueue delivery and invalid metadata before native calls', async () => {
  for (const extra of [{ delivery: 'steer' }, { resume: false }, { metadata: [] }, { id: 'bad/id' }, { text: ' ' }]) {
    const { client, calls } = fixture();
    await assert.rejects(client.prompt(native.id, { id: 'msg_stable1', text: 'Project question', ...extra }), error => error.notSubmitted === true);
    assert.equal(calls.length, 0);
  }
});

test('Kimi accepted POST and in-memory prompt queue alone cannot prove durable admission', async () => {
  const { client, calls } = fixture({ [`/api/v1/sessions/${native.id}/prompts`]: (_u, init) => init.method === 'GET' ? json({ active: null, queued: [] }) : json({ prompt_id: 'msg_stable1', user_message_id: 'msg_stable1', status: 'queued', content: [{ type: 'text', text: 'Project question' }], created_at: native.created_at }) });
  await assert.rejects(client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' }), error => error.uncertain === true && error.notSubmitted !== true);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('Kimi reconciles a lost POST by exact persisted message and never reposts matching input', async () => {
  const { client, calls } = fixture({ [`/api/v1/sessions/${native.id}/prompts`]: (_u, init, saved) => {
    if (init.method === 'GET') return json({ active: null, queued: [] });
    const body = JSON.parse(init.body); saved.set(body.prompt_id, msg(body.prompt_id, body.content[0].text)); throw new Error('private transport details');
  } });
  await client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' });
  await client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' });
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('Kimi mismatched persisted ID, role, session or complete text never counts as receipt', async () => {
  for (const bad of [{ ...msg(), id: 'msg_other' }, { ...msg(), role: 'assistant' }, { ...msg(), session_id: 'session_other' }, msg('msg_stable1', 'Different text'), { ...msg(), content: [{ type: 'text', text: 'Project question' }, { type: 'text', text: 'extra' }] }]) {
    const { client, saved, calls } = fixture(); saved.set('msg_stable1', bad);
    await assert.rejects(client.prompt(native.id, { id: 'msg_stable1', text: 'Project question' }), /message|input|match/);
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
  }
});

test('Kimi HTTP 200 error envelopes are failures with upstream bodies withheld', async () => {
  for (const value of [json(null, 40101), json(null, 50001), json(null, 40101, 401)]) {
    const { client } = fixture({ '/api/v1/meta': () => value });
    await assert.rejects(client.session(native.id), error => !error.message.includes('private upstream') && /Kimi/.test(error.message));
  }
});

test('Kimi lists bounded native messages and validates their session ownership', async () => {
  const { client, saved } = fixture(); saved.set('msg_one', msg('msg_one', 'One')); saved.set('msg_two', msg('msg_two', 'Two'));
  assert.deepEqual((await client.messages(native.id, { limit: 2 })).map(m => m.id), ['msg_one', 'msg_two']);
  saved.set('msg_two', { ...msg('msg_two'), session_id: 'session_other' });
  await assert.rejects(client.messages(native.id), /message|session/);
});

test('Kimi discover reads owner descriptor and token privately and detects changed scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-kimi-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'server.token'), serviceFile = join(root, 'service.json');
  await writeFile(tokenFile, 'private-token\n', { mode: 0o600 });
  const record = { id: identity.serviceId, url: identity.origin, version: identity.version, tokenFile, directory, workspaceId: native.workspace_id, sessionIds: [native.id], commandShell: 'posix' };
  await writeFile(serviceFile, JSON.stringify(record), { mode: 0o600 });
  const { fetchImpl } = fixture(); const client = await KimiClient.discover({ serviceFile, fetchImpl });
  assert.equal((await client.session(native.id)).id, native.id); assert.ok(!JSON.stringify(client).includes('private-token'));
  await writeFile(serviceFile, JSON.stringify({ ...record, sessionIds: ['session_other'] }));
  await assert.rejects(client.session(native.id), /changed|scope/);
  await assert.rejects(KimiClient.discover({ serviceFile: '' }), /owner|Set/);
});
