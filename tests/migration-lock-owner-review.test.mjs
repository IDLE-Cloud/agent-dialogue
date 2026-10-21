import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withOwnedDirectoryLock } from '../lib/bridge-store.mjs';
import { renameImmutable } from '../lib/atomic-rename.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from '../lib/private-files.mjs';

const budget = { timeout: process.platform === 'win32' ? 120000 : 30000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-owned-lock-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: join(root, 'state') }, dialogue = join(context.stateDir, 'dialogue');
  await mkdir(context.stateDir, { mode: 0o700 }); await mkdir(dialogue, { mode: 0o700 });
  // Only fixture parents are provisioned here. The production lock creator
  // must establish the owner of its own internal owner.json before callback.
  if (process.platform === 'win32') for (const path of [root, context.stateDir, dialogue]) await protectWindowsPrivatePath(path, { directory: true });
  return { root, context, dialogue };
}

for (const role of ['control', 'dispatch']) {
  test(`strict ${role} exposes only a current-user private owner file to the callback`, budget, async t => {
    const f = await fixture(t), binding = { id: 'b_00000000-0000-4000-8000-000000000001', revision: 1 };
    const name = role === 'control' ? '.lock' : `${binding.id}.dispatch.lock`, path = join(f.dialogue, name, 'owner.json');
    await withOwnedDirectoryLock(f.context, { name, role, ...(role === 'dispatch' ? { binding } : {}) }, async owner => {
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), owner);
      const info = await lstat(path, { bigint: true }); assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(info.nlink, 1n);
      if (process.platform === 'win32') {
        const acl = await inspectWindowsPrivatePath(path);
        assert.equal(acl.ownerSid, acl.currentUserSid); assert.equal(acl.protected, true);
      } else { assert.equal(info.mode & 0o777n, 0o600n); assert.equal(info.uid, BigInt(process.getuid())); }
    });
    await assert.rejects(lstat(join(f.dialogue, name)), { code: 'ENOENT' });
  });
}

test('a same-bytes replacement of a newly created owner inode cannot reach the callback or be deleted as owned evidence', budget, async t => {
  const f = await fixture(t), path = join(f.dialogue, '.lock', 'owner.json'), retained = join(f.dialogue, '.lock', 'owner-original.private');
  const original = fs.promises.open; let replaced = false, callback = false, replacedInode;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === path && (args[1] === 'wx' || args[1] === 'wx+')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        if (!replaced) {
          replaced = true; const bytes = await readFile(path);
          await renameImmutable(path, retained, { expectedDestination: null }); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          replacedInode = (await lstat(path, { bigint: true })).ino;
        }
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(withOwnedDirectoryLock(f.context, { name: '.lock', role: 'control' }, async () => { callback = true; }));
    assert.equal(replaced, true); assert.equal(callback, false);
    assert.equal((await lstat(path, { bigint: true })).ino, replacedInode);
    assert.notEqual((await lstat(retained, { bigint: true })).ino, replacedInode);
    assert.deepEqual(await readFile(path), await readFile(retained));
  } finally { fs.promises.open = original; syncBuiltinESMExports(); }
});

test('control and dispatch release retain a same-bytes replacement owner inode after a normal callback', budget, async t => {
  for (const role of ['control', 'dispatch']) {
    const f = await fixture(t), binding = { id: 'b_00000000-0000-4000-8000-000000000002', revision: 1 };
    const name = role === 'control' ? '.lock' : `${binding.id}.dispatch.lock`;
    const path = join(f.dialogue, name, 'owner.json'), retained = join(f.dialogue, name, 'owner-original.private');
    let called = false, replacementInode;
    await assert.rejects(withOwnedDirectoryLock(f.context, { name, role, ...(role === 'dispatch' ? { binding } : {}) }, async () => {
      called = true; const bytes = await readFile(path);
      await renameImmutable(path, retained, { expectedDestination: null });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); replacementInode = (await lstat(path, { bigint: true })).ino;
    }), { code: 'LOCK_OWNERSHIP_CHANGED' });
    assert.equal(called, true, role);
    assert.equal((await lstat(path, { bigint: true })).ino, replacementInode, role);
    assert.notEqual((await lstat(retained, { bigint: true })).ino, replacementInode, role);
    assert.deepEqual(await readFile(path), await readFile(retained), role);
  }
});
