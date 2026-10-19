import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeV1Client } from '../lib/opencode-v1.mjs';

const identity = { serviceId: 'owned-v1-service', origin: 'http://127.0.0.1:4567', version: '1.19.0' };
const directory = 'C:\\Users\\Operator\\Project';
const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const session = { id: 'ses_existing123', projectID: 'project-one', directory, title: 'Existing chat', agent: 'review', model: { id: 'native-model', providerID: 'native-provider', variant: 'high' }, permission: [{ permission: 'bash', pattern: '*', action: 'ask' }], time: { created: 1, updated: 2 } };
const health = { healthy: true, version: '1.19.0' };
const message = (id = 'msg_stable1', text = 'Project question') => ({ info: { id, sessionID: session.id, role: 'user', agent: session.agent, model: { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant } }, parts: [{ id: 'prt_one', sessionID: session.id, messageID: id, type: 'text', text }] });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
function fixture(overrides = {}, options = {}) {
  const calls = [], saved = new Map();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (overrides[url.pathname]) return overrides[url.pathname](url, init, saved);
    if (url.pathname === '/global/health') return json(health);
    if (url.pathname === '/config') return json({ shell });
    if (url.pathname === `/session/${session.id}`) return json(structuredClone(session));
    if (url.pathname === '/session') return json([structuredClone(session)]);
    if (url.pathname === '/session/status') return json({});
    if (url.pathname === `/session/${session.id}/message`) return json([...saved.values()]);
    if (url.pathname === `/session/${session.id}/prompt_async`) {
      const body = JSON.parse(init.body), persisted = message(body.messageID, body.parts[0].text);
      persisted.info.agent = body.agent; persisted.info.model = { ...body.model, variant: body.variant };
      saved.set(body.messageID, persisted); return json(null, 204);
    }
    if (url.pathname.startsWith(`/session/${session.id}/message/`)) return json(saved.get(url.pathname.split('/').at(-1)) ?? null, saved.has(url.pathname.split('/').at(-1)) ? 200 : 404);
    assert.fail(`Unexpected V1 request: ${init.method} ${url.pathname}`);
  };
  const client = new OpenCodeV1Client({ identity, password: 'private-password', directory, projectId: session.projectID, shell, commandShell: 'powershell', fetchImpl, receiptTimeoutMs: 5, pollIntervalMs: 1, ...options });
  return { client, calls, saved, fetchImpl };
}

test('V1 rejects non-loopback origins, non-V1 versions, missing scope and credentials', () => {
  for (const origin of ['https://example.com', 'http://user:password@localhost:4567', 'http://localhost:4567/private', 'file:///tmp/server']) assert.throws(() => fixture({}, { identity: { ...identity, origin } }), /loopback|Invalid/);
  assert.throws(() => fixture({}, { identity: { ...identity, version: '2.0.20' } }), /version/);
  assert.throws(() => fixture({}, { password: '' }), /credentials/);
  for (const options of [{ directory: 'relative' }, { directory: '' }, { projectId: '' }, { receiptTimeoutMs: 0 }]) assert.throws(() => fixture({}, options), /Invalid|scope/);
});

test('V1 exposes truthful capabilities without a native durable queue or automatic resume', () => {
  const { client } = fixture();
  assert.equal(client.capabilities.existingAttach, true);
  assert.equal(client.capabilities.queue, false);
  assert.equal(client.capabilities.stableInputId, true);
  assert.equal(client.capabilities.resume, false);
  assert.equal(client.capabilities.idleOnly, true);
  assert.equal(client.capabilities.commandShell, 'powershell');
  assert.ok(!JSON.stringify(client).includes('private-password'));
});

test('V1 session listing and exact attachment normalize native directory without changing metadata', async () => {
  const { client, calls } = fixture();
  const listed = await client.sessions({ directory: 'C:/Users/Operator/Project' });
  assert.equal(listed.length, 1);
  const actual = await client.session(session.id);
  assert.equal(actual.id, session.id);
  assert.equal(actual.location.directory, directory);
  assert.deepEqual(actual.model, session.model);
  assert.deepEqual(actual.permission, session.permission);
  assert.ok(calls.every(({ url }) => !url.pathname.startsWith('/api/')));
  assert.ok(calls.filter(({ url }) => url.pathname !== '/global/health').every(({ url }) => url.searchParams.get('directory') === directory));
  await assert.rejects(client.sessions({ directory: 'C:/DifferentProject' }), /scope/);
});

test('V1 exact sessions reject a different ID, project, directory or archived chat', async () => {
  for (const delta of [{ id: 'ses_other' }, { projectID: 'project-two' }, { directory: 'D:\\Other' }, { time: { archived: 10 } }]) {
    const { client } = fixture({ [`/session/${session.id}`]: () => json({ ...session, ...delta }) });
    await assert.rejects(client.session(session.id), /session|scope|archived/);
  }
});

test('V1 validates IDs and rejects unsafe APIs before making requests', async () => {
  const { client, calls } = fixture();
  for (const id of ['latest', 'ses_bad/slash', 'ses_bad?query', 'ses_bad_underscore']) await assert.rejects(client.session(id), /Invalid/);
  await assert.rejects(client.prompt(session.id, { id: 'msg_bad/slash', text: 'hello' }), /Invalid/);
  await assert.rejects(client.prompt(session.id, { id: 'msg_ok', text: ' ' }), /nonempty/);
  for (const path of ['/api/session', '//other/session', '/session/../../config', '/session#fragment', '/session?directory=other', '/session/ses_ok/permissions/permission']) await assert.rejects(client.request('GET', path), /Invalid/);
  await assert.rejects(client.request('PATCH', '/session'), /Unsupported/);
  assert.equal(calls.length, 0);
});

test('V1 submits stable input into the exact existing session and confirms persisted text', async () => {
  const { client, calls } = fixture();
  const receipt = await client.prompt(session.id, { id: 'msg_stable1', text: 'Project question', metadata: { room: 'r_one' } });
  assert.equal(receipt.id, 'msg_stable1');
  assert.equal(receipt.sessionID, session.id);
  assert.equal(receipt.type, 'user');
  assert.equal(receipt.status, 'persisted');
  const submissions = calls.filter(({ init }) => init.method === 'POST');
  assert.equal(submissions.length, 1);
  const { url, init } = submissions[0];
  assert.equal(url.pathname, `/session/${session.id}/prompt_async`);
  assert.deepEqual(JSON.parse(init.body), { messageID: 'msg_stable1', agent: 'review', model: { providerID: 'native-provider', modelID: 'native-model' }, variant: 'high', parts: [{ type: 'text', text: 'Project question' }] });
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.authorization, `Basic ${Buffer.from('opencode:private-password').toString('base64')}`);
  assert.ok(init.signal instanceof AbortSignal);
});

test('V1 preserves the default variant and does not inherit agent variant or tool permissions', async () => {
  const unchanged = { ...session, model: { ...session.model, variant: 'default' } };
  const { client, calls } = fixture({ [`/session/${session.id}`]: () => json(unchanged) });
  await client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' });
  const body = JSON.parse(calls.find(({ init }) => init.method === 'POST').init.body);
  assert.equal(body.variant, 'default');
  for (const key of ['tools', 'system', 'permission', 'permissions', 'noReply']) assert.equal(Object.hasOwn(body, key), false);
});

test('V1 does not POST to busy or retrying sessions and reports a safely retryable preflight', async () => {
  for (const type of ['busy', 'retry']) {
    const { client, calls } = fixture({ '/session/status': () => json({ [session.id]: { type } }) });
    await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' }), error => error.retryable === true && error.notSubmitted === true && error.nativeBusy === true);
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
  }
});

test('V1 rejects unsupported steer or stopped delivery and missing native model/agent before POST', async () => {
  for (const extra of [{ delivery: 'steer' }, { resume: false }, { metadata: [] }]) {
    const { client, calls } = fixture();
    await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'hello', ...extra }), error => error.notSubmitted === true);
    assert.equal(calls.length, 0);
  }
  for (const delta of [{ agent: undefined }, { model: undefined }, { model: { providerID: 'x' } }]) {
    const { client, calls } = fixture({ [`/session/${session.id}`]: () => json({ ...session, ...delta }) });
    await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'hello' }), error => error.notSubmitted === true);
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
  }
});

test('V1 HTTP 204 is not admission evidence without the exact persisted user input', async () => {
  const { client, calls } = fixture({ [`/session/${session.id}/prompt_async`]: () => json(null, 204) });
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' }), error => error.uncertain === true && error.notSubmitted !== true);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('V1 reconciles a lost POST response by exact persisted input, without resubmitting', async () => {
  const { client, saved, calls } = fixture({ [`/session/${session.id}/prompt_async`]: (_url, init, map) => { const body = JSON.parse(init.body); map.set(body.messageID, message(body.messageID, body.parts[0].text)); throw new Error('secret transport detail'); } });
  const receipt = await client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' });
  assert.equal(receipt.id, 'msg_stable1');
  assert.equal((await client.input(session.id, 'msg_stable1')).info.id, 'msg_stable1');
  assert.equal(saved.size, 1);
  await client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' });
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
});

test('V1 refuses a stable-ID collision instead of overwriting a prior message', async () => {
  const { client, saved, calls } = fixture(); saved.set('msg_stable1', message('msg_stable1', 'Different original body'));
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' }), /different|match|collision/);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
});

test('V1 exact input lookup rejects assistant IDs, wrong sessions and mixed part ownership', async () => {
  const bad = [
    { ...message(), info: { ...message().info, role: 'assistant' } },
    { ...message(), info: { ...message().info, sessionID: 'ses_other' } },
    { ...message(), info: { ...message().info, id: 'msg_other' } },
    { ...message(), parts: [{ ...message().parts[0], sessionID: 'ses_other' }] },
    { ...message(), parts: [{ ...message().parts[0], messageID: 'msg_other' }] },
  ];
  for (const value of bad) {
    const { client } = fixture({ [`/session/${session.id}/message/msg_stable1`]: () => json(value) });
    await assert.rejects(client.input(session.id, 'msg_stable1'), /message|input/);
  }
});

test('V1 messages retain native parts and inbox explicitly has no native queue', async () => {
  const { client, saved, calls } = fixture(); saved.set('msg_stable1', message());
  assert.deepEqual(await client.messages(session.id, { limit: 50 }), [message()]);
  assert.deepEqual(await client.inbox(session.id), []);
  assert.equal(await client.input(session.id, 'msg_missing'), null);
  assert.equal(calls.some(({ url }) => url.pathname.endsWith('/inbox')), false);
  assert.equal(calls.find(({ url }) => url.pathname.endsWith('/message')).url.searchParams.get('limit'), '50');
  for (const limit of [0, -1, 1001, 1.5]) await assert.rejects(client.messages(session.id, { limit }), /Invalid/);
});

test('V1 never infers idle from malformed status and serializes local concurrent submissions', async () => {
  const { client, calls } = fixture({ '/session/status': () => json([]) });
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'hello' }), error => error.notSubmitted === true);
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const other = fixture({ '/session/status': async () => { await gate; return json({}); } });
  const first = other.client.prompt(session.id, { id: 'msg_first', text: 'Project question' });
  await assert.rejects(other.client.prompt(session.id, { id: 'msg_second', text: 'Project question' }), error => error.retryable === true && error.notSubmitted === true);
  release(); await first;
});

test('V1 service-file discovery verifies health and detects owner service/scope rotation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ad-v1-service-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const serviceFile = join(dir, 'service.json');
  const record = { id: identity.serviceId, url: identity.origin, version: identity.version, password: 'secret', directory, projectId: session.projectID, shell, commandShell: 'powershell' };
  await writeFile(serviceFile, JSON.stringify(record), { mode: 0o600 });
  const fixtureClient = fixture();
  const client = await OpenCodeV1Client.discover({ serviceFile, fetchImpl: fixtureClient.fetchImpl });
  assert.deepEqual(client.identity, identity);
  assert.equal((await client.session(session.id)).id, session.id);
  await writeFile(serviceFile, JSON.stringify({ ...record, id: 'replacement-service' }));
  const before = fixtureClient.calls.length;
  await assert.rejects(client.session(session.id), /identity changed/);
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'hello' }), error => error.notSubmitted === true);
  assert.equal(fixtureClient.calls.length, before);
});

test('V1 rejects changed service version and withholds remote errors and credential contents', async t => {
  for (const data of [{ healthy: true, version: '2.0.20' }, { healthy: false, version: '1.19.0' }]) {
    const { client } = fixture({ '/global/health': () => json(data) });
    await assert.rejects(client.session(session.id), /health|version/);
  }
  const { client } = fixture({ '/global/health': () => json({ password: 'must-not-leak' }, 401) });
  await assert.rejects(client.info(), error => !error.message.includes('must-not-leak') && /401/.test(error.message));
  const dir = await mkdtemp(join(tmpdir(), 'ad-v1-invalid-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const serviceFile = join(dir, 'service.json'); await writeFile(serviceFile, '{"password":"secret-parse-content",BAD');
  await assert.rejects(OpenCodeV1Client.discover({ serviceFile }), error => !error.message.includes('secret-parse-content'));
});

test('V1 verifies effective shell and refuses a changed shell before submission', async () => {
  const { client, calls } = fixture({ '/config': () => json({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }) });
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' }), error => error.notSubmitted === true && /shell/.test(error.message));
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
});

test('V1 exact lookup requires the complete ledger text, including multiline content', async () => {
  const { client, saved } = fixture();
  const text = 'Project question\nSecond line\n回复测试';
  await client.prompt(session.id, { id: 'msg_stable1', text });
  assert.equal((await client.input(session.id, 'msg_stable1', { text })).parts[0].text, text);
  await assert.rejects(client.input(session.id, 'msg_stable1', { text: 'Different body' }), /complete expected/);
  saved.set('msg_partial', { ...message('msg_partial'), parts: [] });
  await assert.rejects(client.input(session.id, 'msg_partial'), /complete expected/);
});

test('V1 submission rejects reverted sessions instead of triggering native history cleanup', async () => {
  const { client, calls } = fixture({ [`/session/${session.id}`]: () => json({ ...session, revert: { messageID: 'msg_earlier' } }) });
  await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'hello' }), error => error.notSubmitted === true && /reverted/.test(error.message));
  assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 0);
});

test('V1 uncertainty persists on partial input or changed stored text/model after POST', async () => {
  for (const mutate of [value => { value.parts = []; }, value => { value.parts[0].text = 'Different'; }, value => { value.info.model.modelID = 'other-model'; }]) {
    const { client, calls } = fixture({ [`/session/${session.id}/prompt_async`]: (_url, init, saved) => { const body = JSON.parse(init.body), value = message(body.messageID, body.parts[0].text); mutate(value); saved.set(body.messageID, value); return json(null, 204); } });
    await assert.rejects(client.prompt(session.id, { id: 'msg_stable1', text: 'Project question' }), error => error.uncertain === true && error.notSubmitted !== true);
    assert.equal(calls.filter(({ init }) => init.method === 'POST').length, 1);
  }
});

test('V1 lists archived metadata but rejects silent session-list truncation', async () => {
  const archived = { ...session, time: { archived: 10 } };
  const first = fixture({ '/session': () => json([archived]) });
  assert.equal((await first.client.sessions())[0].time.archived, 10);
  const many = fixture({ '/session': () => json(Array.from({ length: 1001 }, (_, index) => ({ ...session, id: `ses_a${index}` }))) });
  await assert.rejects(many.client.sessions(), /listing limit/);
  assert.equal(many.calls.find(({ url }) => url.pathname === '/session').url.searchParams.get('limit'), '1001');
});
