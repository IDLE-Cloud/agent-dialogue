import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBinding, readStore, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { pauseBinding } from '../lib/lifecycle.mjs';
import { protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { pidEvidence, planLockRetirement, retireLock, readLockRetirementPlan, validateLockRetirementPlan } from '../lib/lock-recovery.mjs';

const budget = { timeout: process.platform === 'win32' ? 120000 : 15000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const selection = role => role === 'control' ? { role } : { role, alias: 'selected' };
const interrupted = stage => Object.assign(new Error(`owned fixture interruption: ${stage}`), { code: 'FIXTURE_INTERRUPTED' });
async function privateFile(path, value) {
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(path);
}
async function fixture(t, { allPaused = true } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ad-lock-retirement-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir, ledgerBackend: 'embedded' }, children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await once(child, 'close');
    }
  });
  const node = await loadOrCreateNode(context);
  const binding = await withStore(context, store => {
    store.version = 3; store.lifecycle = {}; store.forwardings = {};
    for (const alias of ['selected', 'other']) {
      const b = createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, serviceId: 'fixture', projectId: 'fixture', directory: stateDir, origin: 'http://127.0.0.1:1' });
      b.nodeId = node.nodeId;
    }
    return store.bindings.selected;
  });
  await pauseBinding(context, 'selected'); if (allPaused) await pauseBinding(context, 'other');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); children.push(child); await once(child, 'close');
  assert.equal(await pidEvidence(child.pid), 'confirmed-dead');
  const directory = join(stateDir, 'dialogue'), storePath = join(directory, 'store.json');
  const lockPath = role => join(directory, role === 'control' ? '.lock' : `${binding.id}.dispatch.lock`);
  const owner = (role, extra = {}) => ({ version: 1, role, pid: child.pid, nonce: randomUUID(), createdAt: new Date().toISOString(), ...(role === 'dispatch' ? { bindingId: binding.id, bindingRevision: binding.revision } : {}), ...extra });
  const addLock = async (role, value = owner(role)) => {
    const path = lockPath(role); await mkdir(path, { mode: 0o700 });
    if (process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true });
    await privateFile(join(path, 'owner.json'), value); return path;
  };
  return { context, binding, directory, storePath, deadPid: child.pid, children, owner, addLock, lockPath, before: await readFile(storePath) };
}
async function assertMissing(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function ownedCrashLock(t, f, role) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const script = `
    import { withStore } from ${JSON.stringify(new URL('../lib/bridge-store.mjs', import.meta.url).href)};
    import { withDispatch } from ${JSON.stringify(new URL('../lib/lifecycle.mjs', import.meta.url).href)};
    const context = {stateDir: process.argv[1]};
    const hold = async () => { setInterval(() => {}, 1000); process.send({ready:true}); await new Promise(() => {}); };
    if (process.argv[2] === 'control') await withStore(context, hold);
    else await withDispatch(context, 'selected', hold, {allowPaused:true});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.context.stateDir, role], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  f.children.push(child); let stderr = ''; child.stderr.on('data', value => { stderr += value; }); child.stdout.resume();
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => assert.fail(`owned child exited before lock acquisition: ${stderr}`))]);
  assert.equal(await pidEvidence(child.pid), 'live');
  const path = f.lockPath(role), before = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
  assert.equal(before.pid, child.pid);
  child.kill('SIGKILL'); await once(child, 'close');
  assert.equal(await pidEvidence(child.pid), 'confirmed-dead');
  assert.deepEqual(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')), before);
  return { path, before };
}

test('PID evidence distinguishes this live process, a genuinely exited owned child and unknown query', budget, async t => {
  const f = await fixture(t);
  assert.equal(await pidEvidence(process.pid), 'live'); assert.equal(await pidEvidence(f.deadPid), 'confirmed-dead');
  assert.equal(await pidEvidence(0), 'unknown'); assert.equal(await pidEvidence('12'), 'unknown');
  assert.equal(await pidEvidence(f.deadPid, { killImpl: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), 'unknown');
});

for (const role of ['control', 'dispatch']) {
  test(`actual killed owned child leaves ${role} lock; read-only plan and exact quarantine retirement preserve store bytes`, budget, async t => {
    const f = await fixture(t), crashed = await ownedCrashLock(t, f, role), directory = await readdir(f.directory);
    const { report, plan } = await planLockRetirement(f.context, selection(role));
    assert.equal(report.status, 'ready'); assert.ok(plan); assert.equal(report.effects.sourceWrites, false);
    assert.equal(plan.target.owner.pid, crashed.before.pid); assert.equal(plan.target.ownerHash, hash(await readFile(join(crashed.path, 'owner.json'))));
    assert.deepEqual(await readdir(f.directory), directory); assert.deepEqual(await readFile(f.storePath), f.before);
    assert.equal(JSON.stringify(report).includes(crashed.before.nonce), false); assert.equal(JSON.stringify(report).includes(f.context.stateDir), false);
    const result = await retireLock(f.context, plan, { offline: true });
    assert.equal(result.status, 'retired'); await assertMissing(crashed.path);
    const quarantined = join(f.directory, 'lock-recovery', 'quarantine', `${plan.id}.lock`);
    assert.deepEqual(JSON.parse(await readFile(join(quarantined, 'owner.json'), 'utf8')), crashed.before);
    assert.equal((await lstat(quarantined, { bigint: true })).ino.toString(), plan.target.identity.ino);
    assert.deepEqual(await readFile(f.storePath), f.before);
    assert.equal((await retireLock(f.context, plan, { offline: true })).status, 'already-retired');
    assert.deepEqual(await readFile(f.storePath), f.before); await assertMissing(join(f.directory, '.lock-recovery.lock'));
  });
}

test('plans and existing private plan files are closed, bounded and cannot select an arbitrary path', budget, async t => {
  const f = await fixture(t); await f.addLock('dispatch');
  const { plan } = await planLockRetirement(f.context, selection('dispatch'));
  assert.equal(validateLockRetirementPlan(plan).id, plan.id);
  const path = join(f.context.stateDir, 'selected-plan.json'); await privateFile(path, plan);
  assert.deepEqual(await readLockRetirementPlan(path), plan);
  for (const change of [p => { p.target.name = '../store.json'; }, p => { p.selection.role = 'worker'; }, p => { p.force = true; }, p => { p.target.owner.extra = 'untrusted'; }, p => { p.target.identity.ino = '1.5'; }]) {
    const invalid = structuredClone(plan); change(invalid); assert.throws(() => validateLockRetirementPlan(invalid), { code: 'LOCK_PLAN_INVALID' });
    await privateFile(path, invalid); await assert.rejects(readLockRetirementPlan(path), { code: 'LOCK_PLAN_INVALID' });
  }
  await privateFile(path, Buffer.alloc(128 * 1024 + 1, 32)); await assert.rejects(readLockRetirementPlan(path));
  await privateFile(path, Buffer.from([0xc3, 0x28])); await assert.rejects(readLockRetirementPlan(path));
});

test('explicit offline declaration is required before creating any administrative metadata', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const { plan } = await planLockRetirement(f.context, selection('control'));
  const names = await readdir(f.directory);
  for (const value of [undefined, false, 'true']) await assert.rejects(retireLock(f.context, plan, { offline: value }), { code: 'OFFLINE_REQUIRED' });
  assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('C requires every active local binding paused; D requires its selected binding paused without implicit lifecycle writes', budget, async t => {
  const f = await fixture(t, { allPaused: false }); await f.addLock('control');
  assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review');
  await rm(f.lockPath('control'), { recursive: true }); await f.addLock('dispatch');
  assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'ready');
  await rm(f.lockPath('dispatch'), { recursive: true });
  await withStore(f.context, store => { delete store.lifecycle[f.binding.id]; }); await f.addLock('dispatch');
  const before = await readFile(f.storePath);
  assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review');
  assert.deepEqual(await readFile(f.storePath), before);
});

test('live, unknown and changing PID evidence never authorize lock retirement', budget, async t => {
  const f = await fixture(t); await f.addLock('control', f.owner('control', { pid: process.pid }));
  assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review');
  const dead = f.owner('control'); await privateFile(join(f.lockPath('control'), 'owner.json'), dead);
  assert.equal((await planLockRetirement(f.context, selection('control'), { probe: async () => 'unknown' })).report.status, 'needs-review');
  const { plan } = await planLockRetirement(f.context, selection('control'));
  await assert.rejects(retireLock(f.context, plan, { offline: true, probe: async () => 'live' }));
  assert.deepEqual(JSON.parse(await readFile(join(f.lockPath('control'), 'owner.json'), 'utf8')), dead);
  assert.deepEqual(await readFile(f.storePath), f.before);
});

test('missing, extra, malformed, oversized and invalid UTF-8 owners are read-only needs-review', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), ownerPath = join(path, 'owner.json');
  for (const value of [null, { ...f.owner('control'), extra: true }, f.owner('dispatch'), f.owner('control', { pid: 1 }), f.owner('control', { nonce: 'bad' }), '{', Buffer.alloc(16385, 32), Buffer.from([0xc3, 0x28])]) {
    await privateFile(ownerPath, value === null ? 'null' : value);
    const before = await readFile(ownerPath), names = await readdir(f.directory);
    const { report, plan } = await planLockRetirement(f.context, selection('control'));
    assert.equal(report.status, 'needs-review'); assert.equal(plan, null); assert.deepEqual(await readFile(ownerPath), before); assert.deepEqual(await readdir(f.directory), names);
  }
  await rm(ownerPath); assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review');
});

test('extra lock contents and mismatched dispatch binding or revision are preserved for review', budget, async t => {
  const f = await fixture(t), path = await f.addLock('dispatch');
  await privateFile(join(path, 'unexpected-evidence.json'), 'preserve'); assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review');
  await rm(join(path, 'unexpected-evidence.json'));
  for (const extra of [{ bindingId: `b_${randomUUID()}` }, { bindingRevision: f.binding.revision + 1 }]) {
    await privateFile(join(path, 'owner.json'), f.owner('dispatch', extra)); assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review');
  }
});

test('symlink owner and lock paths are refused without reading or changing their targets', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), target = join(f.context.stateDir, 'external-owner.json'); await privateFile(target, f.owner('control'));
  await mkdir(f.lockPath('control'), { mode: 0o700 }); await symlink(target, join(f.lockPath('control'), 'owner.json'));
  assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review');
  const before = await readFile(target); await rm(f.lockPath('control'), { recursive: true });
  const targetDirectory = join(f.context.stateDir, 'external-lock'); await mkdir(targetDirectory, { mode: 0o700 }); await symlink(targetDirectory, f.lockPath('control'));
  assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review'); assert.deepEqual(await readFile(target), before);
});

test('overbroad existing parent, lock and owner permissions are refused and never repaired', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), path = await f.addLock('control');
  for (const target of [join(path, 'owner.json'), path, f.directory]) {
    const mode = (await lstat(target)).mode & 0o777; await chmod(target, 0o777);
    assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review'); assert.equal((await lstat(target)).mode & 0o777, 0o777);
    await chmod(target, mode);
  }
});

test('worker locks, scheduler descriptors and live or unknown producer reservations remain needs-review', budget, async t => {
  const f = await fixture(t); await f.addLock('dispatch');
  for (const role of ['worker', 'scheduler']) assert.equal((await planLockRetirement(f.context, { role, alias: 'selected' })).report.status, 'needs-review');
  const worker = join(f.directory, `${f.binding.id}.worker.lock`); await mkdir(worker, { mode: 0o700 });
  assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review'); await rm(worker, { recursive: true });
  const scheduled = join(f.directory, 'windows-workers'); await mkdir(scheduled, { mode: 0o700 }); await privateFile(join(scheduled, `${f.binding.id}.${randomUUID()}.launch.json`), '{}');
  assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review'); await rm(scheduled, { recursive: true });
  await rm(f.lockPath('dispatch'), { recursive: true });
  await withStore(f.context, store => { store.workerLaunches = { [f.binding.id]: { version: 1, bindingRevision: f.binding.revision, token: randomUUID(), pid: process.pid, phase: 'stopped' } }; });
  await f.addLock('dispatch'); assert.equal((await planLockRetirement(f.context, selection('dispatch'))).report.status, 'needs-review');
});

test('retiring selected D leaves a different dead C and all unrelated metadata untouched', budget, async t => {
  const f = await fixture(t), c = await f.addLock('control'), d = await f.addLock('dispatch');
  const owner = await readFile(join(c, 'owner.json')), { plan } = await planLockRetirement(f.context, selection('dispatch'));
  assert.equal((await retireLock(f.context, plan, { offline: true })).status, 'retired');
  assert.deepEqual(await readFile(join(c, 'owner.json')), owner); await assertMissing(d); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('changed owner, replaced inode and changed control-store preimage invalidate an old plan', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), { plan } = await planLockRetirement(f.context, selection('control'));
  await privateFile(join(path, 'owner.json'), f.owner('control'));
  await assert.rejects(retireLock(f.context, plan, { offline: true }));
  const fresh = (await planLockRetirement(f.context, selection('control'))).plan;
  const displaced = `${path}.owned-displaced`; await rename(path, displaced); await f.addLock('control', fresh.target.owner);
  await assert.rejects(retireLock(f.context, fresh, { offline: true }));
  const next = (await planLockRetirement(f.context, selection('control'))).plan;
  const store = await readStore(f.context); store.fixtureNewField = true; await privateFile(f.storePath, store);
  await assert.rejects(retireLock(f.context, next, { offline: true }));
  assert.equal((await readStore(f.context)).fixtureNewField, true);
});

for (const stage of ['checkpoint-persisted', 'quarantined']) {
  test(`interruption after ${stage} retries only the original before/after image`, budget, async t => {
    const f = await fixture(t), path = await f.addLock('dispatch'), { plan } = await planLockRetirement(f.context, selection('dispatch'));
    await assert.rejects(retireLock(f.context, plan, { offline: true, checkpointHook: async point => { if (point === stage) throw interrupted(stage); } }), { code: 'FIXTURE_INTERRUPTED' });
    const checkpointPath = join(f.directory, 'lock-recovery', 'checkpoints', `${plan.id}.json`), prepared = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.equal(prepared.phase, 'prepared'); await assertMissing(join(f.directory, '.lock-recovery.lock'));
    if (stage === 'quarantined') await assertMissing(path); else assert.equal((await lstat(path)).isDirectory(), true);
    const recovered = await retireLock(f.context, plan, { offline: true }); assert.ok(['retired', 'already-retired'].includes(recovered.status));
    const after = await readFile(checkpointPath); assert.equal(JSON.parse(after).phase, 'retired');
    assert.equal((await retireLock(f.context, plan, { offline: true })).status, 'already-retired'); assert.deepEqual(await readFile(checkpointPath), after);
    assert.deepEqual(await readFile(f.storePath), f.before);
  });
}

test('a later dead owner at the original path is preserved when a quarantined old plan is retried', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const { plan } = await planLockRetirement(f.context, selection('control'));
  await assert.rejects(retireLock(f.context, plan, { offline: true, checkpointHook: async stage => { if (stage === 'quarantined') throw interrupted(stage); } }), { code: 'FIXTURE_INTERRUPTED' });
  await f.addLock('control'); const owner = await readFile(join(f.lockPath('control'), 'owner.json'));
  assert.equal((await retireLock(f.context, plan, { offline: true })).status, 'already-retired'); assert.deepEqual(await readFile(join(f.lockPath('control'), 'owner.json')), owner);
  assert.deepEqual(await readFile(f.storePath), f.before);
});

test('rename failure preserves exact old lock and durable checkpoint without deleting or replacing anything', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), before = await readFile(join(path, 'owner.json')), { plan } = await planLockRetirement(f.context, selection('control'));
  await assert.rejects(retireLock(f.context, plan, { offline: true, renameImpl: async () => { throw Object.assign(new Error('synthetic rename denied'), { code: 'EPERM' }); } }));
  assert.deepEqual(await readFile(join(path, 'owner.json')), before);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'lock-recovery', 'checkpoints', `${plan.id}.json`), 'utf8')).phase, 'prepared');
  assert.equal((await retireLock(f.context, plan, { offline: true })).status, 'retired');
});

test('R mutex serializes recoverers and a stale R is never automatically removed', budget, async t => {
  const f = await fixture(t); await f.addLock('dispatch'); const { plan } = await planLockRetirement(f.context, selection('dispatch'));
  let entered, release; const gate = new Promise(resolve => { entered = resolve; }), released = new Promise(resolve => { release = resolve; });
  const first = retireLock(f.context, plan, { offline: true, checkpointHook: async stage => { if (stage === 'checkpoint-persisted') { entered(); await released; } } });
  await gate; await assert.rejects(retireLock(f.context, plan, { offline: true }), { code: 'RECOVERY_BUSY' }); release(); await first;
  const r = join(f.directory, '.lock-recovery.lock'); await mkdir(r, { mode: 0o700 }); await privateFile(join(r, 'owner.json'), f.owner('recovery'));
  const bytes = await readFile(join(r, 'owner.json')); await assert.rejects(retireLock(f.context, plan, { offline: true }), { code: 'RECOVERY_BUSY' }); assert.deepEqual(await readFile(join(r, 'owner.json')), bytes);
});

test('FIFO owner is rejected without blocking or mutating the pipe', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), path = await f.addLock('control'), owner = join(path, 'owner.json'); await rm(owner);
  const child = spawn('mkfifo', [owner], { stdio: 'ignore' }); f.children.push(child); const [code] = await once(child, 'close'); assert.equal(code, 0);
  assert.equal((await planLockRetirement(f.context, selection('control'))).report.status, 'needs-review'); assert.equal((await lstat(owner)).isFIFO(), true);
});

test('PID evidence becoming unknown after checkpoint persistence prevents any directory rename', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), before = await readFile(join(path, 'owner.json')), { plan } = await planLockRetirement(f.context, selection('control'));
  let evidence = 'confirmed-dead', renames = 0;
  await assert.rejects(retireLock(f.context, plan, { offline: true, probe: async () => evidence, checkpointHook: async stage => { if (stage === 'checkpoint-persisted') evidence = 'unknown'; }, renameImpl: async () => { renames++; assert.fail('unknown owner must not rename'); } }), { code: 'LOCK_PRODUCER_UNKNOWN' });
  assert.equal(renames, 0); assert.deepEqual(await readFile(join(path, 'owner.json')), before); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('a live later owner at the original path blocks retry without deleting either generation', budget, async t => {
  const f = await fixture(t); await f.addLock('dispatch'); const { plan } = await planLockRetirement(f.context, selection('dispatch'));
  await assert.rejects(retireLock(f.context, plan, { offline: true, checkpointHook: async stage => { if (stage === 'quarantined') throw interrupted(stage); } }), { code: 'FIXTURE_INTERRUPTED' });
  await f.addLock('dispatch', f.owner('dispatch', { pid: process.pid })); const current = await readFile(join(f.lockPath('dispatch'), 'owner.json'));
  const oldPath = join(f.directory, 'lock-recovery', 'quarantine', `${plan.id}.lock`, 'owner.json'), old = await readFile(oldPath);
  await assert.rejects(retireLock(f.context, plan, { offline: true }), { code: 'LOCK_PRODUCER_LIVE' });
  assert.deepEqual(await readFile(join(f.lockPath('dispatch'), 'owner.json')), current); assert.deepEqual(await readFile(oldPath), old);
});

test('a lost directory rename response is reconciled from its exact quarantine without repeating rename', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const { plan } = await planLockRetirement(f.context, selection('control')); let renames = 0;
  await assert.rejects(retireLock(f.context, plan, { offline: true, renameImpl: async (from, to) => { renames++; await rename(from, to); throw new Error('owned fixture loses rename response'); } }), { code: 'LOCK_RENAME_UNCONFIRMED' });
  assert.equal(renames, 1); assert.equal((await retireLock(f.context, plan, { offline: true, renameImpl: async () => assert.fail('must not rename a second time') })).status, 'already-retired');
  await assertMissing(f.lockPath('control')); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('a changed quarantine owner is retained and cannot be accepted as a saved postimage', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const { plan } = await planLockRetirement(f.context, selection('control')); await retireLock(f.context, plan, { offline: true });
  const ownerPath = join(f.directory, 'lock-recovery', 'quarantine', `${plan.id}.lock`, 'owner.json'); await privateFile(ownerPath, f.owner('control'));
  const bytes = await readFile(ownerPath); await assert.rejects(retireLock(f.context, plan, { offline: true }), { code: 'LOCK_QUARANTINE_CHANGED' });
  assert.deepEqual(await readFile(ownerPath), bytes); await assertMissing(f.lockPath('control'));
});

test('changed R owner evidence is retained rather than releasing another recovery owner', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), { plan } = await planLockRetirement(f.context, selection('control'));
  const rOwner = join(f.directory, '.lock-recovery.lock', 'owner.json'); let changed;
  await assert.rejects(retireLock(f.context, plan, { offline: true, checkpointHook: async stage => {
    if (stage !== 'checkpoint-persisted') return;
    changed = f.owner('recovery'); await privateFile(rOwner, changed); throw interrupted(stage);
  } }), { code: 'LOCK_RECOVERY_OWNER_CHANGED' });
  assert.deepEqual(JSON.parse(await readFile(rOwner, 'utf8')), changed); assert.equal((await lstat(path)).isDirectory(), true);
});

test('a checkpoint changed after preparation is retained and cannot authorize directory rename', budget, async t => {
  const f = await fixture(t), path = await f.addLock('control'), { plan } = await planLockRetirement(f.context, selection('control'));
  const checkpointPath = join(f.directory, 'lock-recovery', 'checkpoints', `${plan.id}.json`); let changed, renames = 0;
  await assert.rejects(retireLock(f.context, plan, { offline: true, checkpointHook: async stage => {
    if (stage !== 'checkpoint-persisted') return;
    changed = JSON.parse(await readFile(checkpointPath, 'utf8')); changed.fixtureExternalChange = 'preserve'; await privateFile(checkpointPath, changed);
  }, renameImpl: async (from, to) => { renames++; return rename(from, to); } }), { code: 'LOCK_CHECKPOINT_INVALID' });
  assert.equal(renames, 0); assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), changed); assert.equal((await lstat(path)).isDirectory(), true);
});
