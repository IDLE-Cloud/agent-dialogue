import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from '../lib/hub.mjs';
import { HubClient, newId } from '../lib/client.mjs';
import { saveConfig } from '../lib/config.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/adl.mjs', import.meta.url));
async function call(...args) { return JSON.parse((await exec(process.execPath, [cli, ...args], { timeout: 15_000 })).stdout); }

test('CLI two isolated nodes and scoped existing tool chats exchange replies; viewer does not consume inbox', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-cli-'));
  const hub = await startHub({ dbPath: join(dir, 'hub.sqlite'), adminToken: 'operator-test-token-0123456789012345' });
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const admin = join(dir, 'operator.json');
  await saveConfig(admin, { kind: 'hub', url: hub.url, token: 'operator-test-token-0123456789012345' });
  const room = await call('room', '--config', admin, '--label', 'CLI integration');
  const agents = [], scopes = [], nodes = [];
  for (const name of ['a', 'b']) {
    const { code } = await call('enrollment', '--config', admin);
    const node = join(dir, `${name}-node.json`); nodes.push(node);
    await call('enroll', '--config', node, '--hub', hub.url, '--code', code, '--label', name);
    const agent = await call('attach', '--config', node, '--kind', 'tool', '--session', `existing-chat-${name}`, '--directory', dir, '--alias', name);
    agents.push(agent);
    await call('join', '--config', admin, '--room', room.id, '--agent', agent.id);
    const scope = join(dir, `${name}-chat.json`); scopes.push(scope);
    await call('scope', '--config', admin, '--room', room.id, '--agent', agent.id, '--out', scope);
    await call('link-tools', '--config', node, '--agent', agent.id, '--scope-config', scope);
  }
  const id = newId();
  const sent = await call('send', '--config', scopes[0], '--room', room.id, '--to', agents[1].id, '--id', id, '--text', '请评审实现');
  assert.equal(sent.message.sender, agents[0].id); assert.equal(sent.message.id, id);
  const viewer = join(dir, 'viewer.json');
  await call('viewer', '--config', admin, '--room', room.id, '--out', viewer);
  const history = await call('history', '--config', viewer, '--room', room.id);
  assert.equal(history.items[0].deliveries[0].state, 'queued');
  const received = await call('inbox', '--config', scopes[1]);
  assert.equal(received.items[0].message.id, id);
  assert.equal(received.items[0].delivery.state, 'tool-read');
  const reread = await call('inbox', '--config', scopes[1], '--after', '0');
  assert.equal(reread.items[0].message.id, id);
  const reply = await call('send', '--config', scopes[1], '--room', room.id, '--to', agents[0].id, '--reply-to', id, '--text', '评审完成');
  assert.equal(reply.message.replyTo, id);
  const back = await call('inbox', '--config', scopes[0]);
  assert.equal(back.items[0].message.id, reply.message.id);
  assert.equal((await call('context', '--config', scopes[0])).self.binding.sessionId, 'existing-chat-a');
  const observer = new HubClient(JSON.parse(await readFile(viewer, 'utf8')));
  await assert.rejects(observer.request('POST', '/v1/messages', { id: newId(), room: room.id, to: [agents[0].id], text: 'no', replyTo: null }), e => e.status === 403);
  if (process.platform !== 'win32') assert.equal((await stat(scopes[0])).mode & 0o077, 0);
});

test('CLI init refuses replacing another config and uses independent Lite state directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-init-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'hub.json');
  await call('init', '--config', file, '--port', '0');
  const before = await readFile(file, 'utf8');
  await assert.rejects(call('init', '--config', file));
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(JSON.parse(before).dbPath, join(dir, 'hub.sqlite'));
});
