import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { validateSshSource } from './readers/ssh.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail() { throw new Error('Invalid viewer source configuration; use explicit local paths or pinned SSH rooms.'); }
function exact(value, keys) { if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(); }
export function validLabel(label) { return typeof label === 'string' && label.trim().length > 0 && label.length <= 64 && !/[\x00-\x1f\x7f]/.test(label); }

export async function readViewerConfig(path) {
  try {
    const location = resolve(path), info = await stat(location);
    if (!info.isFile() || info.size > 65536) fail();
    const bytes = await readFile(location);
    if (bytes.length > 65536) fail();
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    exact(config, ['version', 'sources']);
    if (config.version !== 1 || !Array.isArray(config.sources) || !config.sources.length || config.sources.length > 16) fail();
    return config.sources.map(row => {
      if (row?.kind === 'local') {
        exact(row, ['kind', 'label', 'path']);
        if (!validLabel(row.label) || typeof row.path !== 'string' || !row.path.trim() || Buffer.byteLength(row.path) > 4096 || /[\x00-\x1f\x7f]/.test(row.path)) fail();
        return { kind: 'local', label: row.label, path: resolve(dirname(location), row.path) };
      }
      if (row?.kind === 'ssh') {
        exact(row, ['kind', 'label', 'destination', 'executable', 'cli', 'stateDir', 'expectedNodeId', 'rooms', ...(Object.hasOwn(row, 'shell') ? ['shell'] : [])]);
        return validateSshSource({ ...row, id: 'configuration-validation' });
      }
      fail();
    });
  } catch { fail(); }
}

/** Only the operator-selected file and CLI can add a source; browser requests cannot. */
export async function registerSources(inputs) {
  if (!inputs.length || inputs.length > 16) fail();
  const endpoints = new Set(), sources = [];
  for (const input of inputs) {
    if (!validLabel(input.label)) fail();
    if (!input.kind || input.kind === 'local') {
      if (typeof input.path !== 'string' || !isAbsolute(input.path)) fail();
      const path = await realpath(input.path).catch(error => { if (error.code === 'ENOENT') return resolve(input.path); throw error; });
      const endpoint = JSON.stringify(['local', path]);
      if (endpoints.has(endpoint)) throw new Error('The same source directory was registered more than once.');
      endpoints.add(endpoint);
      sources.push({ id: `src_${createHash('sha256').update(path).digest('hex').slice(0, 24)}`, label: input.label, path });
    } else {
      const { id: ignoredId, ...config } = input;
      void ignoredId;
      const endpoint = JSON.stringify(['ssh', config.destination, config.stateDir, config.shell || 'posix']);
      if (endpoints.has(endpoint)) throw new Error('The same SSH source was registered more than once.');
      endpoints.add(endpoint);
      const id = `src_${createHash('sha256').update(JSON.stringify([endpoint, config.expectedNodeId, config.rooms])).digest('hex').slice(0, 24)}`;
      sources.push(validateSshSource({ ...config, id }));
    }
  }
  return sources;
}
