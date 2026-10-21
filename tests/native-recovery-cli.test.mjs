import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';
import { createBinding, withStore } from '../lib/bridge-store.mjs';
const options = { timeout: process.platform === 'win32' ? 180000 : 30000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-native-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache') };
  const env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: context.stateDir, AGENT_DIALOGUE_CACHE_DIR: context.cacheDir, AGENT_DIALOGUE_LEDGER: 'embedded' };
  const call = args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), ...args], { cwd: root, env, capture: true, timeout: process.platform === 'win32' ? 120000 : 30000 });
  return { ...context, root, call };
}
test('CLI explicit v4 upgrade and repeat preserve state while malformed targets create nothing', options, async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const target of ['5', '04', '4\n']) {
    assert.notEqual((await f.call(['state', 'upgrade', '--offline', '--target', target])).code, 0);
    assert.deepEqual(await readdir(f.root), before);
  }
  const result = await f.call(['state', 'upgrade', '--offline', '--target', '4', '--json']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).version, 4);
  const path = join(f.stateDir, 'dialogue', 'store.json'), bytes = await readFile(path);
  const repeat = await f.call(['state', 'upgrade', '--offline', '--target', '4']); assert.equal(repeat.code, 0, repeat.stderr); assert.equal(JSON.parse(repeat.stdout).upgraded, false);
  assert.deepEqual(await readFile(path), bytes);
});
test('native CLI validates exact event and scope before reporting missing provenance without creation', options, async t => {
  const f = await fixture(t); assert.equal((await f.call(['state', 'upgrade', '--offline', '--target', '4'])).code, 0);
  await withStore(f, store => createBinding(store, { alias: 'selected', harness: 'opencode-v1', sessionId: 'ses_fixture', projectId: 'fixture', directory: f.root, serviceId: 'fixture', origin: 'http://127.0.0.1:1' }));
  const path = join(f.stateDir, 'dialogue', 'store.json'), before = await readFile(path), names = await readdir(join(f.stateDir, 'dialogue'));
  for (const args of [
    ['bridge', 'native-evidence', 'selected'], ['bridge', 'native-evidence', 'selected', '--event', '01'],
    ['bridge', 'native-evidence', 'selected', '--event', '1', '--allow-session-load'],
    ['bridge', 'native-reconcile', 'selected', '--event', '1', '--force'],
  ]) assert.notEqual((await f.call(args)).code, 0);
  for (const command of ['native-evidence', 'native-reconcile']) {
    const result = await f.call(['bridge', command, 'selected', '--event', '7', '--json']);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reason, 'legacy-or-missing-native-provenance');
  }
  assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(join(f.stateDir, 'dialogue')), names);
});
test('lock plan without configuration stays read-only and retire requires explicit offline selection', options, async t => {
  const f = await fixture(t), before = await readdir(f.root);
  const planned = await f.call(['lock', 'plan', '--json']);
  assert.equal(JSON.parse(planned.stdout).status, 'needs-review'); assert.deepEqual(await readdir(f.root), before);
  assert.notEqual((await f.call(['lock', 'retire', '--plan', join(f.root, 'missing.json')])).code, 0);
  assert.deepEqual(await readdir(f.root), before);
});
