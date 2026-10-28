import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../lib/hub.mjs';
import { HubClient, newId } from '../lib/client.mjs';
import { renderAgent, renderMessage, startViewer } from '../web/app.js';

class Element {
  constructor(name) { this.name = name; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].join(''); }
  descendants() { return [this, ...this.children.flatMap(child => child.descendants())]; }
}
class Document {
  constructor() { this.elements = new Map(); }
  createElement(name) { return new Element(name); }
  getElementById(id) { if (!this.elements.has(id)) this.elements.set(id, new Element('div')); return this.elements.get(id); }
}
const roomId = 'room_22222222-2222-4222-8222-222222222222';
const messageId = 'msg_11111111-1111-4111-8111-111111111111';
const agentId = 'agent_33333333-3333-4333-8333-333333333333';
const agent = { id: agentId, nodeId: 'node_test', alias: '<img src=x onerror=alert(1)>', harness: 'opencode', mode: 'native-push', state: 'ready', binding: { sessionId: 'ses_test', projectDirectory: '/project/<script>x</script>', serviceIdentity: { serviceId: 'service_test', origin: 'http://127.0.0.1:1' } } };
const message = { id: messageId, seq: 4, room: roomId, sender: agentId, to: [agentId], text: '<script>globalThis.pwned=true</script>\n第二行', replyTo: 'msg_44444444-4444-4444-8444-444444444444', createdAt: '2026-10-22T12:00:00Z', deliveries: [{ agentId, state: 'unknown' }] };

test('viewer renders hostile message/alias/path as plain text and keeps reply relation', () => {
  const doc = new Document(), card = renderMessage(doc, message, [agent]), identity = renderAgent(doc, agent);
  assert.ok(card.text.includes(message.text));
  assert.ok(card.text.includes(agent.alias));
  assert.ok(identity.text.includes(agent.binding.projectDirectory));
  assert.ok(identity.text.includes('ses_test'));
  assert.ok(identity.text.includes('上次报告：可接收'));
  assert.ok(identity.text.includes('节点上次联系 Hub：尚无心跳'));
  const nodes = [...card.descendants(), ...identity.descendants()];
  assert.equal(nodes.some(node => ['script', 'img', 'iframe'].includes(node.name)), false);
  assert.equal(nodes.some(node => Object.keys(node.attributes).some(key => key.startsWith('on'))), false);
  assert.equal(nodes.find(node => node.name === 'a').attributes.href, `#message-${message.replyTo}`);
  assert.equal(nodes.find(node => node.className === 'delivery').dataset.state, 'unknown');
  assert.ok(card.text.includes('待核对'));
});

test('viewer reads history/status only, refreshes delivery evidence and never marks inbox read', async t => {
  const doc = new Document(), calls = [];
  const request = async (path, options) => {
    calls.push({ path, options });
    const value = path === '/v1/context' ? { rooms: [{ id: roomId, label: '协作项目', members: [agent] }] }
      : path.startsWith('/v1/history?') ? { items: [message], cursor: 4 }
      : path.startsWith('/v1/status?') ? { message, deliveries: [{ agentId, state: 'delivered' }] }
      : null;
    assert.ok(value, `Unexpected endpoint ${path}`);
    return { ok: true, status: 200, json: async () => value };
  };
  const viewer = startViewer(doc, request); t.after(() => viewer.close());
  for (let i = 0; i < 10 && doc.getElementById('count').textContent !== '1 条消息'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.getElementById('count').textContent, '1 条消息');
  assert.ok(doc.getElementById('messages').text.includes('原生已接收'));
  assert.equal(doc.getElementById('messages').text.includes('待核对'), false);
  assert.equal(doc.getElementById('workspace').hidden, false);
  assert.equal(calls.some(call => call.path.includes('/inbox')), false);
  assert.ok(calls.every(call => !call.options.method && call.options.credentials === 'same-origin'));
  await viewer.refresh();
  assert.ok(calls.some(call => call.path.includes('after=4')));
});

test('login exchanges token in POST body, clears field and never puts token in URL', async t => {
  const doc = new Document(), calls = []; let loggedIn = false;
  const request = async (path, options) => {
    calls.push({ path, options });
    if (path === '/v1/viewer-session') { loggedIn = true; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return loggedIn ? { ok: true, status: 200, json: async () => ({ rooms: [] }) } : { ok: false, status: 401 };
  };
  const viewer = startViewer(doc, request); t.after(() => viewer.close());
  for (let i = 0; i < 10 && !doc.getElementById('login').hidden; i++) await new Promise(resolve => setImmediate(resolve));
  doc.getElementById('token').value = 'SECRET_VIEWER_CREDENTIAL';
  await doc.getElementById('login').listeners.submit({ preventDefault() {} });
  const login = calls.find(call => call.path === '/v1/viewer-session');
  assert.equal(login.options.method, 'POST');
  assert.deepEqual(JSON.parse(login.options.body), { token: 'SECRET_VIEWER_CREDENTIAL' });
  assert.equal(doc.getElementById('token').value, '');
  assert.equal(calls.some(call => call.path.includes('SECRET_VIEWER_CREDENTIAL')), false);
});

test('actual Hub viewer cookie loads paginated history and replies without consuming agent inbox', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-viewer-'));
  const adminToken = 'viewer-integration-admin-01234567890';
  const hub = await startHub({ dbPath: join(dir, 'hub.sqlite'), adminToken });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = new HubClient({ url: hub.url, token: adminToken });
  const room = await admin.request('POST', '/v1/rooms', { label: '网页集成' });
  const identities = [];
  for (const alias of ['发送者', '接收者']) {
    const { code } = await admin.request('POST', '/v1/enrollments', {});
    const enrolled = await new HubClient({ url: hub.url }).request('POST', '/v1/enroll', { code, label: alias });
    const node = new HubClient({ url: hub.url, token: enrolled.token });
    const agent = await node.request('POST', '/v1/agents', { alias, harness: 'tool', mode: 'tool-pull', binding: { serviceIdentity: { serviceId: `operator:${alias}`, origin: 'operator-assigned' }, sessionId: `chat-${alias}`, projectDirectory: dir } });
    await admin.request('POST', '/v1/members', { room: room.id, agentId: agent.id });
    const scoped = await admin.request('POST', '/v1/scopes', { agentId: agent.id, rooms: [room.id] });
    identities.push({ agent, client: new HubClient({ url: hub.url, token: scoped.token }) });
  }
  const sent = [];
  for (let i = 0; i < 102; i++) {
    sent.push(await identities[0].client.request('POST', '/v1/messages', { id: newId(), room: room.id, to: [identities[1].agent.id], text: i === 0 ? '<script>unsafe()</script>' : `分页消息 ${i}`, replyTo: null }));
  }
  const viewerScope = await admin.request('POST', '/v1/viewers', { rooms: [room.id] });
  const doc = new Document(), calls = [];
  let cookie = '';
  const browserRequest = async (path, options) => {
    calls.push(path);
    const headers = new Headers(options?.headers);
    if (cookie) headers.set('cookie', cookie);
    if (options?.method === 'POST') headers.set('origin', hub.url);
    const response = await fetch(new URL(path, hub.url), { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const viewer = startViewer(doc, browserRequest); t.after(() => viewer.close());
  for (let i = 0; i < 100 && doc.getElementById('connection').textContent !== '连接中断'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  doc.getElementById('token').value = viewerScope.token;
  await doc.getElementById('login').listeners.submit({ preventDefault() {} });
  assert.equal(doc.getElementById('count').textContent, '102 条消息');
  assert.ok(doc.getElementById('messages').text.includes('<script>unsafe()</script>'));
  assert.ok(calls.filter(path => path.startsWith('/v1/history?')).length >= 2);
  assert.equal(calls.some(path => path.startsWith('/v1/inbox')), false);
  const beforeRead = await identities[0].client.request('GET', `/v1/status?id=${sent[0].message.id}`);
  assert.equal(beforeRead.deliveries[0].state, 'queued');
  await identities[1].client.request('GET', '/v1/inbox?after=0&limit=100');
  const reply = await identities[1].client.request('POST', '/v1/messages', { id: newId(), room: room.id, to: [identities[0].agent.id], text: '已收到第一条', replyTo: sent[0].message.id });
  await viewer.refresh();
  assert.equal(doc.getElementById('count').textContent, '103 条消息');
  assert.ok(doc.getElementById('messages').text.includes('工具已读'));
  const replyCard = doc.getElementById('messages').children.find(card => card.id === `message-${reply.message.id}`);
  assert.ok(replyCard.text.includes(`回复 ${sent[0].message.id}`));
});
