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
  const prefix = join(temp, 'prefix'), cwd = join(temp, 'unrelated cwd'), state = join(temp, 'state'), cache = join(temp, 'cache');
  await mkdir(cwd); await mkdir(state);
  await call('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)]);
  const command = join(prefix, 'bin', 'agent-dialogue');
  const fake = join(temp, 'hcom');
  await writeFile(fake, `#!/usr/bin/env node\nif(process.argv[2]==='--version') console.log('hcom 0.7.30'); else if(process.argv[2]==='list') console.log('[]'); else throw Error('Unexpected command');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(prefix, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, AGENT_DIALOGUE_STATE_DIR: state, AGENT_DIALOGUE_CACHE_DIR: cache, AGENT_DIALOGUE_HCOM: fake };
  const pkg = join(prefix, 'lib/node_modules/@idle-cloud/agent-dialogue');
  const before = await readdir(pkg);
  assert.match(await call(command, ['--help'], { cwd, env }), /attach opencode/);
  assert.deepEqual(JSON.parse(await call(command, ['bindings'], { cwd, env })), { bindings: [], rooms: [] });
  const doctor = JSON.parse(await call(command, ['doctor', '--json'], { cwd, env }));
  assert.equal(doctor.stateDir, state); assert.equal(doctor.cacheDir, cache); assert.equal(doctor.hcom.version, 'hcom 0.7.30');
  assert.deepEqual(await readdir(pkg), before, 'Running installed CLI must not create state/cache inside package');
  const installed = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.2.0');
  console.log(JSON.stringify({ status: 'passed', name: installed.name, version: installed.version, packedFiles: paths.length, packedBytes: packed.size, checks: ['package allowlist', 'isolated prefix install', 'global executable', 'arbitrary working directory', 'external state/cache', 'no package mutation'] }, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
