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
const HELP = `agent-dialogue — local cross-harness agent communication

  setup                                   Install the pinned platform release in your user cache
  doctor [--json]                         Inspect tools, versions and local endpoints
  launch <codex|opencode|kimi|pi> --cwd PATH
       [--prompt TEXT] [--tag LABEL] [--interactive] [--terminal PRESET]
       [-- native-tool-arguments...]
  list [--json] | status [--json]          List endpoints / hcom diagnostics
  send TARGET --message TEXT [--reply-to ID] [--thread NAME]
       [--intent request|inform|ack]        Send as the external operator (bigboss)
  history [--last N] [--thread NAME]       Read full message events as JSON Lines
  stop NAME                               Stop one existing local endpoint
  sessions opencode                       List existing native OpenCode chats
  attach opencode --session ID --alias NAME Attach an existing chat, no fork/new chat
  bindings                                Show exact bindings, rooms and receipts
  room create --name LABEL --members a,b   Create a project collaboration room
  collab send --room ID --from ALIAS --to ALIAS --message TEXT
       [--reply-to EVENT] [--expected-session ID]
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
    const path = resolve(dir, command);
    try { await access(path, constants.X_OK); return path; } catch { /* continue PATH search */ }
  }
  return null;
}
async function doctor(context, json) {
  const tools = {};
  await Promise.all(['codex', 'opencode', 'kimi', 'pi', 'node', 'ssh'].map(async name => {
    const path = await executablePath(name, context.env);
    let version = null, error = null;
    if (path && name !== 'ssh') {
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
  const context = runtimeEnvironment(sourceEnv);
  await protectPersonalState(context.stateDir);
  await protectPersonalState(context.cacheDir);
  if (command === 'setup') { if (input.length) fail('setup takes no arguments.'); return await installHcom(context); }
  if (command === 'doctor') {
    const { options, rest } = parseOptions(input, { '--json': 'boolean' }); noRest(rest);
    return await doctor(context, !!options['--json']);
  }
  if (['sessions', 'attach', 'bindings', 'room', 'collab', 'bridge', 'detach'].includes(command)) {
    const bridge = await import('../lib/bridge.mjs');
    let result;
    if (command === 'sessions') {
      if (input[0] !== 'opencode') fail('sessions currently supports opencode.');
      const { options, rest } = parseOptions(input.slice(1), { '--cwd': 'value', '--json': 'boolean' }); noRest(rest);
      const { OpenCodeClient } = await import('../lib/opencode.mjs');
      const client = await OpenCodeClient.discover({ serviceFile: context.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE });
      result = { service: client.identity, sessions: (await client.sessions({ directory: options['--cwd'] ? resolve(options['--cwd']) : undefined })).map(s => ({ id: s.id, title: s.title, projectId: s.projectID, directory: s.location?.directory, model: s.model, time: s.time })) };
    } else if (command === 'attach') {
      if (input[0] !== 'opencode') fail('attach currently supports opencode.');
      const { options, rest } = parseOptions(input.slice(1), { '--session': 'value', '--alias': 'value' }); noRest(rest);
      if (!options['--session'] || !options['--alias']) fail('attach needs --session ID and --alias NAME.');
      result = await bridge.attach(context, { sessionId: options['--session'], alias: options['--alias'] });
    } else if (command === 'bindings' || command === 'bridge' && input[0] === 'status') {
      const { rest } = parseOptions(command === 'bindings' ? input : input.slice(1), { '--json': 'boolean' }); noRest(rest);
      result = await bridge.bridgeStatus(context);
    } else if (command === 'room' && input[0] === 'create') {
      const { options, rest } = parseOptions(input.slice(1), { '--name': 'value', '--members': 'value' }); noRest(rest);
      result = await bridge.roomCreate(context, { name: options['--name'], members: options['--members']?.split(',') || [] });
    } else if (command === 'collab' && input[0] === 'send') {
      const { options, rest } = parseOptions(input.slice(1), { '--room': 'value', '--from': 'value', '--to': 'value', '--message': 'value', '--reply-to': 'value', '--expected-session': 'value' }); noRest(rest);
      result = await bridge.collabSend(context, { room: options['--room'], from: options['--from'], to: options['--to'], text: options['--message'], replyTo: options['--reply-to'] || null, expectedSession: options['--expected-session'] });
    } else if (command === 'bridge' && input[0] === 'start' && input.length === 2) result = await bridge.startBridge(context, input[1]);
    else if (command === 'detach' && input.length === 1) result = await bridge.detach(context, input[0]);
    else fail('Invalid collaboration command; see --help.');
    console.log(JSON.stringify(result, null, 2)); return 0;
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
  return (await run(context.binary, argv, { env: context.env })).code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Complete module evaluation before loading the optional bridge, which reuses runtime helpers.
  main().then(code => { process.exitCode = code; })
    .catch(e => { console.error(`agent-dialogue: ${e.message}`); process.exitCode = 1; });
}
