import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cliFixture, mcpClient, hostMeta, toolValue } from './helpers/zcode-cli-fixture.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { withStore, createBinding, createRoom } from '../lib/bridge-store.mjs';
import { sealRoom } from '../lib/nodes.mjs';
import { inspectWindowsPrivatePath } from '../lib/private-files.mjs';

// These fixtures are synthetic MCP hosts. They verify the actual local CLI and
// wire contract, not a ZCode app/model run or cryptographic host authentication.
test('actual CLI bootstraps identity over stdio without room/node and rejects wrong host metadata', async t => {
  const f = await cliFixture(t);
  assert.equal(f.service.version, 1); assert.equal(f.service.directory, f.directory);
  const h = await mcpClient(t, f);
  const listing = await h.request('tools/list');
  assert.deepEqual(listing.result.tools.map(tool => tool.name).sort(), ['dialogue_identity', 'dialogue_context', 'dialogue_send', 'dialogue_inbox', 'dialogue_status'].sort());
  assert.equal((await h.call('dialogue_context', {}, hostMeta('sess_exact_cli', f.directory))).isError, true);
  const actual = toolValue(await h.call('dialogue_identity', {}, hostMeta('sess_exact_cli', f.directory)));
  assert.equal(actual.sessionId, 'sess_exact_cli'); assert.equal(actual.roomAssigned, false); assert.equal(actual.autoWake, false);
  const conflict = hostMeta('sess_invented', f.directory); conflict['com.zcode/request-context'].session_id = 'sess_other';
  const subagent = hostMeta('sess_subagent', f.directory); subagent.runtime_scope = subagent['com.zcode/request-context'].runtime_scope = 'subagent';
  for (const meta of [{}, conflict, subagent, hostMeta('sess_wrong_directory', join(f.temp, 'another project'))]) assert.equal((await h.call('dialogue_identity', {}, meta)).isError, true);
  assert.equal((await h.call('dialogue_identity', { sessionId: 'sess_forged' }, hostMeta('sess_forged', f.directory))).isError, true);
  const { sessions } = await f.json(['sessions', 'zcode', '--cwd', f.directory]);
  assert.equal(sessions.length, 1); assert.equal(sessions[0].id, 'sess_exact_cli');
  const bindings = await f.json(['bindings']); assert.deepEqual(bindings, { bindings: [], rooms: [] });
  const overwritten = await f.cli(['zcode', 'init', '--cwd', f.directory, '--file', f.serviceFile], { success: false });
  assert.notEqual(overwritten.code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.serviceFile, 'utf8')), f.service);
  await assert.rejects(readFile(join(f.context.stateDir, 'dialogue', 'node.json')), { code: 'ENOENT' });
  await h.close();
});

test('CLI scope export creates a private new file and existing stdio bootstrap reads its first assigned scope', async t => {
  const f = await cliFixture(t), h = await mcpClient(t, f);
  const native = toolValue(await h.call('dialogue_identity', {}, hostMeta('sess_scope_cli', f.directory)));
  assert.equal((await h.call('dialogue_context', {}, hostMeta(native.sessionId, f.directory))).isError, true);
  await initializeEmbedded(f.context);
  const node = await loadOrCreateNode(f.context);
  const { sessions: listed } = await f.json(['sessions', 'zcode', '--cwd', f.directory]);
  let self, peer, room;
  await withStore(f.context, store => {
    self = createBinding(store, { alias: 'zcode-cli-self', harness: 'zcode-tools', sessionId: native.sessionId, projectId: listed[0].projectId, directory: f.directory, serviceId: `zcode-tools-${f.service.id}`, origin: `zcode-tools://${f.service.id}` });
    peer = createBinding(store, { alias: 'scope-peer', harness: 'opencode-v2', sessionId: 'ses_synthetic_peer', projectId: 'synthetic-project', directory: f.directory, serviceId: 'synthetic-service', origin: 'http://127.0.0.1:4500' });
    self.nodeId = peer.nodeId = node.nodeId;
    room = createRoom(store, { name: 'CLI scope fixture', members: [self.alias, peer.alias] });
  });
  room = await sealRoom(f.context, room);
  const args = ['mcp-context', '--room', room.id, '--from', self.alias, '--to', peer.alias, '--output', f.scopeFile];
  const saved = await f.json(args); assert.equal(saved.saved, true); assert.equal(saved.path, f.scopeFile);
  const bytes = await readFile(f.scopeFile), scope = JSON.parse(bytes);
  assert.equal(scope.self.sessionId, native.sessionId); assert.equal(scope.peers.length, 1);
  if (process.platform === 'win32') {
    const acl = await inspectWindowsPrivatePath(f.scopeFile);
    assert.equal(acl.protected, true); assert.equal(acl.currentUserSid, acl.ownerSid);
  } else assert.equal((await stat(f.scopeFile)).mode & 0o777, 0o600);
  assert.notEqual((await f.cli(args, { success: false })).code, 0);
  assert.deepEqual(await readFile(f.scopeFile), bytes, 'refused overwrite must preserve original scope bytes');
  const assigned = toolValue(await h.call('dialogue_context', {}, hostMeta(native.sessionId, f.directory)));
  assert.equal(assigned.self.alias, self.alias); assert.equal(assigned.room.id, room.id); assert.equal(assigned.deliveryMode, 'tool-pull');
  assert.equal((await h.call('dialogue_context', {}, hostMeta('sess_another_chat', f.directory))).isError, true);
  await h.close();
});
