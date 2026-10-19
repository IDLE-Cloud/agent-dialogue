import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, withStore } from '../lib/bridge-store.mjs';
import { bridgeStatus } from '../lib/bridge.mjs';
import { renameImmutable } from '../lib/atomic-rename.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lifecycle-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { stateDir: root };
  const binding = await withStore(context, store => createBinding(store, { alias: 'selected', harness: 'test', sessionId: 'selected-session', projectId: 'project', directory: '/fixture/project', serviceId: 'fixture-service', origin: 'fixture' }));
  const directory = join(root, 'dialogue'), path = join(directory, `${binding.id}.worker.json`);
  const worker = async () => (await bridgeStatus(context)).bindings.find(row => row.id === binding.id).worker;
  return { context, binding, directory, path, worker };
}

test('runtime readers retain complete immutable snapshots during concurrent atomic publication', async t => {
  const f = await fixture(t), marker = 'immutable-runtime-'.repeat(2048);
  // No synthetic PID or token: bridgeStatus must retain unknown ownership and
  // never inspect any real process merely to exercise the snapshot reader.
  const value = generation => ({ status: 'paused', cursor: generation, receipts: {}, generation, marker: `${generation}:${marker}` });
  await writeFile(f.path, JSON.stringify(value(0)), { mode: 0o600 });
  const prepared = await Promise.all(Array.from({ length: 80 }, async (_, index) => {
    const temporary = join(f.directory, `runtime-publish-${index + 1}.json`);
    await writeFile(temporary, JSON.stringify(value(index + 1)), { mode: 0o600 });
    return temporary;
  }));
  const publishing = (async () => {
    for (const temporary of prepared) { await renameImmutable(temporary, f.path); await new Promise(resolve => setImmediate(resolve)); }
  })();
  const [publication, ...outcomes] = await Promise.allSettled([publishing, ...Array.from({ length: 16 }, async () => {
    for (let index = 0; index < 40; index++) {
      const worker = await f.worker();
      assert.equal(worker.status, 'paused', 'a legal rename is not invalid owner evidence');
      assert.equal(worker.ownershipEvidence, 'unknown'); assert.equal(worker.running, null);
      assert.ok(Number.isSafeInteger(worker.generation) && worker.generation >= 0 && worker.generation <= 80);
      assert.equal(worker.cursor, worker.generation); assert.equal(worker.marker, `${worker.generation}:${marker}`);
    }
  })]);
  if (publication.status === 'rejected') throw publication.reason;
  const failed = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(failed.length, 0, `${failed.length} runtime readers failed during legal atomic publication: ${failed[0]?.reason?.message || ''}`);
});

test('runtime snapshot reader rejects actual in-place mutation without treating it as missing', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ status: 'paused', cursor: 17, receipts: {}, marker: 'before' }), { mode: 0o600 });
  const before = await stat(f.path), probe = await open(f.path, 'r');
  const prototype = Object.getPrototypeOf(probe), original = prototype.read; await probe.close();
  let changed = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await original.apply(this, args), target = await this.stat();
    // bridgeStatus also reads store.json. Mutate only the selected runtime fd.
    if (!changed && target.dev === before.dev && target.ino === before.ino) {
      changed = true;
      await writeFile(f.path, JSON.stringify({ status: 'paused', cursor: 18, receipts: {}, marker: 'after!' }));
      const next = new Date(Date.now() + 2000); await utimes(f.path, next, next);
    }
    return result;
  });
  const worker = await f.worker();
  assert.equal(changed, true); assert.equal(worker.status, 'invalid'); assert.equal(worker.ownershipEvidence, 'unknown');
});

test('runtime malformed UTF-8, corrupt JSON, oversized and nonregular records remain invalid; missing stays distinct', async t => {
  const f = await fixture(t);
  assert.equal((await f.worker()).ownershipEvidence, 'not-recorded');
  for (const bytes of [Buffer.from('{malformed'), Buffer.from([0xff, 0xfe]), Buffer.from('null'), Buffer.from('{"cursor":-1,"receipts":{}}')]) {
    await writeFile(f.path, bytes, { mode: 0o600 });
    const worker = await f.worker(); assert.equal(worker.status, 'invalid'); assert.equal(worker.ownershipEvidence, 'unknown');
  }
  await truncate(f.path, 16 * 1024 * 1024 + 1);
  assert.equal((await f.worker()).status, 'invalid');
  await rm(f.path); await mkdir(f.path); assert.equal((await f.worker()).status, 'invalid');
  await rm(f.path, { recursive: true }); assert.equal((await f.worker()).ownershipEvidence, 'not-recorded');
  if (process.platform !== 'win32') {
    const target = join(f.directory, 'unrelated-runtime.json'), bytes = '{"status":"paused","cursor":17,"receipts":{}}';
    await writeFile(target, bytes, { mode: 0o600 }); await symlink(target, f.path);
    assert.equal((await f.worker()).status, 'invalid'); assert.equal(await readFile(target, 'utf8'), bytes);
  }
});
