import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { HCOM_VERSION, runtimeEnvironment } from '../lib/paths.mjs';

test('default state and runtime live in user directories independent of the package', () => {
  const result = runtimeEnvironment({}, '/read-only/node_modules/agent-dialogue');
  assert.equal(HCOM_VERSION, '0.7.30');
  assert.equal(result.stateDir, join(homedir(), '.local', 'state', 'agent-dialogue', 'spaces', 'default'));
  assert.equal(result.cacheDir, join(homedir(), '.cache', 'agent-dialogue'));
  assert.equal(result.runtimeDir, join(result.cacheDir, 'hcom-0.7.30', `${platform()}-${arch()}`));
  assert.equal(result.binary, join(result.runtimeDir, 'bin', 'hcom'));
  assert.ok(!result.stateDir.includes('node_modules'));
  assert.ok(!result.runtimeDir.includes('node_modules'));
  assert.equal(result.env.AGENT_DIALOGUE_STATE_DIR, result.stateDir);
  assert.equal(result.env.AGENT_DIALOGUE_CACHE_DIR, result.cacheDir);
});

test('spaces isolate communication state while sharing the fixed dependency cache', () => {
  const a = runtimeEnvironment({ AGENT_DIALOGUE_SPACE: 'project-a' });
  const b = runtimeEnvironment({ AGENT_DIALOGUE_SPACE: 'project_b' });
  assert.equal(a.stateDir, join(homedir(), '.local', 'state', 'agent-dialogue', 'spaces', 'project-a'));
  assert.notEqual(a.stateDir, b.stateDir);
  assert.equal(a.cacheDir, b.cacheDir);
  assert.equal(a.binary, b.binary);
});

test('explicit environment overrides are normalized and inherited hcom controls cannot replace them', () => {
  const source = {
    HOME: '/do-not-repurpose-home', CODEX_HOME: '/keep-codex-config',
    AGENT_DIALOGUE_STATE_DIR: './private state', AGENT_DIALOGUE_CACHE_DIR: './private cache', AGENT_DIALOGUE_HCOM: './custom hcom',
    AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: './service records/service.json',
    HCOM_DIR: '/old-hcom-state', HCOM_AUTO_APPROVE: '1', HCOM_AUTO_TRUST_WORKSPACE: '1', PATH: '/custom/bin', TERM: 'dumb',
  };
  const result = runtimeEnvironment(source);
  assert.equal(result.stateDir, resolve('./private state'));
  assert.equal(result.cacheDir, resolve('./private cache'));
  assert.equal(result.binary, resolve('./custom hcom'));
  assert.equal(result.env.HCOM_DIR, result.stateDir);
  assert.equal(result.env.AGENT_DIALOGUE_STATE_DIR, result.stateDir);
  assert.equal(result.env.AGENT_DIALOGUE_CACHE_DIR, result.cacheDir);
  assert.equal(result.env.AGENT_DIALOGUE_HCOM, result.binary);
  assert.equal(result.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE, resolve('./service records/service.json'));
  assert.equal(result.env.HCOM_AUTO_APPROVE, '0');
  assert.equal(result.env.HCOM_AUTO_TRUST_WORKSPACE, '0');
  assert.equal(result.env.PATH, `${join(result.runtimeDir, 'bin')}${delimiter}/custom/bin`);
  assert.equal(result.env.TERM, 'xterm-256color');
  assert.equal(result.env.HOME, source.HOME); assert.equal(result.env.CODEX_HOME, source.CODEX_HOME);
  assert.equal(source.HCOM_DIR, '/old-hcom-state', 'the caller environment must not be mutated');
});

test('defaults ignore source HOME and honor absolute XDG roots', () => {
  const result = runtimeEnvironment({ HOME: '/different-home', XDG_STATE_HOME: '/user state', XDG_CACHE_HOME: '/user cache', TERM: 'screen-256color' });
  assert.equal(result.stateDir, '/user state/agent-dialogue/spaces/default');
  assert.equal(result.cacheDir, '/user cache/agent-dialogue');
  assert.equal(result.env.HOME, '/different-home');
  assert.equal(result.env.TERM, 'screen-256color');
  assert.equal(runtimeEnvironment({ HOME: '/different-home' }).stateDir, runtimeEnvironment({}).stateDir);
});

test('default paths stay unchanged when working directory and package metadata move', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dialogue-paths-'));
  const before = process.cwd();
  t.after(async () => { process.chdir(before); await rm(dir, { recursive: true, force: true }); });
  const first = runtimeEnvironment({}, '/first/install');
  process.chdir(dir);
  const second = runtimeEnvironment({}, '/other/install');
  assert.equal(second.stateDir, first.stateDir);
  assert.equal(second.cacheDir, first.cacheDir);
  assert.equal(second.runtimeDir, first.runtimeDir);
  assert.equal(second.binary, first.binary);
});

test('invalid namespaces are rejected unless an explicit state directory controls the space', () => {
  for (const space of ['', 'Upper', '1name', '../escape', 'a/b', 'a b', 'x'.repeat(41), null]) {
    assert.throws(() => runtimeEnvironment({ AGENT_DIALOGUE_SPACE: space }), /AGENT_DIALOGUE_SPACE/);
  }
  assert.equal(runtimeEnvironment({ AGENT_DIALOGUE_SPACE: '../ignored', AGENT_DIALOGUE_STATE_DIR: '/specific/state' }).stateDir, '/specific/state');
  assert.equal(runtimeEnvironment({ AGENT_DIALOGUE_SPACE: 'x'.repeat(40) }).stateDir.endsWith('x'.repeat(40)), true);
});

test('relative or empty XDG roots fail even when another path override is present', () => {
  for (const key of ['XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    for (const value of ['relative', '', ' ', null, '/bad\0path']) {
      assert.throws(() => runtimeEnvironment({ [key]: value, AGENT_DIALOGUE_STATE_DIR: '/safe/state', AGENT_DIALOGUE_CACHE_DIR: '/safe/cache' }), new RegExp(key));
    }
  }
});

test('state and cache cannot be the home directory or personal hcom subtree', () => {
  for (const key of ['AGENT_DIALOGUE_STATE_DIR', 'AGENT_DIALOGUE_CACHE_DIR']) {
    for (const value of [homedir(), join(homedir(), '.hcom'), join(homedir(), '.hcom', 'child')]) {
      assert.throws(() => runtimeEnvironment({ [key]: value }), /dedicated directory/);
    }
    for (const value of ['', ' ', null, '/bad\0path']) assert.throws(() => runtimeEnvironment({ [key]: value }), new RegExp(key));
  }
  assert.throws(() => runtimeEnvironment({ AGENT_DIALOGUE_HCOM: '' }), /AGENT_DIALOGUE_HCOM/);
  assert.equal(runtimeEnvironment({ AGENT_DIALOGUE_STATE_DIR: join(homedir(), '.hcom-independent') }).stateDir, join(homedir(), '.hcom-independent'));
});
