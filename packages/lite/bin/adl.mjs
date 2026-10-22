#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, configRelative, requireNewConfig } from '../lib/config.mjs';
import { HubClient, hubUrl, newId } from '../lib/client.mjs';

const HELP = `Agent Dialogue Lite 0.1.0 — Node.js 24+

adl init       [--config hub.json] [--port 8417] [--host 127.0.0.1] [--public-origin https://hub.example]
adl hub        --config hub.json
adl enrollment --config hub.json
adl enroll     --config node.json --hub https://hub.example --code CODE --label mac
adl room       --config hub.json --label project
adl sessions   --kind opencode|opencode-v1 --service-file FILE [--directory DIR]
adl attach     --config node.json --kind opencode|opencode-v1 --service-file FILE --session FULL_ID --alias NAME
adl attach     --config node.json --kind tool --session OPERATOR_CHAT_ID --directory DIR --alias NAME
adl join       --config hub.json --room ROOM --agent AGENT
adl scope      --config hub.json --agent AGENT --room ROOM[,ROOM] --out chat.json
adl link-tools --config node.json --agent AGENT --scope-config chat.json
adl viewer     --config hub.json --room ROOM[,ROOM] --out viewer.json
adl node       --config node.json [--port 8418]
adl mcp        --config chat.json
adl context    --config chat.json
adl send       --config chat.json --room ROOM --to AGENT[,AGENT] --text TEXT [--id msg_UUID] [--reply-to msg_UUID]
adl inbox      --config chat.json [--after 0] [--limit 50]
adl status     --config chat.json --id msg_UUID
adl resolve    --config hub.json --id msg_UUID --agent AGENT --state failed|delivered --note TEXT --executor-stopped
adl history    --config viewer.json --room ROOM [--after 0] [--limit 50]

Config files contain credentials; keep private. Use one scope file per selected chat.
Native push wakes a supported running harness; tool inbox alone does not wake a model.
Remote HTTP: use HTTPS or an SSH tunnel to a loopback URL. No automatic process launch.
`;

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required.`);
  return value;
}
function integer(value, fallback, max = 65535) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw new Error('Invalid numeric option.');
  return Number(value);
}
function list(value) { return value.split(',').map(v => v.trim()).filter(Boolean); }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
async function hold(close) {
  await new Promise(resolveDone => {
    let closing = false;
    const stop = async () => {
      if (closing) return; closing = true;
      try { await close(); } finally { resolveDone(); }
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Lite requires Node.js 24 or later.');
  const names = ['config', 'port', 'host', 'public-origin', 'hub', 'code', 'label', 'kind', 'service-file', 'session', 'directory',
    'alias', 'room', 'agent', 'out', 'scope-config', 'to', 'text', 'id', 'reply-to', 'after', 'limit', 'state', 'note'];
  const { values: o, positionals } = parseArgs({ options: Object.fromEntries([
    ...names.map(name => [name, { type: 'string' }]), ['help', { type: 'boolean', short: 'h' }],
    ['executor-stopped', { type: 'boolean' }],
  ]), allowPositionals: true });
  const command = positionals[0];
  if (o.help || !command) { process.stdout.write(HELP); return; }
  if (positionals.length !== 1) throw new Error('Use one command; see adl --help.');
  const file = resolve(o.config || defaultConfig());

  if (command === 'init') {
    const port = integer(o.port, 8417);
    const publicOrigin = o['public-origin'] ? hubUrl(o['public-origin']) : undefined;
    if (publicOrigin && !publicOrigin.startsWith('https:')) throw new Error('--public-origin requires HTTPS.');
    const path = await saveConfig(file, { kind: 'hub', url: publicOrigin || `http://127.0.0.1:${port}`, host: o.host || '127.0.0.1', port, publicOrigin,
      token: randomBytes(32).toString('base64url'), dbPath: join(dirname(file), 'hub.sqlite') });
    print({ config: path, next: 'adl hub --config <config>' }); return;
  }
  if (command === 'enroll') {
    await requireNewConfig(file);
    const url = hubUrl(required(o, 'hub'));
    const result = await new HubClient({ url }).request('POST', '/v1/enroll', { code: required(o, 'code'), label: required(o, 'label') });
    const path = await saveConfig(file, { kind: 'node', url, token: result.token, node: result.node, services: {}, toolConfigs: {}, port: integer(o.port, 8418) });
    print({ config: path, node: result.node }); return;
  }
  if (command === 'sessions') {
    const { discoverAdapter } = await import('../lib/adapters.mjs');
    const client = await discoverAdapter({ kind: required(o, 'kind'), serviceFile: resolve(required(o, 'service-file')) });
    print({ serviceIdentity: client.identity, sessions: await client.sessions(o.directory ? { directory: o.directory } : {}) }); return;
  }

  const config = await loadConfig(file);
  const client = new HubClient(config);
  switch (command) {
    case 'hub': {
      if (config.kind !== 'hub') throw new Error('Hub requires its operator config.');
      const { startHub } = await import('../lib/hub.mjs');
      const hub = await startHub({ dbPath: configRelative(file, config.dbPath), adminToken: config.token, host: config.host, port: config.port, publicOrigin: config.publicOrigin });
      if (config.port === 0) {
        config.port = Number(new URL(hub.url).port); config.url = config.publicOrigin || hub.url;
        await saveConfig(file, config, { exclusive: false });
      }
      print({ service: 'hub', url: hub.url, viewer: config.publicOrigin || hub.url }); await hold(hub.close); break;
    }
    case 'enrollment': print(await client.request('POST', '/v1/enrollments', {})); break;
    case 'room': print(await client.request('POST', '/v1/rooms', { label: required(o, 'label') })); break;
    case 'join': print(await client.request('POST', '/v1/members', { room: required(o, 'room'), agentId: required(o, 'agent') })); break;
    case 'attach': {
      if (config.kind !== 'node') throw new Error('Attach requires a node config.');
      const kind = required(o, 'kind'); let binding;
      if (kind === 'tool') {
        binding = { serviceIdentity: { serviceId: `operator:${config.node.id}`, origin: 'operator-assigned' },
          sessionId: required(o, 'session'), projectDirectory: resolve(required(o, 'directory')) };
      } else {
        const { discoverAdapter, bindingFor } = await import('../lib/adapters.mjs');
        const serviceFile = resolve(required(o, 'service-file'));
        const native = await discoverAdapter({ kind, serviceFile });
        binding = await bindingFor(native, required(o, 'session'));
        config.services[binding.serviceIdentity.serviceId] = { kind, serviceFile };
      }
      const agent = await client.request('POST', '/v1/agents', { alias: required(o, 'alias'), harness: kind,
        mode: kind === 'tool' ? 'tool-pull' : 'native-push', binding });
      await saveConfig(file, config, { exclusive: false }); print(agent); break;
    }
    case 'scope':
    case 'viewer': {
      const out = resolve(required(o, 'out')), rooms = list(required(o, 'room'));
      await requireNewConfig(out);
      const body = command === 'scope' ? { agentId: required(o, 'agent'), rooms } : { rooms };
      const result = await client.request('POST', command === 'scope' ? '/v1/scopes' : '/v1/viewers', body);
      await saveConfig(out, { kind: command === 'scope' ? 'agent' : 'viewer', url: config.url, ...result });
      print({ config: out, ...(result.agentId ? { agentId: result.agentId } : {}), rooms }); break;
    }
    case 'link-tools': {
      if (config.kind !== 'node') throw new Error('Link-tools requires a node config.');
      const scopePath = resolve(required(o, 'scope-config'));
      const scoped = await loadConfig(scopePath);
      const context = await new HubClient(scoped).request('GET', '/v1/context');
      const agentId = required(o, 'agent');
      if (hubUrl(scoped.url) !== hubUrl(config.url) || context.self?.id !== agentId || context.self?.nodeId !== config.node.id) {
        throw new Error('Scope must belong to the selected agent on this node and Hub.');
      }
      config.toolConfigs[agentId] = scopePath; await saveConfig(file, config, { exclusive: false });
      print({ agentId, config: scopePath }); break;
    }
    case 'node': {
      if (config.kind !== 'node') throw new Error('Node requires its enrolled config.');
      const { runNode } = await import('../lib/node.mjs');
      const node = await runNode({ client, port: integer(o.port, config.port ?? 8418), services: config.services, toolConfigs: config.toolConfigs });
      print({ service: 'node', url: node.url, node: config.node }); await hold(node.close); break;
    }
    case 'mcp': {
      if (config.kind !== 'agent') throw new Error('MCP requires a per-chat agent config.');
      const { serveTools } = await import('../lib/mcp.mjs');
      await serveTools({ client }); break;
    }
    case 'context': print(await client.request('GET', '/v1/context')); break;
    case 'send': {
      const body = { id: o.id || newId(), room: required(o, 'room'), to: list(required(o, 'to')), text: required(o, 'text'), replyTo: o['reply-to'] || null };
      print(await client.request('POST', '/v1/messages', body)); break;
    }
    case 'inbox': {
      const params = new URLSearchParams({ after: String(integer(o.after, 0, Number.MAX_SAFE_INTEGER)), limit: String(integer(o.limit, 50, 100)) });
      print(await client.request('GET', `/v1/inbox?${params}`)); break;
    }
    case 'status': print(await client.request('GET', `/v1/status?${new URLSearchParams({ id: required(o, 'id') })}`)); break;
    case 'resolve': {
      if (!o['executor-stopped']) throw new Error('Stop the old Node and inspect the exact native chat, then pass --executor-stopped.');
      print(await client.request('POST', '/v1/deliveries/resolve', { messageId: required(o, 'id'), agentId: required(o, 'agent'),
        state: required(o, 'state'), note: required(o, 'note'), executorStopped: true })); break;
    }
    case 'history': {
      const params = new URLSearchParams({ room: required(o, 'room'), after: String(integer(o.after, 0, Number.MAX_SAFE_INTEGER)), limit: String(integer(o.limit, 50, 100)) });
      print(await client.request('GET', `/v1/history?${params}`)); break;
    }
    default: throw new Error('Unknown command; see adl --help.');
  }
}

main().catch(error => {
  // Only fixed Lite/public errors are emitted. Native adapter messages are already sanitized.
  process.stderr.write(`${JSON.stringify({ error: { code: error.code || 'command_failed', message: error.message },
    ...(error.messageId ? { messageId: error.messageId } : {}) })}\n`);
  process.exitCode = 1;
});
