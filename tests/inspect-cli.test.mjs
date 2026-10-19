import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-inspect-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'unrelated cwd'), state = join(root, 'missing state'), cache = join(root, 'missing cache');
  await mkdir(cwd);
  const env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: state, AGENT_DIALOGUE_CACHE_DIR: cache, AGENT_DIALOGUE_LEDGER: 'embedded' };
  const call = args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), 'inspect', ...args], { env, cwd, capture: true, timeout: 10000 });
  return { root, cwd, state, cache, env, call };
}

test('inspect CLI explains an unconfigured space from any cwd without creating state or cache', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  const result = await f.call(['--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.overall, 'unconfigured');
  assert.equal(report.effects.sourceWrites, false);
  assert.equal(report.effects.nativeContact, false);
  assert.equal(report.effects.sshContact, false);
  assert.equal(report.effects.modelTurns, false);
  assert.ok(report.checks.some(check => check.code === 'STATE_NOT_INITIALIZED'));
  assert.deepEqual(await readdir(f.root), before);
  assert.equal(result.stderr, '');
  const text = await f.call([]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /unconfigured/);
  assert.match(text.stdout, /STATE_NOT_INITIALIZED/);
  assert.deepEqual(await readdir(f.root), before);
});

test('inspect does not execute tools on PATH, hcom or SSH', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), bin = join(f.root, 'fake bin');
  await mkdir(bin);
  for (const name of ['hcom', 'codex', 'opencode', 'kimi', 'pi', 'ssh']) {
    await writeFile(join(bin, name), `#!/bin/sh\nprintf unexpected > '${join(f.root, 'executed')}'\nexit 99\n`, { mode: 0o755 });
  }
  f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
  f.env.AGENT_DIALOGUE_HCOM = join(bin, 'hcom');
  const before = await readdir(f.root), result = await f.call(['--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readdir(f.root), before);
  assert.equal(JSON.parse(result.stdout).effects.thirdPartyExecutables, false);
});

test('invalid or implicit deep inspection is rejected without starting anything or leaking argv', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  for (const args of [['--native'], ['--allow-session-load'], ['--ssh'], ['--json', '--json'], ['--private-credential-sentinel']]) {
    const result = await f.call(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /inspect.*invalid/i);
    assert.doesNotMatch(result.stderr, /private-credential-sentinel/);
    assert.deepEqual(await readdir(f.root), before);
  }
});

test('inspect exposes blockers as a safe report and nonzero exit without changing the source', async t => {
  const f = await fixture(t), dir = join(f.state, 'dialogue');
  await mkdir(dir, { recursive: true });
  const bytes = '{ "password": "report-secret-sentinel"';
  await writeFile(join(dir, 'store.json'), bytes);
  const result = await f.call(['--json']);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(['blocked', 'needs-review'].includes(report.overall));
  assert.ok(report.checks.some(check => check.code === 'STORE_INVALID'));
  assert.doesNotMatch(result.stdout + result.stderr, /report-secret-sentinel/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(dir, 'store.json'), 'utf8'), bytes);
});
