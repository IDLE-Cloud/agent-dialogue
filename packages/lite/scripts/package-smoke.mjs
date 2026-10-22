import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(join(tmpdir(), 'adl package with spaces-'));
async function npmEntrypoint() {
  const dirs = [dirname(process.execPath), ...(process.env.PATH || '').split(delimiter)];
  const candidates = [process.env.npm_execpath, ...dirs.flatMap(path => [join(path, 'node_modules/npm/bin/npm-cli.js'),
    resolve(path, '../lib/node_modules/npm/bin/npm-cli.js'), join(path, 'npm')])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const path = await realpath(candidate); if (path.endsWith('npm-cli.js')) { await access(path); return path; } }
    catch { /* Try the next installed npm path. */ }
  }
  throw new Error('Cannot locate npm-cli.js; run this check using npm run test:package.');
}
const npmCli = await npmEntrypoint();
async function call(command, args, cwd = root) {
  if (command === 'npm') { command = process.execPath; args = [npmCli, ...args]; }
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}
try {
  const pack = JSON.parse(await call('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir]))[0];
  for (const { path } of pack.files) assert.ok(!/(^|\/)(tests|scripts|node_modules|\.state|verification)(\/|$)/.test(path), path);
  const install = join(dir, 'install'); await mkdir(install);
  // Install one local tarball; the package has zero dependencies and no lifecycle scripts.
  await call('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', join(dir, pack.filename)]);
  const pkg = join(install, 'node_modules', '@idle-cloud', 'agent-dialogue-lite');
  assert.match(await call(process.execPath, [join(pkg, 'bin', 'adl.mjs'), '--help'], dir), /Native push wakes/);
  const { startHub } = await import(pathToFileURL(join(pkg, 'lib', 'hub.mjs')));
  const { HubClient } = await import(pathToFileURL(join(pkg, 'lib', 'client.mjs')));
  const hub = await startHub({ dbPath: join(dir, 'smoke.sqlite'), adminToken: 'smoke-operator-token-0123456789012345' });
  try {
    const client = new HubClient({ url: hub.url, token: 'smoke-operator-token-0123456789012345' });
    const room = await client.request('POST', '/v1/rooms', { label: 'Installed package' });
    assert.ok(room.id);
    for (const path of ['/', '/app.js', '/style.css']) assert.equal((await fetch(hub.url + path)).status, 200);
  } finally { await hub.close(); }
  console.log(JSON.stringify({ status: 'passed', package: pack.name, version: pack.version, files: pack.files.length, packedBytes: pack.size,
    checks: ['isolated tarball install', 'CLI outside source tree', 'installed SQLite Hub/API', 'packaged viewer assets', 'no runtime dependencies'] }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
