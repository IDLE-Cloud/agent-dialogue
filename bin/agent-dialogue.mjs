#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runtimeEnvironment } from '../lib/paths.mjs';
import { installHcom, validateArchiveListing } from '../lib/install.mjs';
export { runtimeEnvironment, validateArchiveListing };

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = new Set(['codex', 'opencode', 'kimi', 'pi']);
const HELP = `agent-dialogue — cross-node, cross-harness agent communication

  setup                                   Install the pinned platform release in your user cache
  doctor [--json]                         Inspect tools, versions and local endpoints
  launch <codex|opencode|kimi|pi> --cwd PATH
       [--prompt TEXT] [--tag LABEL] [--interactive] [--terminal PRESET]
       [-- native-tool-arguments...]
  list [--json] | status [--json]          List endpoints / hcom diagnostics
  send TARGET --message TEXT [--reply-to ID] [--thread NAME]
       [--intent request|inform|ack]        Send as the external operator (bigboss)
  history [--last N] [--thread NAME]       Read full message events as JSON Lines
  view [--source LABEL=PATH ...] [--config PATH] [--port N]
                                           Open a local read-only dialogue observer
  view-export --state-dir PATH             Fixed stdin/stdout SSH observation entry
  agent-guide [--room ID --from ALIAS [--to ALIAS]]
                                           Read protocol / generate one agent's exact context
  stop NAME                               Stop one existing local endpoint
  sessions <opencode|opencode-v1|codex|kimi|zcode> [--cwd PATH] List exact native chats
  attach <opencode|opencode-v1|codex|kimi|zcode> --session ID --alias NAME [--resume]
                                           Bind an existing chat; Codex resume is explicit
  zcode init --cwd PATH --file PATH         Create an owner-selected tool-inbox descriptor
  mcp-context --room ID --from ALIAS [--to ALIAS] [--output PATH]
                                           Export a private, fixed ZCode MCP assignment
  mcp --zcode-service PATH [--context PATH]  Serve contextual MCP tools over stdio
  bindings                                Show exact bindings, rooms and receipts
  room create --name LABEL --members a,b   Create a project collaboration room
  room export ID | room import --file PATH Export/accept a signed room manifest
  node init --name LABEL | node export     Create identity / export signed peer card
  node peer add --file CARD (--ssh HOST | --local) --executable PATH
       [--cli PATH] --state-dir PATH [--cache-dir PATH]
       [--service-file PATH] [--codex-home PATH] [--kimi-service-file PATH] [--zcode-service-file PATH]
       [--shell posix|powershell] [--opencode-v1-service-file PATH]
       [--ledger hcom|embedded] [--ssh-config PATH]
  node status | node flush [--message ID]  Inspect nodes / retry the same durable message
  collab send --room ID --from ALIAS --to ALIAS --message TEXT
       [--reply-to EVENT] [--expected-session ID] [--queue]
                                           Queue locally when the model shell has no network
  bridge start ALIAS | bridge status       Start/inspect the native-session bridge
  detach ALIAS                            Stop bridge; preserve the original chat
  hcom <read-command> [arguments...]       Restricted read-only upstream access

Headless launch is the default. --interactive opens a user terminal via hcom.
--foreground is unsupported; it does not attach to an existing desktop chat.
State: AGENT_DIALOGUE_STATE_DIR or XDG state/agent-dialogue/spaces/<AGENT_DIALOGUE_SPACE>.
Cache: AGENT_DIALOGUE_CACHE_DIR or XDG cache/agent-dialogue; independent of package location.
AGENT_DIALOGUE_HCOM may select an explicit hcom executable for tests/advanced use.
`;

function fail(message) { throw new Error(message); }
function within(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = dirname(path);
    if (parent === path) throw e;
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

async function protectPersonalState(stateDir) {
  const actual = await canonicalPath(stateDir);
  const home = await canonicalPath(homedir());
  const personal = await canonicalPath(join(homedir(), '.hcom'));
  if (actual === home || within(actual, personal)) fail('State directory resolves into your home or personal ~/.hcom; use a dedicated directory.');
}

export async function run(executable, args, { env = process.env, cwd = PROJECT_DIR, capture = false, timeout = 0 } = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '', timer;
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    }
    if (timeout) timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot run ${executable}: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? (signal === 'SIGINT' ? 130 : 143), stdout, stderr, signal });
    });
  });
}

function parseOptions(args, specs) {
  const options = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--') { rest.push(...args.slice(i + 1)); break; }
    if (!Object.hasOwn(specs, key)) fail(`Unknown option: ${key}`);
    if (Object.hasOwn(options, key)) fail(`Duplicate option: ${key}`);
    if (specs[key] === 'boolean') options[key] = true;
    else {
      if (i + 1 >= args.length || args[i + 1] === '--') fail(`Missing value for ${key}`);
      options[key] = args[++i];
    }
  }
  return { options, rest };
}
function noRest(rest) { if (rest.length) fail('This command does not accept native arguments.'); }
async function readJsonFile(path) {
  if (!path) fail('A JSON file path is required.');
  const bytes = await readFile(resolve(path));
  if (bytes.length > 262144) fail('JSON document exceeds 256 KiB.');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('Invalid JSON document.'); }
}
async function readStdinJson() {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 262144) fail('Node envelope exceeds 256 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Invalid node envelope JSON.'); }
}
function targetName(input) {
  const name = input?.replace(/^@/, '');
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name === 'all' || name.endsWith('-')) {
    fail('Use one exact local endpoint name; broadcasts, remote targets and tag fan-out are disabled.');
  }
  return name;
}

export function launchArguments(tool, args) {
  if (!TOOLS.has(tool)) fail(`Unsupported harness: ${tool || '(missing)'}. Choose codex, opencode, kimi or pi.`);
  if (args.includes('--foreground')) fail('--foreground is unsupported. Use --interactive to open a user terminal, or omit it for headless.');
  const { options, rest } = parseOptions(args, { '--cwd': 'value', '--prompt': 'value', '--tag': 'value', '--interactive': 'boolean', '--terminal': 'value' });
  if (!options['--cwd']) fail('launch requires --cwd PATH.');
  const cwd = resolve(options['--cwd']);
  const tag = options['--tag'] ?? tool;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tag)) fail('--tag must be 1–64 letters, digits, underscores or hyphens.');
  if (options['--terminal'] && !options['--interactive']) fail('--terminal requires --interactive.');
  const forbidden = new Set(['--go', '--headless', '--dir', '--tag', '--device', '--terminal', '--hcom-prompt', '--hcom-system-prompt']);
  if (rest.some(arg => forbidden.has(arg.split('=')[0]))) fail('Native arguments cannot override local hcom launch controls.');
  const argv = [tool, '--go'];
  if (!options['--interactive']) argv.push('--headless');
  if (options['--terminal']) argv.push('--terminal', options['--terminal']);
  argv.push('--dir', cwd, '--tag', tag);
  if ('--prompt' in options) argv.push('--hcom-prompt', options['--prompt']);
  if (rest.length) argv.push('--', ...rest);
  return { argv, cwd };
}

async function executablePath(command, env) {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']) {
      const path = resolve(dir, command + suffix);
      try { await access(path, constants.X_OK); return path; } catch { /* continue PATH search */ }
    }
  }
  return null;
}
async function doctor(context, json) {
  const tools = {};
  await Promise.all(['codex', 'opencode', 'kimi', 'pi', 'node', 'ssh'].map(async name => {
    const path = await executablePath(name, context.env);
    let version = null, error = null;
    if (path && name !== 'ssh' && (process.platform !== 'win32' || name === 'node')) {
      try {
        const result = await run(path, ['--version'], { env: context.env, capture: true, timeout: 15_000 });
        version = (result.stdout || result.stderr).trim().split('\n')[0] || null;
        if (result.code) error = `version check exited ${result.code}`;
      } catch (e) { error = e.message; }
    }
    tools[name] = { path, version, ...(error ? { error } : {}) };
  }));
  let hcom = { path: context.binary, version: null }, endpoints = [], errors = [];
  try {
    if (context.ledgerBackend === 'embedded') {
      const { runEmbedded } = await import('../lib/embedded-ledger.mjs');
      hcom = { path: null, backend: 'embedded', version: (await runEmbedded(context, ['--version'])).trim() };
      if (await exists(context.stateDir)) endpoints = JSON.parse(await runEmbedded(context, ['list', '--json']));
    } else {
    const version = await run(context.binary, ['--version'], { env: context.env, capture: true, timeout: 10_000 });
    hcom.version = version.stdout.trim() || null;
    if (version.code) errors.push(`hcom --version exited ${version.code}`);
    if (await exists(context.stateDir)) {
      const listing = await run(context.binary, ['list', '--json'], { env: context.env, capture: true, timeout: 10_000 });
      if (listing.code) errors.push(`hcom list exited ${listing.code}`);
      else {
        const items = JSON.parse(listing.stdout);
        endpoints = (Array.isArray(items) ? items : [items]).map(({ name, base_name, tool, status, session_id, headless, hooks_bound, process_bound }) => ({ name, base_name, tool, status, session_id, headless, hooks_bound, process_bound }));
      }
    }
    }
  } catch (e) { errors.push(e.message); }
  const result = { platform: `${platform()}-${arch()}`, node: process.version, projectDir: PROJECT_DIR, stateDir: context.stateDir, cacheDir: context.cacheDir, runtimeDir: context.runtimeDir, hcom, tools, endpoints, errors, note: 'Executable presence does not verify provider login, model availability or desktop-chat attachment.' };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`State: ${result.stateDir}\nhcom: ${hcom.version || 'not available'} (${hcom.path})`);
    for (const [name, value] of Object.entries(tools)) console.log(`${name}: ${value.version || (value.path ? 'found' : 'not on PATH')}${value.path ? ` (${value.path})` : ''}`);
    console.log(`Endpoints: ${endpoints.length}\n${result.note}`);
    for (const message of errors) console.error(message);
  }
  return errors.length ? 1 : 0;
}

export async function main(args = process.argv.slice(2), sourceEnv = process.env) {
  const [command, ...input] = args;
  if (!command || command === '--help' || command === 'help') { console.log(HELP); return 0; }
  if (command === 'view-export') {
    const { runObservationExport } = await import('../lib/viewer/export-cli.mjs');
    return await runObservationExport(input);
  }
  if (command === 'agent-guide' && input.length === 0) {
    console.log(await (await import('../lib/agent-guide.mjs')).readAgentGuide());
    return 0;
  }
  const context = runtimeEnvironment(sourceEnv);
  await protectPersonalState(context.stateDir);
  await protectPersonalState(context.cacheDir);
  if (command === 'agent-guide') {
    const { options, rest } = parseOptions(input, { '--room': 'value', '--from': 'value', '--to': 'value' }); noRest(rest);
    console.log(await (await import('../lib/agent-guide.mjs')).generateAgentContext(context, {
      room: options['--room'], from: options['--from'], to: options['--to'],
    }));
    return 0;
  }
  if (command === 'zcode') {
    if (input[0] !== 'init') fail('Use zcode init --cwd PATH --file PATH.');
    const { options, rest } = parseOptions(input.slice(1), { '--cwd': 'value', '--file': 'value' }); noRest(rest);
    if (!options['--cwd'] || !options['--file']) fail('zcode init requires an exact workspace and private service file.');
    const { createZCodeService } = await import('../lib/zcode.mjs');
    console.log(JSON.stringify(await createZCodeService({ path: resolve(options['--file']), directory: resolve(options['--cwd']) }), null, 2));
    return 0;
  }
  if (command === 'mcp-context') {
    const { options, rest } = parseOptions(input, { '--room': 'value', '--from': 'value', '--to': 'value', '--output': 'value' }); noRest(rest);
    const { createMcpScope } = await import('../lib/mcp-tools.mjs');
    const text = JSON.stringify(await createMcpScope(context, { room: options['--room'], from: options['--from'], to: options['--to'] }), null, 2) + '\n';
    if (options['--output']) {
      const path = resolve(options['--output']), parent = dirname(path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) fail('MCP context parent must be a regular directory.');
      await writeFile(path, text, { flag: 'wx', mode: 0o600 });
      if (platform() === 'win32') await (await import('../lib/private-files.mjs')).protectWindowsPrivatePath(path);
      console.log(JSON.stringify({ saved: true, path }));
    } else process.stdout.write(text);
    return 0;
  }
  if (command === 'mcp') {
    const { options, rest } = parseOptions(input, { '--context': 'value', '--zcode-service': 'value' }); noRest(rest);
    const { createDialogueMcpTools } = await import('../lib/mcp-tools.mjs');
    const { serveMcpStdio } = await import('../lib/mcp-stdio.mjs');
    const handlers = await createDialogueMcpTools(context, { scopeFile: options['--context'] ? resolve(options['--context']) : undefined, serviceFile: options['--zcode-service'] ? resolve(options['--zcode-service']) : context.env.AGENT_DIALOGUE_ZCODE_SERVICE_FILE });
    await serveMcpStdio({ ...handlers, serverInfo: { name: 'agent-dialogue', version: '0.3.0' } });
    return 0;
  }
  if (command === 'view') {
    const { runViewer } = await import('../lib/viewer/cli.mjs');
    return await runViewer(input, context);
  }
  if (command === 'setup') {
    if (input.length) fail('setup takes no arguments.');
    if (context.ledgerBackend === 'embedded') {
      console.log(JSON.stringify(await (await import('../lib/embedded-ledger.mjs')).initializeEmbedded(context), null, 2));
      return 0;
    }
    return await installHcom(context);
  }
  if (command === 'doctor') {
    const { options, rest } = parseOptions(input, { '--json': 'boolean' }); noRest(rest);
    return await doctor(context, !!options['--json']);
  }
  if (command === 'node') {
    const nodes = await import('../lib/nodes.mjs');
    let result;
    if (input[0] === 'init') {
      const { options, rest } = parseOptions(input.slice(1), { '--name': 'value' }); noRest(rest);
      const { loadOrCreateNode, nodePublic } = await import('../lib/node-identity.mjs');
      result = nodePublic(await loadOrCreateNode(context, { name: options['--name'] || 'node' }));
    } else if (input[0] === 'export' && input.length === 1) result = await nodes.exportNode(context);
    else if (input[0] === 'status' && input.length === 1) result = await nodes.nodeStatus(context);
    else if (input[0] === 'receive' && input.length === 1) result = await nodes.receiveEnvelope(context, await readStdinJson());
    else if (input[0] === 'peer' && input[1] === 'add') {
      const { options, rest } = parseOptions(input.slice(2), { '--file': 'value', '--ssh': 'value', '--local': 'boolean', '--executable': 'value', '--cli': 'value', '--state-dir': 'value', '--cache-dir': 'value', '--service-file': 'value', '--opencode-v1-service-file': 'value', '--kimi-service-file': 'value', '--zcode-service-file': 'value', '--codex-home': 'value', '--shell': 'value', '--ledger': 'value', '--ssh-config': 'value' }); noRest(rest);
      if (!!options['--ssh'] === !!options['--local']) fail('Choose exactly one transport: --ssh HOST or --local.');
      const transport = { kind: options['--local'] ? 'local-process' : 'ssh', executable: options['--executable'], stateDir: options['--state-dir'] };
      if (options['--ssh']) transport.destination = options['--ssh'];
      if (options['--cli']) transport.args = [options['--cli']];
      for (const [flag, key] of [['--cache-dir', 'cacheDir'], ['--service-file', 'serviceFile'], ['--opencode-v1-service-file', 'opencodeV1ServiceFile'], ['--codex-home', 'codexHome'], ['--kimi-service-file', 'kimiServiceFile'], ['--zcode-service-file', 'zcodeServiceFile'], ['--shell', 'shell'], ['--ledger', 'ledgerBackend'], ['--ssh-config', 'sshConfig']]) if (options[flag]) transport[key] = options[flag];
      result = await nodes.pairPeer(context, await readJsonFile(options['--file']), transport);
    } else if (input[0] === 'flush') {
      const { options, rest } = parseOptions(input.slice(1), { '--message': 'value' }); noRest(rest);
      const status = await nodes.nodeStatus(context);
      const ids = options['--message'] ? [options['--message']] : Object.keys(status.outbox).filter(id => ['queued', 'unknown', 'preparing'].includes(status.outbox[id].status));
      result = [];
      for (const id of ids) result.push(await nodes.flushMessage(context, id));
    } else fail('Invalid node command; see --help.');
    console.log(JSON.stringify(result, null, 2)); return 0;
  }
  if (['sessions', 'attach', 'bindings', 'room', 'collab', 'bridge', 'detach'].includes(command)) {
    const bridge = await import('../lib/bridge.mjs');
    let result;
    if (command === 'sessions') {
      const { options, rest } = parseOptions(input.slice(1), { '--cwd': 'value', '--json': 'boolean' }); noRest(rest);
      const { listNative } = await import('../lib/adapters.mjs');
      result = await listNative(context, input[0], { directory: options['--cwd'] ? resolve(options['--cwd']) : undefined });
    } else if (command === 'attach') {
      const { harnessId } = await import('../lib/adapters.mjs');
      const harness = harnessId(input[0]);
      const { options, rest } = parseOptions(input.slice(1), { '--session': 'value', '--alias': 'value', '--resume': 'boolean' }); noRest(rest);
      if (!options['--session'] || !options['--alias']) fail('attach needs --session ID and --alias NAME.');
      if (options['--resume'] && harness !== 'codex-app-server') fail('--resume currently applies only to Codex.');
      result = await bridge.attach(context, { harness, sessionId: options['--session'], alias: options['--alias'], resume: !!options['--resume'] });
    } else if (command === 'bindings' || command === 'bridge' && input[0] === 'status') {
      const { rest } = parseOptions(command === 'bindings' ? input : input.slice(1), { '--json': 'boolean' }); noRest(rest);
      result = await bridge.bridgeStatus(context);
    } else if (command === 'room' && input[0] === 'create') {
      const { options, rest } = parseOptions(input.slice(1), { '--name': 'value', '--members': 'value' }); noRest(rest);
      result = await bridge.roomCreate(context, { name: options['--name'], members: options['--members']?.split(',') || [] });
    } else if (command === 'room' && input[0] === 'export' && input.length === 2) {
      result = await (await import('../lib/nodes.mjs')).exportRoom(context, input[1]);
    } else if (command === 'room' && input[0] === 'import') {
      const { options, rest } = parseOptions(input.slice(1), { '--file': 'value' }); noRest(rest);
      result = await (await import('../lib/nodes.mjs')).acceptRoom(context, await readJsonFile(options['--file']));
    } else if (command === 'collab' && input[0] === 'send') {
      const { options, rest } = parseOptions(input.slice(1), { '--room': 'value', '--from': 'value', '--to': 'value', '--message': 'value', '--reply-to': 'value', '--expected-session': 'value', '--queue': 'boolean' }); noRest(rest);
      const message = { room: options['--room'], from: options['--from'], to: options['--to'], text: options['--message'], replyTo: options['--reply-to'] || null, expectedSession: options['--expected-session'] };
      result = options['--queue'] ? await (await import('../lib/submissions.mjs')).queueSubmission(context, message) : await bridge.collabSend(context, message);
    } else if (command === 'bridge' && input[0] === 'start' && input.length === 2) result = await bridge.startBridge(context, input[1]);
    else if (command === 'detach' && input.length === 1) result = await bridge.detach(context, input[0]);
    else fail('Invalid collaboration command; see --help.');
    console.log(JSON.stringify(result, null, 2)); return 0;
  }
  if (context.ledgerBackend === 'embedded' && ['launch', 'send', 'stop', 'hcom'].includes(command)) {
    fail('The embedded ledger supports native sessions/attach/room/collab; upstream hooks, launch and raw hcom commands are unavailable.');
  }
  let argv;
  if (command === 'launch') {
    const launch = launchArguments(input[0], input.slice(1));
    const info = await lstat(launch.cwd).catch(() => null);
    if (!info?.isDirectory()) fail(`Working directory does not exist: ${launch.cwd}`);
    argv = launch.argv;
  } else if (command === 'list' || command === 'status') {
    const { options, rest } = parseOptions(input, { '--json': 'boolean' }); noRest(rest);
    argv = [command, ...(options['--json'] ? ['--json'] : [])];
  } else if (command === 'send') {
    const name = targetName(input[0]);
    const { options, rest } = parseOptions(input.slice(1), { '--message': 'value', '--reply-to': 'value', '--thread': 'value', '--intent': 'value' }); noRest(rest);
    if (!options['--message']?.trim()) fail('send requires a non-empty --message TEXT.');
    if (options['--reply-to'] && !/^\d+(?::[A-Za-z0-9]+)?$/.test(options['--reply-to'])) fail('--reply-to requires an event ID such as 42 or 42:BOXE.');
    if (options['--intent'] && !['request', 'inform', 'ack'].includes(options['--intent'])) fail('Invalid --intent; choose request, inform or ack.');
    if (options['--intent'] === 'ack' && !options['--reply-to']) fail('--intent ack requires --reply-to ID.');
    argv = ['send', '-b', '--json', `@${name}`];
    for (const key of ['--reply-to', '--thread', '--intent']) if (key in options) argv.push(key, options[key]);
    argv.push('--', options['--message']);
  } else if (command === 'history') {
    const { options, rest } = parseOptions(input, { '--last': 'value', '--thread': 'value' }); noRest(rest);
    const count = options['--last'] ?? '20';
    if (!/^[1-9]\d{0,4}$/.test(count)) fail('--last must be an integer from 1 to 99999.');
    argv = ['events', '--type', 'message', '--full', '--last', count];
    if ('--thread' in options) argv.push('--thread', options['--thread']);
  } else if (command === 'stop') {
    if (input.length !== 1) fail('stop requires exactly one endpoint name.');
    const name = targetName(input[0]);
    const listing = await run(context.binary, ['list', '--json'], { env: context.env, capture: true });
    if (listing.code) fail(`Cannot verify endpoint before stopping: ${listing.stderr.trim() || `hcom exited ${listing.code}`}`);
    const entries = JSON.parse(listing.stdout);
    if (!Array.isArray(entries)) fail('Unexpected endpoint listing; refusing to stop.');
    const matches = entries.filter(item => item.name === name || item.base_name === name);
    if (matches.length !== 1 || !matches[0].name || matches[0].device || matches[0].is_remote) fail('Endpoint must match exactly one current local name.');
    argv = ['kill', targetName(matches[0].name)];
  } else if (command === 'hcom') {
    if (!input.length) fail('Specify an upstream read command: list, status, events, transcript, --help or --version.');
    const allowed = new Set(['list', 'status', 'events', 'transcript', '--help', '--version']);
    if (!allowed.has(input[0])) fail(`Upstream command ${input[0]} is outside this local wrapper. Use launch/send/stop or a supported read command.`);
    if (input[0] === 'events' && input.slice(1).some(arg => ['sub', 'unsub', 'launch', '--remote-fetch', '--device'].includes(arg.split('=')[0]))) fail('Only local event queries are allowed through this wrapper.');
    if (input.some(arg => ['--device', '--name'].includes(arg.split('=')[0]))) fail('Remote or agent identity overrides are not allowed through the operator wrapper.');
    argv = input;
  } else fail(`Unknown command: ${command}. Run --help.`);
  await mkdir(context.stateDir, { recursive: true });
  if (context.ledgerBackend === 'embedded') {
    const output = await (await import('../lib/embedded-ledger.mjs')).runEmbedded(context, argv);
    if (output) process.stdout.write(output);
    return 0;
  }
  return (await run(context.binary, argv, { env: context.env })).code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Complete module evaluation before loading the optional bridge, which reuses runtime helpers.
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error(`agent-dialogue: ${e.message}`); process.exitCode = 1; });
}
