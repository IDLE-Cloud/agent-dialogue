import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { createViewer, markdownExport } from '../lib/viewer/server.mjs';
import { ViewerModel } from '../lib/viewer/stream.mjs';
import { viewerOptions } from '../lib/viewer/cli.mjs';
import { makeSources } from './fixtures/viewer-fixture.mjs';
import { projectSources } from '../lib/viewer/projection.mjs';

const spec = { id: 'source-a', label: 'Local sample', path: '/not-browser-controlled' };
const source = (changes = {}) => ({ ...spec, path: undefined, observedAt: '2026-10-18T00:00:00Z', generation: 'db-one', available: true, error: null, events: [], store: {}, workers: [], diagnostics: [], ...changes });
const message = i => ({ id: `message-${i}`, roomId: 'room-a', text: `message ${i} <script>window.pwned=1</script>`, from: { alias: 'alice', bindingId: 'binding-alice', sessionId: 'native-alice', harness: 'codex-app-server' }, to: { alias: 'bob' }, timestamp: '2026-10-18T00:00:00Z', kind: 'message', statuses: ['ledger-stored'], evidence: [{ sourceId: spec.id, localEventId: i }], sourceIds: [spec.id], replyTo: null, issues: [] });
function projection(messages = Array.from({ length: 205 }, (_, i) => message(i + 1))) {
  return { sources: [], rooms: [{ id: 'room-a', roomId: 'r_synthetic', name: 'Sample', participants: [], sourceIds: [spec.id], messageCount: messages.length, issues: [] }], messages, diagnostics: [] };
}
async function setup(t, options = {}) {
  const viewer = await createViewer({ sources: [spec], reader: async () => source(), projector: () => projection(), pollMs: 60000, ...options });
  t.after(() => viewer.close());
  const bootstrap = await fetch(viewer.url, { redirect: 'manual' });
  assert.equal(bootstrap.status, 303);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  return { ...viewer, cookie, get: (path, init = {}) => fetch(`${viewer.origin}${path}`, { ...init, headers: { cookie, ...init.headers } }) };
}
test('viewer requires its local access link and blocks wrong hosts, origins and mutation endpoints', async t => {
  const viewer = await setup(t);
  assert.equal((await fetch(`${viewer.origin}/api/snapshot`)).status, 401);
  assert.equal((await fetch(`${viewer.origin}/?token=invalid`, { redirect: 'manual' })).status, 403);
  assert.equal((await viewer.get('/api/snapshot', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await viewer.get('/api/snapshot', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await viewer.get('/api/snapshot', { method: 'POST' })).status, 405);
  for (const path of ['/api/send', '/api/flush', '/api/resume', '/api/sources', '/node.json', '/lib/paths.mjs', '/%2e%2e/node.json']) assert.equal((await viewer.get(path)).status, 404, path);
  const response = await viewer.get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});
test('viewer paths and SQL cannot be supplied through browser queries', async t => {
  const viewer = await setup(t);
  for (const query of ['path=/etc/passwd', 'sql=SELECT+*+FROM+events', 'source=/etc/passwd', 'room=room-a&room=room-b', 'limit=101', 'limit=0', 'before=invalid']) {
    const response = await viewer.get(`/api/messages?room=room-a&${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal((await viewer.get('/api/messages?room=missing')).status, 404);
  assert.equal((await viewer.get('/api/message?id=missing')).status, 404);
});
test('history pages use scoped anchors and keep all messages exactly once', async t => {
  const viewer = await setup(t);
  const seen = [];
  let before = '';
  do {
    const response = await viewer.get(`/api/messages?room=room-a${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    seen.unshift(...page.messages.map(m => m.id));
    assert.ok(page.messages.length <= 100);
    before = page.nextCursor;
  } while (before);
  assert.deepEqual(seen, Array.from({ length: 205 }, (_, i) => `message-${i + 1}`));
  const first = await (await viewer.get('/api/messages?room=room-a')).json();
  assert.equal((await viewer.get(`/api/messages?room=room-a&q=other&before=${encodeURIComponent(first.nextCursor)}`)).status, 409);
  viewer.model.epoch++;
  assert.equal((await viewer.get(`/api/messages?room=room-a&before=${encodeURIComponent(first.nextCursor)}`)).status, 409);
  assert.equal((await (await viewer.get('/api/message?id=message-1')).json()).message.id, 'message-1');
});
test('exports include the selected complete filter scope and safe plain text', async t => {
  const viewer = await setup(t);
  const exported = await (await viewer.get('/api/export?room=room-a&participant=alice&q=message%20205')).json();
  assert.equal(exported.scope.count, 1);
  assert.equal(exported.messages[0].id, 'message-205');
  assert.equal(JSON.stringify(exported).includes(spec.path), false);
  const markdown = await viewer.get('/api/export?room=room-a&format=markdown&q=message%20205');
  assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(await markdown.text(), /<script>window.pwned=1<\/script>/);
  assert.equal((await viewer.get('/api/export?room=room-a&format=html')).status, 400);
  const fenced = markdownExport({ ...exported, messages: [{ ...message(1), text: '```\n<script>bad</script>\n```' }] });
  assert.match(fenced, /````\n```/);
});
test('source-filtered exports retain freshness metadata for every referenced copy', async t => {
  const fixtures = makeSources();
  const projected = projectSources(fixtures);
  const specs = fixtures.map(s => ({ id: s.id, label: s.label, path: `/synthetic/${s.id}` }));
  const viewer = await setup(t, { sources: specs, reader: async spec => fixtures.find(s => s.id === spec.id), projector: projectSources });
  const room = projected.rooms.find(room => room.manifestHash);
  const response = await viewer.get(`/api/export?${new URLSearchParams({ room: room.id, source: fixtures[0].id })}`);
  const exported = await response.json();
  assert.equal(exported.scope.sourceFilterMode, 'message-membership');
  assert.equal(exported.scope.evidenceScope, 'all-collected-copies');
  const referenced = new Set(exported.messages.flatMap(m => m.evidence.map(e => e.sourceId)));
  for (const id of referenced) assert.ok(exported.sources.some(source => source.id === id && source.observedAt));
  assert.equal(exported.sources.length, 2);
});
test('observation refresh catches receipt-only updates, retains stale history and resets on replacement', async () => {
  let current = source({ events: [{ id: 1 }], workers: [{ receipts: {} }] });
  const model = new ViewerModel([spec], { reader: async () => structuredClone(current), projector: sources => projection(sources[0].events.map((event, i) => message(i + 1))), ringSize: 2 });
  await model.refresh();
  const initial = model.revision;
  current.observedAt = '2026-10-18T00:00:01Z';
  await model.refresh();
  assert.equal(model.revision, initial, 'observation clock alone must not reset pages');
  current.workers[0].receipts['1'] = { status: 'admitted', inputId: 'input-1' };
  await model.refresh();
  assert.equal(model.replay(initial)[0].type, 'change');
  current = source({ available: false, generation: undefined, error: 'Source unavailable' });
  await model.refresh();
  assert.equal(model.projection.messages.length, 1);
  assert.equal(model.snapshot().sources[0].available, false);
  assert.equal(model.snapshot().sources[0].observedAt, '2026-10-18T00:00:01Z');
  current = source({ generation: 'db-two' });
  await model.refresh();
  assert.equal(model.replay(model.ring.at(-2).id)[0].type, 'reset');
  assert.equal(model.epoch, 1);
  assert.equal(model.replay(initial)[0].type, 'reset', 'expired replay must request resynchronization');
  await model.close();
});
test('SSE reconnect replays bounded events or explicitly resets unknown histories', async t => {
  const viewer = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await viewer.get('/api/events', { signal: controller.signal, headers: { 'Last-Event-ID': 'old-server:100' } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: reset/);
  assert.match(text, /history-expired-or-server-restarted/);
  await reader.cancel();
});
test('SSE same-revision reconnect becomes ready immediately even without changed data', async t => {
  const viewer = await setup(t);
  const response = await viewer.get('/api/events', { signal: AbortSignal.timeout(1000), headers: { 'Last-Event-ID': viewer.model.revision } });
  assert.equal(response.status, 200);
  await response.body.cancel();
});
test('viewer CLI registers explicit unique sources, with no implicit extra default', async () => {
  const selected = await viewerOptions(['--source', 'A=/tmp/a', '--source', 'B=/tmp/b', '--port', '0'], '/tmp/default');
  assert.deepEqual(selected.sources.map(s => s.label), ['A', 'B']);
  assert.equal(selected.sources.some(s => s.path.includes('default')), false);
  await assert.rejects(viewerOptions(['--source', 'A=/tmp/a', '--source', 'B=/tmp/a'], '/tmp/default'), /more than once/);
  for (const args of [['--host', '0.0.0.0'], ['--source', '/tmp/a'], ['--port', '-1'], ['--port', '1', '--port', '2'], ['--source']]) await assert.rejects(viewerOptions(args, '/tmp/default'));
});
test('unexpected reader failures never expose raw environment errors', async t => {
  const viewer = await setup(t, { reader: async () => { throw new Error('password=very-secret /private/native/home'); }, projector: () => projection([]) });
  const json = JSON.stringify(await (await viewer.get('/api/snapshot')).json());
  assert.equal(json.includes('very-secret'), false);
  assert.equal(json.includes('/private'), false);
  assert.equal(json.includes('Source read failed'), true);
});
test('raw Host validation is enforced without relying on browser CORS behavior', async t => {
  const viewer = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${viewer.origin}/api/snapshot`, { headers: { Host: 'localhost.evil.example', Cookie: viewer.cookie } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
