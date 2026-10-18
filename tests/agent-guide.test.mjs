import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentContext } from '../lib/agent-guide.mjs';
import { createBinding, createRoom } from '../lib/bridge-store.mjs';
import { observationTestNode } from './fixtures/viewer-observation-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cli = join(root, 'bin/agent-dialogue.mjs');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'agent-guide-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const context = { stateDir: join(temp, "space ' ` $(touch NEVER_EXECUTED)"), cacheDir: join(temp, 'cache'), binary: join(temp, 'hcom'), env: {
    AGENT_DIALOGUE_HCOM: 'explicit', AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: join(temp, 'service.json'),
    CODEX_HOME: join(temp, 'codex'), AGENT_DIALOGUE_CODEX_SOCKET: join(temp, 'control.sock'),
    SECRET_TOKEN: 'NEVER_EXPORT_SECRET', OPENAI_API_KEY: 'NEVER_EXPORT_API_KEY',
  } };
  const store = { version: 1, bindings: {}, rooms: {} };
  for (const alias of ['alice', 'bob', 'charlie']) createBinding(store, { alias, harness: 'opencode', sessionId: `ses_${alias}`, projectId: 'project', directory: '/workspace/project', serviceId: 'service', origin: 'http://127.0.0.1:4000', token: 'NEVER_EXPORT_BINDING_TOKEN' });
  const room = createRoom(store, { name: 'Synthetic project', members: ['alice', 'bob', 'charlie'] });
  const node = observationTestNode();
  for (const binding of Object.values(store.bindings)) binding.nodeId = node.nodeId;
  for (const member of room.members) member.nodeId = node.nodeId;
  store.bindings.alice.privateKey = 'NEVER_EXPORT_BINDING_TOKEN';
  const dir = join(context.stateDir, 'dialogue'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'node.json'), JSON.stringify(node), { mode: 0o600 });
  const path = join(dir, 'store.json');
  const save = () => writeFile(path, JSON.stringify(store)); await save();
  return { temp, context, store, room, path, save };
}

test('static agent guide is available before setup and ignores invalid state configuration', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'agent-guide-static-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'agent-guide'], { cwd: temp, encoding: 'utf8', env: { ...process.env, AGENT_DIALOGUE_STATE_DIR: '', AGENT_DIALOGUE_SPACE: 'INVALID' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Establish your identity once/);
  assert.match(result.stdout, /queued submission/);
  assert.deepEqual(await readdir(temp), []);
});

test('assigned context includes exact peers without starting services or mutating control state', async t => {
  const { context, path, room } = await fixture(t);
  const before = await readFile(path), content = await generateAgentContext(context, { room: room.id, from: 'alice' });
  assert.match(content, /"sessionId": "ses_alice"/);
  assert.match(content, /--to 'bob' --expected-session 'ses_bob'/);
  assert.match(content, /--to 'charlie' --expected-session 'ses_charlie'/);
  assert.equal((content.match(/collab send --queue --room/g) || []).length, 2);
  for (const secret of ['NEVER_EXPORT_SECRET', 'NEVER_EXPORT_API_KEY', 'NEVER_EXPORT_BINDING_TOKEN', 'privateKey']) assert.equal(content.includes(secret), false, secret);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(join(context.stateDir, 'dialogue')), ['node.json', 'store.json']);
});

test('CLI generates one assigned context with the selected state and rejects incomplete options', async t => {
  const { context, temp, path, room } = await fixture(t), before = await readFile(path);
  const env = { ...process.env, ...context.env, AGENT_DIALOGUE_STATE_DIR: context.stateDir, AGENT_DIALOGUE_CACHE_DIR: context.cacheDir, AGENT_DIALOGUE_HCOM: context.binary };
  const result = spawnSync(process.execPath, [cli, 'agent-guide', '--room', room.id, '--from', 'alice', '--to', 'bob'], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--from 'alice' --to 'bob' --expected-session 'ses_bob'/);
  assert.equal(result.stdout.includes('NEVER_EXPORT_API_KEY'), false);
  assert.deepEqual(await readFile(path), before);
  for (const args of [['--from', 'alice'], ['--room', room.id, '--from', 'alice', '--unknown', 'value']]) {
    const rejected = spawnSync(process.execPath, [cli, 'agent-guide', ...args], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
  }
});

test('generated commands preserve literal paths and exact route through a POSIX shell', async t => {
  const { context, temp, room } = await fixture(t);
  const content = await generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' });
  const line = content.split('\n').find(text => text.includes('collab send --queue --room'));
  assert.ok(line);
  const capture = join(temp, 'capture.mjs');
  await writeFile(capture, 'console.log(JSON.stringify({args:process.argv.slice(2),state:process.env.AGENT_DIALOGUE_STATE_DIR,service:process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE}));\n');
  const command = line.replace(`${quote(process.execPath)} ${quote(cli)}`, `${quote(process.execPath)} ${quote(capture)}`);
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: temp, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.state, context.stateDir); assert.equal(observed.service, context.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE);
  assert.deepEqual(observed.args, ['collab', 'send', '--queue', '--room', room.id, '--from', 'alice', '--to', 'bob', '--expected-session', 'ses_bob', '--message', 'YOUR_MESSAGE']);
  assert.equal((await readdir(temp)).includes('NEVER_EXECUTED'), false);
});

test('contexts reject impersonation, inactive/stale identities, foreign node pins and nonmembers', async t => {
  const { context, store, room, save } = await fixture(t);
  for (const options of [{}, { room: room.id, from: 'operator' }, { room: room.id, from: 'alice', to: 'alice' }, { room: room.name, from: 'alice' }]) {
    await assert.rejects(generateAgentContext(context, options));
  }
  store.bindings.alice.remote = true; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice' }), /owning node/);
  delete store.bindings.alice.remote;
  store.bindings.bob.active = false; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }), /inactive/);
  store.bindings.bob.active = true; store.bindings.bob.revision++; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }), /Stale/);
  store.bindings.bob.revision--; room.members.find(member => member.alias === 'bob').nodeId = 'n_wrong_node'; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }), /node pin/);
  delete room.members.find(member => member.alias === 'bob').nodeId;
  room.members = room.members.filter(member => member.alias !== 'alice'); await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }), /not a member/);
});

test('missing assignments fail without initializing an unused space', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'agent-guide-missing-')); t.after(() => rm(temp, { recursive: true, force: true }));
  await assert.rejects(generateAgentContext({ stateDir: join(temp, 'unused'), env: {} }, { room: 'r_missing', from: 'alice' }), /Unknown room/);
  assert.deepEqual(await readdir(temp), []);
});

test('a copied store cannot claim a different owning node even if room and binding pins agree', async t => {
  const { context, store, room, save } = await fixture(t);
  const foreign = observationTestNode(12);
  store.bindings.alice.nodeId = foreign.nodeId;
  room.members.find(member => member.alias === 'alice').nodeId = foreign.nodeId;
  await save();
  const before = await readFile(join(context.stateDir, 'dialogue', 'node.json'));
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }), /owning node/);
  assert.deepEqual(await readFile(join(context.stateDir, 'dialogue', 'node.json')), before);
});

test('missing node identity is never created while generating an assigned guide', async t => {
  const { context, room } = await fixture(t);
  await rm(join(context.stateDir, 'dialogue', 'node.json'));
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }));
  assert.deepEqual(await readdir(join(context.stateDir, 'dialogue')), ['store.json']);
});

test('malformed allowed identity fields cannot export nested secret objects', async t => {
  const { context, store, room, save } = await fixture(t);
  store.bindings.alice.harness = { token: 'PRIVATE_NESTED_SECRET' }; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }));
  store.bindings.alice.harness = 'opencode'; room.manifestHash = { token: 'PRIVATE_NESTED_SECRET' }; await save();
  await assert.rejects(generateAgentContext(context, { room: room.id, from: 'alice', to: 'bob' }));
});
