import { resolve } from 'node:path';
import { OpenCodeClient } from './opencode.mjs';

const OPENCODE_CAPABILITIES = Object.freeze({ existingAttach: true, queue: true, stableInputId: true, resume: false });

export function harnessId(tool) {
  if (tool === 'opencode-v1') return 'opencode-v1';
  if (tool === 'opencode' || tool === 'opencode-v2') return 'opencode-v2';
  if (tool === 'codex' || tool === 'codex-app-server') return 'codex-app-server';
  throw new Error(`Unsupported native harness: ${typeof tool === 'string' ? tool : '(missing)'}. Choose opencode or codex.`);
}

/** Keep the original instance so adapter methods retain their private state. */
export async function nativeClient(context, harness, { factory } = {}) {
  const normalized = harnessId(harness);
  let client;
  if (factory !== undefined) {
    if (typeof factory !== 'function') throw new Error('Native adapter factory must be a function.');
    client = await factory(normalized, context);
  } else if (normalized === 'opencode-v2') {
    client = await OpenCodeClient.discover({ serviceFile: context?.env?.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE });
  } else if (normalized === 'opencode-v1') {
    const { OpenCodeV1Client } = await import('./opencode-v1.mjs');
    client = await OpenCodeV1Client.discover({ serviceFile: context?.env?.AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE });
  } else {
    const { CodexClient } = await import('./codex.mjs');
    client = await CodexClient.discover({ env: context?.env });
  }
  if (!client || !client.identity || ['session', 'prompt', 'inbox', 'messages'].some(method => typeof client[method] !== 'function')) {
    await client?.close?.();
    throw new Error('Native adapter does not implement the required session interface.');
  }
  if (normalized === 'opencode-v2' && !client.capabilities) {
    Object.defineProperty(client, 'capabilities', { value: OPENCODE_CAPABILITIES, enumerable: true });
  }
  return client;
}

export async function withNative(context, harness, fn, options = {}) {
  if (typeof fn !== 'function') throw new Error('withNative requires a callback.');
  const client = await nativeClient(context, harness, options);
  try { return await fn(client); }
  finally { await client.close?.(); }
}

/** The receiver checks authoritative runtime data, never a model's claimed ID. */
export async function inspectBinding(client, binding) {
  if (!binding || binding.remote) throw new Error('Cannot inspect a remote binding through a local native adapter.');
  if (!client?.identity || client.identity.serviceId !== binding.serviceId || client.identity.origin !== binding.origin) {
    throw new Error('Native service identity changed; attach a new binding after review.');
  }
  const session = await client.session(binding.sessionId);
  const directory = session?.location?.directory;
  if (!session || session.id !== binding.sessionId || session.projectID !== binding.projectId || typeof directory !== 'string' || !directory || resolve(directory) !== binding.directory || session.time?.archived) {
    throw new Error('Native session/project/directory does not match binding.');
  }
  return session;
}

function safeModel(model) {
  if (typeof model === 'string') return model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const result = {};
  for (const key of ['id', 'model', 'modelID', 'providerID', 'provider', 'variant']) {
    if (typeof model[key] === 'string') result[key] = model[key];
  }
  return Object.keys(result).length ? result : null;
}

function safeTime(time) {
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const result = {};
  for (const key of ['created', 'updated', 'idle', 'viewed', 'archived']) {
    if (typeof time[key] === 'number' && Number.isFinite(time[key])) result[key] = time[key];
  }
  return result;
}

export async function listNative(context, tool, { directory, factory } = {}) {
  const harness = harnessId(tool);
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim() || directory.includes('\0'))) throw new Error('Invalid native directory filter.');
  const expectedDirectory = directory === undefined ? undefined : resolve(directory);
  return await withNative(context, harness, async client => {
    if (typeof client.sessions !== 'function') throw new Error('Native adapter does not support session listing.');
    const items = await client.sessions(expectedDirectory === undefined ? {} : { directory: expectedDirectory });
    if (!Array.isArray(items)) throw new Error('Invalid native session listing.');
    const sessions = [];
    for (const session of items) {
      if (!session || typeof session.id !== 'string' || !session.id) throw new Error('Invalid native session metadata.');
      const sessionDirectory = session.location?.directory;
      if (expectedDirectory !== undefined && (typeof sessionDirectory !== 'string' || resolve(sessionDirectory) !== expectedDirectory)) continue;
      sessions.push({
        id: session.id,
        title: typeof session.title === 'string' ? session.title : null,
        projectId: typeof session.projectID === 'string' ? session.projectID : null,
        directory: typeof sessionDirectory === 'string' ? sessionDirectory : null,
        model: safeModel(session.model),
        time: safeTime(session.time),
        loaded: typeof session.loaded === 'boolean' ? session.loaded : null,
      });
    }
    const service = { serviceId: client.identity.serviceId, origin: client.identity.origin };
    if (typeof client.identity.version === 'string') service.version = client.identity.version;
    return { harness, service, capabilities: client.capabilities || {}, sessions };
  }, { factory });
}
