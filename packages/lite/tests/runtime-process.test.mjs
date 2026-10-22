import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient } from '../lib/client.mjs';
import { startHub } from '../lib/hub.mjs';

const adminToken = 'process-test-admin-credential-at-least-24';
const nodeModule = new URL('../lib/node.mjs', import.meta.url).href;
const clientModule = new URL('../lib/client.mjs', import.meta.url).href;
const childCode = `
  const config = JSON.parse(process.env.ADL_PROCESS_TEST);
  const { runNode } = await import(${JSON.stringify(nodeModule)});
  const { HubClient } = await import(${JSON.stringify(clientModule)});
  const { appendFileSync } = await import('node:fs');
  const node = await runNode({client:new HubClient(config),pollMs:20,adapterFactory:()=>({
    inspect:async()=>({state:'ready'}),
    submit:async message=>{ appendFileSync(config.marker,message.id+'\\n'); process.send({type:'native-attempt',id:message.id}); await new Promise(()=>{}); }
  })});
  process.send({type:'ready',url:node.url});
`;
function launch(config) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
    env: { ...process.env, ADL_PROCESS_TEST: JSON.stringify(config) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  // Drain stderr without copying local environment/config credentials into test output.
  child.stderr.resume();
  return child;
}
async function message(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not report ${type}.`)); }, 8000);
    const onMessage = value => { if (value?.type === type) { cleanup(); resolve(value); } };
    const onExit = () => { cleanup(); reject(new Error('Child exited before its checkpoint.')); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function setup(hub) {
  const admin = new HubClient({ url: hub.url, token: adminToken });
  const { code } = await admin.request('POST', '/v1/enrollments', {});
  const registration = await admin.request('POST', '/v1/enroll', { code, label: 'process-node' });
  const node = new HubClient({ url: hub.url, token: registration.token });
  const room = await admin.request('POST', '/v1/rooms', { label: 'crash-project' });
  const agents = [];
  for (const mode of ['tool-pull', 'native-push']) {
    const agent = await node.request('POST', '/v1/agents', { alias: mode, harness: 'opencode', mode, binding: {
      serviceIdentity: { serviceId: 'crash-service', origin: 'http://127.0.0.1:1' }, sessionId: `ses_${mode === 'tool-pull' ? 'sender' : 'receiver'}`,
      projectDirectory: process.platform === 'win32' ? 'C:\\project' : '/project', projectId: 'process-test',
    } });
    await admin.request('POST', '/v1/members', { room: room.id, agentId: agent.id }); agents.push(agent);
  }
  const scope = await admin.request('POST', '/v1/scopes', { agentId: agents[0].id, rooms: [room.id] });
  const body = { id: `msg_${randomUUID()}`, room: room.id, to: [agents[1].id], text: 'Preserve this accepted project message through process exit.' };
  return { admin, senderToken: scope.token, nodeToken: registration.token, body };
}

test('Node killed at native-attempt checkpoint leaves unknown and a restart never submits it again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adl-node-crash-')); const children = [];
  const hub = await startHub({ dbPath: join(directory, 'hub.db'), adminToken });
  t.after(async () => { await Promise.all(children.map(kill)); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  const f = await setup(hub), marker = join(directory, 'native-attempts.txt');
  const config = { kind: 'node', url: hub.url, token: f.nodeToken, marker };
  const child = launch(config); children.push(child); await message(child, 'ready');
  const checkpoint = message(child, 'native-attempt');
  await new HubClient({ url: hub.url, token: f.senderToken }).request('POST', '/v1/messages', f.body);
  assert.equal((await checkpoint).id, f.body.id);
  assert.equal((await f.admin.request('GET', `/v1/status?id=${f.body.id}`)).deliveries[0].state, 'delivering');
  await kill(child);
  const restarted = launch(config); children.push(restarted); await message(restarted, 'ready');
  const deadline = Date.now() + 5000;
  while ((await f.admin.request('GET', `/v1/status?id=${f.body.id}`)).deliveries[0].state !== 'unknown') {
    if (Date.now() >= deadline) assert.fail('Node restart did not surface unknown delivery.');
    await sleep(20);
  }
  await sleep(350);
  assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), [f.body.id]);
});
