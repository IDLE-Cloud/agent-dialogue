import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['bin', 'lib', 'config', 'web'];
const ROOT_FIELDS = ['dev', 'ino', 'mode', 'uid', 'gid'];
const FILE_FIELDS = [...ROOT_FIELDS, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const DIR_FIELDS = [...ROOT_FIELDS, 'mtimeNs', 'ctimeNs'];
const DESCRIPTOR_KEYS = ['version', 'packageRoot', 'cliPath', 'workerPath', 'nodePath', 'platform', 'packageVersion', 'runtimeFiles', 'runtimeSha256', 'runtimeManifest', 'rootIdentity', 'identities', 'nodeIdentity', 'nodeSha256', 'nodeVersionEvidence'];
const PATH_KEYS = ['path', 'canonicalPath', 'exists', 'identity', 'anchorPath', 'anchorIdentity', 'missing'];
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const INTEGER = /^(?:0|[1-9][0-9]{0,39})(?![\s\S])/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\s\S])/;
const LIMITS = { entries: 1024, files: 512, depth: 24, runtimeFile: 16 * 1024 * 1024, runtimeTotal: 64 * 1024 * 1024, package: 256 * 1024, artifact: 512 * 1024 * 1024 };
const KNOWN = Object.freeze({
  '56f96305f7234e922fd277bb402210b01e978e2f50bc40652d071fcb1093c94d': { source: 'known-63fba03', sourceSchemas: [1, 2, 3] },
  '7ec88027e61bba31be457b5ed05c17863d214e2ed4a4f7878a8844ce08efd19d': { source: 'known-1dd0c7c', sourceSchemas: [1, 2, 3, 4] },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => createHash('sha256').update(value).digest('hex');
const coded = code => Object.assign(new Error('Migration installation evidence is invalid, unsupported or changed; preserve the original installations and state.'), { code });
const fail = (code = 'MIGRATION_INSTALLATION_INVALID') => { throw coded(code); };
const identity = (info, fields) => Object.fromEntries(fields.map(key => [key, info[key].toString()]));
const identical = (a, b, fields) => fields.every(key => a[key] === b[key]);
const validIdentity = (value, fields) => exact(value, fields) && fields.every(key => typeof value[key] === 'string' && INTEGER.test(value[key]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const absolute = value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 32768 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && value.trim().length > 0;
const inside = (path, parent) => { const part = relative(parent, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
function relativeRuntime(value, directory = false) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return !directory && value === 'package.json' || ROOTS.includes(value.split('/')[0]) && (directory || value.includes('/'));
}
function safeInfo(info, directory = false) {
  if (!info || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.ino < 1n || !directory && info.nlink !== 1n || ROOT_FIELDS.some(key => typeof info[key] !== 'bigint' || info[key] < 0n)) fail();
  // Installed code is public data. Inspect ownership and write bits, never
  // chmod/ACL-repair a selected installation or execute a helper to inspect it.
  if (process.platform !== 'win32' && ((info.mode & 0o022n) !== 0n || process.getuid && ![0n, BigInt(process.getuid())].includes(info.uid))) fail();
}
async function regular(path, limit, { retain = false } = {}) {
  const before = await lstat(path, { bigint: true }); safeInfo(before);
  if (before.size < 0n || before.size > BigInt(limit)) fail('MIGRATION_INSTALLATION_LIMIT');
  if (await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat({ bigint: true }); safeInfo(info);
    if (!identical(before, info, FILE_FIELDS)) fail('MIGRATION_INSTALLATION_CHANGED');
    const digest = createHash('sha256'), chunks = [], buffer = Buffer.alloc(Math.min(65536, Number(info.size) + 1)); let total = 0;
    while (true) {
      const part = await handle.read(buffer, 0, Math.min(buffer.length, Number(info.size) + 1 - total), null);
      if (!part.bytesRead) break;
      total += part.bytesRead; if (total > Number(info.size)) fail('MIGRATION_INSTALLATION_CHANGED');
      digest.update(buffer.subarray(0, part.bytesRead)); if (retain) chunks.push(Buffer.from(buffer.subarray(0, part.bytesRead)));
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || BigInt(total) !== info.size || !identical(info, after, FILE_FIELDS) || !identical(info, current, FILE_FIELDS) || await realpath(path) !== path) fail('MIGRATION_INSTALLATION_CHANGED');
    return { identity: identity(info, FILE_FIELDS), sha256: digest.digest('hex'), ...(retain ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}
async function artifact(selected) {
  if (!absolute(selected)) fail();
  // An explicit Node/hcom alias is resolved once. Subsequent invocation must
  // use this pinned canonical path; package-tree links remain unsupported.
  const path = await realpath(resolve(selected)), info = await regular(path, LIMITS.artifact);
  if (process.platform !== 'win32' && (BigInt(info.identity.mode) & 0o111n) === 0n) fail();
  return { path, identity: info.identity, sha256: info.sha256 };
}
function metadata(bytes) {
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  if (!object(value) || value.name !== '@idle-cloud/agent-dialogue' || !VERSION.test(value.version || '') || value.type !== 'module' || !object(value.bin) || value.bin['agent-dialogue'] !== 'bin/agent-dialogue.mjs') fail();
  return value;
}

/** Fixed reviewed runtime digests, never package.version-based compatibility.
 * The current digest is supplied only from a freshly inspected running package. */
export function migrationSourceCompatibility(sourceSha256, currentSha256) {
  if (!HASH.test(sourceSha256 || '') || !HASH.test(currentSha256 || '')) fail();
  const known = Object.hasOwn(KNOWN, sourceSha256) ? KNOWN[sourceSha256] : sourceSha256 === currentSha256 ? { source: 'current-source', sourceSchemas: [1, 2, 3, 4] } : null;
  if (!known) fail('MIGRATION_SOURCE_UNSUPPORTED');
  return { source: known.source, sourceSchemas: [...known.sourceSchemas], targetSchema: 4 };
}

/** Read-only bounded inspection. No import, execution, download, native query,
 * directory creation or permission repair is performed on selected artifacts. */
export async function inspectInstallation(selected) {
  if (!exact(selected, ['packageRoot', 'nodePath']) || !absolute(selected.packageRoot) || !absolute(selected.nodePath)) fail();
  try {
    const selectedInfo = await lstat(resolve(selected.packageRoot), { bigint: true }); safeInfo(selectedInfo, true);
    const packageRoot = await realpath(resolve(selected.packageRoot)), root = await lstat(packageRoot, { bigint: true }); safeInfo(root, true);
    const files = new Map(), directories = new Map(); let entries = 0, total = 0;
    async function readRuntime(path) {
      if (++entries > LIMITS.entries || files.size >= LIMITS.files) fail('MIGRATION_INSTALLATION_LIMIT');
      const file = await regular(join(packageRoot, ...path.split('/')), path === 'package.json' ? LIMITS.package : LIMITS.runtimeFile, { retain: path === 'package.json' || path === 'config/hcom.lock.json' });
      total += Number(file.identity.size); if (total > LIMITS.runtimeTotal) fail('MIGRATION_INSTALLATION_LIMIT'); files.set(path, file);
    }
    async function walk(path, depth) {
      if (depth > LIMITS.depth || ++entries > LIMITS.entries) fail('MIGRATION_INSTALLATION_LIMIT');
      const full = join(packageRoot, ...path.split('/')), info = await lstat(full, { bigint: true }); safeInfo(info, true);
      if (await realpath(full) !== full) fail(); directories.set(path, identity(info, DIR_FIELDS));
      const dir = await opendir(full);
      for await (const item of dir) {
        if (!item.name || item.name === '.' || item.name === '..' || /[\x00-\x1f\x7f\\/]/.test(item.name)) fail();
        const next = `${path}/${item.name}`;
        if (item.isSymbolicLink()) fail();
        if (item.isDirectory()) await walk(next, depth + 1);
        else if (item.isFile()) await readRuntime(next);
        else fail();
      }
    }
    await readRuntime('package.json'); for (const rootName of ROOTS) await walk(rootName, 1);
    for (const required of ['bin/agent-dialogue.mjs', 'bin/bridge-worker.mjs', 'config/hcom.lock.json']) if (!files.has(required)) fail();
    const pkg = metadata(files.get('package.json').bytes);
    const ordered = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), runtimeManifest = ordered.map(([path, file]) => ({ path, sha256: file.sha256 }));
    const node = await artifact(selected.nodePath), currentNodePath = await realpath(process.execPath);
    // Detect mutations anywhere earlier in the walk, as well as fd-local
    // mutation. atime is deliberately absent because reads may update it.
    for (const [path, file] of files) {
      const full = join(packageRoot, ...path.split('/')), current = await lstat(full, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !same(identity(current, FILE_FIELDS), file.identity) || await realpath(full) !== full) fail('MIGRATION_INSTALLATION_CHANGED');
    }
    for (const [path, expected] of directories) {
      const full = join(packageRoot, ...path.split('/')), current = await lstat(full, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(identity(current, DIR_FIELDS), expected) || await realpath(full) !== full) fail('MIGRATION_INSTALLATION_CHANGED');
    }
    const finalRoot = await lstat(packageRoot, { bigint: true });
    if (!finalRoot.isDirectory() || finalRoot.isSymbolicLink() || !identical(root, finalRoot, ROOT_FIELDS) || await realpath(resolve(selected.packageRoot)) !== packageRoot) fail('MIGRATION_INSTALLATION_CHANGED');
    return validateDescriptor({ version: 1, packageRoot, cliPath: join(packageRoot, 'bin/agent-dialogue.mjs'), workerPath: join(packageRoot, 'bin/bridge-worker.mjs'), nodePath: node.path, platform: `${process.platform}-${process.arch}`, packageVersion: pkg.version,
      runtimeFiles: runtimeManifest.length, runtimeSha256: hash(JSON.stringify(runtimeManifest)), runtimeManifest, rootIdentity: identity(root, ROOT_FIELDS),
      identities: { files: Object.fromEntries(ordered.map(([path, file]) => [path, file.identity])), directories: Object.fromEntries([...directories].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) },
      nodeIdentity: node.identity, nodeSha256: node.sha256, nodeVersionEvidence: node.path === currentNodePath ? { kind: 'current-process', version: process.versions.node } : { kind: 'artifact-only', version: null } });
  } catch (error) { if (String(error.code).startsWith('MIGRATION_')) throw error; throw coded('MIGRATION_INSTALLATION_INVALID'); }
}

function validateDescriptor(value) {
  if (!exact(value, DESCRIPTOR_KEYS) || value.version !== 1 || !['packageRoot', 'cliPath', 'workerPath', 'nodePath'].every(key => absolute(value[key]) && resolve(value[key]) === value[key]) || value.cliPath !== join(value.packageRoot, 'bin/agent-dialogue.mjs') || value.workerPath !== join(value.packageRoot, 'bin/bridge-worker.mjs') || !/^(?:darwin|linux|win32)-[a-z0-9_]+(?![\s\S])/.test(value.platform || '') || !VERSION.test(value.packageVersion || '') || !Number.isSafeInteger(value.runtimeFiles) || value.runtimeFiles < 4 || value.runtimeFiles > LIMITS.files || !Array.isArray(value.runtimeManifest) || value.runtimeManifest.length !== value.runtimeFiles || !HASH.test(value.runtimeSha256 || '') || hash(JSON.stringify(value.runtimeManifest)) !== value.runtimeSha256 || !HASH.test(value.nodeSha256 || '') || !validIdentity(value.rootIdentity, ROOT_FIELDS) || !validIdentity(value.nodeIdentity, FILE_FIELDS) || value.nodeIdentity.nlink !== '1' || BigInt(value.nodeIdentity.size) > BigInt(LIMITS.artifact) || !exact(value.identities, ['files', 'directories']) || !object(value.identities.files) || !object(value.identities.directories)) fail();
  const names = value.runtimeManifest.map(row => { if (!exact(row, ['path', 'sha256']) || !relativeRuntime(row.path) || !HASH.test(row.sha256 || '')) fail(); return row.path; });
  if (!same(names, [...new Set(names)].sort()) || names.some(path => path.split('/').length > LIMITS.depth + 1) || !same(Object.keys(value.identities.files).sort(), names) || !['package.json', 'bin/agent-dialogue.mjs', 'bin/bridge-worker.mjs', 'config/hcom.lock.json'].every(path => names.includes(path))) fail();
  if (!Object.entries(value.identities.files).every(([path, info]) => validIdentity(info, FILE_FIELDS) && info.nlink === '1' && BigInt(info.size) <= BigInt(path === 'package.json' ? LIMITS.package : LIMITS.runtimeFile)) || Object.keys(value.identities.directories).length > LIMITS.entries || !ROOTS.every(path => Object.hasOwn(value.identities.directories, path)) || !Object.entries(value.identities.directories).every(([path, info]) => relativeRuntime(path, true) && path.split('/').length <= LIMITS.depth && validIdentity(info, DIR_FIELDS))) fail();
  if (!exact(value.nodeVersionEvidence, ['kind', 'version']) || (value.nodeVersionEvidence.kind === 'current-process' ? !VERSION.test(value.nodeVersionEvidence.version || '') : value.nodeVersionEvidence.kind !== 'artifact-only' || value.nodeVersionEvidence.version !== null)) fail();
  return value;
}

export async function assertInstallationsUnchanged(descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 2) fail();
  for (const expected of descriptors) {
    validateDescriptor(expected);
    try { if (!same(await inspectInstallation({ packageRoot: expected.packageRoot, nodePath: expected.nodePath }), expected)) fail('MIGRATION_INSTALLATION_CHANGED'); }
    catch { fail('MIGRATION_INSTALLATION_CHANGED'); }
  }
  return true;
}

async function pathSnapshot(path, { required = false } = {}) {
  if (!absolute(path)) fail(); path = resolve(path);
  let anchor = path; const missing = [];
  while (true) {
    let info; try { info = await lstat(anchor, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(anchor) === anchor) throw error; missing.unshift(relative(dirname(anchor), anchor)); if (missing.length > 128) fail('MIGRATION_INSTALLATION_LIMIT'); anchor = dirname(anchor); continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (required && missing.length) fail();
    const anchorPath = await realpath(anchor), anchorIdentity = identity(info, ROOT_FIELDS), canonicalPath = join(anchorPath, ...missing);
    return { path, canonicalPath, exists: missing.length === 0, identity: missing.length === 0 ? anchorIdentity : null, anchorPath, anchorIdentity, missing };
  }
}
function validatePathSnapshot(value) {
  if (!exact(value, PATH_KEYS) || !['path', 'canonicalPath', 'anchorPath'].every(key => absolute(value[key]) && resolve(value[key]) === value[key]) || typeof value.exists !== 'boolean' || !validIdentity(value.anchorIdentity, ROOT_FIELDS) || !Array.isArray(value.missing) || value.missing.length > 128 || !value.missing.every(part => typeof part === 'string' && part && part !== '.' && part !== '..' && !/[\\/\x00-\x1f\x7f]/.test(part)) || join(value.anchorPath, ...value.missing) !== value.canonicalPath || (value.exists ? value.missing.length !== 0 || !validIdentity(value.identity, ROOT_FIELDS) || !same(value.identity, value.anchorIdentity) : !value.missing.length || value.identity !== null)) fail();
}
function validateArtifact(value) { if (!exact(value, ['path', 'identity', 'sha256']) || !absolute(value.path) || resolve(value.path) !== value.path || !validIdentity(value.identity, FILE_FIELDS) || value.identity.nlink !== '1' || BigInt(value.identity.size) > BigInt(LIMITS.artifact) || !HASH.test(value.sha256 || '')) fail(); }
function noOverlap(paths) { for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (inside(paths[i], paths[j]) || inside(paths[j], paths[i])) fail('MIGRATION_PATH_OVERLAP'); }
function validateNamespace(value) {
  if (!exact(value, ['state', 'cache', 'backend', 'dependency']) || !['hcom', 'embedded'].includes(value.backend)) fail();
  validatePathSnapshot(value.state); validatePathSnapshot(value.cache); if (!value.state.exists) fail();
  if (value.backend === 'embedded') { if (value.dependency !== null) fail(); }
  else {
    const dependency = value.dependency;
    if (!exact(dependency, ['version', 'lockSha256', 'lockedArchiveSha256', 'selectedPath', 'artifact']) || !VERSION.test(dependency.version || '') || !HASH.test(dependency.lockSha256 || '') || !HASH.test(dependency.lockedArchiveSha256 || '') || !absolute(dependency.selectedPath)) fail();
    validateArtifact(dependency.artifact);
  }
}

export function validateMigrationInstallations(value) {
  if (!exact(value, ['version', 'from', 'to', 'namespace', 'compatibility']) || value.version !== 1) fail();
  validateDescriptor(value.from); validateDescriptor(value.to); validateNamespace(value.namespace);
  if (value.from.platform !== value.to.platform || !same(value.compatibility, migrationSourceCompatibility(value.from.runtimeSha256, value.to.runtimeSha256))) fail();
  noOverlap([value.from.packageRoot, value.to.packageRoot, value.namespace.state.canonicalPath, value.namespace.cache.canonicalPath]);
  return value;
}

/** Production always selects this package and this Node as the candidate.
 * sources is direct-JS fixture injection, never a persisted plan/CLI option. */
export async function captureMigrationInstallations(context, selected, { sources = { packageRoot: PACKAGE_ROOT, nodePath: process.execPath } } = {}) {
  if (!object(context) || !absolute(context.stateDir) || !absolute(context.cacheDir) || !['embedded', 'hcom'].includes(context.ledgerBackend) || !exact(selected, ['fromPackage', 'fromNode']) || !exact(sources, ['packageRoot', 'nodePath'])) fail();
  const from = await inspectInstallation({ packageRoot: selected.fromPackage, nodePath: selected.fromNode }), to = await inspectInstallation(sources);
  const state = await pathSnapshot(context.stateDir, { required: true }), cache = await pathSnapshot(context.cacheDir);
  noOverlap([from.packageRoot, to.packageRoot, state.canonicalPath, cache.canonicalPath]);
  let dependency = null;
  if (context.ledgerBackend === 'hcom') {
    if (process.platform === 'win32') fail();
    const oldLock = await regular(join(from.packageRoot, 'config/hcom.lock.json'), LIMITS.package, { retain: true }), lock = await regular(join(to.packageRoot, 'config/hcom.lock.json'), LIMITS.package, { retain: true });
    if (oldLock.sha256 !== lock.sha256) fail('MIGRATION_DEPENDENCY_CHANGED');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lock.bytes)); } catch { fail(); }
    const expected = value?.assets?.[`${process.platform}-${process.arch}`]?.sha256;
    if (!VERSION.test(value?.version || '') || !HASH.test(expected || '') || !absolute(context.binary)) fail();
    dependency = { version: value.version, lockSha256: lock.sha256, lockedArchiveSha256: expected, selectedPath: resolve(context.binary), artifact: await artifact(context.binary) };
  }
  const snapshot = validateMigrationInstallations({ version: 1, from, to, namespace: { state, cache, backend: context.ledgerBackend, dependency }, compatibility: migrationSourceCompatibility(from.runtimeSha256, to.runtimeSha256) });
  await assertInstallationsUnchanged([from, to]); return snapshot;
}

export async function assertMigrationInstallationsUnchanged(context, snapshot, options = {}) {
  validateMigrationInstallations(snapshot);
  try {
    const current = await captureMigrationInstallations(context, { fromPackage: snapshot.from.packageRoot, fromNode: snapshot.from.nodePath }, options);
    if (!same(current, snapshot)) fail('MIGRATION_INSTALLATION_CHANGED');
  } catch { fail('MIGRATION_INSTALLATION_CHANGED'); }
  return true;
}
