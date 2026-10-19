import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameImmutable } from '../lib/atomic-rename.mjs';

const denied = code => Object.assign(new Error(`synthetic ${code}`), { code });
async function fixture(t, { destination = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ad-atomic-rename-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'immutable.tmp'), target = join(dir, 'current.json');
  await writeFile(source, 'new immutable bytes', { mode: 0o600 });
  if (destination) await writeFile(target, 'prior complete bytes', { mode: 0o600 });
  let clock = 0; const waits = [];
  return { dir, source, target, waits, clock: () => clock, wait: async ms => { waits.push(ms); clock += ms; } };
}

test('Windows sharing denial retries the same immutable source and exact destination without deleting either', async t => {
  const f = await fixture(t), before = await stat(f.source), calls = [];
  await renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, retryDelayMs: 20, renameImpl: async (source, target) => {
    calls.push([source, target]);
    assert.equal((await stat(source)).ino, before.ino);
    assert.equal(await readFile(source, 'utf8'), 'new immutable bytes');
    assert.equal(await readFile(target, 'utf8'), 'prior complete bytes');
    if (calls.length < 3) throw denied(calls.length === 1 ? 'EPERM' : 'EACCES');
    await rename(source, target);
  } });
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [f.source, f.target]));
  assert.deepEqual(f.waits, [20, 20]);
  assert.equal(await readFile(f.target, 'utf8'), 'new immutable bytes');
  await assert.rejects(stat(f.source), { code: 'ENOENT' });
});

test('permanent Windows sharing denial stops at its bounded deadline and retains both versions', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, timeoutMs: 40, retryDelayMs: 20, renameImpl: async () => { calls++; throw denied('EPERM'); } }), { code: 'EPERM' });
  assert.ok(calls >= 1 && calls <= 3); assert.ok(f.waits.reduce((n, ms) => n + ms, 0) <= 40);
  assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
  assert.equal(await readFile(f.target, 'utf8'), 'prior complete bytes');
});

test('non-Windows permission errors and Windows other errors are never retried', async t => {
  for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EACCES'], ['win32', 'EIO'], ['win32', 'EXDEV']]) {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(renameImmutable(f.source, f.target, { platform, now: f.clock, wait: f.wait, renameImpl: async () => { calls++; throw denied(code); } }), { code });
    assert.equal(calls, 1); assert.deepEqual(f.waits, []);
    assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
    assert.equal(await readFile(f.target, 'utf8'), 'prior complete bytes');
  }
});

test('replacement of the immutable source aborts before another rename and preserves changed evidence', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, renameImpl: async () => {
    calls++; const other = join(f.dir, 'different.tmp'); await writeFile(other, 'replacement evidence'); await rename(other, f.source); throw denied('EPERM');
  } }), { code: 'ATOMIC_RENAME_SOURCE_CHANGED' });
  assert.equal(calls, 1); assert.equal(await readFile(f.source, 'utf8'), 'replacement evidence');
  assert.equal(await readFile(f.target, 'utf8'), 'prior complete bytes');
});

test('same-inode source mutation is refused instead of publishing a rebuilt temporary', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, renameImpl: async () => {
    calls++; await writeFile(f.source, 'changed source evidence with different size'); throw denied('EACCES');
  } }), { code: 'ATOMIC_RENAME_SOURCE_CHANGED' });
  assert.equal(calls, 1); assert.equal(await readFile(f.source, 'utf8'), 'changed source evidence with different size');
  assert.equal(await readFile(f.target, 'utf8'), 'prior complete bytes');
});

test('a changed destination refuses retry and retains the foreign generation and original temp', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, renameImpl: async () => {
    calls++; const other = join(f.dir, 'foreign.tmp'); await writeFile(other, 'foreign committed generation'); await rename(other, f.target); throw denied('EPERM');
  } }), { code: 'ATOMIC_RENAME_DESTINATION_CHANGED' });
  assert.equal(calls, 1); assert.equal(await readFile(f.target, 'utf8'), 'foreign committed generation');
  assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
});

test('a missing destination is supported but its appearance during a denied retry is never overwritten', async t => {
  const f = await fixture(t, { destination: false }); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: f.clock, wait: f.wait, renameImpl: async () => {
    calls++; await writeFile(f.target, 'newly appeared evidence'); throw denied('EPERM');
  } }), { code: 'ATOMIC_RENAME_DESTINATION_CHANGED' });
  assert.equal(calls, 1); assert.equal(await readFile(f.target, 'utf8'), 'newly appeared evidence');
  assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
  const clean = await fixture(t, { destination: false });
  await renameImmutable(clean.source, clean.target);
  assert.equal(await readFile(clean.target, 'utf8'), 'new immutable bytes');
});

test('attempt budget is bounded even if the injected retry clock does not advance', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { platform: 'win32', now: () => 0, wait: async () => {}, maxAttempts: 3, renameImpl: async () => { calls++; throw denied('EACCES'); } }), { code: 'EACCES' });
  assert.equal(calls, 3); assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
});

test('distinct 64-bit inodes whose Number values collide still publish using exact BigInt identity', async t => {
  const f = await fixture(t), sourceInode = 2n ** 60n, targetInode = sourceInode + 1n, requests = [];
  assert.equal(Number(sourceInode), Number(targetInode)); assert.notEqual(sourceInode, targetInode);
  let renamed = 0;
  await renameImmutable(f.source, f.target, { platform: 'win32', lstatImpl: async (path, options) => {
    requests.push(options);
    const info = await lstat(path, options), inode = path === f.source ? sourceInode : targetInode;
    return { ...info, ino: options?.bigint ? inode : Number(inode), isFile: () => info.isFile(), isSymbolicLink: () => info.isSymbolicLink() };
  }, renameImpl: async (source, target) => { renamed++; await rename(source, target); } });
  assert.equal(renamed, 1); assert.ok(requests.length >= 4); assert.ok(requests.every(options => options?.bigint === true));
  assert.equal(await readFile(f.target, 'utf8'), 'new immutable bytes');
  await assert.rejects(stat(f.source), { code: 'ENOENT' });
});

test('actual source and destination hardlinks remain rejected before any publication attempt', async t => {
  const f = await fixture(t); await rm(f.target); await link(f.source, f.target);
  const source = await lstat(f.source, { bigint: true }), target = await lstat(f.target, { bigint: true });
  assert.equal(source.dev, target.dev); assert.equal(source.ino, target.ino);
  let renamed = 0;
  await assert.rejects(renameImmutable(f.source, f.target, { renameImpl: async () => { renamed++; } }), { code: 'ATOMIC_RENAME_OPTIONS_INVALID' });
  assert.equal(renamed, 0);
  assert.equal(await readFile(f.source, 'utf8'), 'new immutable bytes');
  assert.equal(await readFile(f.target, 'utf8'), 'new immutable bytes');
});
