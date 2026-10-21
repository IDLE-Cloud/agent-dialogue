import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from './private-files.mjs';

// Official v3.14.3 commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e:
// core/src/mcp/index.ts:214-239 obtains this context from the tool runtime;
// adapters/src/mcp/index.ts:1748-1770 emits identical flat/namespaced _meta.
// The MCP tool arguments are not an identity source. This adapter offers a
// contextual tool inbox, not native prompt admission, loading or automatic wake.
const VERSION = '3.14.3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION = /^sess_[A-Za-z0-9._-]{1,200}$/;
const REQUIRED = ['session_id', 'workspace_path', 'runtime_scope', 'client_mode', 'delivery_kind'];
const CONTEXT = [...REQUIRED, 'trace_id', 'span_id', 'parent_span_id', 'turn_id', 'workspace_identity', 'workspace_key', 'remote_session_id'];
const DESCRIPTOR_KEYS = ['version', 'id', 'zcodeVersion', 'directory', 'runtimeDir'];
const REGISTRATION_KEYS = ['version', 'serviceId', 'sessionId', 'directory', 'runtimeScope', 'clientMode', 'deliveryKind', 'firstObservedAt', 'lastObservedAt'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const printable = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value);
const fail = message => { throw new Error(`ZCode: ${message}`); };
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function absolute(value) {
  if (!printable(value)) fail('invalid absolute workspace scope.');
  if (/^[A-Za-z]:[\\/]/.test(value)) return win32.normalize(value);
  if (posix.isAbsolute(value)) return posix.normalize(value);
  fail('workspace scope must be absolute.');
}
function canonical(value) { const path = absolute(value); return /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path; }
function localPath(value) { if (!printable(value) || !isAbsolute(value)) fail('owner control path must be absolute.'); return resolve(value); }
function runtimePath(serviceFile) { return join(dirname(serviceFile), `${basename(serviceFile)}.runtime`); }

/** Normalize only the host-supplied _meta record, never model tool arguments. */
export function zcodeRequestContext(requestMeta, { directory } = {}) {
  const selected = absolute(directory);
  if (!object(requestMeta) || !object(requestMeta['com.zcode/request-context'])) fail('official request metadata context is missing.');
  const nested = requestMeta['com.zcode/request-context'];
  for (const key of CONTEXT) {
    const flatHas = Object.hasOwn(requestMeta, key), nestedHas = Object.hasOwn(nested, key);
    if (REQUIRED.includes(key) && (!flatHas || !nestedHas) || flatHas !== nestedHas || flatHas && (!printable(requestMeta[key]) || requestMeta[key] !== nested[key])) fail('official request metadata copies conflict or contain an invalid context.');
  }
  if (!SESSION.test(nested.session_id) || nested.runtime_scope !== 'main' || nested.client_mode !== 'desktop-continuous' || nested.delivery_kind !== 'desktop-continuous') fail('request metadata must identify the exact main desktop context.');
  if (canonical(nested.workspace_path) !== canonical(selected)) fail('request workspace is outside the selected directory scope.');
  return Object.freeze({ sessionId: nested.session_id, directory: selected, runtimeScope: 'main', clientMode: 'desktop-continuous', deliveryKind: 'desktop-continuous' });
}

async function windowsPrivate(paths, { secure = false } = {}) {
  try {
    for (const path of paths) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) fail('invalid private Windows control path.');
      const options = { directory: info.isDirectory() };
      // Reuse the SID-based, typed ACL evidence path already used by node
      // identities. Unlike an opaque marker, this also verifies reparse points,
      // path kind, ownership and every inherited/explicit ACE after provisioning.
      const evidence = secure ? await protectWindowsPrivatePath(path, options) : await inspectWindowsPrivatePath(path, options);
      if (evidence.ownerSid !== evidence.currentUserSid || evidence.aces.some(rule => rule.type === 'allow' && rule.rights !== 0 && rule.sid !== evidence.currentUserSid)) fail('private Windows owner/ACL is not current-user-only.');
    }
  } catch { fail('control paths must have current-user private Windows ACLs.'); }
}
async function regular(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) fail('control paths must be regular private files/directories without symlinks.');
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) fail('control path ownership or permissions are not private.');
  return info;
}
async function privateJson(path, limit = 65536) {
  const before = await regular(path);
  if (before.size > limit) fail('private descriptor/registration exceeds its size limit.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino || current.size > limit) fail('private file changed while opening.');
    const bytes = await handle.readFile(); if (bytes.length > limit) fail('private descriptor/registration exceeds its size limit.');
    try { return { value: JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)), fileIdentity: `${current.dev}:${current.ino}` }; }
    catch { fail('invalid private descriptor/registration JSON.'); }
  } finally { await handle.close(); }
}
function descriptor(value, serviceFile) {
  if (!exactKeys(value, DESCRIPTOR_KEYS) || value.version !== 1 || typeof value.id !== 'string' || !UUID.test(value.id)) fail('invalid owner service descriptor.');
  if (value.zcodeVersion !== VERSION) fail('unsupported ZCode version; only the verified 3.14.3 metadata contract is enabled.');
  const directory = absolute(value.directory);
  if (directory !== value.directory || localPath(value.runtimeDir) !== runtimePath(serviceFile)) fail('owner descriptor directory/runtime scope is invalid.');
  return Object.freeze({ version: 1, id: value.id, zcodeVersion: value.zcodeVersion, directory, runtimeDir: value.runtimeDir });
}
async function readService(serviceFile) {
  await regular(dirname(serviceFile), true);
  const read = await privateJson(serviceFile);
  const value = descriptor(read.value, serviceFile), runtime = await regular(value.runtimeDir, true);
  if (process.platform === 'win32') await windowsPrivate([dirname(serviceFile), serviceFile, value.runtimeDir]);
  return { value, fileIdentity: read.fileIdentity, runtimeIdentity: `${runtime.dev}:${runtime.ino}`, parentIdentity: await realpath(dirname(serviceFile)) };
}
async function exclusiveJson(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  // Elevated Windows shells may otherwise make Administrators the file owner.
  // Secure only this newly created file, never relax or repair existing paths.
  if (process.platform === 'win32') await windowsPrivate([path], { secure: true });
}

/** Create one private operator-owned control service; do not touch ZCode config. */
export async function createZCodeService({ path, directory, zcodeVersion = VERSION } = {}) {
  const serviceFile = localPath(path); directory = absolute(directory);
  if (zcodeVersion !== VERSION) fail('unsupported ZCode version.');
  try { await lstat(serviceFile); fail('service descriptor already exists; refusing overwrite.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = dirname(serviceFile), createdParent = await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' && createdParent !== undefined) await windowsPrivate([parent], { secure: true });
  await regular(parent, true);
  if (process.platform === 'win32') await windowsPrivate([parent]);
  const runtimeDir = runtimePath(serviceFile);
  try { await mkdir(runtimeDir, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('runtime directory already exists; refusing overwrite.'); throw error; }
  try {
    if (process.platform === 'win32') await windowsPrivate([runtimeDir], { secure: true });
    const value = { version: 1, id: randomUUID(), zcodeVersion, directory, runtimeDir };
    await exclusiveJson(serviceFile, value); await readService(serviceFile); return Object.freeze(value);
  } catch (error) { await rm(runtimeDir, { recursive: true, force: true }); throw error; }
}
function registrationFile(runtimeDir, id) { return join(runtimeDir, `${createHash('sha256').update(id).digest('hex')}.json`); }
function registration(value, selected) {
  if (!exactKeys(value, REGISTRATION_KEYS) || value.version !== 1 || value.serviceId !== `zcode-tools-${selected.id}` || typeof value.sessionId !== 'string' || !SESSION.test(value.sessionId) || value.directory !== selected.directory || value.runtimeScope !== 'main' || value.clientMode !== 'desktop-continuous' || value.deliveryKind !== 'desktop-continuous' || !Number.isSafeInteger(value.firstObservedAt) || value.firstObservedAt < 1 || !Number.isSafeInteger(value.lastObservedAt) || value.lastObservedAt < value.firstObservedAt) fail('invalid or out-of-scope candidate registration.');
  return value;
}
function session(value) {
  return { id: value.sessionId, projectID: `zcode_${createHash('sha256').update(canonical(value.directory)).digest('hex').slice(0, 32)}`, location: { directory: value.directory }, title: '', time: { created: value.firstObservedAt, updated: value.lastObservedAt }, nativeState: 'unknown', observationSource: 'zcode-mcp-request-context' };
}
function unsupported() { return Object.assign(new Error('ZCode tool inbox does not submit native prompts or expose native admission/history. Use the contextual MCP receive tool in the selected desktop chat.'), { code: 'ZCODE_TOOLS_ONLY', unsupported: true, notSubmitted: true }); }

export class ZCodeToolsClient {
  #serviceFile; #selected; #pin;
  constructor({ serviceFile, record }) {
    this.#serviceFile = serviceFile; this.#selected = record.value; this.#pin = record;
    Object.defineProperty(this, 'identity', { value: Object.freeze({ serviceId: `zcode-tools-${record.value.id}`, origin: `zcode-tools://${record.value.id}`, version: record.value.zcodeVersion }), enumerable: true });
    Object.defineProperty(this, 'directory', { value: record.value.directory, enumerable: true });
    Object.defineProperty(this, 'capabilities', { value: Object.freeze({ existingAttach: true, toolInbox: true, autoWake: false, queue: false, stableInputId: false, resume: false }), enumerable: true });
  }
  static async discover({ serviceFile = process.env.AGENT_DIALOGUE_ZCODE_SERVICE_FILE } = {}) {
    if (!printable(serviceFile)) fail('set AGENT_DIALOGUE_ZCODE_SERVICE_FILE to the explicit owner service descriptor.');
    serviceFile = localPath(serviceFile); return new ZCodeToolsClient({ serviceFile, record: await readService(serviceFile) });
  }
  async #revalidate() {
    const current = await readService(this.#serviceFile);
    if (JSON.stringify(current) !== JSON.stringify(this.#pin)) fail('owner service identity or scope changed; explicitly select a new service.');
  }
  async #readRegistration(id, allowMissing = false) {
    if (typeof id !== 'string' || !SESSION.test(id)) fail('invalid exact session ID.');
    const path = registrationFile(this.#selected.runtimeDir, id);
    try {
      const read = await privateJson(path);
      if (process.platform === 'win32') await windowsPrivate([path]);
      const value = registration(read.value, this.#selected);
      if (value.sessionId !== id) fail('candidate registration does not match its exact requested session.');
      return value;
    } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  }
  async register(requestMeta) {
    const context = zcodeRequestContext(requestMeta, { directory: this.#selected.directory });
    await this.#revalidate();
    const lock = join(this.#selected.runtimeDir, '.registration.lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('candidate registration is busy; stale locks require explicit recovery.'); throw error; }
    const temporary = join(this.#selected.runtimeDir, `.registration-${randomUUID()}.tmp`);
    try {
      const previous = await this.#readRegistration(context.sessionId, true), now = Date.now();
      const value = { version: 1, serviceId: this.identity.serviceId, ...context, firstObservedAt: previous?.firstObservedAt ?? now, lastObservedAt: Math.max(previous?.lastObservedAt ?? now, now) };
      await exclusiveJson(temporary, value); await this.#revalidate();
      await rename(temporary, registrationFile(this.#selected.runtimeDir, context.sessionId)); return session(value);
    } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true }); }
  }
  async sessions({ directory } = {}) {
    if (directory !== undefined && canonical(directory) !== canonical(this.#selected.directory)) fail('workspace directory is outside owner scope.');
    await this.#revalidate(); const items = [];
    for (const file of (await readdir(this.#selected.runtimeDir)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) { if (file.endsWith('.json')) fail('unexpected candidate registration path.'); continue; }
      const path = join(this.#selected.runtimeDir, file);
      if (process.platform === 'win32') await windowsPrivate([path]);
      const value = registration((await privateJson(path)).value, this.#selected);
      if (registrationFile(this.#selected.runtimeDir, value.sessionId) !== path) fail('candidate path does not match its exact session.');
      items.push(session(value));
    }
    return items;
  }
  async session(id) { await this.#revalidate(); const value = await this.#readRegistration(id, true); if (!value) fail('session has not been observed as a contextual MCP candidate.'); return session(value); }
  async prompt() { throw unsupported(); }
  async input() { throw unsupported(); }
  async inbox() { throw unsupported(); }
  async messages() { throw unsupported(); }
}
