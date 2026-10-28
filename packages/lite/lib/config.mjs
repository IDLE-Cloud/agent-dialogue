import { mkdir, open, readFile, stat, lstat, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const stateDirectory = () => process.env.ADL_HOME ? resolve(process.env.ADL_HOME) :
  process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'agent-dialogue-lite') :
    join(homedir(), '.local', 'state', 'agent-dialogue-lite');
export const defaultConfig = () => join(stateDirectory(), 'hub.json');

export async function requireNewConfig(file) {
  try { await lstat(resolve(file)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output config already exists; choose a new path.');
}

export async function loadConfig(file) {
  const path = resolve(file);
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) {
    throw new Error('Config must be a private regular file (chmod 600 on POSIX).');
  }
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot parse Lite config.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Lite config.');
  return config;
}

export async function saveConfig(file, value, { exclusive = true } = {}) {
  const path = resolve(file);
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  // Only create the owned leaf. Never recursively chmod shared state or installed executables.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!exclusive) await loadConfig(path);
  const output = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(output, 'wx', 0o600);
  try {
    await handle.writeFile(encoded); await handle.sync(); await handle.close();
    if (!exclusive) await rename(output, path);
  } catch (error) {
    await handle.close().catch(() => {}); await rm(output, { force: true }).catch(() => {}); throw error;
  }
  return path;
}

export function configRelative(file, value) {
  return isAbsolute(value) ? value : resolve(dirname(resolve(file)), value);
}
