import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TESTS = [
  'tests/viewer-observation.test.mjs',
  'tests/viewer-ssh.test.mjs',
  'tests/viewer-remote-cli.test.mjs',
  'tests/viewer-ssh-integration.test.mjs',
];
const IMPLEMENTATION = [
  'bin/agent-dialogue.mjs',
  'lib/node-identity.mjs',
  'lib/viewer/config.mjs',
  'lib/viewer/export-cli.mjs',
  'lib/viewer/observation.mjs',
  'lib/viewer/cli.mjs',
  'lib/viewer/stream.mjs',
  'lib/viewer/server.mjs',
  'lib/viewer/projection.mjs',
  'lib/viewer/readers/local.mjs',
  'lib/viewer/readers/ssh.mjs',
  'tests/fixtures/viewer-fixture.mjs',
  'tests/fixtures/viewer-observation-fixture.mjs',
  ...TESTS,
  'scripts/ssh-observer-verify.mjs',
];

async function unused(directory) {
  try { await stat(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('A verification run with that ID already exists. Choose a new version.');
}

async function sourceIdentity() {
  const hash = createHash('sha256'), files = {};
  for (const file of [...IMPLEMENTATION].sort()) {
    const bytes = await readFile(join(PROJECT, file));
    files[file] = createHash('sha256').update(bytes).digest('hex');
    hash.update(file).update('\0').update(bytes).update('\0');
  }
  return { implementationSha256: hash.digest('hex'), files };
}

function testCounts(tap) {
  const output = {};
  for (const name of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    output[name] = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  const timing = [...tap.matchAll(/^# duration_ms (\d+(?:\.\d+)?)\s*$/gm)];
  output.reportedDurationMs = timing.length ? Number(timing.at(-1)[1]) : null;
  return output;
}

async function execute(log) {
  const descriptor = openSync(log, 'wx', 0o600);
  const started = performance.now();
  return await new Promise(done => {
    let child, tail = '', bytes = 0, timedOut = false, outputLimitExceeded = false, startFailed = false, settled = false, killTimer;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); closeSync(descriptor);
      done({ exitCode, signal: signal || null, timedOut, outputLimitExceeded, startFailed, elapsedMs: +(performance.now() - started).toFixed(2), counts: testCounts(tail) });
    };
    const stop = () => {
      child?.kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => child?.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000);
    try {
      child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...TESTS], { cwd: PROJECT, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      startFailed = true; finish(null, null); return;
    }
    const consume = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { outputLimitExceeded = true; stop(); return; }
      // Raw test output is retained only in the ignored, private 0600 log.
      writeSync(descriptor, chunk);
      if (stdout) tail = (tail + chunk.toString('utf8')).slice(-1024 * 1024);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.once('error', () => { startFailed = true; finish(null, null); });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

async function main() {
  if (process.argv.length > 3) throw new Error('Use one fresh ssh-observer-YYYYMMDD-vN run ID.');
  const run = process.argv[2] || `ssh-observer-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-v1`;
  if (!/^ssh-observer-[0-9]{8}-v[1-9][0-9]*(?![\s\S])/.test(run)) throw new Error('Use a fresh ssh-observer-YYYYMMDD-vN run ID.');
  const output = join(PROJECT, 'verification', run), privateRoot = join(PROJECT, '.state', run);
  await unused(output); await unused(privateRoot);
  const identity = await sourceIdentity();
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' });
  if (revision.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(revision.stdout)) throw new Error('Cannot record the current source revision.');
  await mkdir(dirname(output), { recursive: true }); await mkdir(dirname(privateRoot), { recursive: true });
  await mkdir(output); await mkdir(privateRoot, { mode: 0o700 });
  const config = {
    version: 1, scenario: 'local-fake-ssh-readonly-observer', recordedAt: new Date().toISOString(),
    baseCommit: revision.stdout.trim(), implementationSha256: identity.implementationSha256,
    implementationFiles: identity.files, command: ['node', '--test', '--test-reporter=tap', ...TESTS],
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    fakeSSH: true, actualSshConnections: 0, modelCalls: 0, realModelTraffic: false,
    connectionCountBasis: 'The fixed test suite uses injected runners or PATH-local fake SSH executables; no actual SSH server is contacted. This is a fixture property, not a network-monitor measurement.',
    scope: 'Synthetic sealed room snapshots, local SQLite WAL writers, fixed remote export CLI executed locally, and loopback viewer HTTP only.',
    coverage: [
      'exact node and immutable room manifest scope with remote/client validation',
      'minimal metadata and secret-field exclusion, including malicious responses',
      'fixed SSH quoting, known-host verification, stdin request and bounded output',
      '12-second child deadline, abort, throttle and independent local progress',
      'actual export CLI with active WAL and before/after DB/WAL/SHM/control-file hashes',
      'queued request folding, signed wire copy deduplication, exact sessions and linked replies',
      'disconnect stale retention, fresh-nonce recovery and late receipt updates',
      'source replacement, event deletion/rewrite reset and observer shutdown',
    ],
    rawOutputPolicy: 'Only sanitized counts and timing are published. Raw test output is written to an ignored private 0600 log.',
  };
  await writeFile(join(output, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  const result = await execute(join(privateRoot, 'test-output.log'));
  const finalIdentity = await sourceIdentity().catch(() => null);
  const sourceStableDuringRun = finalIdentity?.implementationSha256 === identity.implementationSha256;
  const counts = result.counts;
  const completed = sourceStableDuringRun && result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && !result.startFailed &&
    Number.isSafeInteger(counts.tests) && counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  const metrics = {
    version: 1, scenario: config.scenario, recordedAt: new Date().toISOString(), baseCommit: config.baseCommit,
    implementationSha256: config.implementationSha256, fakeSSH: true, actualSshConnections: 0, modelCalls: 0, realModelTraffic: false,
    sourceStableDuringRun, finalImplementationSha256: finalIdentity?.implementationSha256 || null,
    completed, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded, startFailed: result.startFailed,
    elapsedMs: result.elapsedMs, tests: counts.tests, suites: counts.suites, passed: counts.pass, failed: counts.fail,
    cancelled: counts.cancelled, skipped: counts.skipped, todo: counts.todo, reportedDurationMs: counts.reportedDurationMs,
    validationKind: 'Local protocol and fake SSH integration verification; actual second-machine SSH and multi-machine communication remain separately unverified.',
  };
  await writeFile(join(output, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output: relative(PROJECT, output), completed, passed: metrics.passed, failed: metrics.failed, elapsedMs: metrics.elapsedMs, fakeSSH: true, actualSshConnections: 0, modelCalls: 0 }));
  if (!completed) process.exitCode = 1;
}

main().catch(error => {
  // The only surfaced errors are fixed script diagnostics; filesystem paths and subprocess output stay private.
  const safe = error?.message?.startsWith('Use ') || error?.message?.startsWith('A verification run ') || error?.message === 'Cannot record the current source revision.';
  console.error(safe ? error.message : 'Observer verification could not run. Check the source files and use a fresh run ID.');
  process.exitCode = 1;
});
