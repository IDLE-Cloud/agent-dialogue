import test from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, hubUrl, newId } from '../lib/client.mjs';

test('client retains stable message ID on lost response, never retries POST and redacts transport secrets', async () => {
  const id = newId(); let calls = 0;
  const client = new HubClient({ url: 'http://127.0.0.1:8417', token: 'private-token', fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bearer private-token');
    throw new Error('private-token upstream-details');
  } });
  await assert.rejects(client.request('POST', '/v1/messages', { id }), error => {
    assert.equal(error.messageId, id); assert.equal(error.status, 0); assert.doesNotMatch(error.message, /private-token|upstream/); return true;
  });
  assert.equal(calls, 1);
});

test('credentials cannot be redirected to another origin and remote plaintext is refused', async () => {
  for (const url of ['http://example.com', 'https://secret@hub.example', 'https://hub.example/?token=secret', 'ftp://localhost']) {
    assert.throws(() => hubUrl(url));
  }
  assert.equal(hubUrl('https://hub.example/'), 'https://hub.example');
  assert.equal(hubUrl('http://[::1]:8888'), 'http://[::1]:8888');
  const client = new HubClient({ url: 'http://localhost:8417', fetchImpl: async () => { throw new Error('must not run'); } });
  await assert.rejects(client.request('POST', '//elsewhere/v1/messages', {}), /Invalid Hub request/);
});

test('client exposes bounded public error code and stable send ID, withholds proxy content', async () => {
  const id = newId();
  const client = new HubClient({ url: 'http://localhost', fetchImpl: async () => new Response(JSON.stringify({
    error: { code: 'conflict', message: 'secret proxy text' },
  }), { status: 409 }) });
  await assert.rejects(client.request('POST', '/v1/messages', { id }), error => {
    assert.equal(error.code, 'conflict'); assert.equal(error.messageId, id); assert.doesNotMatch(error.message, /secret/); return true;
  });
});
