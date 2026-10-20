import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withOwnedDirectoryLock } from '../lib/bridge-store.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { scanStateFiles, writeBackupBlobs, verifyBackupBlobs, readBackupBlob, validateBackupLedger } from '../lib/migration-files.mjs';
import * as migrationFiles from '../lib/migration-files.mjs';
import { powershellCommand, powershellQuote } from '../lib/platform.mjs';

const budget = { timeout: process.platform === 'win32' ? 300000 : 30000 };
const hash = data => createHash('sha256').update(data).digest('hex');
let reportedInitialDialogueOwner = false;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-migration-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (process.platform === 'win32') await protectWindowsPrivatePath(root, { directory: true });
  const stateDir = join(root, 'state'); await mkdir(stateDir, { mode: 0o700 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(stateDir, { directory: true });
  const dialogue = join(stateDir, 'dialogue'); await mkdir(dialogue, { mode: 0o700 });
  if (process.platform === 'win32') {
    if (!reportedInitialDialogueOwner) {
      const inherited = await inspectWindowsPrivatePath(dialogue, { directory: true });
      t.diagnostic(JSON.stringify({ fixture: 'new-dialogue-before-provisioning', ownerSid: inherited.ownerSid, currentUserSid: inherited.currentUserSid, ownerMatchesCurrentUser: inherited.ownerSid === inherited.currentUserSid }));
      reportedInitialDialogueOwner = true;
    }
    // Only this freshly created fixture directory is provisioned. Existing
    // source directories remain subject to the production owner refusal.
    await protectWindowsPrivatePath(dialogue, { directory: true });
  }
  const file = async (name, data, mode = 0o600) => { const path = join(stateDir, name); await writeFile(path, data, { mode }); if (process.platform === 'win32') await protectWindowsPrivatePath(path); else await chmod(path, mode); return path; };
  const store = Buffer.from('{"version":4,"opaque":"retain all original bytes"}\n');
  await file('dialogue/store.json', store); await file('history.txt', 'full retained history\n', 0o644);
  return { root, context: { stateDir }, stateDir, file, store, destination: join(root, 'backup') };
}
const reject = promise => assert.rejects(promise, error => /^MIGRATION_/.test(error.code));

test('whole-state scan is deterministic and read-only with exact BigInt metadata and stable directory identity', budget, async t => {
  const f = await fixture(t), names = await readdir(f.root), bytes = await readFile(join(f.stateDir, 'dialogue/store.json'));
  const a = await scanStateFiles(f.context), b = await scanStateFiles(f.context);
  assert.deepEqual(a, b); assert.equal(a.manifest.fileCount, 2); assert.equal(a.manifest.totalBytes, bytes.length + 22);
  const row = a.manifest.entries.find(row => row.path === 'dialogue/store.json');
  assert.equal(row.sha256, hash(bytes)); assert.equal(typeof row.ino, 'string'); assert.equal(row.nlink, '1');
  assert.equal(a.manifest.root.mtimeNs, undefined); assert.equal(a.manifest.entries.find(row => row.kind === 'directory').ctimeNs, undefined);
  assert.deepEqual(await readdir(f.root), names); assert.deepEqual(await readFile(join(f.stateDir, 'dialogue/store.json')), bytes);
});
test('private manifest/blobs preserve every file without creating a runnable state and deduplicate identical bytes', budget, async t => {
  const f = await fixture(t); await f.file('same.txt', f.store);
  const expected = await scanStateFiles(f.context), result = await writeBackupBlobs(f.context, f.destination, { expected });
  assert.deepEqual(result.manifest, expected.manifest); assert.equal(result.manifestHash, expected.manifestHash);
  assert.deepEqual((await readdir(f.destination)).sort(), ['blobs', 'complete.json', 'manifest.json']);
  assert.equal((await readdir(join(f.destination, 'blobs'))).length, 2);
  assert.deepEqual(await verifyBackupBlobs(f.destination, { expectedManifestHash: expected.manifestHash }), result);
  const row = expected.manifest.entries.find(row => row.path === 'dialogue/store.json');
  assert.deepEqual(await readBackupBlob(f.destination, row.sha256, { expectedManifestHash: expected.manifestHash }), f.store);
  if (process.platform === 'win32') await inspectWindowsPrivatePath(join(f.destination, 'manifest.json'));
  else assert.equal((await lstat(join(f.destination, 'manifest.json'))).mode & 0o777, 0o600);
  await reject(writeBackupBlobs(f.context, f.destination, { expected }));
});
test('only the exact currently owned control lock may be excluded; its parent timestamps do not break a fingerprint', budget, async t => {
  const f = await fixture(t), before = await scanStateFiles(f.context);
  await withOwnedDirectoryLock(f.context, { name: '.lock', role: 'control' }, async owner => {
    assert.deepEqual(await scanStateFiles(f.context, { ownedControl: owner }), before);
    await reject(scanStateFiles(f.context, { ownedControl: { ...owner, nonce: '00000000-0000-0000-0000-000000000000' } }));
    await assert.rejects(scanStateFiles(f.context), { code: 'MIGRATION_CONTROL_UNVERIFIED' });
    await assert.rejects(writeBackupBlobs(f.context, f.destination), { code: 'MIGRATION_CONTROL_UNVERIFIED' });
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  });
  assert.deepEqual(await scanStateFiles(f.context), before);
});
test('stale source manifests and source/backup path overlap are refused before completion', budget, async t => {
  const f = await fixture(t), expected = await scanStateFiles(f.context); await f.file('new.txt', 'new original fact');
  await reject(writeBackupBlobs(f.context, f.destination, { expected }));
  await reject(writeBackupBlobs(f.context, join(f.stateDir, 'nested')));
  await assert.rejects(lstat(join(f.destination, 'complete.json')), { code: 'ENOENT' });
});
test('strict source limits bound file count, each file, total bytes and actual UTF8 manifest bytes', budget, async t => {
  const f = await fixture(t);
  for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 1 }, { maxManifestBytes: 100 }]) await reject(scanStateFiles(f.context, { limits }));
  for (const limits of [{ maxFiles: 4097 }, { maxFileBytes: -1 }, { unknown: 1 }]) await reject(scanStateFiles(f.context, { limits }));
});
test('the selected store has an independent 16MiB cap before any unbounded read', budget, async t => {
  const f = await fixture(t); await f.file('dialogue/store.json', Buffer.alloc(16 * 1024 * 1024 + 1)); await reject(scanStateFiles(f.context));
});
test('source hardlinks are refused without altering either link', budget, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'history.txt'), target = join(f.root, 'outside.txt'); await link(source, target);
  await reject(scanStateFiles(f.context)); assert.equal((await lstat(source, { bigint: true })).nlink, 2n); assert.deepEqual(await readFile(source), await readFile(target));
});
test('source symlinks and special files are refused without following or blocking', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await writeFile(outside, 'untouched');
  await symlink(outside, join(f.stateDir, 'pointer')); await reject(scanStateFiles(f.context)); await rm(join(f.stateDir, 'pointer'));
  execFileSync('mkfifo', [join(f.stateDir, 'pipe')]); await reject(scanStateFiles(f.context)); assert.equal(await readFile(outside, 'utf8'), 'untouched');
});
test('broadened source permissions are rejected without repair, while private-root readable executable modes are retained', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.file('executable', '#!/bin/sh\n', 0o755);
  assert.equal(Number((await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'executable').mode) & 0o777, 0o755);
  const path = join(f.stateDir, 'history.txt'); await chmod(path, 0o666); await reject(scanStateFiles(f.context)); assert.equal((await lstat(path)).mode & 0o777, 0o666);
});
test('backup hashes, completion marker, exact blob set and expected manifest anchor are independently enforced', budget, async t => {
  const f = await fixture(t), original = await writeBackupBlobs(f.context, f.destination), row = original.manifest.entries.find(row => row.kind === 'file');
  await reject(verifyBackupBlobs(f.destination, { expectedManifestHash: '0'.repeat(64) }));
  const path = join(f.destination, 'blobs', row.sha256), bytes = await readFile(path); await writeFile(path, 'tampered'); await reject(verifyBackupBlobs(f.destination)); await writeFile(path, bytes);
  await writeFile(join(f.destination, 'blobs', 'f'.repeat(64)), 'extra', { mode: 0o600 }); await reject(verifyBackupBlobs(f.destination)); await rm(join(f.destination, 'blobs', 'f'.repeat(64)));
  await rm(join(f.destination, 'complete.json')); await reject(verifyBackupBlobs(f.destination));
});
test('corrupt UTF8 and nonclosed or traversing manifests cannot be treated as completed backup', budget, async t => {
  const f = await fixture(t); await writeBackupBlobs(f.context, f.destination);
  const p = join(f.destination, 'manifest.json'), bytes = await readFile(p);
  for (const change of [m => { m.extra = true; }, m => { m.entries[0].path = '../outside'; }, m => { m.entries.reverse(); }, m => { m.entries[0].ino = 1; }]) {
    const value = JSON.parse(bytes); change(value); await writeFile(p, JSON.stringify(value)); await reject(verifyBackupBlobs(f.destination));
  }
  await writeFile(p, Buffer.from([0xff, 0xfe])); await reject(verifyBackupBlobs(f.destination));
});
test('backup ledger validation sees uncheckpointed WAL commits only in a private working copy and preserves source and blobs', budget, async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.stateDir, 'hcom.db'));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA application_id=1094995015; PRAGMA user_version=1; CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE ad_endpoints(name TEXT PRIMARY KEY,registered_at TEXT NOT NULL); INSERT INTO events(timestamp,type,data)VALUES('fixed','message','{}');");
    if (process.platform === 'win32') for (const suffix of ['', '-wal', '-shm']) await protectWindowsPrivatePath(join(f.stateDir, 'hcom.db'+suffix));
    const before = await scanStateFiles(f.context), result = await writeBackupBlobs(f.context, f.destination, { expected: before });
    const checked = await validateBackupLedger(f.destination, { expectedManifestHash: result.manifestHash, backend: 'embedded' });
    assert.equal(checked.status, 'verified'); assert.equal(checked.events, 1); assert.deepEqual(await scanStateFiles(f.context), before);
    assert.deepEqual(await verifyBackupBlobs(f.destination), result);
  } finally { db.close(); }
});
test('foreign backend, invalid DB and nonempty rollback journal cannot pass private-copy validation', budget, async t => {
  for (const mode of ['invalid', 'journal']) {
    const f = await fixture(t); await f.file('hcom.db', mode === 'invalid' ? 'not a SQLite database' : Buffer.alloc(100));
    if (mode === 'journal') await f.file('hcom.db-journal', 'unresolved hot journal');
    const result = await writeBackupBlobs(f.context, f.destination);
    await reject(validateBackupLedger(f.destination, { expectedManifestHash: result.manifestHash, backend: 'embedded' }));
    assert.deepEqual(await verifyBackupBlobs(f.destination), result);
  }
});

test('controlled inplace source mutation during a handle read is rejected without completing a backup', budget, async t => {
  const f = await fixture(t), original = fs.promises.open, target = await realpath(join(f.stateDir, 'history.txt')); let changed = false;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === target && typeof args[1] === 'number') {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => { const result = await read(...values); if (!changed && result.bytesRead) { changed = true; await writeFile(target, 'controlled changed original bytes'); } return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await reject(writeBackupBlobs(f.context, f.destination)); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.equal(changed, true); await assert.rejects(lstat(join(f.destination, 'complete.json')), { code: 'ENOENT' });
});

test('a selected source ancestor redirected during a read cannot silently rescope the complete snapshot', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), selected = join(f.root, 'selected'), alternative = join(f.root, 'alternative');
  await mkdir(alternative, { mode: 0o700 }); await symlink(f.stateDir, selected);
  const context = { stateDir: selected }, target = await realpath(join(f.stateDir, 'history.txt')), original = fs.promises.open; let changed = false;
  // The source root itself may not be a symlink, so use an ordinary leaf under
  // a selected ancestor link, as with canonical system path aliases.
  const sourceParent = join(f.root, 'parent'); await mkdir(sourceParent, { mode: 0o700 }); await fs.promises.rename(f.stateDir, join(sourceParent, 'state'));
  await rm(selected); await symlink(sourceParent, selected); await mkdir(join(alternative, 'state'), { mode: 0o700 }); context.stateDir = join(selected, 'state');
  const canonicalTarget = await realpath(join(context.stateDir, 'history.txt'));
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === canonicalTarget && typeof args[1] === 'number') {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => { const result = await read(...values); if (!changed && result.bytesRead) { changed = true; await rm(selected); await symlink(alternative, selected); } return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await reject(scanStateFiles(context)); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
});

test('manifest metadata retains adjacent integers above Number precision and rejects kind/mode contradictions', budget, async t => {
  const f = await fixture(t), backup = await writeBackupBlobs(f.context, f.destination), m = structuredClone(backup.manifest);
  const rows = m.entries.filter(row => row.kind === 'file'); rows[0].ino = '9007199254740992'; rows[1].ino = '9007199254740993';
  const replace = async value => { const h = hash(JSON.stringify(value)); await writeFile(join(f.destination, 'manifest.json'), JSON.stringify(value)+'\n'); await writeFile(join(f.destination, 'complete.json'), JSON.stringify({ version: 1, manifestHash: h })+'\n'); return h; };
  const verified = await verifyBackupBlobs(f.destination, { expectedManifestHash: await replace(m) });
  assert.notEqual(verified.manifest.entries.filter(row => row.kind === 'file')[0].ino, verified.manifest.entries.filter(row => row.kind === 'file')[1].ino);
  const wrong = structuredClone(m); wrong.entries.find(row => row.kind === 'directory').mode = rows[0].mode;
  await replace(wrong); await reject(verifyBackupBlobs(f.destination));
});

test('an events view cannot impersonate the owned embedded events table during ledger validation', budget, async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.stateDir, 'hcom.db'));
  db.exec("PRAGMA application_id=1094995015; PRAGMA user_version=1; CREATE VIEW events AS SELECT 1 AS id,'fixed' AS timestamp,'message' AS type,'{}' AS data; CREATE TABLE ad_endpoints(name TEXT PRIMARY KEY,registered_at TEXT NOT NULL);"); db.close();
  if (process.platform === 'win32') await protectWindowsPrivatePath(join(f.stateDir, 'hcom.db'));
  const backup = await writeBackupBlobs(f.context, f.destination);
  await reject(validateBackupLedger(f.destination, { expectedManifestHash: backup.manifestHash, backend: 'embedded' }));
});

test('completion evidence changed during blob verification cannot authorize the old snapshot', budget, async t => {
  const f = await fixture(t), backup = await writeBackupBlobs(f.context, f.destination), row = backup.manifest.entries.find(row => row.kind === 'file');
  const selected = join(f.destination, 'blobs', row.sha256), targets = new Set([selected, await realpath(selected)]), original = fs.promises.open; let changed = false;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (targets.has(args[0]) && typeof args[1] === 'number') {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => { const result = await read(...values); if (!changed && result.bytesRead) { changed = true; await writeFile(join(f.destination, 'complete.json'), JSON.stringify({ version: 1, manifestHash: '0'.repeat(64) })); } return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await reject(verifyBackupBlobs(f.destination, { expectedManifestHash: backup.manifestHash })); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
});

test('new candidate metadata matches the exact source while source bytes and parent metadata remain unchanged', budget, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json');
  if (process.platform !== 'win32') await chmod(source, 0o644);
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  const candidate = await f.file('dialogue/candidate.tmp', '{"version":4,"candidate":true}\n');
  const parent = await lstat(join(f.stateDir, 'dialogue'), { bigint: true });
  const result = await migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected, { newlyCreated: true });
  for (const key of ['mode', 'uid', 'gid', 'aclHash']) assert.equal(result[key], expected[key], key);
  assert.equal(result.nlink, '1'); assert.equal(result.sha256, hash(await readFile(candidate)));
  assert.deepEqual(await readFile(source), f.store);
  const sourceAfter = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  assert.deepEqual(sourceAfter, expected);
  const afterParent = await lstat(join(f.stateDir, 'dialogue'), { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs']) assert.equal(afterParent[key], parent[key], key);
});
test('an existing candidate is only verified and is never repaired to match the source', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json'); await chmod(source, 0o644);
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  const candidate = await f.file('dialogue/candidate.tmp', 'independent candidate bytes');
  const before = await lstat(candidate, { bigint: true });
  await assert.rejects(migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected, { newlyCreated: false }), { code: 'MIGRATION_CANDIDATE_INVALID' });
  const after = await lstat(candidate, { bigint: true });
  for (const key of ['ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], key);
  assert.equal(await readFile(candidate, 'utf8'), 'independent candidate bytes');
});
test('a matching existing candidate is verified without writing its metadata', budget, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json');
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  const candidate = await f.file('dialogue/candidate.tmp', 'independent candidate bytes'), before = await lstat(candidate, { bigint: true });
  await migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected);
  const after = await lstat(candidate, { bigint: true });
  for (const key of ['ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], key);
});
test('candidate preparation refuses a changed source and preserves both independent files', budget, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json');
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  const candidate = await f.file('dialogue/candidate.tmp', 'independent candidate bytes');
  await writeFile(source, 'changed source evidence'); const before = await lstat(candidate, { bigint: true });
  await assert.rejects(migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected, { newlyCreated: true }), { code: 'MIGRATION_FILES_CHANGED' });
  assert.equal(await readFile(source, 'utf8'), 'changed source evidence'); assert.equal(await readFile(candidate, 'utf8'), 'independent candidate bytes');
  assert.equal((await lstat(candidate, { bigint: true })).ctimeNs, before.ctimeNs);
});
test('candidate metadata never modifies the source through the same path or a real hardlink', budget, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json');
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  await reject(migrationFiles.prepareMigrationCandidateMetadata(source, source, expected, { newlyCreated: true }));
  const candidate = join(f.stateDir, 'dialogue/candidate.tmp'); await link(source, candidate);
  await reject(migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected, { newlyCreated: true }));
  assert.deepEqual(await readFile(source), f.store); assert.equal((await lstat(source, { bigint: true })).nlink, 2n);
});
test('Windows nondefault private source ACL is copied exactly only to a newly created candidate', { ...budget, skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), source = join(f.stateDir, 'dialogue/store.json');
  const script = `$ErrorActionPreference='Stop';$p=${powershellQuote(source)};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.FileSecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,'Read','Allow')));[IO.File]::SetAccessControl($p,$a);`;
  execFileSync(win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), powershellCommand(script).split(' ').slice(1), { windowsHide: true, timeout: 8000, maxBuffer: 1024 });
  const expected = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json');
  const candidate = await f.file('dialogue/candidate.tmp', 'independent candidate bytes');
  const candidateBefore = (await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/candidate.tmp');
  assert.notEqual(candidateBefore.aclHash, expected.aclHash);
  await assert.rejects(migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected), { code: 'MIGRATION_CANDIDATE_INVALID' });
  assert.deepEqual((await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/candidate.tmp'), candidateBefore);
  const after = await migrationFiles.prepareMigrationCandidateMetadata(source, candidate, expected, { newlyCreated: true });
  assert.equal(after.aclHash, expected.aclHash);
  assert.deepEqual((await scanStateFiles(f.context)).manifest.entries.find(row => row.path === 'dialogue/store.json'), expected);
});
