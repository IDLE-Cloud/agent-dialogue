import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const FRAME_PREFIX = 'agent-dialogue/1\n';
const ALIAS = /^[a-z][a-z0-9_-]{0,39}$/;
const FRAME_KEYS = ['version', 'room', 'from', 'to', 'fromBindingId', 'toBindingId', 'fromRevision', 'toRevision', 'text', 'replyTo'];

function fail(message) { throw new Error(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${label} must be a non-empty string.`);
  return value;
}
function controlDirectory(context) {
  return join(nonempty(context?.stateDir, 'context.stateDir'), 'dialogue');
}
function freshStore() { return { version: 1, bindings: {}, rooms: {} }; }
function validateStore(store) {
  if (!object(store) || store.version !== 1 || !object(store.bindings) || !object(store.rooms)) fail('Invalid dialogue control store.');
  return store;
}

/** Read control metadata only. hcom remains the authoritative message body store. */
export async function readStore(context) {
  try { return validateStore(JSON.parse(await readFile(join(controlDirectory(context), 'store.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return freshStore(); throw error; }
}

/** Fail closed on a concurrent or stale lock; never guess that another writer died. */
export async function withStore(context, fn) {
  const dir = controlDirectory(context), lock = join(dir, '.lock');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail(`Dialogue control store is busy: ${lock}. A stale lock requires explicit recovery.`);
    throw error;
  }
  const temporary = join(dir, `.store-${randomUUID()}.tmp`);
  try {
    const store = await readStore(context);
    const value = await fn(store);
    validateStore(store);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(temporary, 0o600);
    await rename(temporary, join(dir, 'store.json'));
    return value;
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}

export function validateAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) fail('Alias must start with a lowercase letter and contain 1–40 lowercase letters, digits, underscores or hyphens.');
  return alias;
}

export function resolveBinding(store, alias) {
  validateAlias(alias);
  if (!Object.hasOwn(store.bindings, alias) || !store.bindings[alias]?.active) fail(`Unknown or inactive binding: ${alias}.`);
  return store.bindings[alias];
}

export function createBinding(store, input) {
  const alias = validateAlias(input?.alias);
  if (alias === 'operator') fail('operator is reserved for explicit user messages.');
  if (Object.hasOwn(store.bindings, alias)) fail(`Binding alias already exists: ${alias}.`);
  const native = {};
  for (const key of ['harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin']) native[key] = nonempty(input[key], key);
  for (const binding of Object.values(store.bindings)) {
    if (binding.active && binding.harness === native.harness && binding.serviceId === native.serviceId && binding.sessionId === native.sessionId) {
      fail(`Native session is already bound as ${binding.alias}.`);
    }
  }
  const binding = { alias, id: `b_${randomUUID()}`, revision: 1, ...native, hcomName: `d${randomBytes(6).toString('hex')}`, active: true };
  store.bindings[alias] = binding;
  return binding;
}

export function createRoom(store, { name, members } = {}) {
  nonempty(name, 'Room name');
  if (!Array.isArray(members) || members.length < 2 || new Set(members).size !== members.length) fail('A room requires at least two distinct binding aliases.');
  const pins = members.map(alias => {
    const binding = resolveBinding(store, alias);
    return { alias: binding.alias, bindingId: binding.id, revision: binding.revision };
  });
  const room = { id: `r_${randomUUID()}`, name, members: pins };
  store.rooms[room.id] = room;
  return room;
}

export function resolveRoom(store, id) {
  nonempty(id, 'Room ID');
  if (!Object.hasOwn(store.rooms, id) || store.rooms[id]?.id !== id) fail(`Unknown room ID: ${id}. Use the exact room ID, not its display name.`);
  return store.rooms[id];
}

function resolvePinned(store, room, alias) {
  const binding = resolveBinding(store, alias);
  const pin = room.members.find(member => member.alias === alias);
  if (!pin) fail(`Binding ${alias} is not a member of room ${room.id}.`);
  if (binding.id !== pin.bindingId || binding.revision !== pin.revision) fail(`Stale room binding for ${alias}; explicit room membership update is required.`);
  return binding;
}

export function validateRoute(store, { room: roomId, from, to, expectedSession, replyTo } = {}) {
  const room = resolveRoom(store, roomId);
  const source = from === 'operator' ? { alias: 'operator', id: 'operator', revision: 1 } : resolvePinned(store, room, from);
  const destination = resolvePinned(store, room, to);
  if (source.alias === destination.alias) fail('Source and destination must be distinct participants.');
  if (expectedSession !== undefined && expectedSession !== destination.sessionId) fail(`Expected session does not match binding ${to}.`);
  if (replyTo !== undefined && replyTo !== null) nonempty(replyTo, 'replyTo');
  return { room, from: source, to: destination };
}

function validateFrame(frame) {
  if (!object(frame)) fail('Invalid dialogue frame: expected an object.');
  for (const key of FRAME_KEYS) if (!Object.hasOwn(frame, key)) fail(`Invalid dialogue frame: missing ${key}.`);
  if (frame.version !== 1) fail('Unsupported dialogue frame version.');
  nonempty(frame.room, 'Frame room');
  validateAlias(frame.from); validateAlias(frame.to);
  nonempty(frame.fromBindingId, 'Frame source binding ID');
  nonempty(frame.toBindingId, 'Frame destination binding ID');
  for (const key of ['fromRevision', 'toRevision']) {
    if (!Number.isSafeInteger(frame[key]) || frame[key] < 1) fail(`Invalid dialogue frame ${key}.`);
  }
  nonempty(frame.text, 'Frame text');
  if (frame.replyTo !== null) nonempty(frame.replyTo, 'Frame replyTo');
  return frame;
}

export function encodeFrame(payload) { return FRAME_PREFIX + JSON.stringify(validateFrame(payload)); }

export function decodeFrame(text) {
  if (typeof text !== 'string' || !text.startsWith(FRAME_PREFIX)) fail('Unframed hcom message: expected agent-dialogue/1 protocol.');
  let frame;
  try { frame = JSON.parse(text.slice(FRAME_PREFIX.length)); }
  catch { fail('Invalid dialogue frame JSON.'); }
  return validateFrame(frame);
}

/** Run immediately before submitting text to the exact native session. */
export function validateIncoming(store, binding, frame) {
  validateFrame(frame);
  const route = validateRoute(store, { room: frame.room, from: frame.from, to: frame.to, replyTo: frame.replyTo });
  const identityFields = ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId', 'remote'];
  if (!binding || identityFields.some(key => binding[key] !== route.to[key])) {
    fail('Incoming frame is for a different or stale destination binding.');
  }
  if (frame.fromBindingId !== route.from.id || frame.fromRevision !== route.from.revision || frame.toBindingId !== route.to.id || frame.toRevision !== route.to.revision) {
    fail('Incoming frame has stale or mismatched binding IDs/revisions.');
  }
  return route;
}
