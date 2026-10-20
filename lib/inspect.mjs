import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeClient } from './adapters.mjs';
import { readExistingNode, payloadHash, validatePublicNode } from './node-identity.mjs';
import { validateTransport } from './node-transport.mjs';
import { summarizeForwardings, validateStore } from './bridge-store.mjs';
import { lifecycleState } from './lifecycle.mjs';

const MAX_JSON = 4 * 1024 * 1024, MAX_RECORDS = 1000;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BINDING = new RegExp(`^b_${UUID}$`), ROOM = new RegExp(`^r_${UUID}$`);
const TOKEN = new RegExp(`^${UUID}(?![\\s\\S])`, 'i');
const NODE = /^n_[a-f0-9]{64}$/, HASH = /^[a-f0-9]{64}$/;
const HARNESSES = new Set(['opencode-v2', 'opencode-v1', 'codex-app-server', 'kimi-code', 'zcode-tools']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const printable = (value, max = 8192) => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const signature = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const fault = code => Object.assign(new Error('Inspect metadata is unavailable.'), { inspectCode: code });
const own = (value, key) => Object.hasOwn(value, key);

function validateOptions(context, options) {
  if (!object(context) || !isAbsolute(context.stateDir || '') || typeof context.cacheDir !== 'string' || !isAbsolute(context.cacheDir) || !['embedded', 'hcom'].includes(context.ledgerBackend)) throw new Error('Inspect requires a valid dedicated runtime context.');
  if (!object(options) || Object.keys(options).some(key => !['binding', 'room', 'native', 'allowSessionLoad'].includes(key))) throw new Error('Inspect received invalid options.');
  if (options.binding !== undefined && (!printable(options.binding, 40) || !ALIAS.test(options.binding))) throw new Error('Inspect --binding requires an exact valid alias.');
  if (options.room !== undefined && (!printable(options.room, 40) || !ROOM.test(options.room))) throw new Error('Inspect --room requires a complete room ID.');
  for (const key of ['native', 'allowSessionLoad']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Inspect probe switches must be boolean.');
  if (options.native && !options.binding) throw new Error('Inspect --native requires --binding with an exact local alias.');
  if (options.allowSessionLoad && !options.native) throw new Error('Inspect --allow-session-load requires --native and an exact Kimi binding.');
}
async function info(path, directory = false) {
  const value = await lstat(path);
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) throw fault('STATE_UNSAFE_PATH');
  return value;
}
async function bytes(path, limit = MAX_JSON, headerOnly = false) {
  const before = await info(path);
  if (!headerOnly && before.size > limit) throw fault('FILE_TOO_LARGE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || signature(opened) !== signature(before)) throw fault('FILE_CHANGED_DURING_READ');
    const chunks = []; let count = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, limit + (headerOnly ? 0 : 1) - count));
      if (!buffer.length) break;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead; if (count > limit) throw fault('FILE_TOO_LARGE'); chunks.push(buffer.subarray(0, bytesRead));
      if (headerOnly && count >= limit) break;
    }
    const after = await handle.stat(), pathAfter = await info(path);
    if (signature(after) !== signature(before) || signature(pathAfter) !== signature(before)) throw fault('FILE_CHANGED_DURING_READ');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
async function json(path, limit = MAX_JSON) {
  const data = await bytes(path, limit);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw fault('INVALID_JSON'); }
}
function readFailure(error, fallback) {
  if (error?.inspectCode && error.inspectCode !== 'INVALID_JSON') return error.inspectCode;
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'STATE_UNREADABLE';
  if (error?.code === 'ELOOP') return 'STATE_UNSAFE_PATH';
  return fallback;
}
function action(code, argv = [], { mutates = false, mayLoadSession = false } = {}) {
  return { code, command: ['agent-dialogue', ...argv], mutates, mayLoadSession };
}
function check(report, code, status, message, { scope = {}, source = 'local-control', kind = 'file-metadata', probed = true, actions = [] } = {}) {
  report.checks.push({ id: `${code.toLowerCase()}:${Object.values(scope).join(':')}`, code, status, scope, evidence: { source, kind, probed }, message, actions });
}
function finish(report, unconfigured = false) {
  const summary = { ok: 0, warn: 0, blocked: 0, notProbed: 0, needsReview: 0 };
  for (const row of report.checks) summary[{ 'not-probed': 'notProbed', 'needs-review': 'needsReview' }[row.status] || row.status]++;
  report.summary = summary;
  report.overall = summary.blocked ? 'blocked' : summary.needsReview ? 'needs-review' : unconfigured ? 'unconfigured' : 'ready-local';
  report.exitCode = summary.blocked || summary.needsReview ? 1 : 0;
  return report;
}
function bindingProjection(binding, store) {
  const result = {};
  for (const key of ['alias', 'id', 'revision', 'harness', 'sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName', 'active', 'nodeId', 'remote']) if (own(binding, key)) result[key] = binding[key];
  const lifecycle = binding.remote ? null : binding.active ? lifecycleState(store, binding) : store.lifecycle?.[binding.id] || { bindingRevision: binding.revision, desired: 'enabled', generation: 0, changedAt: null };
  result.lifecycle = lifecycle ? Object.fromEntries(['bindingRevision', 'desired', 'generation', 'changedAt'].map(key => [key, lifecycle[key]])) : null;
  return result;
}
function validOrigin(value) {
  if (!printable(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (['http:', 'https:'].includes(url.protocol)) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      return (host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) && value === url.origin;
    }
    if (url.protocol === 'unix:') return value.startsWith('unix:///') && !url.host && url.pathname.startsWith('/');
    if (url.protocol === 'zcode-tools:') return new RegExp(`^zcode-tools://${UUID}$`).test(value);
    return false;
  } catch { return false; }
}
function validBinding(binding, alias) {
  return object(binding) && ALIAS.test(alias) && binding.alias === alias && BINDING.test(binding.id || '') && positive(binding.revision) && HARNESSES.has(binding.harness) && typeof binding.active === 'boolean' &&
    ['sessionId', 'projectId', 'directory', 'serviceId', 'origin', 'hcomName'].every(key => printable(binding[key])) && validOrigin(binding.origin) &&
    (binding.nodeId === undefined || NODE.test(binding.nodeId)) && (binding.remote === undefined || typeof binding.remote === 'boolean');
}
function validRoom(room, id) {
  return object(room) && ROOM.test(id) && room.id === id && printable(room.name, 4096) && Array.isArray(room.members) && room.members.length >= 2 && room.members.length <= MAX_RECORDS &&
    new Set(room.members.map(member => member?.alias)).size === room.members.length && room.members.every(member => object(member) && ALIAS.test(member.alias || '') && BINDING.test(member.bindingId || '') && positive(member.revision) && (member.nodeId === undefined || NODE.test(member.nodeId)));
}
function roomProjection(room) {
  const result = { id: room.id, name: room.name, members: room.members.map(member => ({ alias: member.alias, bindingId: member.bindingId, revision: member.revision, ...(member.nodeId ? { nodeId: member.nodeId } : {}) })) };
  for (const key of ['revision', 'ownerNodeId', 'manifestHash']) if (own(room, key) && (key === 'revision' ? positive(room[key]) : key === 'ownerNodeId' ? typeof room[key] === 'string' && NODE.test(room[key]) : typeof room[key] === 'string' && HASH.test(room[key]))) result[key] = room[key];
  return result;
}

async function inspectLedger(report, context) {
  try {
    const data = await bytes(join(context.stateDir, 'hcom.db'), 100, true);
    if (data.length !== 100 || !data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw fault('LEDGER_HEADER_UNSUPPORTED');
    const applicationId = data.readUInt32BE(68), userVersion = data.readUInt32BE(60);
    if (context.ledgerBackend === 'embedded' && applicationId !== 0x41444c47 || context.ledgerBackend === 'hcom' && applicationId === 0x41444c47) throw fault('LEDGER_BACKEND_MISMATCH');
    if (context.ledgerBackend === 'embedded' && userVersion !== 1) throw fault('LEDGER_HEADER_UNSUPPORTED');
    check(report, 'LEDGER_HEADER_VALID', 'ok', 'The existing SQLite header matches the selected ledger backend; the database was not opened.', { source: 'ledger-header' });
    check(report, 'LEDGER_SCHEMA_NOT_PROBED', 'not-probed', 'Full ledger schema, message history and consistency were not queried.', { source: 'ledger-header', kind: 'not-requested', probed: false });
  } catch (error) {
    if (error.code === 'ENOENT') check(report, 'LEDGER_MISSING', 'warn', 'No existing ledger was found; none was initialized.', { actions: [action('SETUP_LEDGER', ['setup'], { mutates: true })] });
    else check(report, readFailure(error, 'LEDGER_HEADER_UNSUPPORTED'), 'blocked', 'The selected ledger header cannot be safely validated.');
  }
  try {
    const journal = await info(join(context.stateDir, 'hcom.db-journal'));
    if (journal.size > 0) check(report, 'LEDGER_ROLLBACK_JOURNAL_PRESENT', 'needs-review', 'An existing rollback journal requires offline review; no SQLite connection was opened.');
  } catch (error) { if (error.code !== 'ENOENT') check(report, readFailure(error, 'LEDGER_SIDECAR_UNREADABLE'), 'needs-review', 'The ledger sidecar metadata cannot be safely read.'); }
}

async function inspectNode(report, context) {
  const path = join(context.stateDir, 'dialogue', 'node.json');
  try {
    const nodeInfo = await info(path);
    if (nodeInfo.size > 16384) throw fault('NODE_IDENTITY_INVALID');
    if (process.platform !== 'win32' && ((nodeInfo.mode & 0o077) !== 0 || nodeInfo.uid !== process.getuid())) throw fault('NODE_PRIVATE_INVALID');
    report.effects.permissionMetadataProbe = process.platform === 'win32';
    // Identity verification is delegated to the existing private signing-key reader;
    // confirm that its source still has the same metadata after validation.
    const node = await readExistingNode(context);
    if (signature(await info(path)) !== signature(nodeInfo)) throw fault('FILE_CHANGED_DURING_READ');
    report.node = { nodeId: node.nodeId, name: node.name, signingKeyValidated: true };
    check(report, 'NODE_IDENTITY_VALID', 'ok', 'The existing node signing identity and private-file permissions were validated.', { source: 'node-identity' });
    return node;
  } catch (error) {
    if (error.code === 'ENOENT') check(report, 'NODE_MISSING', 'warn', 'No existing node identity was found; local legacy rooms remain usable and no key was created.', { actions: [action('INITIALIZE_NODE', ['node', 'init', '--name', 'chosen-node'], { mutates: true })] });
    else check(report, readFailure(error, 'NODE_IDENTITY_INVALID'), 'blocked', 'The existing node identity or private-file permissions could not be validated; no key was replaced.');
    return null;
  }
}

async function inspectWorker(report, context, binding) {
  const scope = { alias: binding.alias, bindingId: binding.id, revision: binding.revision };
  if (binding.remote) { check(report, 'PEER_NOT_PROBED', 'not-probed', 'Remote owner and transport availability were not probed; no SSH was started.', { scope, source: 'peer-control', kind: 'not-requested', probed: false }); return; }
  const root = join(context.stateDir, 'dialogue'), path = join(root, `${binding.id}.worker.json`); let runtime = null;
  try {
    runtime = await json(path);
    if (!object(runtime) || runtime.cursor !== undefined && (!Number.isSafeInteger(runtime.cursor) || runtime.cursor < 0) || runtime.status !== undefined && !['starting', 'ready', 'waiting-native', 'paused', 'stopping', 'error', 'stopped'].includes(runtime.status)) throw fault('WORKER_RUNTIME_INVALID');
    check(report, 'WORKER_RUNTIME_RECORDED', 'ok', 'A worker runtime record exists; it is historical metadata, not proof of a live owned process.', { scope, source: 'worker-runtime' });
    if (runtime.error || runtime.status === 'error') check(report, 'WORKER_REPORTED_ERROR', 'needs-review', 'The worker recorded an error; review its local runtime and log without replaying unknown inputs.', { scope, source: 'worker-runtime' });
    if (runtime.pending) check(report, 'NATIVE_PENDING', 'needs-review', 'A native input has a pending outcome; preserve its original input ID and reconcile before retrying.', { scope, source: 'worker-runtime' });
    if (runtime.outgoingPending) check(report, 'OUTGOING_PENDING', 'needs-review', 'A local queued request has a pending forwarding outcome; preserve its original request and message association.', { scope, source: 'worker-runtime' });
  } catch (error) {
    if (error.code === 'ENOENT') check(report, 'WORKER_RUNTIME_MISSING', 'warn', 'No worker runtime record was found; no worker was started.', { scope, source: 'worker-runtime' });
    else check(report, readFailure(error, 'WORKER_RUNTIME_INVALID'), 'needs-review', 'Worker runtime metadata cannot be safely read.', { scope, source: 'worker-runtime' });
  }
  try {
    await info(join(root, `${binding.id}.dispatch.lock`), true);
    check(report, 'DISPATCH_LOCK_PRESENT', 'needs-review', 'A binding dispatch lock exists; new dispatch or lifecycle operations may be blocked. Preserve its original owner evidence for explicit review; no lock was removed.', { scope, source: 'binding-dispatch-lock' });
  } catch (error) {
    if (error.code !== 'ENOENT') check(report, 'DISPATCH_LOCK_UNREADABLE', 'needs-review', 'Binding dispatch lock metadata cannot be safely read. Preserve its owner evidence; no lock was removed.', { scope, source: 'binding-dispatch-lock' });
  }
  const lock = join(root, `${binding.id}.worker.lock`);
  try {
    await info(lock, true); let owner;
    try { owner = await json(join(lock, 'owner.json'), 16384); }
    catch (error) { check(report, readFailure(error, 'WORKER_LOCK_WITHOUT_OWNER'), 'needs-review', 'The worker lock has no safely readable owner evidence; it was preserved.', { scope, source: 'worker-lock' }); return; }
    if (!object(owner) || !positive(owner.pid) || !printable(owner.token, 256) || !runtime || runtime.pid !== owner.pid || runtime.token !== owner.token) check(report, 'WORKER_OWNER_MISMATCH', 'needs-review', 'Worker lock ownership and runtime metadata do not match; the lock was preserved.', { scope, source: 'worker-lock' });
    else check(report, 'WORKER_OWNER_RECORDED', 'ok', 'Worker lock and runtime ownership records agree; the process itself was not probed.', { scope, source: 'worker-lock' });
  } catch (error) { if (error.code !== 'ENOENT') check(report, readFailure(error, 'WORKER_LOCK_UNREADABLE'), 'needs-review', 'Worker lock metadata cannot be safely read.', { scope, source: 'worker-lock' }); }
  check(report, 'WORKER_PROCESS_NOT_PROBED', 'not-probed', 'Owned worker process liveness was not verified and no process was signalled.', { scope, source: 'worker-runtime', kind: 'not-requested', probed: false });
}

function inspectRoom(report, store, room, node) {
  const scope = { roomId: room.id }; let good = true;
  for (const member of room.members) {
    const binding = own(store.bindings, member.alias) ? store.bindings[member.alias] : null;
    if (!binding?.active || !validBinding(binding, member.alias) || binding.id !== member.bindingId || binding.revision !== member.revision || member.nodeId && (binding.nodeId || node?.nodeId) !== member.nodeId) {
      check(report, 'ROOM_STALE_BINDING', 'blocked', 'A room member no longer matches its exact active binding pins.', { scope: { ...scope, alias: member.alias } }); good = false; continue;
    }
    if (binding.remote && (!binding.nodeId || !object(store.peers) || !own(store.peers, binding.nodeId))) {
      check(report, 'ROOM_PEER_UNPAIRED', 'blocked', 'A remote room member has no explicitly paired owner.', { scope: { ...scope, alias: member.alias } }); good = false;
    }
  }
  const signed = room.manifestHash !== undefined || room.ownerNodeId !== undefined || room.members.some(member => member.nodeId !== undefined);
  if (signed) {
    if (!node) { check(report, 'ROOM_NODE_IDENTITY_REQUIRED', 'blocked', 'A pinned cross-node room requires the existing local node identity.', { scope }); good = false; }
    try {
      if (!positive(room.revision) || !NODE.test(room.ownerNodeId || '') || !HASH.test(room.manifestHash || '') || room.members.some(member => !NODE.test(member.nodeId || ''))) throw new Error();
      const manifest = { type: 'room', version: 1, id: room.id, name: room.name, revision: room.revision, ownerNodeId: room.ownerNodeId, members: room.members.map(member => ({ alias: member.alias, bindingId: member.bindingId, revision: member.revision, nodeId: member.nodeId })) };
      if (payloadHash(manifest) !== room.manifestHash) throw new Error();
    } catch { check(report, 'ROOM_MANIFEST_INVALID', 'blocked', 'The stored room manifest hash or signed routing metadata is invalid.', { scope }); good = false; }
  }
  if (good) check(report, 'ROOM_PINS_VALID', 'ok', 'Room membership matches the stored exact active binding pins.', { scope });
}

async function probeNative(report, context, binding, options, nativeFactory) {
  const scope = { alias: binding.alias, bindingId: binding.id, revision: binding.revision };
  if (!options.native) { check(report, 'NATIVE_NOT_PROBED', 'not-probed', 'The native service and selected chat were not contacted.', { scope, source: 'native-service', kind: 'not-requested', probed: false, actions: [action('INSPECT_NATIVE', ['inspect', '--binding', binding.alias, '--native'])] }); return; }
  if (binding.remote) { check(report, 'NATIVE_REQUIRES_OWNER_INSPECTION', 'not-probed', 'Inspect the native service on its owning node; no local native adapter or SSH was started.', { scope, source: 'native-service', kind: 'not-requested', probed: false }); return; }
  if (!binding.active) { check(report, 'NATIVE_DETACHED_NOT_PROBED', 'not-probed', 'This historical binding is detached; its native service was not contacted.', { scope, source: 'native-service', kind: 'not-requested', probed: false }); return; }
  if (binding.harness === 'kimi-code' && !options.allowSessionLoad) {
    check(report, 'KIMI_SESSION_LOAD_NOT_REQUESTED', 'not-probed', 'Kimi session reads may load a cold chat; no discovery or API call was made. Add --allow-session-load only for this server-owned chat.', { scope, source: 'native-service', kind: 'not-requested', probed: false, actions: [action('INSPECT_KIMI_SESSION', ['inspect', '--binding', binding.alias, '--native', '--allow-session-load'], { mayLoadSession: true })] }); return;
  }
  const toolInbox = binding.harness === 'zcode-tools';
  report.effects.nativeContact = !toolInbox;
  report.effects.mayUpdateNativeMetadata = !toolInbox;
  report.effects.mayLoadSession = binding.harness === 'kimi-code';
  if (toolInbox && process.platform === 'win32') report.effects.permissionMetadataProbe = true;
  let client;
  try { client = await nativeClient(context, binding.harness, { factory: nativeFactory }); }
  catch { check(report, 'NATIVE_SERVICE_UNAVAILABLE', 'needs-review', 'The selected service or local registration could not be inspected; no submission or service restart was attempted.', { scope, source: toolInbox ? 'zcode-registration' : 'native-service', kind: toolInbox ? 'local-registration' : 'native-query' }); return; }
  try {
    if (client.identity.serviceId !== binding.serviceId || client.identity.origin !== binding.origin) { check(report, 'NATIVE_IDENTITY_CHANGED', 'blocked', 'The selected native service identity changed; keep the old binding stopped and select the intended service explicitly.', { scope, source: 'native-service', kind: 'native-query' }); return; }
    let session;
    try { session = await client.session(binding.sessionId); }
    catch { check(report, 'NATIVE_SERVICE_UNAVAILABLE', 'needs-review', 'The exact selected session could not be queried; preserve pending state and inspect the selected service locally.', { scope, source: toolInbox ? 'zcode-registration' : 'native-service', kind: toolInbox ? 'local-registration' : 'native-query' }); return; }
    if (!session || session.id !== binding.sessionId || session.projectID !== binding.projectId || !printable(session.location?.directory) || resolve(session.location.directory) !== binding.directory || session.time?.archived) {
      check(report, 'NATIVE_SESSION_MISMATCH', 'blocked', 'The observed session, project or directory does not match the exact binding.', { scope, source: toolInbox ? 'zcode-registration' : 'native-service', kind: toolInbox ? 'local-registration' : 'native-query' }); return;
    }
    if (toolInbox) {
      check(report, 'ZCODE_REGISTRATION_OBSERVED', 'ok', 'The exact host-observed ZCode registration matches this binding; delivery remains tool-pull with autoWake=false.', { scope, source: 'zcode-registration', kind: 'local-registration' });
      check(report, 'ZCODE_NATIVE_LIVENESS_UNAVAILABLE', 'not-probed', 'Saved registration does not prove that the desktop window is currently online, awake or processing an inbox.', { scope, source: 'zcode-registration', kind: 'unsupported', probed: false });
    } else {
      check(report, 'NATIVE_SESSION_MATCH', 'ok', 'The selected service and exact session/project/directory match; no model input was submitted.', { scope, source: 'native-service', kind: 'native-query' });
      if (session.pendingInteraction === 'approval' || session.pendingInteraction === 'question') check(report, 'NATIVE_APPROVAL_WAIT', 'warn', 'The selected chat has a pending native interaction; the inspection did not answer it.', { scope, source: 'native-service', kind: 'native-query' });
      else if (session.busy || session.mainTurnActive || session.nativeStatus === 'running' || session.native?.status === 'active') check(report, 'NATIVE_BUSY', 'warn', 'The selected chat is busy; this inspection did not enqueue or steer it.', { scope, source: 'native-service', kind: 'native-query' });
      if (binding.harness === 'codex-app-server' && (session.loaded === false || session.native?.loaded === false)) check(report, 'NATIVE_NOT_LOADED', 'warn', 'The Codex thread is not loaded; it was not resumed or started.', { scope, source: 'native-service', kind: 'native-query' });
    }
  } finally { try { await client.close?.(); } catch { check(report, 'NATIVE_INSPECTION_CLOSE_FAILED', 'warn', 'The inspection client could not confirm closure; no model input was submitted.', { scope, source: 'native-service' }); } }
}

/** Fixed-field local diagnostics. Reads never initialize state, SQLite, native services or SSH. */
export async function inspect(context, options = {}, { nativeFactory, clock = () => new Date() } = {}) {
  validateOptions(context, options);
  const now = clock(), observedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const report = { schemaVersion: 1, command: 'inspect', mode: options.native ? 'selected-native' : 'local-metadata', observedAt,
    effects: { sourceWrites: false, nativeContact: false, sshContact: false, thirdPartyExecutables: false, modelTurns: false, mayUpdateNativeMetadata: false, mayLoadSession: false, permissionMetadataProbe: false },
    environment: { platform: platform(), arch: arch(), node: process.version, packageVersion: null, ledgerBackend: context.ledgerBackend },
    paths: { stateDir: context.stateDir, cacheDir: context.cacheDir, runtimeDir: typeof context.runtimeDir === 'string' ? context.runtimeDir : null },
    selection: { binding: options.binding ?? null, room: options.room ?? null }, node: null, bindings: [], rooms: [], checks: [] };
  try { const pkg = await json(fileURLToPath(new URL('../package.json', import.meta.url)), 65536); if (printable(pkg.version, 80)) report.environment.packageVersion = pkg.version; }
  catch { check(report, 'PACKAGE_METADATA_UNAVAILABLE', 'warn', 'Installed package version metadata could not be read.'); }
  try { await info(context.stateDir, true); }
  catch (error) {
    if (error.code === 'ENOENT') { check(report, 'STATE_NOT_INITIALIZED', 'warn', 'The selected state directory does not exist; no state, node or cache was initialized.', { source: 'state-directory', actions: [action('READ_SETUP_GUIDE', ['agent-guide'])] }); return finish(report, true); }
    check(report, readFailure(error, 'STATE_UNREADABLE'), 'blocked', 'The selected state directory cannot be safely inspected.'); return finish(report);
  }
  check(report, 'STATE_DIRECTORY_PRESENT', 'ok', 'The selected dedicated state directory already exists.', { source: 'state-directory' });
  await inspectLedger(report, context);
  const directory = join(context.stateDir, 'dialogue');
  try { await info(directory, true); }
  catch (error) {
    if (error.code === 'ENOENT') { check(report, 'STORE_MISSING', 'warn', 'No dialogue control metadata exists; no binding or node was created.'); return finish(report, true); }
    check(report, readFailure(error, 'STATE_UNREADABLE'), 'blocked', 'Dialogue control metadata cannot be safely inspected.'); return finish(report);
  }
  const node = await inspectNode(report, context); let store;
  try {
    store = await json(join(directory, 'store.json'));
    if (!object(store) || ![1, 2, 3].includes(store.version) || !object(store.bindings) || !object(store.rooms)) throw fault(![1, 2, 3].includes(store?.version) ? 'STORE_SCHEMA_UNSUPPORTED' : 'STORE_INVALID');
    for (const key of ['bindings', 'rooms', 'peers', 'inbox', 'outbox', 'mcpSends', 'lifecycle', 'workerLaunches', 'forwardings']) {
      if (store[key] === undefined) continue;
      if (!object(store[key])) throw fault('STORE_INVALID');
      if (Object.keys(store[key]).length > MAX_RECORDS) throw fault('CONTROL_RECORD_LIMIT_EXCEEDED');
    }
    try { validateStore(store); } catch (error) { throw fault(['FORWARDING_INVALID', 'MCP_SEND_INVALID'].includes(error.code) ? error.code : [2, 3].includes(store.version) ? 'LIFECYCLE_INVALID' : 'STORE_INVALID'); }
  } catch (error) {
    if (error.code === 'ENOENT') { check(report, 'STORE_MISSING', 'warn', 'The dialogue control store does not exist; none was created.'); return finish(report, true); }
    const code = readFailure(error, 'STORE_INVALID');
    check(report, code, 'blocked', code === 'CONTROL_RECORD_LIMIT_EXCEEDED' ? 'The existing control metadata exceeds this bounded inspection record limit; this does not establish corruption and no metadata was changed.' : 'The dialogue control store is invalid, unsupported or unreadable.'); return finish(report);
  }
  check(report, 'STORE_VALID', 'ok', 'The existing supported control store was read without acquiring a writer lock.');
  if (store.version === 3) {
    report.forwardings = summarizeForwardings(store, options.binding ? { bindingId: store.bindings[options.binding]?.id ?? '' } : {});
    if (report.forwardings.total > report.forwardings.phases.forwarded) check(report, 'FORWARDING_PENDING', 'needs-review', 'Recorded forwarding provenance has unfinished phases; inspect the original evidence without appending or clearing pending state.', { source: 'forwardings' });
    if (Object.values(store.forwardings).some(row => (!options.binding || row.bindingId === store.bindings[options.binding]?.id) && row.recovery?.phase === 'runtime-prepared')) check(report, 'FORWARDING_RECOVERY_PENDING', 'needs-review', 'A verified forwarding result still has an unfinished runtime receipt checkpoint; no pending state was cleared by inspection.', { source: 'forwarding-recovery' });
  }
  try { await info(join(directory, '.lock'), true); check(report, 'CONTROL_LOCK_PRESENT', 'needs-review', 'A control-store lock exists; no owner was assumed stale and the lock was preserved.'); }
  catch (error) { if (error.code !== 'ENOENT') check(report, readFailure(error, 'CONTROL_LOCK_UNREADABLE'), 'needs-review', 'The control-store lock cannot be safely inspected.'); }
  const selected = options.binding ? own(store.bindings, options.binding) ? [[options.binding, store.bindings[options.binding]]] : [] : Object.entries(store.bindings);
  if (options.binding && !selected.length) check(report, 'BINDING_NOT_FOUND', 'blocked', 'The exact selected binding alias does not exist.');
  if (!options.binding) check(report, 'BINDING_NOT_SELECTED', 'not-probed', 'No single chat was selected for native inspection; stored bindings are listed as local metadata only.', { kind: 'not-requested', probed: false });
  const probeBindings = [];
  for (const [alias, binding] of selected) {
    if (!validBinding(binding, alias)) { check(report, 'BINDING_INVALID', 'blocked', 'A selected stored binding has invalid identity fields.'); continue; }
    const projected = bindingProjection(binding, store); report.bindings.push(projected);
    const scope = { alias, bindingId: binding.id, revision: binding.revision };
    if (!binding.active) check(report, 'BINDING_DETACHED', 'warn', 'The binding is historical and detached; it is not a resumable pause.', { scope });
    else check(report, 'BINDING_IDENTITY_RECORDED', 'ok', 'The exact binding identity is recorded; service liveness is a separate probe.', { scope });
    if (binding.active && projected.lifecycle?.desired === 'paused') check(report, 'BINDING_PAUSED', 'warn', 'The same active binding is paused for new dispatch; its identity, ledger and pending outcomes remain preserved. This is not proof that any native model has stopped.', { scope, actions: [action('RESUME_SAME_BINDING', ['bridge', 'resume', alias], { mutates: true })] });
    const launch = store.workerLaunches?.[binding.id];
    if (!binding.remote && launch !== undefined && (!object(launch) || launch.version !== 1 || launch.bindingRevision !== binding.revision || typeof launch.token !== 'string' || !TOKEN.test(launch.token) || !['launching', 'ready', 'stopped', 'needs-review', 'stop-requested'].includes(launch.phase) || launch.pid !== undefined && (!Number.isSafeInteger(launch.pid) || launch.pid <= 1))) check(report, 'WORKER_LAUNCH_INVALID', 'needs-review', 'A worker launch record is invalid or does not match this binding; preserve its ownership evidence before recovery.', { scope, source: 'worker-launch' });
    else if (!binding.remote && ['launching', 'needs-review', 'stop-requested'].includes(launch?.phase)) check(report, 'WORKER_LAUNCH_PENDING', 'needs-review', 'A worker launch or cooperative stop has an unfinished outcome; no additional worker was started and its original reservation was preserved.', { scope, source: 'worker-launch' });
    if (!binding.remote && binding.nodeId && (!node || binding.nodeId !== node.nodeId)) check(report, 'BINDING_NODE_MISMATCH', 'blocked', 'The local binding does not match the existing owning node identity.', { scope });
    await inspectWorker(report, context, binding);
    if (options.allowSessionLoad && binding.harness !== 'kimi-code') throw new Error('Inspect --allow-session-load only applies to an exact Kimi binding.');
    probeBindings.push(binding);
  }
  const selectedRooms = options.room ? own(store.rooms, options.room) ? [[options.room, store.rooms[options.room]]] : [] : Object.entries(store.rooms).filter(([, room]) => !options.binding || Array.isArray(room?.members) && room.members.some(member => member.alias === options.binding));
  if (options.room && !selectedRooms.length) check(report, 'ROOM_NOT_FOUND', 'blocked', 'The exact selected room ID does not exist.');
  for (const [id, room] of selectedRooms) {
    if (!validRoom(room, id)) { check(report, 'ROOM_INVALID', 'blocked', 'A selected room has invalid membership metadata.'); continue; }
    report.rooms.push(roomProjection(room)); inspectRoom(report, store, room, node);
    if (options.binding && !room.members.some(member => member.alias === options.binding)) check(report, 'ROOM_BINDING_NOT_MEMBER', 'blocked', 'The selected binding is not a member of the selected room.', { scope: { roomId: id, alias: options.binding } });
  }
  for (const [nodeId, peer] of Object.entries(store.peers || {})) {
    if (options.binding && !report.bindings.some(binding => binding.nodeId === nodeId) && !report.rooms.some(room => room.members.some(member => member.nodeId === nodeId))) continue;
    try { validatePublicNode({ nodeId: peer.nodeId, name: peer.name, publicKey: peer.publicKey }); if (peer.nodeId !== nodeId) throw new Error(); validateTransport(peer.transport); }
    catch { check(report, 'TRANSPORT_CONFIG_INVALID', 'blocked', 'A stored paired peer identity or owner-selected transport is invalid.', { source: 'peer-control' }); continue; }
    check(report, 'PEER_NOT_PROBED', 'not-probed', 'A paired owner transport is stored but was not contacted; no SSH connection was attempted.', { scope: { nodeId }, source: 'peer-control', kind: 'not-requested', probed: false });
  }
  for (const [kind, allowed] of [['inbox', ['preparing', 'stored', 'native-admitted']], ['outbox', ['preparing', 'queued', 'unknown', 'remote-stored']], ['mcpSends', ['preparing', 'queued', ...(store.version === 3 ? ['prepared', 'append-started'] : [])]]]) {
    if (Object.values(store[kind] || {}).some(record => !object(record) || !allowed.includes(record.status))) check(report, 'CONTROL_STATUS_UNSUPPORTED', 'needs-review', 'A stored control record has an unsupported status; preserve it for version and outcome review.', { source: kind });
  }
  for (const [messageId, record] of Object.entries(store.inbox || {})) if (object(record) && record.status === 'preparing') check(report, 'INBOX_PENDING', 'needs-review', 'An incoming cross-node message has an incomplete local storage outcome; preserve its original message ID and reconcile before replaying.', { scope: { ...(/^m_[0-9a-f-]{36}$/.test(messageId) ? { messageId } : {}), ...(positive(record.eventId) ? { eventId: record.eventId } : {}) }, source: 'inbox' });
  for (const [messageId, record] of Object.entries(store.outbox || {})) if (object(record) && ['unknown', 'preparing'].includes(record.status)) check(report, 'OUTBOX_UNKNOWN', 'needs-review', 'A cross-node message has an unconfirmed outcome; preserve its original message ID and use evidence-based reconciliation.', { scope: /^m_[0-9a-f-]{36}$/.test(messageId) ? { messageId } : {}, source: 'outbox' });
  if (Object.values(store.mcpSends || {}).some(record => object(record) && record.status === 'preparing')) check(report, 'MCP_SEND_PREPARING', 'needs-review', 'A contextual MCP send has an uncertain local queue outcome; preserve its original request key.', { source: 'mcp-control' });
  if (store.version === 3 && Object.values(store.mcpSends || {}).some(record => object(record) && ['prepared', 'append-started'].includes(record.status))) check(report, 'MCP_SEND_PENDING', 'needs-review', 'A contextual MCP send has an unfinished fixed-identity queue phase; preserve its original request key and submission evidence.', { source: 'mcp-control' });
  for (const binding of probeBindings) {
    if (options.native && !binding.remote && report.checks.some(row => row.status === 'blocked')) check(report, 'NATIVE_BLOCKED_BY_LOCAL_CHECKS', 'not-probed', 'Blocked local identity or routing metadata prevented the requested native inspection.', { scope: { alias: binding.alias }, source: 'native-service', kind: 'not-requested', probed: false });
    else await probeNative(report, context, binding, options, nativeFactory);
  }
  return finish(report, Object.keys(store.bindings).length === 0);
}
