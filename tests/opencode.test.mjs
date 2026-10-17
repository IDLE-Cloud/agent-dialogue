import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeClient } from '../lib/opencode.mjs';

const identity = { serviceId: 'service-a', origin: 'http://127.0.0.1:4567', version: '2.0.20' };
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const client = fetchImpl => new OpenCodeClient({ identity, password: 'never-print-this', fetchImpl });

test('rejects remote origins, credentials, and URL path escapes', async () => {
  for (const origin of ['https://example.com', 'http://127.0.0.1:4567/private', 'http://user:pass@localhost:4567', 'file:///tmp/service']) {
    assert.throws(() => new OpenCodeClient({ identity: { ...identity, origin }, password: 'secret' }), /loopback|Invalid/);
  }
  const api = client(() => assert.fail('must not request'));
  for (const path of ['https://remote/api/session', '//remote/api/session', '/api/../../outside', '/api/session#fragment']) {
    await assert.rejects(api.request('GET', path), /Invalid/);
  }
});

test('uses exact native session path and validates receipt', async () => {
  let submitted;
  const api = client(async (url, options) => {
    submitted = { url: String(url), options, body: JSON.parse(options.body) };
    return json({ data: { id: 'msg_test_1', sessionID: 'ses_existing123', type: 'user', delivery: 'queue' } });
  });
  const result = await api.prompt('ses_existing123', { id: 'msg_test_1', text: 'Project question', metadata: { dialogue: 'd1' } });
  assert.equal(result.sessionID, 'ses_existing123');
  assert.equal(submitted.url, `${identity.origin}/api/session/ses_existing123/prompt`);
  assert.deepEqual(submitted.body, { id: 'msg_test_1', text: 'Project question', metadata: { dialogue: 'd1' }, delivery: 'queue', resume: true });
  assert.equal(submitted.options.redirect, 'error');
  assert.ok(submitted.options.signal instanceof AbortSignal);
  assert.equal(submitted.options.headers.authorization, `Basic ${Buffer.from('opencode:never-print-this').toString('base64')}`);
});

test('rejects a receipt for a different session or input', async () => {
  for (const receipt of [
    { id: 'msg_test', sessionID: 'ses_other', type: 'user' },
    { id: 'msg_other', sessionID: 'ses_expected', type: 'user' },
  ]) {
    await assert.rejects(client(async () => json({ data: receipt })).prompt('ses_expected', { id: 'msg_test', text: 'hello' }), /receipt does not match/);
  }
});

test('session IDs, input IDs, and delivery options are validated before network access', async () => {
  const api = client(() => assert.fail('must not request'));
  for (const id of ['latest', 'ses_a/../b', 'ses_a?x=y', 'ses_a_b']) await assert.rejects(api.session(id), /Invalid/);
  await assert.rejects(api.prompt('ses_ok', { id: 'msg_bad/slash', text: 'hello' }), /Invalid/);
  await assert.rejects(api.prompt('ses_ok', { id: 'msg_ok', text: 'hello', delivery: 'interrupt' }), /Invalid/);
  await assert.rejects(api.prompt('ses_ok', { id: 'msg_ok', text: 'hello', metadata: [] }), /Invalid/);
});

test('session listing preserves native metadata and paginates without guessing latest', async () => {
  const urls = [];
  const api = client(async url => {
    urls.push(new URL(url));
    return urls.length === 1 ? json({ data: [{ id: 'ses_one', location: { directory: '/work project' } }], cursor: { next: 'page-token' } }) : json({ data: [{ id: 'ses_two' }], cursor: {} });
  });
  const result = await api.sessions({ directory: '/work project' });
  assert.deepEqual(result.map(item => item.id), ['ses_one', 'ses_two']);
  assert.equal(result[0].location.directory, '/work project');
  assert.equal(urls[0].searchParams.get('directory'), '/work project');
  assert.equal(urls[1].searchParams.get('cursor'), 'page-token');
  assert.equal(urls[1].searchParams.has('order'), false);
});

test('session, messages, and inbox unwrap native data and reject wrong session', async () => {
  const api = client(async url => {
    if (url.pathname.endsWith('/message')) return json({ data: [{ id: 'msg_a', type: 'assistant' }] });
    if (url.pathname.endsWith('/inbox')) return json({ data: [{ id: 'msg_b', sessionID: 'ses_one' }] });
    return json({ data: { id: 'ses_one', projectID: 'project-one', location: { directory: '/work' } } });
  });
  assert.equal((await api.session('ses_one')).projectID, 'project-one');
  assert.equal((await api.messages('ses_one'))[0].type, 'assistant');
  assert.equal((await api.inbox('ses_one'))[0].sessionID, 'ses_one');
  await assert.rejects(api.session('ses_two'), /different session/);
  await assert.rejects(api.inbox('ses_two'), /Invalid/);
});

test('HTTP and transport errors do not leak provider or credential bodies', async () => {
  await assert.rejects(client(async () => ({ ok: false, status: 401, json: async () => ({ secret: 'secret' }) })).info(), error => error.message === 'OpenCode HTTP 401; response body withheld.');
  await assert.rejects(client(async () => { throw new Error('Bearer hidden-password'); }).info(), error => !error.message.includes('hidden-password'));
});

test('discovery reads credential locally and detects changed service before submitting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-dialogue-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serviceFile = join(dir, 'service.json');
  const record = { id: identity.serviceId, url: identity.origin, version: identity.version, password: 'secret-in-file' };
  await writeFile(serviceFile, JSON.stringify(record), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => { calls++; assert.equal(url.pathname, '/api/info'); return json({ version: '2.0.20' }); };
  let api;
  try { api = await OpenCodeClient.discover({ serviceFile }); } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(api.identity, identity);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(api).includes('secret-in-file'));
  await writeFile(serviceFile, JSON.stringify({ ...record, id: 'replacement-service' }));
  await assert.rejects(api.session('ses_one'), /identity changed/);
  await assert.rejects(api.prompt('ses_one', { id: 'msg_one', text: 'hello' }), /identity changed/);
  assert.equal(calls, 1);
});

test('malformed credential errors do not echo file contents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-dialogue-opencode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serviceFile = join(dir, 'service.json');
  await writeFile(serviceFile, '{"password":"private-data",BAD');
  await assert.rejects(OpenCodeClient.discover({ serviceFile }), error => !error.message.includes('private-data'));
});

test('service-file environment override selects the explicitly configured local service', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dialogue-opencode-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const serviceFile = join(dir, 'service.json');
  await writeFile(serviceFile, JSON.stringify({ id: identity.serviceId, url: identity.origin, version: identity.version, password: 'test-env-credential' }), { mode: 0o600 });
  const previous = process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE;
  process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = serviceFile;
  t.after(() => { if (previous === undefined) delete process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE; else process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = previous; });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), `${identity.origin}/api/info`);
    return json({ version: '2.0.20' });
  });
  const api = await OpenCodeClient.discover();
  assert.equal(api.identity.serviceId, identity.serviceId);
  assert.equal(api.identity.origin, identity.origin);
});
