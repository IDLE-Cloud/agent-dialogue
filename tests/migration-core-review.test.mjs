import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOwnedDirectoryLock } from '../lib/bridge-store.mjs';
import { scanStateFiles } from '../lib/migration-files.mjs';
import { prepareMigration, publishMigrationStore } from '../lib/migration.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';

test('an interrupted publisher retries the same safe readable candidate without repairing or replacing its metadata', { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-core-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state') }, bundle = join(root, 'bundle');
  await mkdir(context.stateDir, { mode: 0o700 }); await mkdir(join(context.stateDir, 'dialogue'), { mode: 0o700 }); await mkdir(bundle, { mode: 0o700 });
  const sourcePath = join(context.stateDir, 'dialogue/store.json'), temporaryName = join(bundle, '.store-fixed-candidate.tmp');
  const original = Buffer.from('{"version":3,"bindings":{},"rooms":{},"lifecycle":{},"forwardings":{}}\n');
  const candidate = Buffer.from('{"version":4,"bindings":{},"rooms":{},"lifecycle":{},"forwardings":{},"nativeIntents":{}}\n');
  await writeFile(sourcePath, original, { mode: 0o644 }); await chmod(sourcePath, 0o644);
  await withOwnedDirectoryLock(context, { name: '.lock', role: 'control' }, async ownedControl => {
    const expectedStore = (await scanStateFiles(context, { ownedControl })).manifest.entries.find(row => row.path === 'dialogue/store.json');
    const fixed = { bytes: candidate, mode: 0o644, temporaryName, expectedStore };
    await assert.rejects(publishMigrationStore(context, { ...fixed, beforePublish: async () => { throw Object.assign(new Error('Owned review interruption'), { code: 'FIXTURE_INTERRUPTED' }); } }), { code: 'FIXTURE_INTERRUPTED' });
    assert.deepEqual(await readFile(sourcePath), original);
    assert.deepEqual(await readFile(temporaryName), candidate);
    const retained = await lstat(temporaryName, { bigint: true }); assert.equal(retained.mode & 0o777n, 0o644n);
    let finalGate = 0;
    await publishMigrationStore(context, { ...fixed, beforePublish: async () => { finalGate++; } });
    assert.equal(finalGate, 1);
    assert.deepEqual(await readFile(sourcePath), candidate);
    const published = await lstat(sourcePath, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs']) assert.equal(published[key], retained[key], key);
    await assert.rejects(lstat(temporaryName), { code: 'ENOENT' });
  });
});

test('prepare preserves and backs up an exact safe readable source store without requiring private file mode', { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-readable-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded' };
  const fromPackage = join(root, 'old prefix'), packageRoot = join(root, 'new prefix'), fromNode = join(root, 'synthetic node artifact');
  await mkdir(context.stateDir, { mode: 0o700 }); await mkdir(join(context.stateDir, 'dialogue'), { mode: 0o700 }); await mkdir(context.cacheDir, { mode: 0o700 });
  await initializeEmbedded(context);
  for (const directory of ['bin', 'lib', 'config', 'web']) await mkdir(join(fromPackage, directory), { recursive: true, mode: 0o700 });
  const files = {
    'package.json': JSON.stringify({ name: '@idle-cloud/agent-dialogue', version: '0.3.0', type: 'module', bin: { 'agent-dialogue': 'bin/agent-dialogue.mjs' } }),
    'bin/agent-dialogue.mjs': 'throw new Error("Owned artifact must not execute");\n',
    'bin/bridge-worker.mjs': 'throw new Error("Owned worker must not start");\n',
    'lib/fixture.mjs': 'export const owned = true;\n', 'config/hcom.lock.json': '{}\n', 'web/index.html': '<!doctype html><title>Owned fixture</title>\n',
  };
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(fromPackage, path), bytes, { mode: 0o644 });
  await cp(fromPackage, packageRoot, { recursive: true }); await writeFile(fromNode, 'Synthetic Node artifact; never execute.\n', { mode: 0o700 });
  const storePath = join(context.stateDir, 'dialogue/store.json'), bytes = Buffer.from('{ "version": 3, "bindings": {}, "rooms": {}, "lifecycle": {}, "forwardings": {} }\n');
  await writeFile(storePath, bytes, { mode: 0o644 }); await chmod(storePath, 0o644); const before = await lstat(storePath, { bigint: true });
  const result = await prepareMigration(context, { fromPackage, fromNode, bundle: join(root, 'bundle'), offline: true }, { installationOptions: { sources: { packageRoot, nodePath: fromNode } } });
  assert.equal(result.phase, 'prepared'); assert.equal(result.sourceChanged, false);
  assert.deepEqual(await readFile(storePath), bytes);
  const after = await lstat(storePath, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], key);
});
