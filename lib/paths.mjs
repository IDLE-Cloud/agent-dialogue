import { homedir, platform, arch } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HCOM_VERSION = '0.7.30';
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPACE = /^[a-z][a-z0-9_-]{0,39}$/;

function pathValue(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a non-empty path.`);
  return value;
}

function xdgRoot(source, variable, fallback) {
  if (source[variable] === undefined) return fallback;
  const value = pathValue(source[variable], variable);
  if (!isAbsolute(value)) throw new Error(`${variable} must be an absolute path.`);
  return value;
}

function within(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function protectUserDirectory(path, home, label) {
  if (path === home || within(path, join(home, '.hcom'))) {
    throw new Error(`${label} must be a dedicated directory, not your home or personal ~/.hcom.`);
  }
}

/** User data is independent of the installed package, so upgrades preserve it. */
export function runtimeEnvironment(source = process.env, projectDir = PACKAGE_DIR) {
  // projectDir remains an API parameter for callers that provide package metadata;
  // it must never determine mutable user paths.
  void projectDir;
  const home = resolve(homedir());
  const stateRoot = xdgRoot(source, 'XDG_STATE_HOME', join(home, '.local', 'state'));
  const cacheRoot = xdgRoot(source, 'XDG_CACHE_HOME', join(home, '.cache'));
  let stateDir;
  if (source.AGENT_DIALOGUE_STATE_DIR !== undefined) {
    stateDir = resolve(pathValue(source.AGENT_DIALOGUE_STATE_DIR, 'AGENT_DIALOGUE_STATE_DIR'));
  } else {
    const space = source.AGENT_DIALOGUE_SPACE === undefined ? 'default' : source.AGENT_DIALOGUE_SPACE;
    if (typeof space !== 'string' || !SPACE.test(space)) throw new Error('AGENT_DIALOGUE_SPACE must start with a lowercase letter and contain 1–40 lowercase letters, digits, underscores or hyphens.');
    stateDir = resolve(stateRoot, 'agent-dialogue', 'spaces', space);
  }
  const cacheDir = source.AGENT_DIALOGUE_CACHE_DIR === undefined
    ? resolve(cacheRoot, 'agent-dialogue')
    : resolve(pathValue(source.AGENT_DIALOGUE_CACHE_DIR, 'AGENT_DIALOGUE_CACHE_DIR'));
  protectUserDirectory(stateDir, home, 'AGENT_DIALOGUE_STATE_DIR');
  protectUserDirectory(cacheDir, home, 'AGENT_DIALOGUE_CACHE_DIR');
  const runtimeDir = join(cacheDir, `hcom-${HCOM_VERSION}`, `${platform()}-${arch()}`);
  const binary = source.AGENT_DIALOGUE_HCOM === undefined
    ? join(runtimeDir, 'bin', 'hcom')
    : resolve(pathValue(source.AGENT_DIALOGUE_HCOM, 'AGENT_DIALOGUE_HCOM'));
  const env = {
    ...source,
    HCOM_DIR: stateDir,
    HCOM_AUTO_APPROVE: '0',
    HCOM_AUTO_TRUST_WORKSPACE: '0',
    AGENT_DIALOGUE_STATE_DIR: stateDir,
    AGENT_DIALOGUE_CACHE_DIR: cacheDir,
    PATH: `${join(runtimeDir, 'bin')}${delimiter}${source.PATH || ''}`,
  };
  if (source.AGENT_DIALOGUE_HCOM !== undefined) env.AGENT_DIALOGUE_HCOM = binary;
  if (source.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE !== undefined) {
    env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = resolve(pathValue(source.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE, 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE'));
  }
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color';
  return { env, stateDir, cacheDir, runtimeDir, binary };
}
