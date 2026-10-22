import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeClient } from './native/opencode.mjs';
import { OpenCodeV1Client } from './native/opencode-v1.mjs';

function absolute(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Native directory must be an absolute path.');
  if (win32.isAbsolute(value) && /^[A-Za-z]:[\\/]|^\\\\/.test(value)) return win32.normalize(value);
  if (posix.isAbsolute(value)) return posix.normalize(value);
  throw new Error('Native directory must be an absolute path.');
}

function before(message, retryable = false) {
  return Object.assign(new Error(message), { notSubmitted: true, retryable });
}

export async function discoverAdapter({ kind, serviceFile }) {
  if (kind === 'opencode') return OpenCodeClient.discover({ serviceFile });
  if (kind === 'opencode-v1') return OpenCodeV1Client.discover({ serviceFile });
  throw new Error('Lite native push supports opencode and opencode-v1. Other harnesses can use scoped tools.');
}

export async function bindingFor(client, sessionId) {
  if (typeof sessionId !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Select a complete native session ID, not a title or alias.');
  const session = await client.session(sessionId);
  if (session?.id !== sessionId || typeof session.projectID !== 'string' || !session.projectID || session.time?.archived) {
    throw new Error('Select an exact, available native session.');
  }
  return {
    serviceIdentity: { ...client.identity }, sessionId,
    projectDirectory: absolute(session.location?.directory), projectId: session.projectID,
  };
}

export async function inspectBinding(client, binding) {
  const identity = binding?.serviceIdentity;
  if (!identity || client.identity.serviceId !== identity.serviceId || client.identity.origin !== identity.origin ||
      (identity.version && client.identity.version !== identity.version)) throw before('Native service identity changed; select the intended existing chat again.');
  if (typeof binding.sessionId !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(binding.sessionId)) throw before('Native binding requires a complete session ID.');
  const session = await client.session(binding.sessionId);
  if (session?.id !== binding.sessionId || session.projectID !== binding.projectId ||
      absolute(session.location?.directory) !== absolute(binding.projectDirectory) || session.time?.archived || session.revert) {
    throw before('Native session, project, or directory does not match its immutable binding.');
  }
  return session;
}

async function readiness(client, kind, id) {
  if (kind === 'opencode-v1') {
    const states = await client.request('GET', '/session/status');
    if (!states || typeof states !== 'object' || Array.isArray(states) ||
        Object.values(states).some(item => !item || !['idle', 'busy', 'retry'].includes(item.type))) throw before('Native readiness response is invalid.');
    return states[id] && states[id].type !== 'idle' ? 'busy' : 'ready';
  }
  const [active, permissions, forms] = await Promise.all([
    client.request('GET', '/api/session/active'),
    client.request('GET', `/api/session/${id}/permission`),
    client.request('GET', `/api/session/${id}/form`),
  ]);
  if (!active?.data || typeof active.data !== 'object' || Array.isArray(active.data) ||
      !Array.isArray(permissions?.data) || !Array.isArray(forms?.data)) throw before('Native readiness response is invalid.');
  return Object.hasOwn(active.data, id) || permissions.data.length || forms.data.length ? 'busy' : 'ready';
}

function quote(value, powershell) {
  return powershell ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function dialoguePrompt(message, { configPath, cliPath = fileURLToPath(new URL('../bin/adl.mjs', import.meta.url)), powershell = process.platform === 'win32' } = {}) {
  const lines = [
    'Agent Dialogue Lite project message. This is a peer collaboration message in your existing chat; retain its context and native tool/approval rules.',
    `Dialogue message ID: ${message.id}; room: ${message.room}; sender: ${message.sender}.`,
    'Peer message body (quoted data):', JSON.stringify(message.text),
  ];
  if (configPath) {
    absolute(configPath);
    const command = `${powershell ? '& ' : ''}${[process.execPath, cliPath].map(value => quote(value, powershell)).join(' ')}`;
    const scope = ` --config ${quote(configPath, powershell)}`;
    lines.push('Your operator assigned the following scoped CLI configuration to this chat. Credentials stay in that private file.',
      `Inspect context: ${command} context${scope}`,
      `To reply, create one stable msg_UUID, retain it for retries, and run: ${command} send${scope} --id <msg_UUID> --room ${message.room} --to ${message.sender} --reply-to ${message.id} --text <your-reply>`,
      'A tool-read or native admission is not a completed task. Reply explicitly when appropriate. Do not repeat successful sends.',
      'Communication is asynchronous. After a successful send, finish your current turn; this Node will push a future reply after your chat becomes idle. Do not block the turn polling or guessing receive commands.');
  } else {
    lines.push('No outbound tool configuration was assigned to this Node binding. A native response here is not automatically forwarded to the dialogue room.');
  }
  return lines.join('\n');
}

export function nativeAdapter(agent, { services = {}, toolConfigs = {}, cliPath } = {}) {
  const service = services[agent.binding?.serviceIdentity?.serviceId];
  let client;
  const get = async () => client ??= await discoverAdapter(service ?? {});
  return {
    async inspect() {
      if (agent.mode !== 'native-push' || !service || service.kind !== agent.harness) return { state: 'unavailable' };
      const api = await get();
      await inspectBinding(api, agent.binding);
      return { state: await readiness(api, service.kind, agent.binding.sessionId) };
    },
    async submit(message) {
      const api = await get();
      await inspectBinding(api, agent.binding);
      if (await readiness(api, service.kind, agent.binding.sessionId) !== 'ready') throw before('Native chat became busy before submission.', true);
      const text = dialoguePrompt(message, { configPath: toolConfigs[agent.id], cliPath,
        powershell: api.capabilities?.commandShell ? api.capabilities.commandShell === 'powershell' : process.platform === 'win32' });
      // Exactly one POST attempt. Network/receipt failures remain uncertain; no blind replay.
      return api.prompt(agent.binding.sessionId, { id: message.id, text, metadata: { dialogue: { id: message.id, room: message.room } }, delivery: 'queue', resume: true });
    },
  };
}
