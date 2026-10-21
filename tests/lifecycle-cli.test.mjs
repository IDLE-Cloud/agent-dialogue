import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, withStore } from '../lib/bridge-store.mjs';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lifecycle-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'), env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: state, AGENT_DIALOGUE_CACHE_DIR: join(root, 'cache'), AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: join(root, 'intentionally absent service.json') };
  const call = args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), ...args], { env, cwd: root, capture: true, timeout: 30000 });
  const populate = async () => {
    const rows = await withStore({ stateDir: state }, store => {
      for (const alias of ['alice', 'bob']) createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'fixture-project', directory: root, serviceId: 'owned-cli-fixture', origin: 'http://127.0.0.1:1' });
      const room = createRoom(store, { name: 'CLI fixture', members: ['alice', 'bob'] }); return { binding: store.bindings.alice, room };
    });
    if (process.platform === 'win32') await (await import('../lib/private-files.mjs')).protectWindowsPrivatePath(join(state, 'dialogue'), { directory: true });
    return rows;
  };
  return { root, state, call, populate };
}

test('state upgrade requires an explicit offline declaration before creating any state', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const args of [['state', 'upgrade'], ['state', 'upgrade', '--offline', '--force']]) {
    const result = await f.call(args); assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(f.root), before);
  }
  const result = await f.call(['state', 'upgrade', '--offline', '--json']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).version, 2);
  assert.deepEqual(await readdir(join(f.state, 'dialogue')), ['store.json']);
  const repeated = await f.call(['state', 'upgrade', '--offline']);
  assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).upgraded, false);
});

test('pause requires v2 and preserves binding, room and progress; failed native resume keeps it paused', async t => {
  const f = await fixture(t), { binding } = await f.populate(), path = join(f.state, 'dialogue', 'store.json');
  const before = await readFile(path, 'utf8');
  const legacy = await f.call(['bridge', 'pause', 'alice', '--json']);
  assert.notEqual(legacy.code, 0); assert.match(legacy.stderr, /offline.*upgrade|upgrade.*offline/i);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await f.call(['state', 'upgrade', '--offline'])).code, 0);
  const first = await f.call(['bridge', 'pause', 'alice', '--json']);
  assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).newDispatchBlocked, true);
  const paused = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(paused.bindings, JSON.parse(before).bindings); assert.deepEqual(paused.rooms, JSON.parse(before).rooms);
  assert.equal(paused.lifecycle[binding.id].generation, 1);
  assert.equal((await f.call(['bridge', 'pause', 'alice'])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).lifecycle, paused.lifecycle);
  const started = await f.call(['bridge', 'start', 'alice']);
  assert.notEqual(started.code, 0); assert.match(started.stderr, /paused/i);
  const resumed = await f.call(['bridge', 'resume', 'alice']);
  assert.notEqual(resumed.code, 0); assert.equal(JSON.parse(await readFile(path, 'utf8')).lifecycle[binding.id].desired, 'paused');
  assert.deepEqual((await readdir(join(f.state, 'dialogue'))).sort(), ['store.json']);
});

test('offline upgrade refuses a live or unverified recorded worker without changing its v1 state', async t => {
  const f = await fixture(t), { binding } = await f.populate(), path = join(f.state, 'dialogue', 'store.json');
  const original = await readFile(path, 'utf8');
  await writeFile(join(f.state, 'dialogue', `${binding.id}.worker.json`), JSON.stringify({ pid: process.pid, token: '12345678-1234-4234-8234-123456789abc', status: 'ready', cursor: 19, receipts: {} }));
  const result = await f.call(['state', 'upgrade', '--offline']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /worker|quiescen/i);
  assert.equal(await readFile(path, 'utf8'), original);
});
