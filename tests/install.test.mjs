import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installHcom, selectRelease, validateArchiveListing } from '../lib/install.mjs';

const committedLock = JSON.parse(await readFile(new URL('../config/hcom.lock.json', import.meta.url), 'utf8'));
const platformKey = 'linux-x64';
const script = version => `#!/bin/sh\nprintf '%s\\n' 'hcom ${version}'\n`;
const digest = data => createHash('sha256').update(data).digest('hex');
const lockFor = data => ({ version: '0.7.30', assets: { [platformKey]: { asset_url: committedLock.assets[platformKey].asset_url, sha256: digest(data) } } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-dialogue-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = join(root, 'runtime');
  return { root, context: { runtimeDir, binary: join(runtimeDir, 'bin', 'hcom'), stateDir: join(root, 'state'), env: process.env } };
}
async function archive(root, version = '0.7.30') {
  const input = join(root, 'input'), packageDir = join(input, 'hcom-test');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'hcom'), script(version), { mode: 0o755 });
  const path = join(root, 'fixture.tar.gz');
  const result = spawnSync('tar', ['-czf', path, '-C', input, 'hcom-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return await readFile(path);
}
async function managedBinary(context, version = '0.7.30') {
  const target = join(context.runtimeDir, 'hcom-0.7.30', 'hcom');
  await mkdir(join(context.runtimeDir, 'bin'), { recursive: true });
  await mkdir(join(context.runtimeDir, 'hcom-0.7.30'));
  await writeFile(target, script(version), { mode: 0o755 });
  await symlink('../hcom-0.7.30/hcom', context.binary);
}
const missing = async path => await lstat(path).then(() => false, error => error.code === 'ENOENT');

test('reviewed release selection pins the four exact official platform assets', () => {
  assert.equal(selectRelease(committedLock, 'darwin-arm64').sha256, '53d1354be8c2c1f3ec9b66a730bef2765f4d03a185c2e3a2bdff1e858d224d2a');
  assert.match(selectRelease(committedLock, 'darwin-x64').asset_url, /hcom-x86_64-apple-darwin\.tar\.gz$/);
  assert.equal(selectRelease(committedLock, 'linux-arm64').sha256, '07e00790934874dd912fc3aebc34f7bb89f6835b74b5c682640c6e54cf22c45e');
  assert.match(selectRelease(committedLock, 'linux-arm64').asset_url, /hcom-aarch64-unknown-linux-gnu\.tar\.gz$/);
  assert.equal(selectRelease(committedLock, 'linux-x64').sha256, '437564d05c28d6b92f31725e4721f76cad149ca79b02b71fb58568270df0c818');
  assert.match(selectRelease(committedLock, 'linux-x64').asset_url, /hcom-x86_64-unknown-linux-gnu\.tar\.gz$/);
});

test('unsupported platforms and malformed locks fail without ABI guessing', () => {
  assert.throws(() => selectRelease(committedLock, 'win32-x64'), /Use WSL/);
  assert.throws(() => selectRelease(committedLock, 'linux-riscv64'), /No reviewed hcom release/);
  assert.throws(() => selectRelease({ ...committedLock, assets: { [platformKey]: { asset_url: 'http://example.org/a.tar.gz', sha256: 'a'.repeat(64) } } }, platformKey), /Invalid release lock/);
});

test('archive listing accepts regular files and rejects traversal, links and mismatched listings', () => {
  validateArchiveListing('pkg/\npkg/hcom\n', 'drwxr-xr-x pkg/\n-rwxr-xr-x pkg/hcom\n');
  for (const path of ['../hcom', '/tmp/hcom', 'C:/hcom', 'pkg/../hcom', 'pkg\\hcom', 'pkg/\u0000hcom']) {
    assert.throws(() => validateArchiveListing(`${path}\n`, `-rwxr-xr-x ${path}\n`), /Unsafe archive entry/);
  }
  assert.throws(() => validateArchiveListing('hcom\n', 'lrwxr-xr-x hcom -> /tmp/hcom\n'), /links or unsupported/);
  assert.throws(() => validateArchiveListing('hcom\n', '-rwxr-xr-x hcom\n-rwxr-xr-x other\n'), /links or unsupported/);
  assert.throws(() => validateArchiveListing('', ''), /empty/);
});

test('setup refuses to overwrite an explicit external executable', async t => {
  const { root, context } = await fixture(t);
  await assert.rejects(installHcom({ ...context, binary: join(root, 'external-hcom') }), /Unset the override/);
  assert.equal(await missing(context.runtimeDir), true);
});

test('checksum mismatch leaves no executable, extracted release, staging or install lock', async t => {
  const { context } = await fixture(t);
  let ran = false;
  await assert.rejects(installHcom(context, { platformKey, fetchImpl: async () => new Response('wrong bytes'), runImpl: async () => { ran = true; } }), /SHA-256 mismatch/);
  assert.equal(ran, false);
  assert.equal(await missing(context.binary), true);
  assert.deepEqual(await readdir(context.runtimeDir), ['bin']);
});

test('offline installation verifies an archive and second setup is idempotent without a download', async t => {
  const { root, context } = await fixture(t), data = await archive(root);
  let downloads = 0;
  const options = { platformKey, lock: lockFor(data), fetchImpl: async () => { downloads++; return new Response(data); } };
  assert.equal(await installHcom(context, options), 0);
  assert.equal((await lstat(context.binary)).isSymbolicLink(), true);
  assert.equal(await realpath(context.binary), await realpath(join(context.runtimeDir, 'hcom-0.7.30', 'hcom-test', 'hcom')));
  assert.equal(await installHcom(context, options), 0);
  assert.equal(downloads, 1);
  assert.deepEqual((await readdir(context.runtimeDir)).sort(), ['bin', 'hcom-0.7.30']);
});

test('a valid checksum with the wrong binary version cannot install', async t => {
  const { root, context } = await fixture(t), data = await archive(root, '0.7.300');
  await assert.rejects(installHcom(context, { platformKey, lock: lockFor(data), fetchImpl: async () => new Response(data) }), /version does not match/);
  assert.deepEqual(await readdir(context.runtimeDir), ['bin']);
});

test('idempotency requires the exact version, not a matching prefix', async t => {
  const { context } = await fixture(t);
  await managedBinary(context, '0.7.300');
  await assert.rejects(installHcom(context, { platformKey, fetchImpl: async () => assert.fail('must not download') }), /does not match pinned version/);
  assert.equal((await lstat(context.binary)).isSymbolicLink(), true);
});

test('existing unmanaged file and escaping symlink remain untouched', async t => {
  const { root, context } = await fixture(t);
  await mkdir(join(context.runtimeDir, 'bin'), { recursive: true });
  await writeFile(context.binary, 'existing');
  await assert.rejects(installHcom(context, { platformKey }), /not a managed runtime/);
  assert.equal(await readFile(context.binary, 'utf8'), 'existing');
  await rm(context.binary);
  const external = join(root, 'external');
  await writeFile(external, 'external');
  await symlink(external, context.binary);
  await assert.rejects(installHcom(context, { platformKey }), /not a managed runtime/);
  assert.equal(await readFile(external, 'utf8'), 'external');
});

test('bin directory symlink cannot redirect installation writes', async t => {
  const { root, context } = await fixture(t), external = join(root, 'external');
  await mkdir(context.runtimeDir);
  await mkdir(external);
  await symlink(external, join(context.runtimeDir, 'bin'));
  await assert.rejects(installHcom(context, { platformKey }), /bin directory must not be a symlink/);
  assert.deepEqual(await readdir(external), []);
});

test('a second concurrent installer fails closed and cannot remove the first owner lock', async t => {
  const { root, context } = await fixture(t), data = await archive(root);
  let signalStarted, releaseFetch;
  const started = new Promise(done => { signalStarted = done; }), gate = new Promise(done => { releaseFetch = done; });
  const first = installHcom(context, { platformKey, lock: lockFor(data), fetchImpl: async () => { signalStarted(); await gate; return new Response(data); } });
  await started;
  const ownerPath = join(context.runtimeDir, '.install.lock', 'owner.json'), owner = await readFile(ownerPath, 'utf8');
  await assert.rejects(installHcom(context, { platformKey }), /Another installer owns/);
  assert.equal(await readFile(ownerPath, 'utf8'), owner);
  releaseFetch();
  assert.equal(await first, 0);
  assert.equal(await missing(join(context.runtimeDir, '.install.lock')), true);
});

test('cleanup preserves an install lock whose ownership changed', async t => {
  const { context } = await fixture(t), ownerPath = join(context.runtimeDir, '.install.lock', 'owner.json');
  await assert.rejects(installHcom(context, { platformKey, fetchImpl: async () => {
    await writeFile(ownerPath, JSON.stringify({ owner: 'replacement-owner' }));
    return new Response('wrong bytes');
  } }), /SHA-256 mismatch/);
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).owner, 'replacement-owner');
});

test('an unsafe archive is rejected before extraction even when its digest matches', async t => {
  const { context } = await fixture(t), data = Buffer.from('mock archive');
  let extracted = false;
  await assert.rejects(installHcom(context, { platformKey, lock: lockFor(data), fetchImpl: async () => new Response(data), runImpl: async (exe, args) => {
    assert.equal(exe, 'tar');
    if (args[0] === '-tzf') return { code: 0, stdout: 'hcom\n', stderr: '' };
    if (args[0] === '-tvzf') return { code: 0, stdout: 'lrwxr-xr-x hcom -> /tmp/hcom\n', stderr: '' };
    extracted = true;
    return { code: 0, stdout: '', stderr: '' };
  } }), /links or unsupported/);
  assert.equal(extracted, false);
  assert.deepEqual(await readdir(context.runtimeDir), ['bin']);
});
