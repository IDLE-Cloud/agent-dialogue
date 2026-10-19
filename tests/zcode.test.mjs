import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZCodeToolsClient, createZCodeService, zcodeRequestContext } from '../lib/zcode.mjs';

const directory = process.platform === 'win32' ? 'E:\\Knowledgebase\\Project' : '/workspace/project';
function meta(delta = {}, nestedDelta = {}) {
  const context = { session_id: 'sess_exact-123', workspace_path: directory, runtime_scope: 'main', client_mode: 'desktop-continuous', delivery_kind: 'desktop-continuous', trace_id: 'trace-original', span_id: 'span-original', turn_id: 'turn-original', workspace_key: directory, ...delta };
  return { ...context, 'com.zcode/request-context': { ...context, ...nestedDelta } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-zcode-')); t.after(() => rm(root, { recursive: true, force: true }));
  const serviceFile = join(root, 'private', 'service.json');
  const descriptor = await createZCodeService({ path: serviceFile, directory });
  const client = await ZCodeToolsClient.discover({ serviceFile });
  return { root, serviceFile, descriptor, client };
}

test('ZCode derives exact main desktop identity from both official request metadata copies', () => {
  assert.deepEqual(zcodeRequestContext(meta(), { directory }), { sessionId: 'sess_exact-123', directory, runtimeScope: 'main', clientMode: 'desktop-continuous', deliveryKind: 'desktop-continuous' });
});

test('ZCode rejects absent, conflicting or model-shaped identity metadata', () => {
  for (const value of [undefined, null, [], {}, { session_id: 'sess_exact-123' }, { 'com.zcode/request-context': meta()['com.zcode/request-context'] }, { ...meta(), 'com.zcode/request-context': [] }, meta({}, { session_id: 'sess_other' }), meta({}, { workspace_path: '/elsewhere' }), meta({}, { runtime_scope: 'subagent' }), meta({}, { trace_id: 'different-trace' })]) assert.throws(() => zcodeRequestContext(value, { directory }), /ZCode|metadata|context/);
});

test('ZCode refuses wrong workspace, subagent and replayable clients', () => {
  for (const delta of [{ workspace_path: '/elsewhere' }, { runtime_scope: 'subagent' }, { client_mode: 'web-remote-replayable' }, { delivery_kind: 'web-remote-replayable' }, { session_id: 'latest' }, { session_id: ['sess_exact-123'] }, { session_id: 'sess_bad/slash' }, { workspace_path: [directory] }, { session_id: 'sess_bad\n' }]) assert.throws(() => zcodeRequestContext(meta(delta), { directory }), /ZCode|workspace|metadata|context/);
});

test('ZCode request metadata never retains prompt, token or unrelated metadata', () => {
  const value = meta(); value.token = 'private-token'; value.arguments = { session_id: 'sess_forged' };
  assert.deepEqual(Object.keys(zcodeRequestContext(value, { directory })).sort(), ['clientMode', 'deliveryKind', 'directory', 'runtimeScope', 'sessionId']);
});

test('ZCode service creation is exclusive, private and tools-only', async t => {
  const { client, descriptor, serviceFile } = await fixture(t);
  assert.deepEqual(Object.keys(descriptor).sort(), ['directory', 'id', 'runtimeDir', 'version', 'zcodeVersion']);
  assert.match(descriptor.id, /^[0-9a-f-]{36}$/); assert.equal(descriptor.version, 1); assert.equal(descriptor.zcodeVersion, '3.14.3');
  assert.deepEqual(client.identity, { serviceId: `zcode-tools-${descriptor.id}`, origin: `zcode-tools://${descriptor.id}`, version: '3.14.3' });
  assert.equal(client.directory, directory); assert.throws(() => { client.directory = '/elsewhere'; }, TypeError);
  assert.deepEqual(client.capabilities, { existingAttach: true, toolInbox: true, autoWake: false, queue: false, stableInputId: false, resume: false });
  await assert.rejects(createZCodeService({ path: serviceFile, directory }), /exists|overwrite/);
  if (process.platform !== 'win32') { assert.equal((await lstat(serviceFile)).mode & 0o777, 0o600); assert.equal((await lstat(descriptor.runtimeDir)).mode & 0o777, 0o700); }
});

test('ZCode lists no native session until a real contextual MCP registration', async t => {
  const { client } = await fixture(t);
  assert.deepEqual(await client.sessions(), []);
  await assert.rejects(client.session('sess_exact-123'), /registered|candidate|observed/);
  const session = await client.register(meta());
  assert.equal(session.id, 'sess_exact-123'); assert.match(session.projectID, /^zcode_[a-f0-9]{32}$/);
  assert.equal(session.location.directory, directory); assert.equal(session.nativeState, 'unknown');
  assert.equal(session.observationSource, 'zcode-mcp-request-context');
  assert.equal(session.loaded, undefined); assert.equal(session.busy, undefined); assert.equal(session.model, undefined);
  assert.deepEqual(await client.session(session.id), session);
  assert.equal((await client.sessions({ directory })).length, 1);
  await assert.rejects(client.sessions({ directory: '/elsewhere' }), /workspace|scope/);
});

test('ZCode registrations are idempotent across separate clients and retain only context identity', async t => {
  const { client, descriptor, serviceFile } = await fixture(t);
  const first = await client.register(meta());
  const secondClient = await ZCodeToolsClient.discover({ serviceFile });
  const second = await secondClient.register(meta({ trace_id: 'another-trace', turn_id: 'another-turn' }));
  assert.equal(second.id, first.id); assert.equal(second.time.created, first.time.created);
  assert.ok(second.time.updated >= first.time.updated); assert.equal((await client.sessions()).length, 1);
  const records = (await readdir(descriptor.runtimeDir)).filter(name => name.endsWith('.json'));
  assert.equal(records.length, 1);
  const raw = await readFile(join(descriptor.runtimeDir, records[0]), 'utf8');
  for (const secret of ['trace-original', 'turn-original', 'private-token', 'prompt']) assert.ok(!raw.includes(secret));
});

test('ZCode rejects invalid registration without writing candidate files', async t => {
  const { client, descriptor } = await fixture(t);
  await assert.rejects(client.register(meta({ runtime_scope: 'subagent' })), /context|metadata/);
  await assert.rejects(client.register(meta({ workspace_path: '/elsewhere' })), /workspace|context/);
  assert.deepEqual(await readdir(descriptor.runtimeDir), []);
});

test('ZCode tooling never fabricates native prompt, input, messages or admission receipts', async t => {
  const { client } = await fixture(t); await client.register(meta());
  for (const method of ['prompt', 'input', 'inbox', 'messages']) await assert.rejects(client[method]('sess_exact-123', { id: 'msg_one', text: 'not submitted' }), error => error.notSubmitted === true && error.unsupported === true && error.code === 'ZCODE_TOOLS_ONLY');
});

test('ZCode pins descriptor identity, scope and runtime directory on every operation', async t => {
  for (const change of [{ id: 'b41fd8ef-56a1-419e-8b26-26a806759bd7' }, { directory: '/elsewhere' }, { runtimeDir: '/elsewhere' }, { zcodeVersion: '3.16.1' }]) {
    const { client, descriptor, serviceFile } = await fixture(t); await client.register(meta());
    await writeFile(serviceFile, JSON.stringify({ ...descriptor, ...change }));
    await assert.rejects(client.sessions(), /changed|scope|version|ZCode/);
  }
});

test('ZCode rejects malformed or oversized descriptors and unverified versions', async t => {
  const { root, serviceFile, descriptor } = await fixture(t);
  for (const change of [{ version: 2 }, { id: [] }, { id: 'latest' }, { directory: 'relative' }, { runtimeDir: join(root, 'different') }, { zcodeVersion: '3.16.1' }, { token: 'unexpected' }]) {
    await writeFile(serviceFile, JSON.stringify({ ...descriptor, ...change }));
    await assert.rejects(ZCodeToolsClient.discover({ serviceFile }), /ZCode|version|scope|descriptor|runtime/);
  }
  await writeFile(serviceFile, 'x'.repeat(70000));
  await assert.rejects(ZCodeToolsClient.discover({ serviceFile }), /limit|large|descriptor/);
  await assert.rejects(createZCodeService({ path: join(root, 'private', 'other.json'), directory, zcodeVersion: '3.16.1' }), /version/);
});

test('ZCode rejects corrupted candidate schema instead of omitting or trusting it', async t => {
  const { client, descriptor } = await fixture(t); await client.register(meta());
  const file = (await readdir(descriptor.runtimeDir)).find(name => name.endsWith('.json'));
  await writeFile(join(descriptor.runtimeDir, file), JSON.stringify({ sessionId: 'sess_exact-123', directory: '/elsewhere' }));
  await assert.rejects(client.sessions(), /ZCode|candidate|registration|context/);
});

test('ZCode refuses a valid-looking record substituted into another exact session path', async t => {
  const { client, descriptor } = await fixture(t); await client.register(meta());
  const file = (await readdir(descriptor.runtimeDir)).find(name => name.endsWith('.json'));
  const path = join(descriptor.runtimeDir, file), value = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...value, sessionId: 'sess_other-123' }));
  await assert.rejects(client.session('sess_exact-123'), /exact requested session/);
  await assert.rejects(client.register(meta()), /exact requested session/);
  await assert.rejects(client.sessions(), /candidate path/);
});

test('ZCode creation and reads refuse control-path symlinks', { skip: process.platform === 'win32' }, async t => {
  const { root, descriptor, serviceFile, client } = await fixture(t);
  const linked = join(root, 'linked-service.json'); await symlink(serviceFile, linked);
  await assert.rejects(ZCodeToolsClient.discover({ serviceFile: linked }), /symbolic|symlink|regular|private/);
  const linkedParent = join(root, 'linked-parent'); await symlink(descriptor.runtimeDir, linkedParent);
  await assert.rejects(createZCodeService({ path: join(linkedParent, 'nested.json'), directory }), /symbolic|symlink|regular|private/);
  await rm(serviceFile); await symlink(join(root, 'not-created'), serviceFile);
  await assert.rejects(client.sessions(), /symbolic|symlink|regular|private/);
});

test('ZCode refuses permissions becoming public after creation', { skip: process.platform === 'win32' }, async t => {
  const { serviceFile, descriptor, client } = await fixture(t);
  await chmod(serviceFile, 0o644); await assert.rejects(client.sessions(), /private|permissions/);
  await chmod(serviceFile, 0o600); await chmod(descriptor.runtimeDir, 0o755);
  await assert.rejects(client.sessions(), /private|permissions/);
});

test('ZCode discover requires explicit owner service path, never scans existing chats', async () => {
  await assert.rejects(ZCodeToolsClient.discover({ serviceFile: '' }), /AGENT_DIALOGUE_ZCODE_SERVICE_FILE|owner/);
});
