import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectInstallation, assertInstallationsUnchanged, captureMigrationInstallations, assertMigrationInstallationsUnchanged, validateMigrationInstallations, migrationSourceCompatibility } from '../lib/migration-installation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { timeout: process.platform === 'win32' ? 60000 : 15000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-installation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'candidate prefix'), old = join(root, 'old prefix'), node = join(root, 'selected node artifact');
  const metadata = { name: '@idle-cloud/agent-dialogue', version: '0.3.0', type: 'module', bin: { 'agent-dialogue': 'bin/agent-dialogue.mjs' } };
  for (const name of ['bin', 'lib', 'config', 'web/viewer']) await mkdir(join(current, name), { recursive: true });
  await writeFile(join(current, 'package.json'), JSON.stringify(metadata) + '\n');
  await writeFile(join(current, 'bin/agent-dialogue.mjs'), 'throw new Error("must never execute selected package");\n', { mode: 0o755 });
  await writeFile(join(current, 'bin/bridge-worker.mjs'), 'throw new Error("must never start worker");\n', { mode: 0o755 });
  await writeFile(join(current, 'lib/example.mjs'), 'export const fixture = true;\n');
  await writeFile(join(current, 'config/hcom.lock.json'), JSON.stringify({ version: '0.7.30', assets: { [`${process.platform}-${process.arch}`]: { sha256: 'a'.repeat(64) } } }));
  await writeFile(join(current, 'web/viewer/index.html'), '<!doctype html><title>fixture</title>\n');
  await cp(current, old, { recursive: true });
  await writeFile(node, 'unexecutable synthetic Node artifact; do not run\n', { mode: 0o755 });
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded' };
  await mkdir(context.stateDir, { mode: 0o700 });
  const options = { fromPackage: old, fromNode: node }, dependencies = { sources: { packageRoot: current, nodePath: node } };
  const capture = () => captureMigrationInstallations(context, options, dependencies);
  return { root, current, old, node, context, options, dependencies, capture };
}

test('installation captures bounded runtime content, exact identities and artifact-only Node without executing anything', budget, async t => {
  const f = await fixture(t), descriptor = await inspectInstallation({ packageRoot: f.old, nodePath: f.node });
  assert.equal(descriptor.version, 1); assert.equal(descriptor.runtimeFiles, 6); assert.equal(descriptor.packageVersion, '0.3.0');
  assert.equal(descriptor.runtimeSha256, hash(JSON.stringify(descriptor.runtimeManifest))); assert.equal(descriptor.nodeSha256, hash(await readFile(f.node)));
  assert.deepEqual(descriptor.nodeVersionEvidence, { kind: 'artifact-only', version: null });
  assert.equal(descriptor.cliPath, join(descriptor.packageRoot, 'bin/agent-dialogue.mjs')); assert.equal(descriptor.workerPath, join(descriptor.packageRoot, 'bin/bridge-worker.mjs'));
  assert.equal(typeof descriptor.rootIdentity.ino, 'string'); assert.equal(typeof descriptor.identities.files['lib/example.mjs'].mtimeNs, 'string');
  assert.deepEqual(descriptor.runtimeManifest.map(row => Object.keys(row)), Array.from({ length: 6 }, () => ['path', 'sha256']));
  assert.deepEqual(descriptor.runtimeManifest.map(row => row.path), descriptor.runtimeManifest.map(row => row.path).sort());
  assert.equal(await assertInstallationsUnchanged([descriptor]), true);
});

test('copied candidate source is compatible while state/cache remain external and missing cache is not created', budget, async t => {
  const f = await fixture(t), before = await lstat(f.context.stateDir, { bigint: true }), snapshot = await f.capture();
  assert.equal(snapshot.from.runtimeSha256, snapshot.to.runtimeSha256); assert.equal(snapshot.from.nodePath, snapshot.to.nodePath);
  assert.deepEqual(snapshot.compatibility, { source: 'current-source', sourceSchemas: [1, 2, 3, 4], targetSchema: 4 });
  assert.equal(snapshot.namespace.backend, 'embedded'); assert.equal(snapshot.namespace.dependency, null); assert.equal(snapshot.namespace.cache.exists, false);
  assert.equal(validateMigrationInstallations(structuredClone(snapshot)).version, 1);
  assert.equal(await assertMigrationInstallationsUnchanged(f.context, snapshot, f.dependencies), true);
  assert.equal((await lstat(f.context.stateDir, { bigint: true })).ino, before.ino); await assert.rejects(lstat(f.context.cacheDir), { code: 'ENOENT' });
});

test('compatibility uses fixed complete runtime digests rather than package version', () => {
  assert.deepEqual(migrationSourceCompatibility('56f96305f7234e922fd277bb402210b01e978e2f50bc40652d071fcb1093c94d', 'b'.repeat(64)), { source: 'known-63fba03', sourceSchemas: [1, 2, 3], targetSchema: 4 });
  assert.deepEqual(migrationSourceCompatibility('7ec88027e61bba31be457b5ed05c17863d214e2ed4a4f7878a8844ce08efd19d', 'b'.repeat(64)), { source: 'known-1dd0c7c', sourceSchemas: [1, 2, 3, 4], targetSchema: 4 });
  assert.throws(() => migrationSourceCompatibility('c'.repeat(64), 'b'.repeat(64)), { code: 'MIGRATION_SOURCE_UNSUPPORTED' });
});

test('only the actual selected current-process Node path carries observed version evidence', budget, async t => {
  const f = await fixture(t), descriptor = await inspectInstallation({ packageRoot: f.old, nodePath: process.execPath });
  assert.equal(descriptor.nodePath, await realpath(process.execPath)); assert.deepEqual(descriptor.nodeVersionEvidence, { kind: 'current-process', version: process.versions.node });
  assert.equal(descriptor.nodeSha256, hash(await readFile(await realpath(process.execPath))));
});

test('an unrecognized old runtime with unchanged version is refused without writes', budget, async t => {
  const f = await fixture(t); await writeFile(join(f.old, 'lib/example.mjs'), 'export const unknown = true;\n');
  const before = await readFile(join(f.old, 'lib/example.mjs'));
  await assert.rejects(f.capture(), { code: 'MIGRATION_SOURCE_UNSUPPORTED' }); assert.deepEqual(await readFile(join(f.old, 'lib/example.mjs')), before);
  await assert.rejects(lstat(f.context.cacheDir), { code: 'ENOENT' });
});

for (const change of ['content', 'replacement', 'extra-file', 'removed-file', ...(process.platform === 'win32' ? [] : ['mode'])]) {
  test(`installation revalidation refuses ${change} even when package version is unchanged`, budget, async t => {
    const f = await fixture(t), snapshot = await f.capture(), selected = join(f.old, 'lib/example.mjs');
    if (change === 'content') await writeFile(selected, 'export const fixture = false;\n');
    if (change === 'replacement') { const other = `${selected}.candidate`; await copyFile(selected, other); await rename(other, selected); }
    if (change === 'extra-file') await writeFile(join(f.old, 'lib/later.mjs'), 'export const later = true;\n');
    if (change === 'removed-file') await rm(selected);
    if (change === 'mode') await chmod(selected, 0o600);
    await assert.rejects(assertMigrationInstallationsUnchanged(f.context, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
  });
}

test('same bytes at a replacement Node inode fail the artifact identity check', budget, async t => {
  const f = await fixture(t), snapshot = await f.capture(), replacement = `${f.node}.replacement`;
  await copyFile(f.node, replacement); await rename(replacement, f.node);
  await assert.rejects(assertMigrationInstallationsUnchanged(f.context, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
});

test('runtime reader detects actual in-place writes on the opened fd', budget, async t => {
  const f = await fixture(t), selected = join(f.old, 'lib/example.mjs'), before = await lstat(selected, { bigint: true }), probe = await open(selected, 'r');
  const prototype = Object.getPrototypeOf(probe), original = prototype.read; await probe.close(); let changed = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await original.apply(this, args), info = await this.stat({ bigint: true });
    if (!changed && info.dev === before.dev && info.ino === before.ino) { changed = true; await writeFile(selected, 'export const fixture = null;\n'); const clock = new Date(Date.now() + 2000); await utimes(selected, clock, clock); }
    return result;
  });
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_CHANGED' }); assert.equal(changed, true);
});

test('runtime parsing refuses malformed UTF-8, unsafe package metadata and oversized input', budget, async t => {
  const f = await fixture(t), path = join(f.old, 'package.json'), original = await readFile(path);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('null'), Buffer.from(JSON.stringify({ name: 'unrelated-package', version: '0.3.0' })), Buffer.from(original.toString('utf8').replace('0.3.0', '0.3.0\\n'))]) {
    await writeFile(path, bytes); await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' });
  }
  await writeFile(path, original); await truncate(path, 256 * 1024 + 1);
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_LIMIT' });
});

test('Node artifact size is bounded before allocating or reading its bytes', budget, async t => {
  const f = await fixture(t); await truncate(f.node, 512 * 1024 * 1024 + 1);
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_LIMIT' });
});

test('a directory cannot replace a runtime file and traversal depth is bounded', budget, async t => {
  const f = await fixture(t), file = join(f.old, 'bin/agent-dialogue.mjs'); await rm(file); await mkdir(file);
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' });
  await rm(file, { recursive: true }); await copyFile(join(f.current, 'bin/agent-dialogue.mjs'), file);
  await mkdir(join(f.old, 'lib', ...Array.from({ length: 25 }, (_, i) => `level${i}`)), { recursive: true });
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_LIMIT' });
});

test('runtime hard links cannot couple two supposedly isolated package prefixes', budget, async t => {
  const f = await fixture(t), selected = join(f.old, 'lib/example.mjs');
  await rm(selected); await link(join(f.current, 'lib/example.mjs'), selected);
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' });
  assert.equal((await lstat(join(f.current, 'lib/example.mjs'))).nlink, 2);
});

test('runtime file count is bounded without reading an arbitrarily large installation tree', budget, async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(join(f.old, 'lib', `file${index}.mjs`), 'export {};\n')));
  await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_LIMIT' });
});

test('from/to packages and state/cache cannot coincide or contain each other', budget, async t => {
  const f = await fixture(t);
  await assert.rejects(captureMigrationInstallations(f.context, { ...f.options, fromPackage: f.current }, f.dependencies), { code: 'MIGRATION_PATH_OVERLAP' });
  for (const context of [{ ...f.context, cacheDir: f.context.stateDir }, { ...f.context, cacheDir: join(f.old, 'cache') }, { ...f.context, stateDir: f.root }, { ...f.context, cacheDir: dirname(f.current) }]) {
    await assert.rejects(captureMigrationInstallations(context, f.options, f.dependencies), { code: 'MIGRATION_PATH_OVERLAP' });
  }
});

test('namespace verification refuses replaced state identity, changed backend and a cache created after capture', budget, async t => {
  const f = await fixture(t), snapshot = await f.capture();
  await assert.rejects(assertMigrationInstallationsUnchanged({ ...f.context, ledgerBackend: 'hcom', binary: f.node }, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
  await mkdir(f.context.cacheDir);
  await assert.rejects(assertMigrationInstallationsUnchanged(f.context, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
  await rm(f.context.cacheDir, { recursive: true }); await rename(f.context.stateDir, `${f.context.stateDir}.original`); await mkdir(f.context.stateDir, { mode: 0o700 });
  await assert.rejects(assertMigrationInstallationsUnchanged(f.context, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
});

test('hcom captures a distinct binary hash on supported platforms and Windows refuses it without execution', budget, async t => {
  const f = await fixture(t); await mkdir(f.context.cacheDir); const binary = join(f.context.cacheDir, 'hcom artifact'); await writeFile(binary, 'synthetic hcom binary; never execute\n', { mode: 0o755 });
  const context = { ...f.context, ledgerBackend: 'hcom', binary };
  if (process.platform === 'win32') { await assert.rejects(captureMigrationInstallations(context, f.options, f.dependencies), { code: 'MIGRATION_INSTALLATION_INVALID' }); return; }
  const snapshot = await captureMigrationInstallations(context, f.options, f.dependencies), dependency = snapshot.namespace.dependency;
  assert.equal(dependency.version, '0.7.30'); assert.equal(dependency.artifact.path, await realpath(binary)); assert.equal(dependency.artifact.sha256, hash(await readFile(binary)));
  assert.equal(dependency.lockedArchiveSha256, 'a'.repeat(64)); assert.notEqual(dependency.artifact.sha256, dependency.lockedArchiveSha256);
  assert.equal(await assertMigrationInstallationsUnchanged(context, snapshot, f.dependencies), true);
  await writeFile(binary, 'modified synthetic binary\n'); await assert.rejects(assertMigrationInstallationsUnchanged(context, snapshot, f.dependencies), { code: 'MIGRATION_INSTALLATION_CHANGED' });
});

test('closed snapshots cannot add instructions, redirect the CLI or forge runtime summaries', budget, async t => {
  const f = await fixture(t), snapshot = await f.capture();
  const variants = [value => { value.command = 'execute'; }, value => { value.from.cliPath = f.node; }, value => { value.to.identities.files['../escape'] = value.to.nodeIdentity; }, value => { value.to.runtimeFiles++; }, value => { value.from.nodeIdentity.ino = 123; }, value => { value.from.nodeIdentity.nlink = '2'; }, value => { value.from.nodeSha256 += '\n'; }, value => { value.namespace.dependency = { command: 'execute' }; }, value => { value.compatibility.sourceSchemas = [1, 2, 3, 4, 5]; }];
  for (const alter of variants) { const value = structuredClone(snapshot); alter(value); assert.throws(() => validateMigrationInstallations(value), { code: 'MIGRATION_INSTALLATION_INVALID' }); }
});

test('explicit paths must be absolute, nonempty and free of control characters', budget, async t => {
  const f = await fixture(t);
  for (const packageRoot of ['', '.', `${f.old}\n`]) await assert.rejects(inspectInstallation({ packageRoot, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' });
  const snapshot = await f.capture(); await assert.rejects(assertInstallationsUnchanged([{ ...snapshot.from, unknown: true }]), { code: 'MIGRATION_INSTALLATION_INVALID' });
});

if (process.platform !== 'win32') {
  test('runtime symlinks are refused while selected Node aliases resolve to a pinned regular artifact', budget, async t => {
    const f = await fixture(t), file = join(f.old, 'lib/example.mjs'), target = join(f.root, 'external.mjs'); await writeFile(target, 'private outside bytes\n');
    await rm(file); await symlink(target, file);
    await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' }); assert.equal(await readFile(target, 'utf8'), 'private outside bytes\n');
    await rm(file); await copyFile(join(f.current, 'lib/example.mjs'), file); const alias = join(f.root, 'node alias'); await symlink(f.node, alias);
    const selected = await inspectInstallation({ packageRoot: f.old, nodePath: alias }); assert.equal(selected.nodePath, await realpath(f.node));
  });
  test('group-writable runtime is refused without repairing modes', budget, async t => {
    const f = await fixture(t), path = join(f.old, 'lib/example.mjs'); await chmod(path, 0o666);
    await assert.rejects(inspectInstallation({ packageRoot: f.old, nodePath: f.node }), { code: 'MIGRATION_INSTALLATION_INVALID' }); assert.equal((await lstat(path)).mode & 0o777, 0o666);
  });
  test('canonical namespace overlap is refused through an otherwise valid ancestor alias', budget, async t => {
    const f = await fixture(t), alias = join(f.root, 'ancestor alias'); await symlink(f.root, alias);
    await assert.rejects(captureMigrationInstallations({ ...f.context, cacheDir: join(alias, 'state') }, f.options, f.dependencies), { code: 'MIGRATION_PATH_OVERLAP' });
  });
}
