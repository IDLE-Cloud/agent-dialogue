import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';
const budget = { timeout: process.platform === 'win32' ? 180000 : 30000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: join(root, 'state'), AGENT_DIALOGUE_CACHE_DIR: join(root, 'cache'), AGENT_DIALOGUE_LEDGER: 'embedded' };
  return { root, call: args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), ...args], { env, cwd: root, capture: true, timeout: process.platform === 'win32' ? 120000 : 30000 }) };
}
test('installed migration help lists explicit offline and fixed source selection', budget, async t => {
  const f = await fixture(t), result = await f.call(['--help']);
  assert.equal(result.code, 0); assert.match(result.stdout, /migration prepare/); assert.match(result.stdout, /migration rollback/);
  assert.deepEqual(await readdir(f.root), []);
});
test('migration rejects malformed selections and missing offline declarations before creating state', budget, async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const args of [
    ['migration', 'prepare'], ['migration', 'apply', '--bundle', join(f.root, 'bundle')],
    ['migration', 'rollback', '--bundle', join(f.root, 'bundle')],
    ['migration', 'accept', '--bundle', join(f.root, 'bundle')],
    ['migration', 'plan', '--from-package', '', '--from-node', process.execPath],
    ['migration', 'plan', '--from-package', f.root, '--from-node', process.execPath, '--target', '3'],
    ['migration', 'prepare', '--from-package', f.root, '--from-node', process.execPath, '--bundle', '', '--offline'],
    ['migration', 'verify', '--bundle', join(f.root, 'bundle'), '--force'],
  ]) {
    const result = await f.call(args); assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(f.root), before);
  }
});
test('unconfigured migration plan and absent bundle queries stay read-only and redact private selections', budget, async t => {
  const f = await fixture(t), before = await readdir(f.root), secret = join(f.root, 'PRIVATE_SELECTION_SECRET');
  const planned = await f.call(['migration', 'plan', '--from-package', secret, '--from-node', process.execPath, '--json']);
  assert.equal(planned.code, 1); assert.equal(JSON.parse(planned.stdout).status, 'needs-review');
  assert.equal(planned.stdout.includes('PRIVATE_SELECTION_SECRET'), false);
  for (const command of ['verify', 'status']) {
    const result = await f.call(['migration', command, '--bundle', secret, '--json']);
    assert.notEqual(result.code, 0); assert.equal(result.stderr.includes('PRIVATE_SELECTION_SECRET'), false);
  }
  assert.deepEqual(await readdir(f.root), before);
});
