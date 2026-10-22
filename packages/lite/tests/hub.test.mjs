import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { startHub } from '../lib/hub.mjs';

const adminToken = 'test_admin_' + 'a'.repeat(32);
const messageId = () => `msg_${randomUUID()}`;
const binding = (sessionId = 'ses_ExistingChat') => ({ serviceIdentity: { serviceId: 'test-service', origin: 'http://127.0.0.1:7331', version: 'test' }, sessionId, projectDirectory: '/test/project', projectId: 'test-project' });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'adl-hub-test-'));
  const dbPath = join(dir, 'hub.sqlite');
  let hub = await startHub({ dbPath, adminToken });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (method, path, body, token = adminToken, options = {}) => {
    const response = await fetch(hub.url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    return { status: response.status, value, headers: response.headers };
  };
  const ok = async (...args) => { const result = await api(...args); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
  const node = async (label) => { const code = await ok('POST', '/v1/enrollments', {}); return await ok('POST', '/v1/enroll', { code: code.code, label }, null); };
  const a = await node('computer-a'), b = await node('computer-b');
  const agent = async (node, alias, sessionId, mode = 'tool-pull') => await ok('POST', '/v1/agents', { alias, harness: 'opencode', mode, binding: binding(sessionId) }, node.token);
  const alice = await agent(a, 'alice', 'ses_Alice'), bob = await agent(b, 'bob', 'ses_Bob');
  const room = await ok('POST', '/v1/rooms', { label: 'project' });
  const joinRoom = async agentId => await ok('POST', '/v1/members', { room: room.id, agentId });
  await joinRoom(alice.id); await joinRoom(bob.id);
  const scope = async agentId => (await ok('POST', '/v1/scopes', { agentId, rooms: [room.id] })).token;
  const aliceToken = await scope(alice.id), bobToken = await scope(bob.id);
  const send = async (input = {}, from = aliceToken) => await ok('POST', '/v1/messages', { id: messageId(), room: room.id, to: [bob.id], text: 'Hello', replyTo: null, ...input }, from);
  return { api, ok, node, agent, a, b, alice, bob, room, joinRoom, scope, aliceToken, bobToken, send, dbPath, get hub() { return hub; }, async restart() { await hub.close(); hub = await startHub({ dbPath, adminToken }); } };
}

test('atomic send is durable and stable-ID duplicates do not create messages', async t => {
  const f = await fixture(t), id = messageId();
  const input = { id, room: f.room.id, to: [f.bob.id], text: 'A question', replyTo: null };
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.api('POST', '/v1/messages', input, f.aliceToken)));
  assert(responses.every(value => value.status === 200));
  assert.equal(f.hub.store.db.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.equal(f.hub.store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 1);
  assert(responses.every(value => value.value.message.seq === responses[0].value.message.seq));
  const conflict = await f.api('POST', '/v1/messages', { ...input, text: 'Different' }, f.aliceToken);
  assert.equal(conflict.status, 409); assert.equal(conflict.value.messageId, id);
  assert.equal((await f.api('POST', '/v1/messages', { ...input, sender: f.bob.id }, f.aliceToken)).status, 400);
  await f.restart();
  const persisted = await f.ok('GET', `/v1/status?id=${id}`, undefined, f.aliceToken);
  assert.equal(persisted.message.text, input.text); assert.equal(persisted.deliveries[0].state, 'queued');
  assert.equal((await f.ok('POST', '/v1/messages', input, f.aliceToken)).message.seq, persisted.message.seq);
});

test('repeatable inbox cursor survives read events and viewer reads never mark tool-read', async t => {
  const f = await fixture(t);
  const first = await f.send({ text: '<img src=x onerror=alert(1)>' });
  const second = await f.send({ text: 'second' });
  const viewer = await f.ok('POST', '/v1/viewers', { rooms: [f.room.id] });
  const history = await f.ok('GET', `/v1/history?room=${f.room.id}&limit=1`, undefined, viewer.token);
  assert.equal(history.items[0].id, first.message.id); assert.equal(history.items[0].deliveries[0].state, 'queued');
  assert.equal(history.items[0].text, '<img src=x onerror=alert(1)>');
  const inbox = await f.ok('GET', '/v1/inbox?limit=1', undefined, f.bobToken);
  assert.equal(inbox.items[0].delivery.state, 'tool-read');
  assert.equal(inbox.cursor, first.message.seq);
  assert.deepEqual(await f.ok('GET', '/v1/inbox?limit=1', undefined, f.bobToken), inbox);
  const next = await f.ok('GET', `/v1/inbox?after=${inbox.cursor}&limit=1`, undefined, f.bobToken);
  assert.equal(next.items[0].message.id, second.message.id);
  const reply = await f.send({ to: [f.alice.id], text: 'My answer', replyTo: first.message.id }, f.bobToken);
  assert.equal(reply.message.replyTo, first.message.id); assert.equal(reply.message.sender, f.bob.id);
  assert.equal((await f.ok('GET', `/v1/inbox?after=${next.cursor}`, undefined, f.bobToken)).items.length, 0);
  assert.equal((await f.api('GET', '/v1/inbox', undefined, viewer.token)).status, 403);
});

test('native admission grants once, blocks only that chat, and accepts definite late receipt', async t => {
  const f = await fixture(t);
  const native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  const other = await f.agent(f.b, 'other', 'ses_Other', 'native-push'); await f.joinRoom(other.id);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  const first = await f.send({ to: [native.id] }), second = await f.send({ to: [native.id], text: 'second' });
  const independent = await f.send({ to: [other.id], text: 'independent' });
  const input = { messageId: first.message.id, agentId: native.id, runId: 'run-1' };
  const races = await Promise.all(Array.from({ length: 10 }, () => f.ok('POST', '/v1/deliveries/begin', input, f.b.token)));
  assert.equal(races.filter(value => value.granted).length, 1);
  const grant = races.find(value => value.granted).grant;
  assert(races.filter(value => !value.granted).every(value => !value.grant));
  assert.equal((await f.api('POST', '/v1/deliveries/begin', input, f.a.token)).status, 403);
  assert.equal((await f.ok('POST', '/v1/deliveries/begin', { ...input, messageId: second.message.id }, f.b.token)).granted, false);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [{ agentId: native.id, state: 'blocked', uncertain: true }] }, f.b.token);
  const unknown = await f.ok('GET', `/v1/status?id=${first.message.id}`, undefined, f.aliceToken);
  assert.equal(unknown.deliveries[0].state, 'unknown');
  assert(!JSON.stringify(unknown).includes(grant)); assert(!JSON.stringify(unknown).includes('grant_hash'));
  const poll = await f.ok('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token);
  assert.equal(poll.deliveries.length, 1); assert.equal(poll.deliveries[0].message.id, independent.message.id);
  assert.equal((await f.api('POST', '/v1/deliveries/result', { messageId: first.message.id, agentId: native.id, grant: 'x'.repeat(32), state: 'delivered' }, f.b.token)).status, 403);
  await f.ok('POST', '/v1/deliveries/result', { messageId: first.message.id, agentId: native.id, grant, state: 'delivered' }, f.b.token);
  assert.equal((await f.ok('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token)).deliveries.length, 2);
});

test('lost begin response remains unknown on Node/Hub restart and never regrants', async t => {
  const f = await fixture(t);
  const native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  const message = await f.send({ to: [native.id] });
  const input = { messageId: message.message.id, agentId: native.id, runId: 'run-1' };
  // The caller deliberately discards the successful response, exactly as a transport loss would.
  await f.ok('POST', '/v1/deliveries/begin', input, f.b.token);
  assert.equal((await f.ok('POST', '/v1/deliveries/begin', input, f.b.token)).granted, false);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-2', statuses: [] }, f.b.token);
  assert.equal((await f.ok('GET', `/v1/status?id=${message.message.id}`, undefined, f.aliceToken)).deliveries[0].state, 'unknown');
  assert.equal((await f.api('POST', '/v1/deliveries/begin', input, f.b.token)).status, 409);
  assert.equal((await f.ok('POST', '/v1/deliveries/begin', { ...input, runId: 'run-2' }, f.b.token)).granted, false);
  const second = await f.send({ to: [native.id], text: 'queued after unknown' });
  await f.restart();
  assert.equal((await f.ok('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token)).deliveries.length, 0);
  assert.equal((await f.ok('GET', `/v1/status?id=${second.message.id}`, undefined, f.aliceToken)).deliveries[0].state, 'queued');
});

test('Hub crash boundary converts delivering to unknown and preserves late grant receipts', async t => {
  const f = await fixture(t), native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  const message = await f.send({ to: [native.id] });
  const input = { messageId: message.message.id, agentId: native.id, runId: 'run-1' };
  const admitted = await f.ok('POST', '/v1/deliveries/begin', input, f.b.token);
  await f.restart();
  assert.equal((await f.ok('GET', `/v1/status?id=${message.message.id}`, undefined, f.aliceToken)).deliveries[0].state, 'unknown');
  assert.equal((await f.ok('POST', '/v1/deliveries/begin', input, f.b.token)).granted, false);
  const receipt = { messageId: message.message.id, agentId: native.id, grant: admitted.grant, state: 'delivered' };
  assert.equal((await f.ok('POST', '/v1/deliveries/result', receipt, f.b.token)).delivery.state, 'delivered');
  assert.equal((await f.ok('POST', '/v1/deliveries/result', receipt, f.b.token)).delivery.state, 'delivered');
});

test('only proven not-submitted admission can return queued', async t => {
  const f = await fixture(t), native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  const message = await f.send({ to: [native.id] });
  const input = { messageId: message.message.id, agentId: native.id, runId: 'run-1' };
  const begin = await f.ok('POST', '/v1/deliveries/begin', input, f.b.token);
  const result = { messageId: message.message.id, agentId: native.id, grant: begin.grant, state: 'queued' };
  assert.equal((await f.api('POST', '/v1/deliveries/result', result, f.b.token)).status, 400);
  assert.equal((await f.ok('POST', '/v1/deliveries/result', { ...result, notSubmitted: true }, f.b.token)).delivery.state, 'queued');
  const next = await f.ok('POST', '/v1/deliveries/begin', input, f.b.token); assert(next.granted); assert.notEqual(next.grant, begin.grant);
  assert.equal((await f.api('POST', '/v1/deliveries/result', { ...result, state: 'delivered' }, f.b.token)).status, 403);
});

test('operator can settle unknown after stopping executor without regrant or repeated effects', async t => {
  const f = await fixture(t), native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  const viewer = await f.ok('POST', '/v1/viewers', { rooms: [f.room.id] });
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  const first = await f.send({ to: [native.id] }), second = await f.send({ to: [native.id], text: 'later queued message' });
  const input = { messageId: first.message.id, agentId: native.id, runId: 'run-1' };
  await f.ok('POST', '/v1/deliveries/begin', input, f.b.token); // The grant response is deliberately not retained.
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [{ agentId: native.id, state: 'blocked', uncertain: true }] }, f.b.token);
  const body = { messageId: first.message.id, agentId: native.id, state: 'failed', note: 'Stopped old executor and verified no native input.', executorStopped: true };
  for (const credential of [f.aliceToken, f.bobToken, f.b.token, viewer.token]) assert.equal((await f.api('POST', '/v1/deliveries/resolve', body, credential)).status, 403);
  assert.equal((await f.api('POST', '/v1/deliveries/resolve', { ...body, executorStopped: false })).status, 400);
  assert.equal((await f.api('POST', '/v1/deliveries/resolve', { ...body, note: '' })).status, 400);
  assert.equal((await f.api('POST', '/v1/deliveries/resolve', { ...body, state: 'queued' })).status, 400);
  const result = await f.ok('POST', '/v1/deliveries/resolve', body); assert.equal(result.delivery.state, 'failed');
  const events = f.hub.store.db.prepare("SELECT count(*) n FROM events WHERE kind='operator-resolved'").get().n;
  assert.deepEqual(await f.ok('POST', '/v1/deliveries/resolve', body), result);
  assert.equal(f.hub.store.db.prepare("SELECT count(*) n FROM events WHERE kind='operator-resolved'").get().n, events);
  assert.equal((await f.api('POST', '/v1/deliveries/resolve', { ...body, state: 'delivered' })).status, 409);
  assert.equal((await f.ok('POST', '/v1/deliveries/begin', input, f.b.token)).granted, false);
  const poll = await f.ok('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token);
  assert.deepEqual(poll.deliveries.map(item => item.message.id), [second.message.id]);
  const next = await f.ok('POST', '/v1/deliveries/begin', { ...input, messageId: second.message.id }, f.b.token); assert(next.granted);
  assert.equal((await f.api('POST', '/v1/deliveries/resolve', { ...body, messageId: second.message.id, state: 'delivered' })).status, 409);
});

test('scopes, room membership, enrollments, and read-only viewer credentials are enforced', async t => {
  const f = await fixture(t);
  const code = await f.ok('POST', '/v1/enrollments', {});
  await f.ok('POST', '/v1/enroll', { code: code.code, label: 'third' }, null);
  assert.equal((await f.api('POST', '/v1/enroll', { code: code.code, label: 'again' }, null)).status, 401);
  assert.equal((await f.api('POST', '/v1/rooms', { label: 'forbidden' }, f.a.token)).status, 403);
  const privateRoom = await f.ok('POST', '/v1/rooms', { label: 'private' });
  assert.equal((await f.api('POST', '/v1/scopes', { agentId: f.alice.id, rooms: [privateRoom.id] })).status, 403);
  assert.equal((await f.api('GET', `/v1/history?room=${privateRoom.id}`, undefined, f.aliceToken)).status, 403);
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: privateRoom.id, to: [f.bob.id], text: 'No' }, f.aliceToken)).status, 403);
  const stranger = await f.agent(f.a, 'stranger', 'ses_Stranger');
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: f.room.id, to: [stranger.id], text: 'No' }, f.aliceToken)).status, 403);
  await f.joinRoom(stranger.id); const strangerToken = await f.scope(stranger.id);
  const message = await f.send();
  assert.equal((await f.api('GET', `/v1/status?id=${message.message.id}`, undefined, strangerToken)).status, 403);
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: f.room.id, to: [f.alice.id], text: 'spoof reply', replyTo: message.message.id }, strangerToken)).status, 403);
  const viewer = await f.ok('POST', '/v1/viewers', { rooms: [f.room.id] });
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: f.room.id, to: [f.alice.id], text: 'No' }, viewer.token)).status, 403);
  assert.equal((await f.api('GET', `/v1/history?room=${privateRoom.id}`, undefined, viewer.token)).status, 403);
  assert.equal((await f.api('GET', `/v1/context?token=${viewer.token}`, undefined, null)).status, 401);
});

test('agent bindings are immutable; alias changes preserve queued target and rebinding creates ID', async t => {
  const f = await fixture(t), pending = await f.send();
  const renamed = await f.agent(f.b, 'renamed', 'ses_Bob');
  assert.equal(renamed.id, f.bob.id); assert.equal(renamed.alias, 'renamed');
  const rebound = await f.agent(f.b, 'renamed', 'ses_Different');
  assert.notEqual(rebound.id, f.bob.id);
  assert.equal((await f.ok('GET', `/v1/status?id=${pending.message.id}`, undefined, f.aliceToken)).deliveries[0].agentId, f.bob.id);
  assert.equal((await f.ok('GET', '/v1/context', undefined, f.bobToken)).self.binding.sessionId, 'ses_Bob');
  const badBinding = binding('ses_Native'); badBinding.serviceIdentity.origin = 'http://192.168.1.1:7331';
  assert.equal((await f.api('POST', '/v1/agents', { alias: 'bad', harness: 'opencode', mode: 'native-push', binding: badBinding }, f.b.token)).status, 400);
});

test('poll wakes when a committed message arrives and rejects invalid wait bounds', async t => {
  const f = await fixture(t), native = await f.agent(f.b, 'native', 'ses_Native', 'native-push'); await f.joinRoom(native.id);
  assert.equal((await f.api('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token)).status, 409);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [] }, f.b.token);
  assert.equal((await f.api('GET', '/v1/node/poll?waitMs=25001', undefined, f.b.token)).status, 400);
  const pending = f.ok('GET', '/v1/node/poll?waitMs=1000', undefined, f.b.token);
  const message = await f.send({ to: [native.id] });
  const result = await pending; assert.equal(result.deliveries[0].message.id, message.message.id);
});

test('large busy-chat backlog does not crowd another chat out of poll', async t => {
  const f = await fixture(t), busy = await f.agent(f.b, 'busy', 'ses_Busy', 'native-push'), ready = await f.agent(f.b, 'ready', 'ses_Ready', 'native-push');
  await f.joinRoom(busy.id); await f.joinRoom(ready.id);
  await f.ok('POST', '/v1/node/heartbeat', { runId: 'run-1', statuses: [{ agentId: busy.id, state: 'busy' }, { agentId: ready.id, state: 'ready' }] }, f.b.token);
  for (let index = 0; index < 105; index++) await f.send({ to: [busy.id], text: `backlog-${index}` });
  const independent = await f.send({ to: [ready.id], text: 'independent' });
  const polled = await f.ok('GET', '/v1/node/poll?waitMs=0', undefined, f.b.token);
  assert.equal(polled.deliveries.length, 2);
  assert(polled.deliveries.some(item => item.message.id === independent.message.id));
  assert.equal(polled.deliveries.find(item => item.delivery.agentId === busy.id).message.text, 'backlog-0');
});

test('viewer login requires same origin and cookie cannot mutate deliveries', async t => {
  const f = await fixture(t), viewer = await f.ok('POST', '/v1/viewers', { rooms: [f.room.id] });
  assert.equal((await f.api('POST', '/v1/viewer-session', { token: viewer.token }, null)).status, 403);
  assert.equal((await f.api('POST', '/v1/viewer-session', { token: viewer.token }, null, { headers: { origin: 'https://evil.example' } })).status, 403);
  const login = await f.api('POST', '/v1/viewer-session', { token: viewer.token }, null, { headers: { origin: f.hub.url } });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const headers = { cookie: cookie.split(';')[0] };
  assert.equal((await f.api('GET', '/v1/context', undefined, null, { headers })).status, 200);
  assert.equal((await f.api('GET', '/v1/context', undefined, null, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.api('POST', '/v1/messages', {}, null, { headers })).status, 403);
  assert.equal((await f.api('GET', '/v1/inbox', undefined, null, { headers })).status, 403);
});

test('text/body limits and unsupported schemas fail explicitly', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: f.room.id, to: [f.bob.id], text: '中'.repeat(21846) }, f.aliceToken)).status, 400);
  assert.equal((await f.api('POST', '/v1/messages', { id: messageId(), room: f.room.id, to: [f.bob.id], text: 'a'.repeat(100_000) }, f.aliceToken)).status, 413);
  const accepted = await f.send({ text: 'a'.repeat(65536) }); assert.equal(accepted.message.text.length, 65536);
  await assert.rejects(startHub({ dbPath: f.dbPath, adminToken: 'wrong_' + 'b'.repeat(32) }), { code: 'invalid_admin' });
  const path = join(tmpdir(), `adl-unknown-schema-${randomUUID()}.sqlite`);
  t.after(() => rm(path, { force: true }));
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
  // DatabaseSync creates its own file with the process umask; this test is about schema only.
  const { chmod } = await import('node:fs/promises'); await chmod(path, 0o600);
  await assert.rejects(startHub({ dbPath: path, adminToken }), { code: 'schema_version' });
});

test('hard process exit preserves committed messages and rolls back an uncommitted send', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-hub-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('../lib/store.mjs', import.meta.url).href;
  for (const phase of ['before-commit', 'after-begin']) {
    const dbPath = join(dir, `${phase}.sqlite`);
    const source = `
      import { LiteStore } from ${JSON.stringify(moduleUrl)};
      const store = new LiteStore({dbPath:${JSON.stringify(dbPath)},adminToken:${JSON.stringify(adminToken)}});
      const admin = store.authenticate(${JSON.stringify(adminToken)});
      const enrolled = store.enroll({...store.createEnrollment(admin),label:'crash-node'});
      const node = store.authenticate(enrolled.token);
      const a = store.registerAgent(node,{alias:'existing-chat',harness:'opencode',mode:'native-push',binding:${JSON.stringify(binding())}});
      const room = store.createRoom(admin,{label:'crash-room'});
      store.addMember(admin,{room:room.id,agentId:a.id});
      const scope = store.authenticate(store.issueScope(admin,{agentId:a.id,rooms:[room.id]}).token);
      const id='msg_crash_evidence';
      if(${JSON.stringify(phase)}==='before-commit') {
        const original=store.event.bind(store);
        store.event=(...args)=>{
          const seq=original(...args);
          if(args[0]==='accepted') {
            process.stdout.write(JSON.stringify({phase:'before-commit',id})+'\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
          }
          return seq;
        };
      }
      store.send(scope,{id,room:room.id,to:[a.id],text:'must survive once committed'});
      store.heartbeat(node,{runId:'crash-run',statuses:[]});
      store.begin(node,{messageId:id,agentId:a.id,runId:'crash-run'});
      process.stdout.write(JSON.stringify({phase:'after-begin',id})+'\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Child did not reach crash boundary: ${errors}`)); }, 5000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', () => { clearTimeout(timeout); if (!output.includes('\n')) reject(new Error(`Child exited before boundary: ${errors}`)); });
    });
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    assert.equal(JSON.parse(output.trim()).phase, phase);
    const { LiteStore } = await import('../lib/store.mjs');
    const reopened = new LiteStore({ dbPath, adminToken });
    try {
      if (phase === 'before-commit') assert.throws(() => reopened.message('msg_crash_evidence'), { code: 'not_found' });
      else {
        const message = reopened.message('msg_crash_evidence');
        assert.equal(message.text, 'must survive once committed');
        assert.equal(reopened.deliveries(message.id)[0].state, 'unknown');
      }
    } finally { reopened.close(); }
  }
});
