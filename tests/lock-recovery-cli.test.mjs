import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_DIR, run } from '../bin/agent-dialogue.mjs';
import { createBinding, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode } from '../lib/node-identity.mjs';
import { pauseBinding } from '../lib/lifecycle.mjs';
import { pidEvidence, readLockRetirementPlan } from '../lib/lock-recovery.mjs';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from '../lib/private-files.mjs';
import { windowsAclDiagnosticRunner } from './helpers/windows-acl-diagnostic.mjs';

// CLI totals include real ACL subprocesses and repeated full-space evidence
// reads on Windows. Individual production ACL/PID deadlines are unchanged.
const budget = { timeout: process.platform === 'win32' ? 240000 : 30000 };
async function privateFile(path, value) {
  await writeFile(path, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsPrivatePath(path);
}
async function fixture(t, { initialize = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ad-lock-cli-')), children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
    await rm(root, { recursive: true, force: true });
  });
  if (process.platform === 'win32') await protectWindowsPrivatePath(root, { directory: true, runner: windowsAclDiagnosticRunner(t, 'lock-cli-fixture-root-protect') });
  const context = { stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), ledgerBackend: 'embedded' };
  const env = { ...process.env, AGENT_DIALOGUE_STATE_DIR: context.stateDir, AGENT_DIALOGUE_CACHE_DIR: context.cacheDir, AGENT_DIALOGUE_LEDGER: 'embedded' };
  const call = args => run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), ...args], { cwd: root, env, capture: true, timeout: process.platform === 'win32' ? 120000 : 30000 });
  if (!initialize) return { ...context, context, root, call, children };
  const node = await loadOrCreateNode(context), binding = await withStore(context, store => {
    store.version = 4; store.lifecycle = {}; store.forwardings = {}; store.nativeIntents = {};
    for (const alias of ['selected', 'other']) {
      const b = createBinding(store, { alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: 'fixture', serviceId: 'fixture', directory: root, origin: 'http://127.0.0.1:1' }); b.nodeId = node.nodeId;
    }
    return store.bindings.selected;
  });
  await pauseBinding(context, 'selected'); await pauseBinding(context, 'other');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); children.push(child); await once(child, 'close');
  assert.equal(await pidEvidence(child.pid), 'confirmed-dead');
  const directory = join(context.stateDir, 'dialogue'), storePath = join(directory, 'store.json'), planPath = join(root, 'private selected plan.json');
  const lockPath = role => join(directory, role === 'control' ? '.lock' : `${binding.id}.dispatch.lock`);
  const owner = (role, pid = child.pid) => ({ version: 1, role, pid, nonce: randomUUID(), createdAt: new Date().toISOString(), ...(role === 'dispatch' ? { bindingId: binding.id, bindingRevision: binding.revision } : {}) });
  const addLock = async (role, pid = child.pid) => {
    const path = lockPath(role); await mkdir(path, { mode: 0o700 }); if (process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true }); await privateFile(join(path, 'owner.json'), owner(role, pid)); return path;
  };
  return { ...context, context, root, call, children, binding, directory, storePath, planPath, lockPath, owner, addLock, before: await readFile(storePath) };
}
const planArgs = (f, role) => ['lock', 'plan', ...(role === 'dispatch' ? ['--binding', 'selected'] : []), '--output', f.planPath, '--json'];
async function killedLockOwner(f, role) {
  const script = `
    import {withStore} from ${JSON.stringify(new URL('../lib/bridge-store.mjs', import.meta.url).href)};
    import {withDispatch} from ${JSON.stringify(new URL('../lib/lifecycle.mjs', import.meta.url).href)};
    const context={stateDir:process.argv[1]};
    const hold=async()=>{setInterval(()=>{},1000);process.send({acquired:true});await new Promise(()=>{});};
    if(process.argv[2]==='control')await withStore(context,hold);else await withDispatch(context,'selected',hold,{allowPaused:true});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.stateDir, role], { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); f.children.push(child);
  let errors = ''; child.stdout.resume(); child.stderr.on('data', value => { errors += value; });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => assert.fail(`owned child failed before acquiring lock: ${errors}`))]);
  assert.equal(await pidEvidence(child.pid), 'live'); child.kill('SIGKILL'); await once(child, 'close');
  assert.equal(await pidEvidence(child.pid), 'confirmed-dead');
  const bytes = await readFile(join(f.lockPath(role), 'owner.json')); assert.equal(JSON.parse(bytes).pid, child.pid); return bytes;
}

test('CLI lock plan is read-only before setup and prints no private plan when evidence is missing', budget, async t => {
  const f = await fixture(t, { initialize: false }), names = await readdir(f.root);
  const result = await f.call(['lock', 'plan', '--output', join(f.root, 'must-not-exist.json'), '--json']);
  assert.equal(result.code, 1); const report = JSON.parse(result.stdout); assert.equal(report.status, 'needs-review'); assert.equal(report.planSaved, false); assert.equal(report.effects.sourceWrites, false);
  assert.deepEqual(await readdir(f.root), names);
});

for (const role of ['control', 'dispatch']) {
  test(`CLI saves a private exact ${role} plan and retires a genuinely killed owner once`, budget, async t => {
    const f = await fixture(t), ownerBytes = await killedLockOwner(f, role), owner = JSON.parse(ownerBytes), before = await readdir(f.directory);
    const planned = await f.call(planArgs(f, role)); assert.equal(planned.code, 0, planned.stderr);
    const report = JSON.parse(planned.stdout); assert.equal(report.status, 'ready'); assert.equal(report.planSaved, true); assert.equal(report.effects.sourceWrites, false);
    assert.equal(planned.stdout.includes(owner.nonce), false); assert.equal(planned.stdout.includes(f.stateDir), false);
    const plan = await readLockRetirementPlan(f.planPath); assert.equal(plan.selection.role, role); assert.equal(plan.target.owner.pid, owner.pid);
    const info = await lstat(f.planPath); assert.equal(info.isFile(), true);
    if (process.platform === 'win32') await inspectWindowsPrivatePath(f.planPath); else assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.directory), before); assert.deepEqual(await readFile(f.storePath), f.before);
    const retired = await f.call(['lock', 'retire', '--plan', f.planPath, '--offline', '--json']); assert.equal(retired.code, 0, retired.stderr); assert.equal(JSON.parse(retired.stdout).status, 'retired');
    await assert.rejects(lstat(f.lockPath(role)), { code: 'ENOENT' });
    const quarantined = join(f.directory, 'lock-recovery', 'quarantine', `${plan.id}.lock`); assert.deepEqual(await readFile(join(quarantined, 'owner.json')), ownerBytes);
    const checkpointPath = join(f.directory, 'lock-recovery', 'checkpoints', `${plan.id}.json`), checkpoint = await readFile(checkpointPath), planBytes = await readFile(f.planPath);
    const repeated = await f.call(['lock', 'retire', '--plan', f.planPath, '--offline']); assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).status, 'already-retired');
    assert.deepEqual(await readFile(checkpointPath), checkpoint); assert.deepEqual(await readFile(f.planPath), planBytes); assert.deepEqual(await readFile(f.storePath), f.before);
  });
}

test('CLI refuses retirement without explicit offline and preserves the original lock and plan', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); assert.equal((await f.call(planArgs(f, 'control'))).code, 0);
  const names = await readdir(f.directory), plan = await readFile(f.planPath), owner = await readFile(join(f.lockPath('control'), 'owner.json'));
  const result = await f.call(['lock', 'retire', '--plan', f.planPath, '--json']); assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(f.planPath), plan); assert.deepEqual(await readFile(join(f.lockPath('control'), 'owner.json')), owner); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('CLI old plan cannot retire a later live owner at the original path', budget, async t => {
  const f = await fixture(t); await f.addLock('dispatch'); assert.equal((await f.call(planArgs(f, 'dispatch'))).code, 0);
  const original = `${f.lockPath('dispatch')}.owned-original`; await rename(f.lockPath('dispatch'), original); await f.addLock('dispatch', process.pid);
  const old = await readFile(join(original, 'owner.json')), current = await readFile(join(f.lockPath('dispatch'), 'owner.json'));
  const result = await f.call(['lock', 'retire', '--plan', f.planPath, '--offline']); assert.notEqual(result.code, 0);
  assert.deepEqual(await readFile(join(original, 'owner.json')), old); assert.deepEqual(await readFile(join(f.lockPath('dispatch'), 'owner.json')), current); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('CLI private plan output never overwrites an existing file', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); await privateFile(f.planPath, 'UNRELATED_PRIVATE_FILE_DO_NOT_OVERWRITE');
  const before = await readFile(f.planPath), names = await readdir(f.directory), result = await f.call(planArgs(f, 'control'));
  assert.notEqual(result.code, 0); assert.deepEqual(await readFile(f.planPath), before); assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('CLI rejects malformed or oversized private plan files and cannot use a plan to select another path', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); assert.equal((await f.call(planArgs(f, 'control'))).code, 0);
  const valid = await readLockRetirementPlan(f.planPath), names = await readdir(f.directory);
  const wrongPath = structuredClone(valid); wrongPath.target.name = '../store.json';
  for (const value of [wrongPath, { ...valid, force: true }, Buffer.alloc(128 * 1024 + 1, 32), Buffer.from([0xc3, 0x28])]) {
    await privateFile(f.planPath, value); const result = await f.call(['lock', 'retire', '--plan', f.planPath, '--offline']); assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(f.storePath), f.before);
  }
});

test('CLI rejects empty explicit binding or output instead of falling back to another lock scope', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const names = await readdir(f.directory);
  for (const args of [
    ['lock', 'plan', '--binding', '', '--output', f.planPath],
    ['lock', 'plan', '--output', ''],
  ]) {
    const result = await f.call(args); assert.notEqual(result.code, 0, 'an explicit empty selection must be rejected');
    await assert.rejects(lstat(f.planPath), { code: 'ENOENT' }); assert.deepEqual(await readdir(f.directory), names); assert.deepEqual(await readFile(f.storePath), f.before);
  }
});

test('CLI cannot save a control-character output path that its private plan reader would refuse', budget, async t => {
  const f = await fixture(t); await f.addLock('control'); const path = `${f.planPath}\n`;
  const result = await f.call(['lock', 'plan', '--output', path, '--json']);
  assert.notEqual(result.code, 0, 'plan writer and private plan reader must agree on allowed paths');
  await assert.rejects(lstat(path), { code: 'ENOENT' }); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('CLI refuses overbroad output parents and input plan permissions without repairing them', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.addLock('control'); const broad = join(f.root, 'broad'); await mkdir(broad, { mode: 0o777 }); await chmod(broad, 0o777);
  const output = join(broad, 'plan.json'), result = await f.call(['lock', 'plan', '--output', output]); assert.notEqual(result.code, 0); await assert.rejects(lstat(output), { code: 'ENOENT' }); assert.equal((await lstat(broad)).mode & 0o777, 0o777);
  assert.equal((await f.call(planArgs(f, 'control'))).code, 0); await chmod(f.planPath, 0o644);
  assert.notEqual((await f.call(['lock', 'retire', '--plan', f.planPath, '--offline'])).code, 0); assert.equal((await lstat(f.planPath)).mode & 0o777, 0o644); assert.deepEqual(await readFile(f.storePath), f.before);
});

test('CLI output symlinks and symlink plan input cannot redirect reads or writes', { ...budget, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.addLock('control'); const target = join(f.root, 'untouched-target.json'); await privateFile(target, 'UNTOUCHED_PRIVATE_TARGET'); await symlink(target, f.planPath);
  assert.notEqual((await f.call(planArgs(f, 'control'))).code, 0); assert.equal(await readFile(target, 'utf8'), 'UNTOUCHED_PRIVATE_TARGET');
  assert.notEqual((await f.call(['lock', 'retire', '--plan', f.planPath, '--offline'])).code, 0); assert.equal(await readFile(target, 'utf8'), 'UNTOUCHED_PRIVATE_TARGET'); assert.deepEqual(await readFile(f.storePath), f.before);
});
