import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../scripts/vps-integration-contract.mjs';

// Entirely synthetic. These contracts never contact a host or start a model.
const runId = 'vps-integration-20990101-v1';
const room = 'r_11111111-1111-4111-8111-111111111111';
const reply = 'm_22222222-2222-4222-8222-222222222222';
const session = 'ses_synthetic_owned_opencode';
const clone = value => structuredClone(value);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function config() {
  return {
    version: 1, runId, timeoutSeconds: 240,
    outputDir: `/synthetic/repository/verification/${runId}`,
    privateDir: `/synthetic/repository/.state/${runId}`,
    local: {
      executable: '/synthetic/node', cli: '/synthetic/tool/bin/agent-dialogue.mjs',
      stateDir: '/synthetic/owned-project/.agent-dialogue', cacheDir: '/synthetic/cache',
      codexThread: '33333333-3333-4333-8333-333333333333', codexCwd: '/synthetic/owned-project',
      codexSocket: '/synthetic/control.sock', codexHome: '/synthetic/codex-home',
      path: '/synthetic/ssh-shim:/usr/bin:/bin', peerSshDestination: 'synthetic-vps',
    },
    remote: {
      sshDestination: 'synthetic-vps', sshConfig: '/synthetic/private/ssh.conf',
      helper: '/synthetic/remote/vps-remote-helper.mjs', executable: '/synthetic/remote/node',
      cli: '/synthetic/remote/tool/bin/agent-dialogue.mjs', stateDir: '/synthetic/remote/state',
      cacheDir: '/synthetic/remote/cache', serviceFile: '/synthetic/remote/service.json',
      workspace: '/synthetic/remote/project', path: '/synthetic/remote/ssh-shim:/usr/bin:/bin',
      peerSshDestination: 'synthetic-mac',
    },
    model: { providerID: 'opencode', id: 'synthetic-free-model' },
  };
}
function scope(extra = {}) {
  const c = config();
  return { node: c.remote.executable, cli: c.remote.cli,
    stateDir: c.remote.stateDir, cacheDir: c.remote.cacheDir,
    serviceFile: c.remote.serviceFile, path: c.remote.path,
    room, from: 'owned-vps', to: 'owned-codex', expectedSession: session,
    runId, replyTo: null, queue: true, ...extra };
}
function command(s = scope(), { message = `Owned communication ${runId}.`, flags = [], env = [] } = {}) {
  return [
    `AGENT_DIALOGUE_STATE_DIR=${quote(s.stateDir)}`,
    `AGENT_DIALOGUE_CACHE_DIR=${quote(s.cacheDir)}`,
    ...(s.serviceFile ? [`AGENT_DIALOGUE_OPENCODE_SERVICE_FILE=${quote(s.serviceFile)}`] : []),
    ...(s.codexHome ? [`CODEX_HOME=${quote(s.codexHome)}`] : []),
    ...(s.codexSocket ? [`AGENT_DIALOGUE_CODEX_SOCKET=${quote(s.codexSocket)}`] : []),
    ...(s.path ? [`PATH=${quote(s.path)}`] : []), ...env,
    quote(s.node), quote(s.cli), 'collab', 'send',
    ...(s.queue ? ['--queue'] : []), '--room', quote(s.room), '--from', quote(s.from),
    '--to', quote(s.to), '--expected-session', quote(s.expectedSession),
    ...(s.replyTo ? ['--reply-to', quote(s.replyTo)] : []),
    '--message', quote(message), ...flags,
  ].join(' ');
}

test('VPS acceptance requires a complete explicit synthetic configuration', () => {
  assert.deepEqual(contract.validateVpsConfig(config()), config());
  for (const invalid of [undefined, null, {}, [], 'synthetic-vps']) {
    assert.throws(() => contract.validateVpsConfig(invalid));
  }
  for (const field of ['version', 'runId', 'outputDir', 'privateDir', 'local', 'remote', 'model']) {
    const value = config(); delete value[field];
    assert.throws(() => contract.validateVpsConfig(value), `Missing ${field}`);
  }
});

test('VPS acceptance rejects unknown configuration and credential fields', () => {
  for (const [section, key, value] of [
    [null, 'target', 'production'], ['local', 'env', { OPENAI_API_KEY: 'synthetic-secret' }],
    ['remote', 'command', 'arbitrary'], ['remote', 'sshArgs', ['-o', 'StrictHostKeyChecking=no']],
    ['model', 'apiKey', 'synthetic-secret'], ['local', 'resumeAnyThread', true],
  ]) {
    const c = config(); (section ? c[section] : c)[key] = value;
    assert.throws(() => contract.validateVpsConfig(c), `Unexpected ${section || 'root'}.${key}`);
  }
});

test('VPS run identifiers have a bounded fresh output-safe form', () => {
  assert.equal(contract.freshRunId(runId), runId);
  for (const id of [null, '', '../vps-integration-20990101-v1', `${runId}\n`, `${runId}/x`,
    'vps-integration-20990101-v0', 'vps-integration-20990101-v01', 'vps-integration-today-v1',
    'vps-integration-20990230-v1', 'vps-integration-20991301-v1', 'vps-integration-20990101-v1;touch-x']) {
    assert.throws(() => contract.freshRunId(id), `Invalid ${JSON.stringify(id)}`);
  }
});

test('VPS configuration binds output names and bounded timeout to the explicit run', () => {
  for (const timeoutSeconds of [0, 29, 601, 1.5, '240', Infinity, NaN]) {
    assert.throws(() => contract.validateVpsConfig({ ...config(), timeoutSeconds }));
  }
  for (const field of ['outputDir', 'privateDir']) {
    const c = config(); c[field] = '/synthetic/different-run';
    assert.throws(() => contract.validateVpsConfig(c));
  }
});

test('VPS paths are absolute and cannot contain controls or backslash ambiguity', () => {
  for (const section of ['local', 'remote']) {
    const paths = section === 'local'
      ? ['executable', 'cli', 'stateDir', 'cacheDir', 'codexCwd', 'codexSocket', 'codexHome']
      : ['sshConfig', 'helper', 'executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace'];
    for (const field of paths) for (const value of ['relative/path', '', '/synthetic/bad\npath', '/synthetic/a\0b', 'C:\\synthetic\\path']) {
      const c = config(); c[section][field] = value;
      assert.throws(() => contract.validateVpsConfig(c), `${section}.${field}: ${JSON.stringify(value)}`);
    }
  }
});

test('VPS local source state remains inside the selected owned Codex workspace', () => {
  for (const stateDir of ['/synthetic/owned-project-sibling/state', '/synthetic/owned-project/../outside/state', '/tmp/other']) {
    const c = config(); c.local.stateDir = stateDir;
    assert.throws(() => contract.validateVpsConfig(c));
  }
  const c = config(); c.local.stateDir = '/synthetic/owned-project/nested/state';
  assert.equal(contract.validateVpsConfig(c).local.stateDir, c.local.stateDir);
});

test('VPS selected Codex thread is an exact UUID and SSH targets are explicit safe aliases', () => {
  for (const codexThread of ['latest', '*', '', `${config().local.codexThread}\n`, 'ses_synthetic']) {
    const c = config(); c.local.codexThread = codexThread;
    assert.throws(() => contract.validateVpsConfig(c));
  }
  for (const section of ['local', 'remote']) for (const field of section === 'local' ? ['peerSshDestination'] : ['sshDestination', 'peerSshDestination']) {
    for (const value of ['-oProxyCommand=evil', 'host;bad', 'user@host bad', '$(bad)', 'host\nother', '']) {
      const c = config(); c[section][field] = value;
      assert.throws(() => contract.validateVpsConfig(c));
    }
  }
});

test('VPS public and private output directories cannot overlap in either direction', () => {
  for (const [outputDir, privateDir] of [
    [`/synthetic/${runId}`, `/synthetic/${runId}`],
    [`/synthetic/${runId}`, `/synthetic/${runId}/private/${runId}`],
    [`/synthetic/${runId}/public/${runId}`, `/synthetic/${runId}`],
  ]) assert.throws(() => contract.validateVpsConfig({ ...config(), outputDir, privateDir }));
});

test('VPS scoped command tokenizer preserves single-quoted literal text and escaped apostrophes', () => {
  assert.deepEqual(contract.shellTokens(`one 'two three' 'owner'\\''s' "four five"`), ['one', 'two three', "owner's", 'four five']);
  const text = `Literal $(never-executed) and \`never-executed\` ${runId}`;
  assert.equal(contract.shellTokens(`echo ${quote(text)}`)[1], text);
});

test('VPS scoped command tokenizer rejects executable shell operators and expansions', () => {
  for (const text of [
    'a; b', 'a && b', 'a || b', 'a | b', 'a &', 'a > b', 'a < b', 'a 2>/tmp/x',
    'a $(b)', 'a `b`', 'a "$(b)"', 'a "$HOME"', 'a ${HOME}', 'a\nb',
    'a $HOME', 'a *', 'a ?x', 'a [ab]', 'a {x,y}', 'a ~', 'a # ignored',
    'a \\\nb', "a 'unterminated", 'a "unterminated', 'a \\', "a 'embedded\nline'", 'a\0b',
  ]) assert.throws(() => contract.shellTokens(text), JSON.stringify(text));
});

test('VPS permission accepts only the exact pinned queue communication command', () => {
  assert.equal(contract.permittedVpsCommand(command(), scope()), true);
  const replyScope = scope({ replyTo: reply });
  assert.equal(contract.permittedVpsCommand(command(replyScope), replyScope), true);
  const literal = `Read-only project discussion: '$()' \`literal\` ${runId}`;
  assert.equal(contract.permittedVpsCommand(command(scope(), { message: literal }), scope()), true);
});

test('VPS permission accepts explicitly selected direct mode and exact Codex runtime pins', () => {
  const direct = scope({ queue: false });
  assert.equal(contract.permittedVpsCommand(command(direct), direct), true);
  const c = config();
  const codex = scope({ codexHome: c.local.codexHome, codexSocket: c.local.codexSocket });
  assert.equal(contract.permittedVpsCommand(command(codex), codex), true);
  assert.equal(contract.permittedVpsCommand(command(scope()), codex), false);
  assert.equal(contract.permittedVpsCommand(command(scope({ codexHome: '/synthetic/other-home', codexSocket: c.local.codexSocket })), codex), false);
});

test('VPS permission requires the expected queue mode and global reply identity', () => {
  const question = scope(); const answer = scope({ replyTo: reply });
  for (const [text, s] of [
    [command(scope({ queue: false })), question], [command(), scope({ queue: false })],
    [command(question), answer], [command(answer), question],
    [command(scope({ replyTo: '42' })), scope({ replyTo: '42' })],
    [command(scope({ replyTo: 'q_22222222-2222-4222-8222-222222222222' })), answer],
  ]) assert.equal(contract.permittedVpsCommand(text, s), false);
});

test('VPS permission rejects every changed route, session, executable or runtime path', () => {
  for (const [field, value] of Object.entries({
    room: 'r_44444444-4444-4444-8444-444444444444', from: 'other-agent', to: 'operator',
    expectedSession: 'ses_other', node: '/synthetic/other-node', cli: '/synthetic/other-cli',
    stateDir: '/synthetic/other-state', cacheDir: '/synthetic/other-cache',
    serviceFile: '/synthetic/other-service', path: '/synthetic/other-path',
  })) assert.equal(contract.permittedVpsCommand(command(scope({ [field]: value })), scope()), false, field);
});

test('VPS permission rejects absent/duplicate/unknown flags and arbitrary commands', () => {
  const good = command();
  for (const text of [
    good.replace(`--expected-session ${quote(session)}`, ''),
    good.replace('--message', '--unknown'),
    command(scope(), { flags: ['--queue'] }),
    command(scope(), { flags: ['--room', quote(room)] }),
    command(scope(), { flags: ['--expected-session', quote(session)] }),
    command(scope(), { flags: ['--force'] }), good.replace('collab send', 'node flush'),
    good.replace('collab send', 'bridge start'), `${good} extra`,
    good.replace(`${quote(scope().node)} ${quote(scope().cli)}`, '/bin/sh -c'),
  ]) assert.equal(contract.permittedVpsCommand(text, scope()), false, text);
});

test('VPS permission rejects injected shell execution and unapproved environment', () => {
  for (const text of [
    `${command()}; arbitrary`, `${command()} && arbitrary`, `${command()} | arbitrary`,
    `${command()} > /tmp/synthetic`, command(scope(), { env: ['OPENAI_API_KEY=synthetic'] }),
    command(scope(), { env: ['HOME=/synthetic/other'] }), command(scope(), { env: ['AGENT_DIALOGUE_STATE_DIR=/synthetic/other'] }),
    command().replace(quote(scope().node), '"$(arbitrary)"'),
    command().replace(`AGENT_DIALOGUE_CACHE_DIR=${quote(scope().cacheDir)} `, ''),
    `env ${command()}`, `cd /synthetic && ${command()}`,
  ]) assert.equal(contract.permittedVpsCommand(text, scope()), false);
});

test('VPS permission requires this run marker and a bounded message body', () => {
  for (const message of ['', 'Unrelated test body', `vps-integration-20990101-v10`,
    `${runId}\nsecond line`, `${runId} ${'界'.repeat(1400)}`]) {
    assert.equal(contract.permittedVpsCommand(command(scope(), { message }), scope()), false);
  }
  assert.equal(contract.permittedVpsCommand(command(scope(), { message: `${runId} ${'x'.repeat(3900)}` }), scope()), true);
});

test('VPS free-model guard requires enabled and zero prices for all advertised tiers', () => {
  const tier = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  assert.equal(contract.hasZeroCostModel({ enabled: true, cost: [tier, clone(tier)] }), true);
  for (const model of [null, {}, { enabled: false, cost: [tier] }, { enabled: true, cost: [] },
    { enabled: true, cost: {} }, { enabled: true }, { enabled: true, cost: [tier, {}] }]) {
    assert.equal(contract.hasZeroCostModel(model), false);
  }
  for (const path of [['input'], ['output'], ['cache', 'read'], ['cache', 'write']]) {
    for (const value of [undefined, null, '0', -1, 0.001, Infinity, NaN]) {
      const bad = clone(tier); const target = path.length === 1 ? bad : bad.cache;
      if (value === undefined) delete target[path.at(-1)]; else target[path.at(-1)] = value;
      assert.equal(contract.hasZeroCostModel({ enabled: true, cost: [tier, bad] }), false);
    }
  }
});

test('VPS harness environment is rebuilt from an explicit normal-variable allowlist', () => {
  const c = config(); const base = {
    HOME: '/synthetic/home', USER: 'synthetic', LOGNAME: 'synthetic', LANG: 'C.UTF-8',
    TMPDIR: '/synthetic/tmp', SSH_AUTH_SOCK: '/synthetic/agent.sock', PATH: '/wrong/path',
    AGENT_DIALOGUE_STATE_DIR: '/wrong/state', HCOM_PASSWORD: 'synthetic-secret',
    CODEX_HOME: '/wrong/codex', CODEX_TOKEN: 'synthetic-secret', CLAUDE_API_KEY: 'synthetic-secret',
    OPENAI_API_KEY: 'synthetic-secret', ANTHROPIC_API_KEY: 'synthetic-secret',
    RANDOM_SECRET: 'synthetic-secret', NODE_OPTIONS: '--require /synthetic/untrusted',
    BASH_ENV: '/synthetic/untrusted', LD_PRELOAD: '/synthetic/untrusted',
  };
  const original = clone(base); const result = contract.buildHarnessEnv(c.local, base);
  assert.deepEqual(base, original);
  assert.equal(result.HOME, base.HOME); assert.equal(result.SSH_AUTH_SOCK, base.SSH_AUTH_SOCK);
  assert.equal(result.PATH, c.local.path); assert.equal(result.CODEX_HOME, c.local.codexHome);
  assert.equal(result.AGENT_DIALOGUE_CODEX_SOCKET, c.local.codexSocket);
  assert.equal(result.AGENT_DIALOGUE_STATE_DIR, c.local.stateDir);
  assert.equal(result.AGENT_DIALOGUE_CACHE_DIR, c.local.cacheDir);
  for (const key of ['HCOM_PASSWORD', 'CODEX_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'RANDOM_SECRET', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD']) assert.equal(Object.hasOwn(result, key), false, key);
});

test('VPS controller spreads the native process environment before validating its normal allowlist', () => {
  // process.env has a special prototype; never print or compare its private values.
  const result = contract.buildHarnessEnv(config().local, { ...process.env });
  assert.equal(result.AGENT_DIALOGUE_STATE_DIR, config().local.stateDir);
  assert.equal(result.CODEX_HOME, config().local.codexHome);
  for (const key of Object.keys(result)) {
    assert.ok(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
      'SSH_AUTH_SOCK', 'PATH', 'AGENT_DIALOGUE_STATE_DIR', 'AGENT_DIALOGUE_CACHE_DIR', 'CODEX_HOME',
      'AGENT_DIALOGUE_CODEX_SOCKET'].includes(key), 'No inherited credential or control variable');
  }
});

test('VPS remote invocation uses fixed verifying SSH argv and JSON stdin', () => {
  const c = config(); const result = contract.buildRemoteInvocation(c, 'probe');
  assert.equal(result.executable, 'ssh');
  assert.deepEqual(result.args, [
    '-F', c.remote.sshConfig, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=5', '--', c.remote.sshDestination,
    `${quote(c.remote.executable)} ${quote(c.remote.helper)}`,
  ]);
  const request = JSON.parse(result.input);
  assert.equal(request.version, 1); assert.equal(request.runId, runId); assert.equal(request.operation, 'probe');
  assert.deepEqual(request.config, Object.fromEntries(['executable', 'cli', 'stateDir', 'cacheDir', 'serviceFile', 'workspace', 'path', 'peerSshDestination'].map(key => [key, c.remote[key]])));
  assert.ok(result.input.endsWith('\n'));
  assert.equal(result.args.some(arg => arg.includes('synthetic-free-model')), false);
  assert.equal(result.input.includes(c.remote.sshConfig), false);
});

test('VPS remote invocation rejects unknown operations and request-envelope overrides', () => {
  for (const operation of ['shell', 'exec', 'arbitrary', '', 'probe; arbitrary']) {
    assert.throws(() => contract.buildRemoteInvocation(config(), operation));
  }
  for (const payload of [{ version: 2 }, { runId: 'other' }, { config: {} }, { operation: 'shell' }, null, [],
    { text: 'x'.repeat(4 * 1024 * 1024) }]) {
    assert.throws(() => contract.buildRemoteInvocation(config(), 'probe', payload));
  }
});

test('VPS run directories are freshly claimed without overwriting an existing result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = { ...config(), outputDir: join(root, 'public', runId), privateDir: join(root, 'private', runId) };
  await contract.claimRunDirectories(c);
  assert.equal((await stat(c.outputDir)).isDirectory(), true);
  assert.equal((await stat(c.privateDir)).isDirectory(), true);
  assert.equal((await stat(c.privateDir)).mode & 0o777, 0o700);
  await writeFile(join(c.outputDir, 'preserved.txt'), 'synthetic prior result');
  await assert.rejects(contract.claimRunDirectories(c));
  assert.equal(await readFile(join(c.outputDir, 'preserved.txt'), 'utf8'), 'synthetic prior result');
});

test('VPS run directory claim rejects existing empty paths, symlinks and public-private nesting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['output', 'private', 'symlink']) {
    const parent = join(root, kind); await mkdir(parent);
    const c = { ...config(), outputDir: join(parent, 'public', runId), privateDir: join(parent, 'private', runId) };
    if (kind === 'symlink') {
      await mkdir(join(parent, 'public')); const target = join(parent, 'target'); await mkdir(target);
      await symlink(target, c.outputDir);
    } else await mkdir(kind === 'output' ? c.outputDir : c.privateDir, { recursive: true });
    await assert.rejects(contract.claimRunDirectories(c), kind);
  }
  const c = { ...config(), outputDir: join(root, runId), privateDir: join(root, runId, 'private', runId) };
  await assert.rejects(contract.claimRunDirectories(c));
});

test('VPS failed private directory claim removes only a newly created empty public directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = { ...config(), outputDir: join(root, 'public', runId), privateDir: join(root, 'private', runId) };
  await mkdir(c.privateDir, { recursive: true });
  const existing = join(c.privateDir, 'preserved.txt'); await writeFile(existing, 'synthetic owned prior result');
  await assert.rejects(contract.claimRunDirectories(c));
  await assert.rejects(stat(c.outputDir), { code: 'ENOENT' });
  assert.equal(await readFile(existing, 'utf8'), 'synthetic owned prior result');
});

test('VPS effective public-private nesting through an ancestor symlink is rejected before creating run roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-vps-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const direction of ['private-in-public', 'public-in-private']) {
    const parent = join(root, direction); const actualParent = join(parent, 'actual');
    await mkdir(actualParent, { recursive: true });
    const alias = join(parent, 'alias'); await symlink(actualParent, alias);
    const outer = join(actualParent, runId), inner = join(alias, runId, 'nested', runId);
    const c = { ...config(),
      outputDir: direction === 'private-in-public' ? outer : inner,
      privateDir: direction === 'private-in-public' ? inner : outer,
    };
    await assert.rejects(contract.claimRunDirectories(c), direction);
    await assert.rejects(stat(outer), { code: 'ENOENT' }, `${direction}: rejected configuration must not create a run root`);
  }
});
