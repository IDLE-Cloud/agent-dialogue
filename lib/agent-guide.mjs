import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStore, resolveBinding, resolveRoom, validateRoute } from './bridge-store.mjs';
import { nodePublic, readExistingNode } from './node-identity.mjs';
import { cliCommand, powershellQuote } from './platform.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function scalar(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid binding context; expected printable identity and path fields.');
  }
  return value;
}
function code(text, language = '') {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(value => value.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

export async function readAgentGuide() {
  return await readFile(join(root, 'docs', 'AGENT-GUIDE.md'), 'utf8');
}

function commandBase(context, shell) {
  scalar(context.stateDir);
  if (context.cacheDir) scalar(context.cacheDir);
  for (const key of ['AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE', 'AGENT_DIALOGUE_KIMI_SERVICE_FILE', 'AGENT_DIALOGUE_ZCODE_SERVICE_FILE', 'CODEX_HOME', 'AGENT_DIALOGUE_CODEX_SOCKET']) {
    if (context.env?.[key]) scalar(context.env[key]);
  }
  return cliCommand(context, [], { shell });
}

function descriptor(binding) {
  return Object.fromEntries(['alias', 'id', 'revision', 'nodeId', 'harness', 'sessionId']
    .filter(key => binding[key] !== undefined)
    .map(key => {
      if (key === 'revision') {
        if (!Number.isSafeInteger(binding[key]) || binding[key] < 1) throw new Error('Invalid binding revision.');
        return [key, binding[key]];
      }
      return [key, scalar(binding[key])];
    }));
}

/** Read operator-selected local control records only; never initialize or query native services. */
export async function generateAgentContext(context, { room: roomId, from, to } = {}) {
  if (!roomId || !from || from === 'operator') throw new Error('agent-guide requires --room ID and --from a local agent alias.');
  const store = await readStore(context);
  const room = resolveRoom(store, roomId), source = resolveBinding(store, from);
  if (source.remote) throw new Error('Generate a sender context on its owning node; remote bindings cannot be local senders.');
  const node = nodePublic(await readExistingNode(context));
  if (source.nodeId !== node.nodeId) throw new Error('The sender binding does not belong to this space\'s owning node.');
  if (room.revision !== undefined && (!Number.isSafeInteger(room.revision) || room.revision < 1)) throw new Error('Invalid room revision.');
  if (room.manifestHash !== undefined && (typeof room.manifestHash !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(room.manifestHash))) throw new Error('Invalid room manifest hash.');
  const peers = to === undefined ? room.members.map(member => member.alias).filter(alias => alias !== from) : [to];
  if (!peers.length) throw new Error('No peer is available in the assigned room.');
  const routes = peers.map(alias => {
    const route = validateRoute(store, { room: roomId, from, to: alias });
    for (const binding of [route.from, route.to]) {
      const pin = room.members.find(member => member.alias === binding.alias);
      if (pin.nodeId !== undefined && pin.nodeId !== binding.nodeId) throw new Error('Room node pin differs from the active binding.');
      scalar(binding.sessionId);
    }
    return route;
  });
  const shell = source.commandShell ?? (process.platform === 'win32' ? 'powershell' : 'posix');
  const quote = shell === 'powershell' ? powershellQuote : value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const language = shell === 'powershell' ? 'powershell' : 'sh';
  const base = commandBase(context, shell);
  const identity = { room: room.id, ...(room.revision !== undefined ? { roomRevision: room.revision } : {}),
    ...(room.manifestHash ? { manifestHash: room.manifestHash } : {}), self: descriptor(source), peers: routes.map(route => descriptor(route.to)) };
  const lines = [
    '# Assigned agent-dialogue context', '',
    'Private operator-generated context for one native chat. Do not commit this file or choose it solely by project directory. Confirm self.sessionId belongs to the current chat before sending.', '',
    'This is a snapshot of saved active bindings and room pins. Generation does not verify native availability, start a worker or send a message. Regenerate after any binding or membership change.', '',
    code(JSON.stringify(identity, null, 2), 'json'), '',
    '## Exact commands', '',
    'These commands use the local queue. The owning bridge performs native checks and delivery. Replace YOUR_MESSAGE with correctly shell-quoted project text; keep every routing value and environment assignment.', ''
  ];
  for (const route of routes) {
    lines.push(`Send to ${route.to.alias}:`, '',
      code(`${base} collab send --queue --room ${quote(room.id)} --from ${quote(from)} --to ${quote(route.to.alias)} --expected-session ${quote(route.to.sessionId)} --message 'YOUR_MESSAGE'`, language), '');
  }
  lines.push('For replies use the complete reply command included in the incoming bridge delivery; it contains the correct local or global --reply-to identifier. Do not reply to a queued submission ID.', '',
    'Operator inspection command (contains local service metadata; keep output private):', '', code(`${base} bindings`, language), '',
    '## Communication protocol', '', await readAgentGuide());
  return `${lines.join('\n').trimEnd()}\n`;
}
