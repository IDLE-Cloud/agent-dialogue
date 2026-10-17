import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_PATH = fileURLToPath(new URL('../config/hcom.lock.json', import.meta.url));
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function within(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

/** Select only a reviewed platform asset; do not guess a different ABI. */
export function selectRelease(lock, platformKey = `${platform()}-${arch()}`) {
  if (!lock || typeof lock.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(lock.version)) fail('Invalid hcom release version lock.');
  const asset = lock.assets?.[platformKey];
  if (!asset) {
    if (platformKey.startsWith('win32-')) fail('Native Windows installation is not supported yet. Use WSL with a reviewed Linux platform asset.');
    fail(`No reviewed hcom release for ${platformKey}. Supported platforms: ${Object.keys(lock.assets || {}).join(', ')}.`);
  }
  const prefix = `https://github.com/aannoo/hcom/releases/download/v${lock.version}/`;
  if (!asset.asset_url?.startsWith(prefix) || !/^hcom-[A-Za-z0-9_-]+\.tar\.gz$/.test(asset.asset_url.slice(prefix.length)) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) {
    fail(`Invalid release lock for ${platformKey}.`);
  }
  return { ...asset, version: lock.version, platform: platformKey };
}

/** Validate both path names and entry kinds before tar extracts anything. */
export function validateArchiveListing(names, verbose) {
  const entries = names.split('\n').filter(Boolean);
  if (!entries.length) fail('Release archive is empty.');
  for (const name of entries) {
    if (name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) fail(`Unsafe archive entry: ${name}`);
  }
  const modes = verbose.split('\n').filter(Boolean).map(line => line[0]);
  if (modes.length !== entries.length || modes.some(mode => mode !== '-' && mode !== 'd')) fail('Archive contains links or unsupported entry types.');
}

async function run(executable, args, { env = process.env, cwd, timeout = 10_000 } = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', outputSize = 0, outputError, killTimer;
    function collect(destination, chunk) {
      outputSize += Buffer.byteLength(chunk);
      if (outputSize > 8 * 1024 * 1024) {
        outputError = new Error(`${executable} output exceeds the installer limit.`);
        child.kill('SIGKILL');
      } else if (destination === 'stdout') stdout += chunk;
      else stderr += chunk;
    }
    child.stdout.setEncoding('utf8').on('data', chunk => collect('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => collect('stderr', chunk));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, timeout);
    function clear() { clearTimeout(timer); clearTimeout(killTimer); }
    child.once('error', error => { clear(); reject(new Error(`Cannot run ${executable}: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clear();
      if (outputError) reject(outputError);
      else done({ code: code ?? 143, stdout, stderr, signal });
    });
  });
}

async function findBinary(root) {
  const found = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) fail('Archive extracted a symbolic link.');
      if (item.isDirectory()) await walk(path);
      else if (!item.isFile()) fail('Archive extracted an unsupported entry type.');
      else if (item.name === 'hcom') found.push(path);
    }
  }
  await walk(root);
  if (found.length !== 1) fail(`Expected exactly one hcom executable; found ${found.length}.`);
  return found[0];
}

function matchingVersion(result, version) { return result.code === 0 && result.stdout.trim() === `hcom ${version}`; }

/** Install into the caller's private runtime cache, never the package directory.
 * Optional dependencies support offline verification; CLI callers use the
 * committed release lock, native fetch, and the real process runner.
 */
export async function installHcom(context, options = {}) {
  if (!context?.runtimeDir || !isAbsolute(context.runtimeDir)) fail('setup requires an absolute private runtimeDir.');
  const runtime = resolve(context.runtimeDir), binDir = join(runtime, 'bin'), binary = join(binDir, 'hcom');
  if (resolve(context.binary || binary) !== binary) fail('setup will not overwrite AGENT_DIALOGUE_HCOM or an external executable. Unset the override to install the pinned runtime, or use that executable directly.');
  const lock = options.lock || JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const release = selectRelease(lock, options.platformKey || `${platform()}-${arch()}`);
  const fetchImpl = options.fetchImpl || globalThis.fetch, runImpl = options.runImpl || run;
  const actualRuntime = await canonicalPath(runtime), home = await canonicalPath(homedir()), personal = await canonicalPath(join(homedir(), '.hcom'));
  if (actualRuntime === home || within(actualRuntime, personal)) fail('Runtime must be a dedicated cache directory, not home or personal ~/.hcom.');
  if (await exists(runtime)) {
    const info = await lstat(runtime);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Runtime path must be a real dedicated directory, not a symlink.');
  } else await mkdir(runtime, { recursive: true, mode: 0o700 });
  const installLock = join(runtime, '.install.lock'), owner = randomUUID(), ownerPath = join(installLock, 'owner.json');
  try { await mkdir(installLock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail(`Another installer owns ${installLock}. If it crashed, inspect its owner.json and remove only that stale lock before retrying.`);
    throw error;
  }
  let staging, installedFinal;
  try {
    await writeFile(ownerPath, JSON.stringify({ owner, pid: process.pid, started: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    if (await exists(binDir)) {
      const info = await lstat(binDir);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('Runtime bin directory must not be a symlink.');
    } else await mkdir(binDir, { mode: 0o700 });
    if (await exists(binary)) {
      const info = await lstat(binary);
      let actual;
      try { actual = await realpath(binary); } catch { fail('Existing hcom symlink is broken; refusing to overwrite it.'); }
      if (!info.isSymbolicLink() || !within(actual, await realpath(runtime))) fail('Existing hcom is not a managed runtime installation; refusing to overwrite it.');
      const result = await runImpl(binary, ['--version'], { env: context.env, capture: true, timeout: 10_000 });
      if (!matchingVersion(result, lock.version)) fail(`Existing hcom does not match pinned version ${lock.version}; refusing to overwrite it.`);
      console.log(`Already installed: ${result.stdout.trim()}\n${binary}`);
      return 0;
    }
    const finalDir = join(runtime, `hcom-${lock.version}`);
    if (await exists(finalDir)) fail(`Installation directory already exists: ${finalDir}. Refusing to overwrite it.`);
    staging = await mkdtemp(join(runtime, '.install-'));
    const response = await fetchImpl(release.asset_url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) fail(`Download failed: HTTP ${response.status}.`);
    if (!response.body) fail('Release download has no response body.');
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) fail('Release archive exceeds 128 MiB.');
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks), hash = createHash('sha256').update(data).digest('hex');
    if (hash !== release.sha256) fail(`SHA-256 mismatch: expected ${release.sha256}, received ${hash}.`);
    const archive = join(staging, 'release.tar.gz'), unpacked = join(staging, 'unpacked');
    await writeFile(archive, data, { flag: 'wx', mode: 0o600 });
    await mkdir(unpacked, { mode: 0o700 });
    const [listing, verbose] = await Promise.all([
      runImpl('tar', ['-tzf', archive], { capture: true, timeout: 10_000 }),
      runImpl('tar', ['-tvzf', archive], { capture: true, timeout: 10_000 }),
    ]);
    if (listing.code || verbose.code) fail('Cannot inspect release archive.');
    validateArchiveListing(listing.stdout, verbose.stdout);
    const extraction = await runImpl('tar', ['-xzf', archive, '-C', unpacked], { capture: true, timeout: 10_000 });
    if (extraction.code) fail(`Cannot extract release: ${extraction.stderr.trim()}`);
    const extracted = await findBinary(unpacked);
    await chmod(extracted, 0o755);
    const result = await runImpl(extracted, ['--version'], { env: context.env, capture: true, timeout: 10_000 });
    if (!matchingVersion(result, lock.version)) fail('Downloaded executable version does not match the release lock.');
    const inside = relative(unpacked, extracted);
    await rename(unpacked, finalDir);
    installedFinal = finalDir;
    await symlink(relative(binDir, join(finalDir, inside)), binary);
    installedFinal = undefined;
    console.log(`Installed ${result.stdout.trim()}\nSHA-256 ${hash}\n${binary}`);
    return 0;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (installedFinal) await rm(installedFinal, { recursive: true, force: true });
    let actualOwner;
    try { actualOwner = JSON.parse(await readFile(ownerPath, 'utf8')).owner; } catch { /* ownership uncertain: preserve lock */ }
    if (actualOwner === owner) await rm(installLock, { recursive: true, force: true });
  }
}
