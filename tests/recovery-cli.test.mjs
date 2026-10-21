import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';
import { withStore, createBinding } from '../lib/bridge-store.mjs';
import { pauseBinding } from '../lib/lifecycle.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-recovery-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state'), env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: stateDir, AGENT_DIALOGUE_CACHE_DIR: join(root, 'cache'), AGENT_DIALOGUE_LEDGER: 'embedded' };
  const call = args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), ...args], { cwd: root, env, capture: true, timeout: 30000 });
  return { root, stateDir, call };
}
test('CLI v3 is explicit, rejects invalid targets before creating state, and preserves v3 on default downgrade refusal', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const target of ['5', '03', '3\n']) { assert.notEqual((await f.call(['state', 'upgrade', '--offline', '--target', target])).code, 0); assert.deepEqual(await readdir(f.root), before); }
  const upgraded = await f.call(['state', 'upgrade', '--offline', '--target', '3']); assert.equal(upgraded.code, 0, upgraded.stderr); assert.equal(JSON.parse(upgraded.stdout).version, 3);
  const path = join(f.stateDir, 'dialogue', 'store.json'), bytes = await readFile(path);
  assert.notEqual((await f.call(['state', 'upgrade', '--offline'])).code, 0); assert.deepEqual(await readFile(path), bytes);
  const repeated = await f.call(['state', 'upgrade', '--offline', '--target', '3']); assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).upgraded, false);
});
test('CLI refuses malformed recovery selections and reports missing legacy provenance without native or runtime creation', async t => {
  const f = await fixture(t); assert.equal((await f.call(['state', 'upgrade', '--offline', '--target', '3'])).code, 0);
  await withStore(f, store => createBinding(store, { alias: 'alice', harness: 'opencode-v2', sessionId: 'ses_fixture', projectId: 'fixture', directory: f.root, serviceId: 'fixture', origin: 'http://127.0.0.1:1' }));
  await pauseBinding(f, 'alice'); const path = join(f.stateDir, 'dialogue', 'store.json'), bytes = await readFile(path);
  for (const args of [['bridge', 'reconcile', 'alice'], ['bridge', 'reconcile', 'alice', '--submission', 'q_bad'], ['bridge', 'reconcile', 'alice', '--submission', 'q_12345678-1234-4234-8234-123456789abc', '--force']]) assert.notEqual((await f.call(args)).code, 0);
  const result = await f.call(['bridge', 'reconcile', 'alice', '--submission', 'q_12345678-1234-4234-8234-123456789abc']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reason, 'legacy-or-missing-provenance');
  assert.deepEqual(await readFile(path), bytes); assert.deepEqual(await readdir(join(f.stateDir, 'dialogue')), ['store.json']);
});
