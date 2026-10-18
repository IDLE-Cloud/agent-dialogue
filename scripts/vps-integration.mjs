#!/usr/bin/env node
/** Opt-in real Codex ↔ VPS OpenCode acceptance. Never selects a host or chat. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient } from '../lib/codex.mjs';
import { decodeFrame } from '../lib/bridge-store.mjs';
import { readExistingNode, signObject } from '../lib/node-identity.mjs';
import { createSourceReader, fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';
import { createViewer } from '../lib/viewer/server.mjs';
import { runtimeEnvironment } from '../lib/paths.mjs';
import { buildHarnessEnv, buildRemoteInvocation, claimRunDirectories, hasZeroCostModel, permittedVpsCommand, validateVpsConfig } from './vps-integration-contract.mjs';
import { ownedCodexActiveTurn } from './vps-cleanup.mjs';
import { verifiedCodexSeed } from './vps-seed.mjs';
import { permittedCodexEvidenceCommand } from './vps-command-evidence.mjs';
import { holdOwnedCodexThread } from './vps-codex-lease.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const MAX_OUTPUT = 4 * 1024 * 1024;
const FINGERPRINT_FILES = ['bin/agent-dialogue.mjs', 'lib/bridge.mjs', 'lib/bridge-store.mjs', 'lib/codex.mjs', 'lib/opencode.mjs', 'lib/nodes.mjs', 'lib/node-identity.mjs', 'lib/node-transport.mjs', 'lib/submissions.mjs', 'lib/viewer/observation.mjs'];
const textOf = item => item.type === 'agentMessage' ? item.text || '' : item.type === 'assistant' ? (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n') : item.text || '';
const inputId = () => `msg_${randomUUID().replaceAll('-', '')}`;
function settings(thread) { return Object.fromEntries(['model', 'modelProvider', 'approvalPolicy', 'sandboxPolicy', 'permissions', 'cwd'].filter(key => Object.hasOwn(thread, key)).map(key => [key, thread[key]])); }
function safeEnv(local) { return buildHarnessEnv(local, { ...process.env }); }

async function execute(executable, args, { env, input = '', timeout = 45_000 } = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let bytes = 0, diagnosticBytes = 0, failed = false, settled = false, killTimer, settleTimer;
    const finish = (code, error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer);
      if (error) reject(error);
      else {
        let stdout;
        try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)); }
        catch { reject(new Error('An acceptance process returned invalid UTF-8.')); return; }
        done({ code: code ?? 143, failed, stdout });
      }
    };
    const stop = () => {
      failed = true; child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
      settleTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(143); }, 1500);
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop(); else output.push(chunk); });
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 64 * 1024) stop(); });
    child.stdin.on('error', () => {}); child.once('error', () => finish(null, new Error('An acceptance process could not start.')));
    child.once('close', code => finish(code)); child.stdin.end(input);
  });
}
async function hashes(directory) {
  const output = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('A test state contains an unsupported symbolic link.');
    if (item.isDirectory()) for (const [name, hash] of Object.entries(await hashes(path))) output[`${item.name}/${name}`] = hash;
    else if (item.isFile()) output[item.name] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return output;
}

async function run(config) {
  await claimRunDirectories(config);
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const aliases = { local: 'owned-codex', remote: 'owned-vps' };
  const facts = { local: `BUDGET_${randomUUID().replaceAll('-', '').slice(0, 16)}`, remote: `COMPAT_${randomUUID().replaceAll('-', '').slice(0, 16)}` };
  const artifact = join(config.local.codexCwd, `vps-decision-${nonce}.json`);
  const env = safeEnv(config.local), context = runtimeEnvironment(env);
  const summary = { version: 1, run_id: config.runId, started_at: new Date().toISOString(), status: 'running',
    scope: 'one explicit owned local Codex thread and one owned VPS OpenCode chat; two independent signed nodes; actual SSH stdio',
    model: { ...config.model, zero_cost_verified: false }, transport: 'ssh', realSsh: true, stages: [], assertions: {},
    permissions: { codexApprovalsGranted: 0, opencodeOnce: 0, opencodeRejected: 0 }, cleanup: [], sshHelperCalls: 0,
    source: { localNode: process.version, localPlatform: process.platform, localArch: process.arch } };
  const privateData = { config, nonce, artifact, facts, errors: [], phases: {}, sessions: {}, messages: {}, snapshots: {} };
  let phase = 'initializing', codex, codexLease, room, remoteId, codexBefore, codexSettingsBefore, latestCodex = [], seedCodexIds = new Set();
  const attached = new Set(), seenPermissions = new Set(), ownedInputIds = new Set();
  let request, response, reverseRequest, reverseResponse, viewer, reader, cancelled = false, communicationComplete = false;
  const interrupt = () => { cancelled = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  async function persist() {
    await writeFile(join(config.outputDir, 'metrics.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(config.privateDir, 'diagnosis.private.json'), JSON.stringify(privateData, null, 2) + '\n', { mode: 0o600 });
  }
  async function stage(name, fields = {}) {
    phase = name; summary.stages.push({ name, at: new Date().toISOString(), ...fields }); await persist();
    console.log(JSON.stringify({ stage: name, ...fields }));
  }
  function assertion(name, value) {
    summary.assertions[name] = Boolean(value);
    if (!value) throw new Error(`Acceptance assertion failed: ${name}.`);
  }
  async function remote(operation, payload = {}) {
    const invocation = buildRemoteInvocation(config, operation, payload);
    summary.sshHelperCalls++;
    const result = await execute(invocation.executable, invocation.args, { env, input: invocation.input });
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Remote acceptance helper returned an invalid response.'); }
    if (result.failed || result.code !== 0 || parsed.version !== 1 || parsed.ok !== true) {
      privateData.errors.push({ phase, operation, remoteResponse: parsed });
      throw new Error('Remote acceptance helper failed; preserve its scope and inspect privately.');
    }
    return parsed.result;
  }
  async function cli(role, args, { input, reject = false, lines = false } = {}) {
    const result = role === 'local'
      ? await execute(config.local.executable, [config.local.cli, ...args], { env, input: input === undefined ? '' : JSON.stringify(input) + '\n', timeout: 35_000 })
      : await remote('cli', { args, ...(input !== undefined ? { input } : {}) });
    if (reject) return !result.failed && result.code !== 0;
    if (result.failed || result.code !== 0) { privateData.errors.push({ phase, role, args: args.slice(0, 2), result }); throw new Error('Owned acceptance CLI operation failed.'); }
    try { return lines ? result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(result.stdout); }
    catch { privateData.errors.push({ phase, role, args: args.slice(0, 2), result }); throw new Error('Owned acceptance CLI returned invalid JSON.'); }
  }
  function commandScope(role, replyTo = null) {
    const side = role === 'local' ? config.local : config.remote;
    return { node: side.executable, cli: side.cli, stateDir: side.stateDir, cacheDir: side.cacheDir,
      ...(role === 'local' ? { codexHome: side.codexHome, codexSocket: side.codexSocket } : { serviceFile: side.serviceFile }),
      room: room.id, from: aliases[role], to: aliases[role === 'local' ? 'remote' : 'local'], expectedSession: role === 'local' ? remoteId : config.local.codexThread,
      runId: config.runId, replyTo, queue: role === 'local' };
  }
  function prefix(role) {
    const side = role === 'local' ? config.local : config.remote;
    const values = { AGENT_DIALOGUE_STATE_DIR: side.stateDir, AGENT_DIALOGUE_CACHE_DIR: side.cacheDir,
      ...(role === 'local' ? { CODEX_HOME: side.codexHome, AGENT_DIALOGUE_CODEX_SOCKET: side.codexSocket } : { AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: side.serviceFile }) };
    return `${Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${quote(side.executable)} ${quote(side.cli)}`;
  }
  function sendCommand(role, text, replyTo = null) {
    const scope = commandScope(role, replyTo);
    return `${prefix(role)} collab send${scope.queue ? ' --queue' : ''} --room ${quote(scope.room)} --from ${quote(scope.from)} --to ${quote(scope.to)} --expected-session ${quote(scope.expectedSession)}${replyTo ? ` --reply-to ${quote(replyTo)}` : ''} --message ${quote(text)}`;
  }
  async function permissions() {
    if (!remoteId) return;
    const pending = await remote('permissions');
    if (!Array.isArray(pending)) throw new Error('Invalid owned OpenCode permission list.');
    for (const permission of pending) {
      if (seenPermissions.has(permission.id)) continue;
      const commands = [permission.metadata?.command, permission.metadata?.cmd, permission.metadata?.script].filter(item => typeof item === 'string');
      const resources = (permission.resources || []).filter(item => typeof item === 'string');
      const candidates = commands.length ? commands : resources;
      const expectedReply = request && !response ? request.frame.globalMessageId : null;
      const allowed = Boolean(room && summary.permissions.opencodeOnce < 2 && /bash|shell|execute/.test(permission.action) && candidates.length && candidates.every(command => permittedVpsCommand(command, commandScope('remote', expectedReply))) && resources.every(command => permittedVpsCommand(command, commandScope('remote', expectedReply))));
      await remote('permission-reply', { permissionId: permission.id, decision: allowed ? 'once' : 'reject' });
      seenPermissions.add(permission.id); summary.permissions[allowed ? 'opencodeOnce' : 'opencodeRejected']++;
      if (!allowed) { privateData.errors.push({ phase, rejectedPermission: permission }); throw new Error('Unexpected OpenCode permission rejected without saved policy changes.'); }
    }
  }
  async function frames(role) {
    const events = await cli(role, ['history', '--last', '1000', '--thread', room.id], { lines: true });
    return events.flatMap(event => { try { const frame = decodeFrame(event.data.text); return frame.room === room.id ? [{ ...event, frame }] : []; } catch { return []; } });
  }
  async function updateExchange() {
    if (!room) return;
    const local = await frames('local');
    const own = (from, to, replyTo) => local.find(event => event.frame.from === from && event.frame.to === to && event.frame.globalMessageId && event.frame.wireEnvelope?.payload?.replyToMessageId === replyTo && event.frame.text.includes(config.runId));
    request = own(aliases.local, aliases.remote, null);
    response = request && own(aliases.remote, aliases.local, request.frame.globalMessageId);
    reverseRequest = own(aliases.remote, aliases.local, null);
    reverseResponse = reverseRequest && own(aliases.local, aliases.remote, reverseRequest.frame.globalMessageId);
  }
  async function waitFor(role, marker, { exchange = false, baseline = new Set() } = {}) {
    const started = Date.now(); let progress = started;
    while (Date.now() - started < config.timeoutSeconds * 1000) {
      if (cancelled) throw new Error('Owned VPS acceptance cancelled.');
      if (exchange) await updateExchange();
      await permissions();
      const messages = role === 'local' ? await codex.messages(config.local.codexThread, { limit: 500 }) : await remote('messages');
      privateData.messages[role] = messages;
      if (role === 'local') latestCodex = messages;
      const answer = messages.find(item => !baseline.has(item.id) && ['agentMessage', 'assistant'].includes(item.type) && (role === 'local' || item.time?.completed) && textOf(item).includes(marker));
      const failed = role === 'local' && messages.find(item => !baseline.has(item.id) && item.type === 'commandExecution' && item.command?.includes(config.runId) && item.exitCode != null && item.exitCode !== 0);
      if (failed) { privateData.errors.push({ phase, failedNativeCommand: failed }); throw new Error('The owned Codex communication command failed.'); }
      if (messages.some(item => item.type === 'assistant' && item.error)) throw new Error('An owned model returned an error.');
      const idle = role === 'local' ? (await codex.session(config.local.codexThread)).nativeStatus === 'idle' : Boolean(answer);
      if (answer && idle) { privateData.messages[role] = messages; return answer; }
      if (Date.now() - progress >= 15_000) { await stage('waiting_for_owned_model', { role, elapsedSeconds: Math.round((Date.now() - started) / 1000) }); progress = Date.now(); }
      await delay(1000);
    }
    throw new Error(`Owned ${role} model response timed out.`);
  }
  async function fingerprint(cliPath) {
    const files = {};
    for (const relative of FINGERPRINT_FILES) files[relative] = createHash('sha256').update(await readFile(join(dirname(dirname(cliPath)), relative))).digest('hex');
    return files;
  }

  try {
    await stage('checking_explicit_owned_environment');
    const existing = await lstat(config.local.stateDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing && (!existing.isDirectory() || (await readdir(config.local.stateDir)).length)) throw new Error('The acceptance local state must be a fresh or empty dedicated directory.');
    await mkdir(config.local.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(config.local.stateDir, 'vps-acceptance-owner.json'), JSON.stringify({ runId: config.runId, nonce }) + '\n', { flag: 'wx', mode: 0o600 });
    const probe = await remote('probe'); privateData.phases.remoteProbe = probe;
    summary.source.remoteNode = probe.node; summary.source.remotePlatform = probe.platform; summary.source.remoteArch = probe.arch; summary.source.remoteOpenCode = probe.service.version;
    const localFingerprint = await fingerprint(config.local.cli);
    summary.source.implementationFiles = localFingerprint;
    assertion('matching_deployed_communication_source', JSON.stringify(probe.implementationFiles) === JSON.stringify(localFingerprint));
    summary.source.verifierFiles = {};
    for (const name of ['vps-integration.mjs', 'vps-integration-contract.mjs', 'vps-cleanup.mjs', 'vps-seed.mjs', 'vps-codex-lease.mjs', 'vps-command-evidence.mjs', 'vps-remote-helper.mjs']) summary.source.verifierFiles[name] = createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex');
    assertion('matching_deployed_acceptance_helper', probe.acceptanceHelperSha256 === summary.source.verifierFiles['vps-remote-helper.mjs']);
    codex = await CodexClient.discover({ env });
    codexBefore = await codex.session(config.local.codexThread);
    const rawBefore = (await codex.request('thread/read', { threadId: config.local.codexThread, includeTurns: false })).thread;
    codexSettingsBefore = settings(rawBefore); privateData.phases.codexBefore = rawBefore;
    summary.codexComparedSettingFields = Object.keys(codexSettingsBefore);
    assertion('explicit_codex_workspace_matches', resolve(codexBefore.location.directory) === config.local.codexCwd && !codexBefore.native.ephemeral);
    if ((await codex.inbox(config.local.codexThread)).length) throw new Error('The selected owned Codex thread has queued work; it was left untouched.');
    if (codexBefore.native.loaded && codexBefore.nativeStatus !== 'idle') throw new Error('The selected owned Codex thread is busy; it was left untouched.');
    // The normal adapter deliberately uses short-lived RPC connections. This
    // owned verifier separately holds one exact thread subscription until cleanup.
    codexLease = await holdOwnedCodexThread({ socketPath: config.local.codexSocket,
      expectedIdentity: codex.identity, threadId: config.local.codexThread, cwd: config.local.codexCwd });
    assertion('controller_holds_exact_owned_codex_subscription', !codexLease.closed);
    const catalogStart = Date.now(); let selected;
    for (let attempt = 0; attempt < 5; attempt++) {
      const catalog = await remote('models');
      selected = Array.isArray(catalog) && catalog.find(item => item.id === config.model.id && item.providerID === config.model.providerID);
      if (selected || attempt === 4) break;
      await delay(1000);
    }
    if (!hasZeroCostModel(selected)) throw new Error('The exact VPS model must be enabled and advertise zero input/output/cache cost for every tier.');
    summary.model.zero_cost_verified = true; summary.model.catalogCheckMs = Date.now() - catalogStart;
    await stage('free_model_and_existing_codex_verified');

    // Save project facts in normal native chats before either chat is attached.
    const remoteSession = await remote('create-session', { model: config.model }); remoteId = remoteSession.id;
    privateData.sessions.remote = remoteId; privateData.sessions.local = config.local.codexThread;
    const remoteSeed = `VPS_SEED_${nonce}`;
    await remote('prompt', { id: inputId(), text: `Owned bounded acceptance ${config.runId} in an empty project fixture. Use no tools, read no files, inspect no other chats or settings, and spawn no agents. Remember your preexisting project constraint: retain the .json extension and read old journal files without rewriting them. Your synthetic, nonsecret, shareable compatibility marker is ${facts.remote}. Later answer one peer request via the supplied exact communication CLI, then stop without acknowledgements. Now reply exactly ${remoteSeed}.` });
    await waitFor('remote', remoteSeed);
    seedCodexIds = new Set((await codex.messages(config.local.codexThread, { limit: 500 })).map(item => item.id));
    const localSeed = `CODEX_SEED_${nonce}`, seedInput = inputId(); ownedInputIds.add(seedInput);
    const seedReceipt = await codex.prompt(config.local.codexThread, { id: seedInput, text: `Owned bounded acceptance ${config.runId}. Preserve this exact test thread, its model and approval settings. Use no tools, inspect no files/chats/settings and spawn no agents. Remember the project engineering budget is 17 units; your synthetic, nonsecret, shareable budget marker is ${facts.local}. Later communicate only when the explicit project task asks; never acknowledge in loops. Now reply exactly ${localSeed}.` });
    privateData.phases.codexSeed = { inputId: seedInput, receipt: seedReceipt };
    const drained = await codex.drain(config.local.codexThread, { inputIds: [seedInput] });
    privateData.phases.codexSeed.drain = drained;
    assertion('codex_seed_drain_did_not_start_another_input', !drained.started || drained.inputId === seedInput);
    await waitFor('local', localSeed, { baseline: seedCodexIds });
    const seedNative = await codex.session(config.local.codexThread);
    assertion('exact_owned_codex_seed_input_completed', verifiedCodexSeed({ threadId: config.local.codexThread,
      inputId: seedInput, marker: localSeed, nativeStatus: seedNative.nativeStatus,
      receipt: seedReceipt, drain: drained, messages: latestCodex }));
    summary.codexSeed = { explicitQueueStartAccepted: drained.started === true,
      executionObservedWithoutExplicitStart: drained.started === false, exactNativeInputCount: 1 };
    assertion('native_project_context_seeded_before_attachment', true);
    await cli('local', ['node', 'init', '--name', `owned-codex-${nonce}`]);
    await cli('remote', ['node', 'init', '--name', `owned-vps-${nonce}`]);
    attached.add('local'); await cli('local', ['attach', 'codex', '--session', config.local.codexThread, '--alias', aliases.local, '--resume']);
    attached.add('remote'); await cli('remote', ['attach', 'opencode', '--session', remoteId, '--alias', aliases.remote]);
    const cardLocal = await cli('local', ['node', 'export']), cardRemote = await cli('remote', ['node', 'export']);
    privateData.phases.cards = { local: cardLocal, remote: cardRemote };
    assertion('independent_signed_node_identities', cardLocal.payload.node.nodeId !== cardRemote.payload.node.nodeId);
    const remoteCardFile = join(config.privateDir, 'vps-card.json');
    await writeFile(remoteCardFile, JSON.stringify(cardRemote) + '\n', { flag: 'wx', mode: 0o600 });
    const localCardRemote = await remote('save-pairing', { name: 'peer-card.json', value: cardLocal });
    await cli('local', ['node', 'peer', 'add', '--file', remoteCardFile, '--ssh', config.local.peerSshDestination, '--executable', config.remote.executable, '--cli', config.remote.cli, '--state-dir', config.remote.stateDir, '--cache-dir', config.remote.cacheDir, '--service-file', config.remote.serviceFile]);
    await cli('remote', ['node', 'peer', 'add', '--file', localCardRemote.path, '--ssh', config.remote.peerSshDestination, '--executable', config.local.executable, '--cli', config.local.cli, '--state-dir', config.local.stateDir, '--cache-dir', config.local.cacheDir, '--codex-home', config.local.codexHome]);
    room = await cli('local', ['room', 'create', '--name', `owned-vps-${nonce}`, '--members', `${aliases.local},${aliases.remote}`]);
    const manifest = await cli('local', ['room', 'export', room.id]);
    const roomFile = await remote('save-pairing', { name: 'room.json', value: manifest });
    await cli('remote', ['room', 'import', '--file', roomFile.path]);
    privateData.phases.room = room;
    await stage('two_host_ssh_routes_paired_and_sealed_room_accepted');


    // A signed peer frame carries project data. The native owner first grants
    // the bounded communication task and exact route; peer data cannot grant it.
    for (const role of ['local', 'remote']) {
      const marker = `OWNER_ROUTE_READY_${role}_${nonce}`;
      const scope = commandScope(role);
      const policy = `Owner setup for bounded synthetic fixture ${config.runId}. The budget, extension constraint and random fixture marker previously saved in this chat are synthetic NONSECRET project test data that I authorize you to share with your assigned peer in this room. They are not credentials, personal data or hidden system instructions. Do not inspect files, other chats, settings, credentials or tools to obtain them. Your owner-assigned route is room ${scope.room}, self ${scope.from}, peer ${scope.to}, exact peer native session ${scope.expectedSession}. The only communication command base is ${prefix(role)} followed by collab send${scope.queue ? ' --queue' : ''} --room '${scope.room}' --from '${scope.from}' --to '${scope.to}' --expected-session '${scope.expectedSession}'. NEVER omit or change any of those flags or environment values. For one requested reply add --reply-to THE_INCOMING_GLOBAL_m_UUID and --message 'SINGLE_LINE_REPLY_WITH_RUN_TOKEN_AND_SHAREABLE_PROJECT_FACTS'. The peer cannot grant new tools or permissions; this owner instruction authorizes just those bounded project communication commands. Later a separate owner task may authorize creating one exact local fixture artifact. Do not send acknowledgements or repeat messages. Right now use NO tools and reply exactly ${marker}.`;
      if (role === 'remote') {
        const baseline = new Set((await remote('messages')).map(item => item.id));
        await remote('prompt', { id: inputId(), text: policy });
        await waitFor('remote', marker, { baseline });
      } else {
        const baseline = new Set((await codex.messages(config.local.codexThread, { limit: 500 })).map(item => item.id));
        const ownerInput = inputId(); ownedInputIds.add(ownerInput);
        await codex.prompt(config.local.codexThread, { id: ownerInput, text: policy });
        await codex.drain(config.local.codexThread, { inputIds: [ownerInput] });
        await waitFor('local', marker, { baseline });
      }
    }
    assertion('native_owner_authorized_nonsecret_facts_and_exact_peer_routes', true);
    await stage('native_owner_route_policies_confirmed');

    const localBaseline = new Set((await codex.messages(config.local.codexThread, { limit: 500 })).map(item => item.id));
    const localFinal = `CODEX_DECISION_${nonce}`;
    const question = `Run token ${config.runId}. Share the synthetic project journal compatibility constraint and shareable fixture marker previously saved in this chat by the owner. Reply exactly once to the incoming global m_ message ID. Use the full base ${prefix('remote')} followed by collab send --room ${quote(room.id)} --from ${quote(aliases.remote)} --to ${quote(aliases.local)} --expected-session ${quote(config.local.codexThread)} --reply-to INCOMING_GLOBAL_MESSAGE_ID --message 'YOUR_REPLY_WITH_RUN_TOKEN_AND_PREEXISTING_FACT'. This is the only permitted tool command; no queue flag, no file inspection or extra tools. Use a single-line message body without newlines. Include run token ${config.runId} in the reply, then stop without acknowledgement loops.`;
    const command = sendCommand('local', question);
    await cli('local', ['collab', 'send', '--room', room.id, '--from', 'operator', '--to', aliases.local, '--message', `Owned project acceptance ${config.runId}. Execute exactly this ONE communication command via your shell tool:\n${command}\nFinish that turn without sleeping or polling. After receiving the linked VPS peer reply, combine your previously saved shareable fixture budget and marker with the peer's preexisting compatibility constraint and marker. Use apply_patch only to create ${artifact}; its JSON object must contain runId, budget (number), budgetMarker, extension, compatibilityMarker. Values must come from your existing context and the linked peer reply, never guesses. This one new file and the supplied queue command are the only authorized tools. Then reply ${localFinal}. Do not inspect any other files/chats, start agents, change settings, or send acknowledgements. If any tool needs approval, leave that request visible; this test grants no Codex approvals.`]);
    const synthesis = await waitFor('local', localFinal, { exchange: true, baseline: localBaseline });
    await updateExchange();
    assertion('codex_model_origin_ssh_request_and_global_linked_vps_reply', request && response && request.data.sender_kind === 'instance' && response.frame.wireEnvelope.payload.replyToMessageId === request.frame.globalMessageId);
    assertion('private_context_combined_after_real_peer_reply', textOf(synthesis).includes(localFinal) && response.frame.text.includes(facts.remote));
    const decisionStat = await lstat(artifact);
    if (!decisionStat.isFile() || decisionStat.isSymbolicLink() || decisionStat.size > 64 * 1024) throw new Error('The owned project decision artifact is missing or invalid.');
    const decisionBytes = await readFile(artifact), decision = JSON.parse(decisionBytes.toString('utf8'));
    assertion('nonce_bound_project_artifact_combines_both_native_contexts', decision.runId === config.runId && decision.budget === 17 && decision.budgetMarker === facts.local && decision.extension === '.json' && decision.compatibilityMarker === facts.remote);
    summary.artifactSha256 = createHash('sha256').update(decisionBytes).digest('hex');
    privateData.phases.decisionArtifact = decision;
    const localQuestionTool = latestCodex.find(item => !localBaseline.has(item.id) && item.type === 'commandExecution' && item.exitCode === 0 && permittedCodexEvidenceCommand(item.command, commandScope('local')));
    let queuedReceipt;
    try { queuedReceipt = JSON.parse(localQuestionTool?.aggregatedOutput?.trim() || 'null'); } catch { /* Exact evidence remains mandatory. */ }
    assertion('native_codex_tool_returned_local_queue_receipt', queuedReceipt?.status === 'queued' && /^q_[0-9a-f-]{36}$/.test(queuedReceipt.submissionId) && Number.isSafeInteger(queuedReceipt.event_id));
    const localWorker = (await cli('local', ['bindings'])).bindings.find(binding => binding.alias === aliases.local)?.worker;
    const forwarded = localWorker?.receipts?.[queuedReceipt.event_id];
    assertion('owning_codex_worker_forwarded_same_submission_to_ssh_message', forwarded?.status === 'forwarded' && forwarded.submissionId === queuedReceipt.submissionId && forwarded.result?.messageId === request.frame.globalMessageId && forwarded.result?.status === 'remote-stored');
    await stage('codex_to_vps_context_and_project_artifact_verified');

    const remoteBaseline = new Set((await remote('messages')).map(item => item.id)), remoteFinal = `VPS_DECISION_${nonce}`;
    const reverseQuestion = `Run token ${config.runId}. Share the synthetic fixture budget and shareable marker previously saved in this chat by the owner, in exactly one linked reply. Use the full base ${prefix('local')} followed by collab send --queue --room ${quote(room.id)} --from ${quote(aliases.local)} --to ${quote(aliases.remote)} --expected-session ${quote(remoteId)} --reply-to INCOMING_GLOBAL_MESSAGE_ID --message 'YOUR_REPLY_WITH_RUN_TOKEN_AND_PREEXISTING_FACT'. Replace only the incoming global ID and reply body. Use a single-line message body without newlines, include run token ${config.runId}. No files, other tools, polling or acknowledgements.`;
    const reverseCommand = sendCommand('remote', reverseQuestion);
    await remote('prompt', { id: inputId(), text: `Owned acceptance ${config.runId}. Execute exactly this ONE shell communication command, and no other tools:\n${reverseCommand}\nFinish the turn without polling. After the linked peer reply arrives, respond ${remoteFinal}, the peer's numeric budget and shareable fixture marker. Do not guess or send any further message/acknowledgement.` });
    const reverseSynthesis = await waitFor('remote', remoteFinal, { exchange: true, baseline: remoteBaseline });
    await updateExchange();
    assertion('vps_model_origin_ssh_request_and_global_linked_codex_reply', reverseRequest && reverseResponse && reverseResponse.frame.wireEnvelope.payload.replyToMessageId === reverseRequest.frame.globalMessageId);
    assertion('reverse_peer_reply_preserves_codex_preexisting_fact', reverseResponse.frame.text.includes(facts.local) && /\b17\b/.test(reverseResponse.frame.text) && textOf(reverseSynthesis).includes(facts.local));
    const remoteMessages = await remote('messages');
    const completedRemoteCommands = remoteMessages.flatMap(message => (message.content || []).filter(part => part.type === 'tool' && part.state?.status === 'completed' && part.state?.metadata?.exit === 0).map(part => part.state.input?.command));
    assertion('native_vps_tools_executed_exact_approved_request_and_reply', completedRemoteCommands.some(text => permittedVpsCommand(text, commandScope('remote', request.frame.globalMessageId))) && completedRemoteCommands.some(text => permittedVpsCommand(text, commandScope('remote'))));
    assertion('only_bounded_once_opencode_permissions', summary.permissions.opencodeOnce === 2 && summary.permissions.opencodeRejected === 0);
    await stage('bidirectional_cross_harness_ssh_model_exchange_verified');

    const beforeStatus = { local: await cli('local', ['node', 'status']), remote: await cli('remote', ['node', 'status']) };
    const beforeLedgerCounts = { local: (await cli('local', ['history', '--last', '1000', '--thread', room.id], { lines: true })).length, remote: (await cli('remote', ['history', '--last', '1000', '--thread', room.id], { lines: true })).length };
    const messagesBefore = { local: await codex.messages(config.local.codexThread, { limit: 500 }), remote: remoteMessages };
    const ids = [request, response, reverseRequest, reverseResponse].map(event => event.frame.globalMessageId);
    assertion('all_four_global_messages_reconciled_on_both_nodes', ids.every(id => Boolean(beforeStatus.local.inbox[id] || beforeStatus.local.outbox[id]) && Boolean(beforeStatus.remote.inbox[id] || beforeStatus.remote.outbox[id])));
    assertion('all_outbound_ssh_messages_remote_stored', [beforeStatus.local, beforeStatus.remote].every(status => Object.values(status.outbox).filter(entry => entry.roomId === room.id).every(entry => entry.status === 'remote-stored')));
    const envelope = request.frame.wireEnvelope, identity = await readExistingNode(context), originalId = request.frame.globalMessageId;
    const replay = await cli('local', ['node', 'flush', '--message', originalId]);
    const receipt = Array.isArray(replay) ? replay[0] : replay;
    assertion('same_id_ssh_flush_returns_original_remote_event', receipt?.messageId === originalId && receipt?.status === 'remote-stored' && receipt.remoteEventId === beforeStatus.remote.inbox[originalId]?.eventId);
    const collision = signObject(identity, { ...envelope.payload, text: `${envelope.payload.text} Owned collision probe.` });
    const tampered = { payload: envelope.payload, signature: `${envelope.signature[0] === 'A' ? 'B' : 'A'}${envelope.signature.slice(1)}` };
    const unaccepted = signObject(identity, { ...envelope.payload, messageId: `m_${randomUUID()}`, roomId: `r_${randomUUID()}` });
    assertion('signed_same_id_body_collision_rejected_over_actual_ssh', await cli('remote', ['node', 'receive'], { input: collision, reject: true }));
    assertion('tampered_signature_rejected_over_actual_ssh', await cli('remote', ['node', 'receive'], { input: tampered, reject: true }));
    assertion('signed_unaccepted_room_rejected_over_actual_ssh', await cli('remote', ['node', 'receive'], { input: unaccepted, reject: true }));
    assertion('wrong_expected_session_rejected_before_submission', await cli('local', ['collab', 'send', '--queue', '--room', room.id, '--from', aliases.local, '--to', aliases.remote, '--expected-session', 'ses_deliberate_wrong_owned_probe', '--message', `Owned non-delivery probe ${config.runId}.`], { reject: true }));
    await delay(1000);
    const afterStatus = { local: await cli('local', ['node', 'status']), remote: await cli('remote', ['node', 'status']) };
    const messagesAfter = { local: await codex.messages(config.local.codexThread, { limit: 500 }), remote: await remote('messages') };
    const mapping = status => Object.entries(status.inbox).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({ id, eventId: entry.eventId, inputId: entry.inputId, payloadHash: entry.payloadHash }));
    assertion('replay_and_rejections_preserve_both_inbox_mappings', ['local', 'remote'].every(role => JSON.stringify(mapping(beforeStatus[role])) === JSON.stringify(mapping(afterStatus[role]))));
    assertion('replay_and_rejections_add_no_room_ledger_message_or_submission', (await cli('local', ['history', '--last', '1000', '--thread', room.id], { lines: true })).length === beforeLedgerCounts.local && (await cli('remote', ['history', '--last', '1000', '--thread', room.id], { lines: true })).length === beforeLedgerCounts.remote);
    assertion('replay_and_rejections_add_no_outbox_intent', ['local', 'remote'].every(role => JSON.stringify(Object.keys(beforeStatus[role].outbox).sort()) === JSON.stringify(Object.keys(afterStatus[role].outbox).sort())));
    const nativeUsers = messages => messages.filter(item => ['user', 'userMessage'].includes(item.type)).map(item => item.id).sort();
    assertion('replay_and_rejections_add_no_native_user_input', ['local', 'remote'].every(role => JSON.stringify(nativeUsers(messagesBefore[role])) === JSON.stringify(nativeUsers(messagesAfter[role]))));
    assertion('replayed_request_has_one_stable_remote_native_input', Boolean(beforeStatus.remote.inbox[originalId]?.inputId) && messagesBefore.remote.filter(item => item.id === beforeStatus.remote.inbox[originalId].inputId).length === 1 && messagesAfter.remote.filter(item => item.id === beforeStatus.remote.inbox[originalId].inputId).length === 1);
    const boundLocal = (await cli('local', ['bindings'])).bindings.find(binding => binding.alias === aliases.local);
    const boundRemote = (await cli('remote', ['bindings'])).bindings.find(binding => binding.alias === aliases.remote);
    assertion('both_exact_native_sessions_and_services_preserved', boundLocal?.sessionId === config.local.codexThread && boundLocal.directory === config.local.codexCwd && boundLocal.serviceId === codex.identity.serviceId && boundRemote?.sessionId === remoteId && boundRemote.directory === config.remote.workspace && boundRemote.serviceId === probe.service.serviceId);
    const rawAfter = (await codex.request('thread/read', { threadId: config.local.codexThread, includeTurns: false })).thread;
    assertion('codex_model_and_permission_settings_preserved', JSON.stringify(settings(rawAfter)) === JSON.stringify(codexSettingsBefore));
    privateData.phases.statusBeforeGuards = beforeStatus; privateData.phases.statusAfterGuards = afterStatus;
    privateData.messages.local = messagesAfter.local; privateData.messages.remote = messagesAfter.remote;
    communicationComplete = true;
    await stage('actual_ssh_replay_signature_and_session_guards_verified');

    // Quiesce only the owned bridge workers before the byte-for-byte observer
    // check. A live writer's WAL changes cannot establish observer mutation.
    for (const role of ['local', 'remote']) { await cli(role, ['detach', aliases[role]]); attached.delete(role); summary.cleanup.push({ target: `${role}-binding`, detached: true, nativeChatPreserved: true }); }
    for (const role of ['local', 'remote']) {
      const deadline = Date.now() + 25_000; let stopped = false;
      while (Date.now() < deadline) {
        const binding = (await cli(role, ['bindings'])).bindings.find(item => item.alias === aliases[role]);
        if (binding && binding.active === false && binding.worker?.running === false) { stopped = true; break; }
        await delay(300);
      }
      const cleanup = summary.cleanup.find(item => item.target === `${role}-binding`);
      if (cleanup) cleanup.workerStopped = stopped;
      assertion(`${role}_owned_worker_stopped_before_readonly_observation`, stopped);
    }
    const hashBefore = { local: await hashes(config.local.stateDir), remote: await remote('hash-state') };
    const remoteSpec = { kind: 'ssh', id: 'owned-vps', label: 'Owned VPS', destination: config.remote.sshDestination, executable: config.remote.executable, cli: config.remote.cli, stateDir: config.remote.stateDir, expectedNodeId: cardRemote.payload.node.nodeId, rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] };
    // The SSH executable inherits only this opt-in run's selected PATH. A
    // caller may place a dedicated -F wrapper there; global SSH config is not
    // rewritten. Credentials and remote paths never enter the viewer API.
    const previousPath = process.env.PATH; process.env.PATH = config.local.path;
    try {
      let attempts = 0;
      reader = createSourceReader({ intervalMs: 3000, remoteReader: async (spec, options) => { attempts++; return await fetchSshObservation(spec, options); } });
      viewer = await createViewer({ sources: [{ kind: 'local', id: 'owned-local', label: 'Owned local', path: config.local.stateDir }, remoteSpec], reader, pollMs: 750 });
      const started = Date.now();
      while (!viewer.model.sources.find(source => source.id === remoteSpec.id)?.available && Date.now() - started < 20_000) { await viewer.model.refresh(); await delay(100); }
      const source = viewer.model.sources.find(item => item.id === remoteSpec.id);
      assertion('real_ssh_observer_accepts_exact_node_and_room_scope', source?.available && source.store.rooms[room.id]?.manifestHash === room.manifestHash && Object.keys(source.store.rooms).length === 1);
      const projected = viewer.model.projection.messages;
      const formal = projected.filter(message => message.evidence.some(item => ids.includes(item.messageId)));
      assertion('real_ssh_observer_deduplicates_four_formal_messages', formal.length === 4 && formal.every(message => message.sourceIds.length === 2));
      const questionProjection = formal.find(message => message.evidence.some(item => item.messageId === request.frame.globalMessageId));
      const replyProjection = formal.find(message => message.evidence.some(item => item.messageId === response.frame.globalMessageId));
      assertion('real_ssh_viewer_links_global_reply_and_native_evidence', questionProjection && replyProjection?.replyTo?.id === questionProjection.id && questionProjection.statuses.includes('native-admitted'));
      const auth = await fetch(viewer.url, { redirect: 'manual' });
      const cookie = auth.headers.get('set-cookie')?.split(';')[0];
      const snapshot = await (await fetch(`${viewer.origin}/api/snapshot`, { headers: { Cookie: cookie } })).json();
      const exported = JSON.stringify(snapshot);
      assertion('real_ssh_viewer_response_excludes_private_paths_and_keys', ![config.local.stateDir, config.remote.stateDir, config.remote.serviceFile, identity.privateKey].some(value => exported.includes(value)));
      summary.observer = { actualSshCollectionsAttempted: attempts, roomCount: viewer.model.projection.rooms.length, formalMessageCount: formal.length, protocol: 'real SSH scoped snapshot', disconnectionRecovery: 'separate controlled route-gate acceptance pending' };
      privateData.phases.observerSources = viewer.model.sources;
    } finally {
      await viewer?.close(); viewer = null; await reader?.close(); reader = null;
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
    const hashAfter = { local: await hashes(config.local.stateDir), remote: await remote('hash-state') };
    assertion('real_ssh_observer_does_not_mutate_quiescent_local_state', JSON.stringify(hashBefore.local) === JSON.stringify(hashAfter.local));
    assertion('real_ssh_export_does_not_mutate_quiescent_remote_state', JSON.stringify(hashBefore.remote) === JSON.stringify(hashAfter.remote));
    summary.observer.hashedFiles = { local: Object.keys(hashBefore.local).length, remote: Object.keys(hashBefore.remote).length };
    summary.status = 'passed';
    await stage('real_two_host_cross_harness_acceptance_completed');
  } catch (error) {
    privateData.errors.push({ phase, message: error.message, stack: error.stack });
    summary.status = communicationComplete ? 'partial' : 'failed';
    summary.failure = { phase, category: cancelled ? 'cancelled' : 'owned-vps-acceptance-failed', privateDiagnosisRetained: true };
    await persist();
  } finally {
    await viewer?.close().catch(() => {}); await reader?.close().catch(() => {});
    if (codex) {
      try {
        const native = await codex.session(config.local.codexThread);
        if (!['idle', 'notLoaded'].includes(native.nativeStatus)) {
          const bindings = await cli('local', ['bindings']);
          const binding = bindings.bindings.find(item => item.alias === aliases.local);
          const current = (await codex.request('thread/read', { threadId: config.local.codexThread, includeTurns: true })).thread;
          latestCodex = await codex.messages(config.local.codexThread, { limit: 500 });
          const owned = ownedCodexActiveTurn({ threadId: config.local.codexThread, thread: current,
            messages: latestCodex, inputIds: [...ownedInputIds], binding, worker: binding?.worker });
          if (owned) { await codex.request('turn/interrupt', { threadId: config.local.codexThread, turnId: owned.turnId }); summary.cleanup.push({ target: 'owned-codex-turn', interrupted: true }); }
          else {
            summary.cleanup.push({ target: 'owned-codex-turn', interrupted: false, checked: false, reason: 'active-turn-ownership-not-confirmed' });
            privateData.errors.push({ phase: 'codex-cleanup', message: 'An active turn could not be proved to belong to this test; it was preserved.' });
          }
        }
      } catch (error) { privateData.errors.push({ phase: 'codex-cleanup', message: error.message }); summary.cleanup.push({ target: 'owned-codex-turn', checked: false }); }
    }
    if (remoteId && summary.status !== 'passed') {
      try { await remote('abort'); summary.cleanup.push({ target: 'owned-vps-session', aborted: true, nativeChatPreserved: true }); }
      catch (error) { privateData.errors.push({ phase: 'vps-cleanup', message: error.message }); summary.cleanup.push({ target: 'owned-vps-session', aborted: false }); }
    }
    for (const role of attached) {
      try { const result = await cli(role, ['detach', aliases[role]]); summary.cleanup.push({ target: `${role}-binding`, detached: result.detached === true, nativeChatPreserved: true }); }
      catch (error) { summary.cleanup.push({ target: `${role}-binding`, detached: false }); privateData.errors.push({ phase: 'detach-cleanup', role, message: error.message }); }
    }
    codexLease?.close(); codex?.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (summary.cleanup.some(item => item.detached === false || item.aborted === false || item.checked === false || item.workerStopped === false)) summary.status = 'cleanup_failed';
    summary.finished_at = new Date().toISOString(); await persist();
  }
  console.log(JSON.stringify({ status: summary.status, assertionsPassed: Object.values(summary.assertions).filter(Boolean).length, assertionsTotal: Object.keys(summary.assertions).length, opencodeOncePermissions: summary.permissions.opencodeOnce, sanitizedMetrics: true }));
  if (summary.status !== 'passed') process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/vps-integration.mjs --config /absolute/private/config.json');
    console.log('Requires a complete explicit v1 config (see config/vps-integration.example.json). Connects only to its exact host and owned Codex thread. Creates one zero-price-model VPS OpenCode chat, preserves seeded context, verifies both SSH directions, replay/rejection guards, a nonce-bound private project artifact and scoped read-only real SSH observation. Never approves Codex requests or changes saved harness permissions. Fresh output/private run directories are required; existing results are never overwritten. The deployment, dedicated SSH account, forwarding route and loopback service must already exist. Raw native/host/path details remain in private diagnosis.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) throw new Error('Use --config with one absolute private configuration path, or --help.');
  const bytes = await readFile(args[1]);
  if (bytes.length > 64 * 1024) throw new Error('Acceptance configuration exceeds 64 KiB.');
  const config = validateVpsConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  await run(config);
}
main().catch(() => { console.error('VPS acceptance could not start. Use --help, a complete explicit private configuration and fresh run directories.'); process.exitCode = 1; });
