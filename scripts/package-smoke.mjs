#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'agent-dialogue-package-'));
async function call(command, args, options = {}) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, shell: false, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolveResult({ code, out, err }); });
  });
  assert.equal(result.code, 0, `${command} ${args.join(' ')}\n${result.err}`); return result.out;
}
try {
  const packed = JSON.parse(await call('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp]))[0];
  const paths = packed.files.map(x => x.path);
  for (const path of paths) assert.ok(!/(^|\/)(\.state|\.runtime|research|verification|node_modules|tests)(\/|$)/.test(path), path);
  assert.ok(paths.includes('bin/agent-dialogue.mjs')); assert.ok(paths.includes('config/hcom.lock.json'));
  assert.ok(paths.includes('lib/paths.mjs')); assert.ok(!paths.includes('docs/NEXT_STEPS.source.md'));
  for (const path of ['lib/adapters.mjs', 'lib/embedded-ledger.mjs', 'lib/opencode-v1.mjs', 'lib/platform.mjs', 'lib/private-files.mjs', 'lib/windows-worker.mjs', 'docs/WINDOWS.md', 'lib/codex.mjs', 'lib/nodes.mjs', 'lib/node-identity.mjs', 'lib/node-transport.mjs', 'lib/submissions.mjs', 'docs/NODES.md', 'lib/viewer/server.mjs', 'lib/viewer/readers/local.mjs', 'lib/viewer/readers/ssh.mjs', 'lib/viewer/observation.mjs', 'lib/viewer/export-cli.mjs', 'lib/viewer/config.mjs', 'lib/agent-guide.mjs', 'web/viewer/index.html', 'web/viewer/app.js', 'web/viewer/style.css', 'docs/VIEWER.md', 'docs/USAGE.md', 'docs/AGENT-GUIDE.md', 'config/AGENTS.snippet.md']) assert.ok(paths.includes(path), path);
  const prefix = join(temp, 'prefix'), cwd = join(temp, 'unrelated cwd'), state = join(temp, 'state'), cache = join(temp, 'cache');
  await mkdir(cwd); await mkdir(state);
  await call('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)]);
  const command = join(prefix, 'bin', 'agent-dialogue');
  const fake = join(temp, 'hcom');
  await writeFile(fake, `#!/usr/bin/env node\nif(process.argv[2]==='--version') console.log('hcom 0.7.30'); else if(process.argv[2]==='list') console.log('[]'); else throw Error('Unexpected command');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(prefix, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, AGENT_DIALOGUE_STATE_DIR: state, AGENT_DIALOGUE_CACHE_DIR: cache, AGENT_DIALOGUE_HCOM: fake };
  const pkg = join(prefix, 'lib/node_modules/@idle-cloud/agent-dialogue');
  const before = await readdir(pkg);
  assert.match(await call(command, ['--help'], { cwd, env }), /attach <opencode\|opencode-v1\|codex>/);
  assert.match(await call(command, ['agent-guide'], { cwd, env: { ...env, AGENT_DIALOGUE_STATE_DIR: '' } }), /Establish your identity once/);
  assert.deepEqual(JSON.parse(await call(command, ['bindings'], { cwd, env })), { bindings: [], rooms: [] });
  const node = JSON.parse(await call(command, ['node', 'init', '--name', 'package-test'], { cwd, env }));
  const exported = JSON.parse(await call(command, ['node', 'export'], { cwd, env }));
  assert.equal(node.nodeId, exported.payload.node.nodeId); assert.ok(exported.signature);
  assert.equal(JSON.stringify(exported).includes('privateKey'), false);
  const doctor = JSON.parse(await call(command, ['doctor', '--json'], { cwd, env }));
  assert.equal(doctor.stateDir, state); assert.equal(doctor.cacheDir, cache); assert.equal(doctor.hcom.version, 'hcom 0.7.30');
  const sourceBefore = await readdir(state);
  const viewerConfig = join(temp, 'observer.json');
  await writeFile(viewerConfig, JSON.stringify({ version: 1, sources: [{ kind: 'local', label: 'Installed package', path: './state' }] }));
  const viewer = spawn(command, ['view', '--config', viewerConfig], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let viewerClosed = false;
  const viewerClose = new Promise(resolveClosed => viewer.once('close', () => { viewerClosed = true; resolveClosed(); }));
  try {
    const url = await new Promise((resolveURL, rejectURL) => {
      let output = '';
      const timeout = setTimeout(() => rejectURL(new Error('Installed viewer did not become ready.')), 10000);
      viewer.once('error', error => { clearTimeout(timeout); rejectURL(error); });
      viewer.once('exit', code => { clearTimeout(timeout); rejectURL(new Error(`Installed viewer exited before readiness: ${code}`)); });
      viewer.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timeout); resolveURL(match[0]); }
      });
      viewer.stderr.resume();
    });
    const bootstrap = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0], origin = new URL(url).origin;
    for (const path of ['/', '/app.js', '/style.css', '/api/snapshot']) {
      const response = await fetch(`${origin}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, path);
      if (path === '/api/snapshot') {
        const snapshot = await response.json();
        assert.equal(snapshot.sources.length, 1);
        assert.equal(snapshot.sources[0].available, false, 'Opening a viewer must not initialize a missing ledger');
      } else assert.ok((await response.text()).length > 100, path);
    }
    assert.deepEqual(await readdir(state), sourceBefore);
  } finally {
    if (!viewerClosed) {
      if (viewer.exitCode === null && viewer.signalCode === null) viewer.kill('SIGTERM');
      await new Promise(resolveStopped => {
        const timeout = setTimeout(() => { viewer.kill('SIGKILL'); resolveStopped(); }, 3000);
        viewerClose.then(() => { clearTimeout(timeout); resolveStopped(); });
      });
    }
  }
  assert.deepEqual(await readdir(pkg), before, 'Running installed CLI must not create state/cache inside package');
  const installed = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  assert.equal(installed.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  console.log(JSON.stringify({ status: 'passed', name: installed.name, version: installed.version, packedFiles: paths.length, packedBytes: packed.size, checks: ['package allowlist including SSH reader/export entry and onboarding guides', 'isolated prefix install', 'global executable', 'agent guide before setup', 'arbitrary working directory', 'external state/cache', 'signed public node export', 'installed viewer assets/API with config-relative source', 'viewer leaves missing ledger absent', 'no package mutation'] }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
