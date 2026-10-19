import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPrivateControlDirectory, readStore, resolveBinding, validateStore, withOwnedDirectoryLock, withStore } from './bridge-store.mjs';

const permits = new WeakMap();
const IDENTITY_FIELDS = ['alias', 'id', 'revision', 'harness', 'serviceId', 'sessionId', 'projectId', 'directory', 'origin', 'hcomName', 'active', 'nodeId', 'remote'];
const error = (code, message) => Object.assign(new Error(message), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const copy = value => structuredClone(value);

function exactBinding(store, input, { allowInactive = false } = {}) {
  const alias = typeof input === 'string' ? input : input?.alias;
  const live = allowInactive && typeof alias === 'string' && Object.hasOwn(store.bindings, alias) ? store.bindings[alias] : resolveBinding(store, alias);
  if (typeof input !== 'string' && (!input || IDENTITY_FIELDS.some(key => input[key] !== live[key]))) throw error('BINDING_CHANGED', 'The exact binding identity changed; select and verify it again.');
  return live;
}
function localBinding(store, input) {
  const live = exactBinding(store, input);
  if (live.remote) throw error('REMOTE_LIFECYCLE_UNSUPPORTED', 'Lifecycle operations must run on the binding owning node.');
  if (typeof live.id !== 'string' || !/^b_[0-9a-f-]+$/.test(live.id) || !Number.isSafeInteger(live.revision) || live.revision < 1) throw error('BINDING_CHANGED', 'Invalid binding identity.');
  return live;
}
function requireV2(store) {
  if (store.version !== 2) throw error('LIFECYCLE_UPGRADE_REQUIRED', 'Pause and resume require an explicit offline state upgrade.');
}
async function control(context, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { return await withStore(context, fn); }
    catch (failure) {
      if (failure.code !== 'CONTROL_BUSY' || Date.now() >= deadline) throw failure;
      await pause(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

/** Pure normalized state. Absent v1/v2 rows retain the original enabled behavior. */
export function lifecycleState(store, binding) {
  validateStore(store);
  const live = exactBinding(store, binding, { allowInactive: true });
  const row = store.version === 2 ? store.lifecycle[live.id] : undefined;
  return row ? copy(row) : { version: 1, bindingRevision: live.revision, desired: 'enabled', generation: 0, changeNonce: null, changedAt: null, reason: null };
}

/** Pure final admission check; incoming ledger storage does not call this. */
export function requireEnabled(store, binding) {
  const live = localBinding(store, binding);
  if (lifecycleState(store, live).desired !== 'enabled') throw error('BINDING_PAUSED', `Binding ${live.alias} is paused; no new dispatch may begin.`);
  return live;
}

/** Hold only one binding dispatch lock across an actual bounded side effect.
 * The control lock is released before the callback. An opaque, scope-bound
 * permit allows nested send→flush without recursive lock acquisition. */
export async function withDispatch(context, input, fn, { allowPaused = false, timeoutMs = 30000, permit } = {}) {
  if (typeof fn !== 'function' || typeof allowPaused !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw error('INVALID_DISPATCH_OPTIONS', 'Invalid dispatch options.');
  const initial = localBinding(await readStore(context), input);
  const statePath = resolve(context.stateDir);
  const check = async () => await control(context, store => {
    const binding = localBinding(store, initial);
    if (!allowPaused) requireEnabled(store, binding);
    return { store: copy(store), binding: copy(binding) };
  }, timeoutMs);
  if (permit !== undefined) {
    const owner = permits.get(permit);
    if (!owner?.active || owner.closing || owner.statePath !== statePath || owner.bindingId !== initial.id || owner.bindingRevision !== initial.revision) throw error('INVALID_DISPATCH_PERMIT', 'The dispatch permit is invalid, expired, or belongs to another binding.');
    const action = (async () => {
      const checked = await check();
      if (!owner.active) throw error('INVALID_DISPATCH_PERMIT', 'The dispatch permit expired before admission.');
      return await fn({ ...checked, permit });
    })();
    owner.pending.add(action);
    try { return await action; } finally { owner.pending.delete(action); }
  }
  return await withOwnedDirectoryLock(context, { name: `${initial.id}.dispatch.lock`, role: 'dispatch', binding: initial, timeoutMs }, async () => {
    const opaque = Object.freeze(Object.create(null));
    const record = { statePath, bindingId: initial.id, bindingRevision: initial.revision, active: true, closing: false, pending: new Set() };
    permits.set(opaque, record);
    try { return await fn({ ...await check(), permit: opaque }); }
    finally {
      record.closing = true;
      // Even accidentally unawaited nested work must finish before releasing D.
      // New work cannot consume this permit after its root callback returns.
      await Promise.allSettled([...record.pending]);
      record.active = false; permits.delete(opaque);
    }
  });
}

function row(binding, previous, desired) {
  return { version: 1, bindingRevision: binding.revision, desired, generation: previous.generation + 1, changeNonce: randomUUID(), changedAt: new Date().toISOString(), reason: desired === 'paused' ? 'operator-pause' : 'operator-resume' };
}
export async function pauseBinding(context, alias, { timeoutMs = 30000, expectedChangeNonce } = {}) {
  return await withDispatch(context, alias, async ({ binding }) => await control(context, store => {
    requireV2(store);
    const live = localBinding(store, binding), previous = lifecycleState(store, live);
    if (expectedChangeNonce !== undefined && previous.changeNonce !== expectedChangeNonce) throw error('LIFECYCLE_CHANGED', 'A newer lifecycle change exists; conditional pause was not applied.');
    if (previous.desired !== 'paused') store.lifecycle[live.id] = row(live, previous, 'paused');
    return { binding: copy(live), lifecycle: lifecycleState(store, live) };
  }, timeoutMs), { allowPaused: true, timeoutMs });
}

/** The complete local identity, relevant room membership and lifecycle CAS. */
export function resumeSnapshot(store, input) {
  requireV2(store);
  const binding = localBinding(store, input);
  const rooms = Object.values(store.rooms).filter(room => room.members?.some(pin => pin.bindingId === binding.id)).map(room => ({ id: room.id, revision: room.revision ?? null, ownerNodeId: room.ownerNodeId ?? null, manifestHash: room.manifestHash ?? null, members: copy(room.members) })).sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, binding: Object.fromEntries(IDENTITY_FIELDS.map(key => [key, binding[key] ?? null])), rooms, lifecycle: lifecycleState(store, binding) };
}
function sameSnapshot(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** Verification runs under dispatch but never under the control lock. Failure
 * or a changed snapshot leaves the pause and all worker progress untouched. */
export async function resumeBinding(context, alias, { snapshot, verify, timeoutMs = 30000 } = {}) {
  if (!snapshot || snapshot.version !== 1 || (verify !== undefined && typeof verify !== 'function')) throw error('INVALID_RESUME_SNAPSHOT', 'Resume requires an exact verified lifecycle snapshot.');
  return await withDispatch(context, alias, async ({ binding, store, permit }) => {
    requireV2(store);
    if (!sameSnapshot(resumeSnapshot(store, binding), snapshot)) throw error('LIFECYCLE_CHANGED', 'Binding identity, room pins, or lifecycle changed; inspect and verify again.');
    if (verify) await verify({ binding, store, permit });
    return await control(context, liveStore => {
      const live = localBinding(liveStore, binding);
      if (!sameSnapshot(resumeSnapshot(liveStore, live), snapshot)) throw error('LIFECYCLE_CHANGED', 'Binding identity, room pins, or lifecycle changed; inspect and verify again.');
      const previous = lifecycleState(liveStore, live);
      if (previous.desired !== 'enabled') liveStore.lifecycle[live.id] = row(live, previous, 'enabled');
      return { binding: copy(live), lifecycle: lifecycleState(liveStore, live) };
    }, timeoutMs);
  }, { allowPaused: true, timeoutMs });
}

async function defaultQuiescent(context) {
  const dir = join(context.stateDir, 'dialogue');
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.worker.json')) continue;
    const path = join(dir, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw error('STATE_NOT_QUIESCENT', 'Worker evidence cannot be safely inspected for offline upgrade.');
    let runtime;
    try { runtime = JSON.parse(await readFile(path, 'utf8')); } catch { throw error('STATE_NOT_QUIESCENT', 'Worker evidence cannot be safely inspected for offline upgrade.'); }
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) || runtime.pid || ['ready', 'registered', 'starting', 'launching'].includes(runtime.status)) throw error('STATE_NOT_QUIESCENT', 'Worker ownership must be verified before offline upgrade.');
  }
}
/** offline is an operator assertion: it cannot discover every CLI/SSH/MCP
 * writer. Known lock/reservation evidence is independently refused. */
export async function upgradeStoreOffline(context, { offline } = {}, { assertQuiescent } = {}) {
  if (offline !== true) throw error('OFFLINE_REQUIRED', 'Offline upgrade requires an explicit declaration that every writer is quiescent.');
  if (assertQuiescent !== undefined && typeof assertQuiescent !== 'function') throw error('INVALID_UPGRADE_OPTIONS', 'Invalid offline upgrade verifier.');
  return await control(context, async store => {
    await assertPrivateControlDirectory(context);
    const names = await readdir(join(context.stateDir, 'dialogue'));
    if (names.some(name => name.endsWith('.dispatch.lock') || name.endsWith('.worker.lock'))) throw error('STATE_NOT_QUIESCENT', 'Existing dispatch or worker locks prevent offline upgrade.');
    if (Object.values(store.workerLaunches || {}).some(value => value?.phase !== 'stopped')) throw error('STATE_NOT_QUIESCENT', 'Unresolved worker launch reservations prevent offline upgrade.');
    await (assertQuiescent || defaultQuiescent)(context, copy(store));
    const upgraded = store.version === 1;
    if (upgraded) { store.version = 2; store.lifecycle = {}; }
    return { version: store.version, upgraded };
  });
}
