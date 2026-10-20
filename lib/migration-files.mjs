import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { inspectWindowsPrivatePath, protectWindowsPrivatePath } from './private-files.mjs';
import { absoluteRemotePath, powershellCommand, powershellQuote } from './platform.mjs';

const DEFAULTS = Object.freeze({ maxFiles: 4096, maxFileBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxManifestBytes: 8 * 1024 * 1024 });
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?![\s\S])/;
const CLOCK = /^-?(?:0|[1-9][0-9]*)(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const BASIC = ['dev', 'ino', 'mode', 'uid', 'gid'];
const FILE_STAT = [...BASIC, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const DIR_KEYS = ['path', 'kind', ...BASIC, 'aclHash'];
const FILE_KEYS = [...DIR_KEYS, 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'sha256'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `MIGRATION_${code}` }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const execute = promisify(execFile);
const sorted = values => [...values].sort();
const within = (path, parent) => { const r = relative(parent, path); return r === '' || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
function limitsFor(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) fail('LIMITS_INVALID', 'Invalid bounded migration limits.');
  const limits = { ...DEFAULTS, ...input };
  for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULTS[key]) fail('LIMITS_INVALID', 'Invalid bounded migration limits.');
  return limits;
}
function pathValue(value) {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('PATH_INVALID', 'Migration requires an exact absolute private directory.');
  return resolve(value);
}
function relativeName(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value) || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || value.split('/').length > 64) fail('MANIFEST_INVALID', 'Invalid bounded migration manifest path.');
  return value;
}
function statFields(info, keys = BASIC) {
  for (const key of keys) if (typeof info[key] !== 'bigint' || !['mtimeNs', 'ctimeNs'].includes(key) && info[key] < 0n) fail('FILES_INVALID', 'Exact migration file identity is unavailable.');
  if (info.ino < 1n) fail('FILES_INVALID', 'Exact migration file identity is unavailable.');
  return Object.fromEntries(keys.map(key => [key, info[key].toString()]));
}
async function acl(path, directory, info, { root = false, artifact = false } = {}) {
  if (process.platform === 'win32') {
    const result = await inspectWindowsPrivatePath(path, { directory });
    if (result.ownerSid !== result.currentUserSid) fail('PRIVACY_INVALID', 'Migration files must belong to the current user.');
    const rules = result.aces.map(rule => ({ sid: rule.sid, type: rule.type, rights: rule.rights, inherited: rule.inherited }));
    const normalized = { version: result.version, currentUserSid: result.currentUserSid, ownerSid: result.ownerSid, protected: result.protected, directory: result.directory, reparse: result.reparse, aces: rules.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) };
    return digest(JSON.stringify(normalized));
  }
  if (process.getuid && info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n || (root || artifact) && (info.mode & 0o077n) !== 0n || !directory && (info.mode & 0o6000n) !== 0n) fail('PRIVACY_INVALID', 'Migration refuses unsafe ownership or permissions without repairing the source.');
  return null;
}
async function directory(path, options = {}) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) fail('FILES_INVALID', 'Migration requires ordinary directories without reparse points.');
  const identity = statFields(info), aclHash = await acl(path, true, info, options);
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !equal(identity, statFields(after))) fail('FILES_CHANGED', 'Migration directory identity changed during inspection.');
  return { ...identity, aclHash };
}
async function sourceRoot(context) {
  const input = pathValue(context?.stateDir);
  const before = await directory(input, { root: true });
  const path = await realpath(input), identity = await directory(path, { root: true });
  if (!equal(before, identity)) fail('FILES_CHANGED', 'Migration source directory changed during canonicalization.');
  return { input, path, identity };
}
async function fileBytes(path, { limit, artifact = false, onChunk } = {}) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(limit)) fail('FILES_INVALID', 'Migration requires bounded ordinary files with a single link.');
  const identity = statFields(before, FILE_STAT), aclHash = await acl(path, false, before, { artifact });
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  const hasher = createHash('sha256'); let total = 0;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || !equal(identity, statFields(info, FILE_STAT))) fail('FILES_CHANGED', 'Migration file changed before its exact handle was opened.');
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit || BigInt(total) > before.size) fail('FILES_CHANGED', 'Migration file grew beyond its bounded observed size.');
      const part = chunk.subarray(0, bytesRead); hasher.update(part); if (onChunk) await onChunk(part);
    }
    if (BigInt(total) !== before.size || !equal(identity, statFields(await handle.stat({ bigint: true }), FILE_STAT))) fail('FILES_CHANGED', 'Migration file changed during its bounded read.');
  } finally { await handle.close(); }
  const after = await lstat(path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || !equal(identity, statFields(after, FILE_STAT)) || await acl(path, false, after, { artifact }) !== aclHash) fail('FILES_CHANGED', 'Migration file identity or privacy changed during reading.');
  return { ...identity, aclHash, sha256: hasher.digest('hex') };
}
async function smallSnapshot(path, limit, artifact = true) {
  const chunks = [], meta = await fileBytes(path, { limit, artifact, onChunk: part => { chunks.push(Buffer.from(part)); } }); return { bytes: Buffer.concat(chunks), meta };
}
async function small(path, limit, artifact = true) { return (await smallSnapshot(path, limit, artifact)).bytes; }
function jsonBytes(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('MANIFEST_INVALID', 'Migration metadata is not bounded valid UTF-8 JSON.'); }
}
async function controlProof(root, owner) {
  const path = join(root, 'dialogue', '.lock');
  if (owner === undefined) {
    try { await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    fail('CONTROL_UNVERIFIED', 'Migration cannot observe an unowned control lock as a quiescent source.');
  }
  const keys = ['version', 'role', 'pid', 'nonce', 'createdAt'];
  if (!exact(owner, keys) || owner.version !== 1 || owner.role !== 'control' || owner.pid !== process.pid || !UUID.test(owner.nonce || '') || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt)) || new Date(owner.createdAt).toISOString() !== owner.createdAt) fail('CONTROL_UNVERIFIED', 'Only the exact currently owned control lock may be excluded.');
  const meta = await directory(path, { artifact: true });
  if (!equal(sorted(await readdir(path)), ['owner.json'])) fail('CONTROL_UNVERIFIED', 'Owned control lock evidence changed.');
  const bytes = await small(join(path, 'owner.json'), 16384);
  const recorded = jsonBytes(bytes);
  if (!exact(recorded, keys) || keys.some(key => recorded[key] !== owner[key])) fail('CONTROL_UNVERIFIED', 'Owned control lock evidence changed.');
  return { meta, ownerHash: digest(bytes) };
}
function encoded(manifest, limits) {
  const text = JSON.stringify(manifest);
  if (Buffer.byteLength(text) + 1 > limits.maxManifestBytes) fail('CAPACITY', 'Migration manifest exceeds its bounded UTF-8 size.');
  return text;
}
async function scanOnce(root, ownedControl, limits, expectedControl) {
  if (!equal(await controlProof(root.path, ownedControl), expectedControl)) fail('CONTROL_UNVERIFIED', 'Owned control lock changed during migration.');
  const entries = []; let fileCount = 0, totalBytes = 0;
  async function visit(path, prefix) {
    const before = await directory(path, { root: prefix === '' });
    const names = sorted(await readdir(path));
    for (const name of names) {
      const key = prefix ? `${prefix}/${name}` : name;
      if (expectedControl && key === 'dialogue/.lock') continue;
      relativeName(key);
      if (entries.length >= limits.maxFiles * 2) fail('CAPACITY', 'Migration directory entry count exceeds its bound.');
      const full = join(path, name), info = await lstat(full, { bigint: true });
      if (info.isDirectory() && !info.isSymbolicLink()) {
        const meta = await directory(full); entries.push({ path: key, kind: 'directory', ...meta }); await visit(full, key);
      } else {
        if (++fileCount > limits.maxFiles) fail('CAPACITY', 'Migration file count exceeds its bound.');
        const limit = key === 'dialogue/store.json' ? Math.min(16 * 1024 * 1024, limits.maxFileBytes) : limits.maxFileBytes;
        if (info.size < 0n || info.size > BigInt(limit) || BigInt(totalBytes) + info.size > BigInt(limits.maxTotalBytes)) fail('CAPACITY', 'Migration file bytes exceed their bounded capacity.');
        const meta = await fileBytes(full, { limit }); totalBytes += Number(meta.size);
        entries.push({ path: key, kind: 'file', ...Object.fromEntries(BASIC.map(k => [k, meta[k]])), aclHash: meta.aclHash, nlink: meta.nlink, size: meta.size, mtimeNs: meta.mtimeNs, ctimeNs: meta.ctimeNs, sha256: meta.sha256 });
      }
    }
    const afterNames = sorted(await readdir(path));
    if (!equal(names, afterNames) || !equal(before, await directory(path, { root: prefix === '' }))) fail('FILES_CHANGED', 'Migration directory contents changed during inspection.');
  }
  await visit(root.path, '');
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { version: 1, platform: process.platform, statePathHash: digest(root.path), root: await directory(root.path, { root: true }), entries, fileCount, totalBytes };
  encoded(manifest, limits);
  if (!equal(manifest.root, root.identity) || await realpath(root.input) !== root.path || !equal(await directory(root.input, { root: true }), root.identity) || !equal(await controlProof(root.path, ownedControl), expectedControl)) fail('FILES_CHANGED', 'Migration source identity changed.');
  return manifest;
}

/** Pure filesystem observation: no database connection, lock or directory is created. */
async function scanFiles(context, { ownedControl, limits: input } = {}) {
  const limits = limitsFor(input), root = await sourceRoot(context), proof = await controlProof(root.path, ownedControl);
  const first = await scanOnce(root, ownedControl, limits, proof), second = await scanOnce(root, ownedControl, limits, proof);
  if (!equal(first, second)) fail('FILES_CHANGED', 'Migration needs one unchanged complete source snapshot.');
  return { manifest: first, manifestHash: digest(encoded(first, limits)) };
}

function validateManifest(value, limits) {
  if (!exact(value, ['version', 'platform', 'statePathHash', 'root', 'entries', 'fileCount', 'totalBytes']) || value.version !== 1 || !['darwin', 'linux', 'win32'].includes(value.platform) || !HASH.test(value.statePathHash || '') || !Array.isArray(value.entries) || value.entries.length > limits.maxFiles * 2 || !Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || value.fileCount > limits.maxFiles || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > limits.maxTotalBytes) fail('MANIFEST_INVALID', 'Invalid closed migration manifest.');
  function meta(row, keys) {
    if (!exact(row, keys)) fail('MANIFEST_INVALID', 'Invalid closed migration file metadata.');
    for (const key of BASIC) if (typeof row[key] !== 'string' || row[key].length > 40 || !DECIMAL.test(row[key])) fail('MANIFEST_INVALID', 'Migration identity must retain exact integer precision.');
    if (BigInt(row.ino) < 1n || (value.platform === 'win32' ? !HASH.test(row.aclHash || '') : row.aclHash !== null)) fail('MANIFEST_INVALID', 'Invalid migration privacy metadata.');
    const mode = BigInt(row.mode), isDirectory = row.kind !== 'file';
    if ((mode & 0o170000n) !== (isDirectory ? 0o040000n : 0o100000n) || value.platform !== 'win32' && ((mode & 0o022n) !== 0n || !Object.hasOwn(row, 'path') && (mode & 0o077n) !== 0n || !isDirectory && (mode & 0o6000n) !== 0n)) fail('MANIFEST_INVALID', 'Migration file kind or permissions contradict its metadata.');
  }
  meta(value.root, [...BASIC, 'aclHash']);
  const entries = [], directories = new Set(['']), names = new Set(); let bytes = 0, count = 0, previous = '';
  for (const entry of value.entries) {
    relativeName(entry?.path);
    if (entry.path <= previous || names.has(value.platform === 'win32' ? entry.path.toLowerCase() : entry.path)) fail('MANIFEST_INVALID', 'Migration paths must be uniquely and canonically sorted.');
    previous = entry.path; names.add(value.platform === 'win32' ? entry.path.toLowerCase() : entry.path);
    if (!directories.has(entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '')) fail('MANIFEST_INVALID', 'Migration manifest omits a parent directory.');
    const keys = entry.kind === 'directory' ? DIR_KEYS : entry.kind === 'file' ? FILE_KEYS : [];
    meta(entry, keys);
    const row = Object.fromEntries(keys.map(k => [k, entry[k]]));
    if (entry.kind === 'directory') directories.add(entry.path);
    else {
      if (entry.nlink !== '1' || typeof entry.size !== 'string' || entry.size.length > 40 || !DECIMAL.test(entry.size) || !['mtimeNs', 'ctimeNs'].every(k => typeof entry[k] === 'string' && entry[k].length <= 40 && CLOCK.test(entry[k]) && entry[k] !== '-0') || !HASH.test(entry.sha256 || '')) fail('MANIFEST_INVALID', 'Invalid bounded migration file record.');
      const limit = entry.path === 'dialogue/store.json' ? Math.min(16 * 1024 * 1024, limits.maxFileBytes) : limits.maxFileBytes;
      if (BigInt(entry.size) > BigInt(limit)) fail('CAPACITY', 'Migration file record exceeds its bound.');
      bytes += Number(entry.size); count++;
    }
    entries.push(row);
  }
  if (count !== value.fileCount || bytes !== value.totalBytes || bytes > limits.maxTotalBytes) fail('MANIFEST_INVALID', 'Migration manifest totals do not match.');
  const result = { version: 1, platform: value.platform, statePathHash: value.statePathHash, root: Object.fromEntries([...BASIC, 'aclHash'].map(k => [k, value.root[k]])), entries, fileCount: count, totalBytes: bytes };
  encoded(result, limits); return result;
}
async function newDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('BACKUP_CONFLICT', 'Migration never overwrites an existing backup destination.'); throw error; }
  if (process.platform === 'win32') await protectWindowsPrivatePath(path, { directory: true });
  await directory(path, { artifact: true });
}
async function writePrivate(path, data) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  if (process.platform === 'win32') await protectWindowsPrivatePath(path);
}
function summary(manifest, manifestHash) { return { manifest, manifestHash, blobCount: new Set(manifest.entries.filter(r => r.kind === 'file').map(r => r.sha256)).size, totalBytes: manifest.totalBytes }; }

/** Creates only a new private data bundle. A failed copy remains incomplete;
 * neither the source nor an existing backup is repaired or overwritten. */
async function writeBlobs(context, destination, { expected, ownedControl, limits: input } = {}) {
  const limits = limitsFor(input), root = await sourceRoot(context), dest = pathValue(destination), parent = await realpath(dirname(dest));
  await directory(parent, { artifact: true });
  if (within(join(parent, dest.slice(dirname(dest).length + 1)), root.path) || within(root.path, dest)) fail('PATH_INVALID', 'Backup and source directories must be separate.');
  const observed = await scanStateFiles(context, { ownedControl, limits });
  if (expected) {
    const m = validateManifest(expected.manifest ?? expected, limits), h = digest(encoded(m, limits));
    if (expected.manifestHash !== undefined && expected.manifestHash !== h || h !== observed.manifestHash) fail('FILES_CHANGED', 'Migration source no longer matches its exact expected snapshot.');
  }
  await newDirectory(dest); await newDirectory(join(dest, 'blobs'));
  const done = new Set();
  for (const row of observed.manifest.entries) {
    if (row.kind !== 'file') continue;
    let output;
    if (!done.has(row.sha256)) output = await open(join(dest, 'blobs', row.sha256), 'wx', 0o600);
    let copied;
    try { copied = await fileBytes(join(root.path, ...row.path.split('/')), { limit: Number(row.size), onChunk: output ? part => output.writeFile(part) : undefined }); if (output) await output.sync(); }
    finally { if (output) await output.close(); }
    const { path, kind, ...expectedMeta } = row;
    if (!equal(copied, { ...Object.fromEntries(FILE_STAT.map(k => [k, expectedMeta[k]])), aclHash: row.aclHash, sha256: row.sha256 })) fail('FILES_CHANGED', 'Migration source changed during backup publication.');
    if (process.platform === 'win32' && !done.has(row.sha256)) await protectWindowsPrivatePath(join(dest, 'blobs', row.sha256));
    done.add(row.sha256);
  }
  const after = await scanStateFiles(context, { ownedControl, limits });
  if (after.manifestHash !== observed.manifestHash) fail('FILES_CHANGED', 'Migration source changed before backup completion.');
  await writePrivate(join(dest, 'manifest.json'), encoded(observed.manifest, limits) + '\n');
  await writePrivate(join(dest, 'complete.json'), JSON.stringify({ version: 1, manifestHash: observed.manifestHash }) + '\n');
  return summary(observed.manifest, observed.manifestHash);
}

/** Verifies every blob, including files not selected by the caller. */
async function verifyBlobs(destination, { expectedManifestHash, limits: input } = {}) {
  const limits = limitsFor(input), dest = pathValue(destination);
  if (expectedManifestHash !== undefined && !HASH.test(expectedManifestHash)) fail('BACKUP_INVALID', 'Invalid expected migration manifest hash.');
  const root = await directory(dest, { artifact: true });
  if (!equal(sorted(await readdir(dest)), ['blobs', 'complete.json', 'manifest.json'])) fail('BACKUP_INVALID', 'Migration backup is incomplete or has unexpected contents.');
  const observedManifest = await smallSnapshot(join(dest, 'manifest.json'), limits.maxManifestBytes), observedComplete = await smallSnapshot(join(dest, 'complete.json'), 512);
  const manifest = validateManifest(jsonBytes(observedManifest.bytes), limits), manifestHash = digest(encoded(manifest, limits));
  const complete = jsonBytes(observedComplete.bytes);
  if (!exact(complete, ['version', 'manifestHash']) || complete.version !== 1 || complete.manifestHash !== manifestHash || expectedManifestHash !== undefined && expectedManifestHash !== manifestHash) fail('BACKUP_INVALID', 'Migration backup does not match its fixed completion evidence.');
  const blobDirectory = await directory(join(dest, 'blobs'), { artifact: true });
  const unique = new Map();
  for (const row of manifest.entries.filter(row => row.kind === 'file')) {
    if (unique.has(row.sha256) && unique.get(row.sha256) !== row.size) fail('BACKUP_INVALID', 'Contradictory migration blob sizes.');
    unique.set(row.sha256, row.size);
  }
  if (!equal(sorted(await readdir(join(dest, 'blobs'))), sorted(unique.keys()))) fail('BACKUP_INVALID', 'Migration backup blob set is incomplete or unexpected.');
  const snapshots = new Map();
  for (const [sha, size] of unique) { const row = await fileBytes(join(dest, 'blobs', sha), { limit: Number(size), artifact: true }); if (row.sha256 !== sha || row.size !== size) fail('BACKUP_INVALID', 'Migration backup blob verification failed.'); snapshots.set(sha, row); }
  for (const [sha, size] of unique) if (!equal(await fileBytes(join(dest, 'blobs', sha), { limit: Number(size), artifact: true }), snapshots.get(sha))) fail('BACKUP_INVALID', 'Migration backup blob changed during complete verification.');
  const finalManifest = await smallSnapshot(join(dest, 'manifest.json'), limits.maxManifestBytes), finalComplete = await smallSnapshot(join(dest, 'complete.json'), 512);
  if (!equal(observedManifest.meta, finalManifest.meta) || !equal(observedComplete.meta, finalComplete.meta) || !equal(sorted(await readdir(dest)), ['blobs', 'complete.json', 'manifest.json']) || !equal(sorted(await readdir(join(dest, 'blobs'))), sorted(unique.keys())) || !equal(blobDirectory, await directory(join(dest, 'blobs'), { artifact: true })) || !equal(root, await directory(dest, { artifact: true }))) fail('BACKUP_INVALID', 'Migration backup identity or completion evidence changed during verification.');
  return summary(manifest, manifestHash);
}
async function readBlob(destination, sha, { expectedManifestHash } = {}) {
  if (!HASH.test(expectedManifestHash || '') || !HASH.test(sha || '')) fail('BACKUP_INVALID', 'An exact expected manifest and selected blob hash are required.');
  const backup = await verifyBackupBlobs(destination, { expectedManifestHash });
  const row = backup.manifest.entries.find(row => row.kind === 'file' && row.sha256 === sha);
  if (!row || BigInt(row.size) > 16n * 1024n * 1024n) fail('CAPACITY', 'The selected recovery blob must fit the bounded store reader.');
  const bytes = await small(join(destination, 'blobs', sha), Number(row.size));
  if (digest(bytes) !== sha) fail('BACKUP_INVALID', 'The selected recovery blob changed.');
  return bytes;
}

function expectedStore(row) {
  if (!exact(row, FILE_KEYS) || row.path !== 'dialogue/store.json' || row.kind !== 'file' || !FILE_STAT.every(key => typeof row[key] === 'string' && row[key].length <= 40 && (['mtimeNs', 'ctimeNs'].includes(key) ? CLOCK : DECIMAL).test(row[key]) && row[key] !== '-0') || row.nlink !== '1' || BigInt(row.ino) < 1n || BigInt(row.size) > 16n * 1024n * 1024n || !HASH.test(row.sha256 || '') || (process.platform === 'win32' ? !HASH.test(row.aclHash || '') : row.aclHash !== null)) fail('CANDIDATE_INVALID', 'Candidate metadata needs the exact bounded source store manifest row.');
  const mode = BigInt(row.mode);
  if ((mode & 0o170000n) !== 0o100000n || process.platform !== 'win32' && ((mode & 0o022n) !== 0n || (mode & 0o6000n) !== 0n || process.getuid && BigInt(row.uid) !== BigInt(process.getuid()))) fail('CANDIDATE_INVALID', 'Candidate metadata requires a safely owned ordinary source store.');
}
async function sourceStore(path, row) {
  const observed = await fileBytes(path, { limit: 16 * 1024 * 1024 });
  if (FILE_KEYS.some(key => !['path', 'kind'].includes(key) && observed[key] !== row[key])) fail('FILES_CHANGED', 'The exact source store changed before candidate metadata could be verified.');
  return observed;
}
async function copyWindowsStoreAcl(source, candidate) {
  if (!absoluteRemotePath(process.env.SystemRoot, 'powershell')) fail('CANDIDATE_INVALID', 'The fixed Windows system ACL helper is unavailable.');
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
    `$s=${powershellQuote(source)};$d=${powershellQuote(candidate)};foreach($p in @($s,$d)){$i=Get-Item -LiteralPath $p -Force;if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Store kind changed'}};` +
    "$sec=[Security.AccessControl.AccessControlSections]'Access,Owner,Group';$a=[IO.File]::GetAccessControl($s,$sec);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Store owner changed'};$sddl=$a.GetSecurityDescriptorSddlForm($sec);$copy=New-Object Security.AccessControl.FileSecurity;$copy.SetSecurityDescriptorSddlForm($sddl,$sec);[IO.File]::SetAccessControl($d,$copy);if([IO.File]::GetAccessControl($s,$sec).GetSecurityDescriptorSddlForm($sec) -cne $sddl -or [IO.File]::GetAccessControl($d,$sec).GetSecurityDescriptorSddlForm($sec) -cne $sddl){throw 'Store ACL changed'};[Console]::Out.Write('{\"copied\":true}');";
  const args = powershellCommand(script).split(' ').slice(1);
  let result;
  try { result = await execute(win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, { windowsHide: true, timeout: 8000, maxBuffer: 1024, encoding: 'utf8' }); }
  catch { fail('CANDIDATE_INVALID', 'The exact source ACL could not be applied to the new candidate within the fixed deadline.'); }
  if (result.stdout !== '{"copied":true}') fail('CANDIDATE_INVALID', 'Candidate ACL copying was not confirmed.');
}

/** Only the caller's newly created immutable candidate may have metadata
 * adjusted. A resumed candidate is evidence: verify it without repairing it. */
async function candidateMetadata(sourcePath, candidatePath, row, { newlyCreated = false } = {}) {
  if (typeof newlyCreated !== 'boolean') fail('CANDIDATE_INVALID', 'Candidate creation ownership must be explicit.');
  expectedStore(row);
  const sourceInput = pathValue(sourcePath), candidateInput = pathValue(candidatePath);
  const source = await realpath(sourceInput), candidate = await realpath(candidateInput);
  if (source === candidate) fail('CANDIDATE_INVALID', 'Candidate metadata cannot alter the original store.');
  await sourceStore(sourceInput, row);
  const before = await fileBytes(candidateInput, { limit: 16 * 1024 * 1024 });
  if (before.dev === row.dev && before.ino === row.ino) fail('CANDIDATE_INVALID', 'Candidate metadata requires an independent file.');
  if (newlyCreated) {
    const handle = await open(candidateInput, constants.O_RDWR | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      if (!equal(statFields(await handle.stat({ bigint: true }), FILE_STAT), Object.fromEntries(FILE_STAT.map(key => [key, before[key]])))) fail('FILES_CHANGED', 'Candidate changed before metadata preparation.');
      if (process.platform !== 'win32' && (before.uid !== row.uid || before.gid !== row.gid)) await handle.chown(Number(row.uid), Number(row.gid));
      if (before.mode !== row.mode) await handle.chmod(Number(BigInt(row.mode) & 0o7777n));
      if (process.platform === 'win32') await copyWindowsStoreAcl(sourceInput, candidateInput);
      await handle.sync();
    } finally { await handle.close(); }
  }
  const after = await fileBytes(candidateInput, { limit: 16 * 1024 * 1024 });
  if (['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'sha256'].some(key => after[key] !== before[key]) || ['mode', 'uid', 'gid', 'aclHash'].some(key => after[key] !== row[key])) fail('CANDIDATE_INVALID', 'Candidate metadata or bytes do not match the exact publication requirements.');
  if (!newlyCreated && !equal(before, after)) fail('FILES_CHANGED', 'Existing candidate evidence changed during verification.');
  await sourceStore(sourceInput, row);
  if (await realpath(sourceInput) !== source || await realpath(candidateInput) !== candidate) fail('FILES_CHANGED', 'Source or candidate path changed during metadata preparation.');
  return after;
}

/** SQLite may update WAL read marks even for a query. Only an isolated private
 * working copy is opened; immutable source blobs are never passed to SQLite. */
async function validateLedger(destination, { expectedManifestHash, backend } = {}) {
  if (!['embedded', 'hcom'].includes(backend) || !HASH.test(expectedManifestHash || '')) fail('LEDGER_INVALID', 'Exact backend and backup evidence are required.');
  const backup = await verifyBackupBlobs(destination, { expectedManifestHash }), files = new Map(backup.manifest.entries.filter(row => row.kind === 'file').map(row => [row.path, row]));
  if (!files.has('hcom.db') || files.has('hcom.db-journal') && BigInt(files.get('hcom.db-journal').size) !== 0n) fail('LEDGER_INVALID', 'Migration refuses a missing database or nonempty rollback journal.');
  const work = await mkdtemp(join(tmpdir(), 'ad-migration-ledger-')); let db;
  try {
    if (process.platform === 'win32') await protectWindowsPrivatePath(work, { directory: true });
    for (const name of ['hcom.db', 'hcom.db-wal', 'hcom.db-shm', 'hcom.db-journal']) {
      const row = files.get(name); if (!row) continue;
      const output = await open(join(work, name), 'wx', 0o600);
      try { const copied = await fileBytes(join(destination, 'blobs', row.sha256), { limit: Number(row.size), artifact: true, onChunk: part => output.writeFile(part) }); if (copied.sha256 !== row.sha256) fail('BACKUP_INVALID', 'Ledger blob changed before validation.'); await output.sync(); }
      finally { await output.close(); }
      if (process.platform === 'win32') await protectWindowsPrivatePath(join(work, name));
    }
    const handle = await open(join(work, 'hcom.db'), 'r');
    const header = Buffer.alloc(100); let count;
    try { count = (await handle.read(header, 0, 100, 0)).bytesRead; } finally { await handle.close(); }
    if (count !== 100 || !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail('LEDGER_INVALID', 'Migration database header is invalid.');
    db = new DatabaseSync(join(work, 'hcom.db'), { allowExtension: false });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') fail('LEDGER_INVALID', 'Migration database integrity could not be verified.');
    const application = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version;
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    const tableType = table => db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(table)?.type;
    const events = columns('events');
    if (tableType('events') !== 'table' || (backend === 'embedded' ? application !== 0x41444c47 || version !== 1 || events.join(',') !== 'id,timestamp,type,data' || tableType('ad_endpoints') !== 'table' || columns('ad_endpoints').join(',') !== 'name,registered_at' : application === 0x41444c47 || !['id', 'timestamp', 'type', 'data'].every(name => events.includes(name)))) fail('LEDGER_INVALID', 'Migration database does not match the selected backend.');
    const countEvents = db.prepare('SELECT count(*) AS n FROM events').get().n;
    if (!Number.isSafeInteger(countEvents) || countEvents < 0) fail('LEDGER_INVALID', 'Migration ledger count is invalid.');
    db.close(); db = undefined;
    await verifyBackupBlobs(destination, { expectedManifestHash });
    return { status: 'verified', backend, events: countEvents, manifestHash: expectedManifestHash };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('MIGRATION_')) throw error;
    fail('LEDGER_INVALID', 'Migration private ledger validation failed; source evidence was preserved.');
  } finally { if (db) db.close(); await rm(work, { recursive: true, force: true }); }
}

async function guarded(operation) {
  try { return await operation(); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('MIGRATION_')) throw error;
    fail('FILES_UNAVAILABLE', 'Migration file evidence could not be safely inspected; the original state was preserved.');
  }
}
export async function scanStateFiles(context, options) { return guarded(() => scanFiles(context, options)); }
export async function writeBackupBlobs(context, destination, options) { return guarded(() => writeBlobs(context, destination, options)); }
export async function verifyBackupBlobs(destination, options) { return guarded(() => verifyBlobs(destination, options)); }
export async function readBackupBlob(destination, sha, options) { return guarded(() => readBlob(destination, sha, options)); }
export async function validateBackupLedger(destination, options) { return guarded(() => validateLedger(destination, options)); }
export async function prepareMigrationCandidateMetadata(source, candidate, expected, options) { return guarded(() => candidateMetadata(source, candidate, expected, options)); }
