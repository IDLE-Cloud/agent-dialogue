#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OpenCodeClient } from '../lib/opencode.mjs';
import { runtimeEnvironment } from '../lib/paths.mjs';
import { decodeFrame } from '../lib/bridge-store.mjs';
import { loadOrCreateNode, signObject } from '../lib/node-identity.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(project, 'bin', 'agent-dialogue.mjs');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node scripts/node-integration.mjs [--model ID] [--timeout SECONDS] [--output DIRECTORY]');
    console.log('Creates two owned normal OpenCode chats, seeds them before attachment, and verifies signed cross-node project collaboration using independent local state directories and local-process transport. This does not claim two-host or SSH connectivity. Detaches owned bindings and preserves native chats. Published metrics contain no transcripts, credentials or local paths.');
    process.exit(0);
  }
  if (!['--model', '--timeout', '--output'].includes(arg) || !process.argv[i + 1]) throw new Error('Unknown or incomplete integration scenario option.');
  options[arg.slice(2)] = process.argv[++i];
}
const timeoutSeconds = Number(options.timeout || 240);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900) throw new Error('--timeout must be 30..900 seconds.');
const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
const runId = `node-project-${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
const privateRoot = join(project, '.state', runId), workspace = join(privateRoot, 'workspace');
const output = resolve(options.output || join(privateRoot, 'result'));
const cacheDir = runtimeEnvironment().cacheDir;
const serviceFile = process.env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE;
const nodes = {
  a: { alias: 'node-a', stateDir: join(privateRoot, 'state-a') },
  b: { alias: 'node-b', stateDir: join(privateRoot, 'state-b') },
};
const facts = { a: `BUDGET_${suffix}`, b: `COMPAT_${suffix}` };
const finalMarker = `PROJECT_NODE_DECISION_${suffix}`;
const summary = { run_id: runId, started_at: new Date().toISOString(), status: 'running', transport: 'local-process', scope: 'two independent local nodes, one existing OpenCode service; no two-host claim', model: { providerID: 'opencode', id: options.model || 'deepseek-v4.1-flash-free' }, stages: [], assertions: {}, permissions: { once: 0, rejected: 0 }, cleanup: [] };
const privateDiagnostics = { sessions: {}, nodes: {}, errors: [] };
const attached = [], permissionIds = new Set(), approvedPerRole = { a: 0, b: 0 };
let client, room, requestId, replyId, phase = 'initializing';

await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: true });
async function persist() {
  await writeFile(join(output, 'metrics.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(privateRoot, 'diagnosis.private.json'), `${JSON.stringify(privateDiagnostics, null, 2)}\n`, { mode: 0o600 });
}
async function stage(name, extra = {}) {
  phase = name;
  summary.stages.push({ name, at: new Date().toISOString(), ...extra });
  await persist();
  console.log(JSON.stringify({ stage: name, ...extra }));
}
function environment(role) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(HCOM_|AGENT_DIALOGUE_|CODEX_(SESSION|THREAD|PARENT|AGENT|PROCESS|APP|INTERNAL)|CLAUDE_)/.test(key)) delete env[key];
  env.AGENT_DIALOGUE_STATE_DIR = nodes[role].stateDir;
  env.AGENT_DIALOGUE_CACHE_DIR = cacheDir;
  if (serviceFile) env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE = serviceFile;
  return env;
}
function rawCall(role, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: environment(role), encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    privateDiagnostics.errors.push({ phase, role, command: args.slice(0, 2), error: result.error?.message, stderr: result.stderr, stdout: result.stdout });
    throw new Error('An owned integration CLI operation failed; private diagnosis retained.');
  }
  return result.stdout;
}
function call(role, args) {
  const stdout = rawCall(role, args);
  try { return JSON.parse(stdout); }
  catch { privateDiagnostics.errors.push({ phase, role, command: args.slice(0, 2), stdout }); throw new Error('An owned integration CLI operation returned invalid JSON.'); }
}
function history(role) { return rawCall(role, ['history', '--last', '1000']).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function receiveProbe(role, envelope, expectedError) {
  const result = spawnSync(process.execPath, [cli, 'node', 'receive'], { env: environment(role), input: `${JSON.stringify(envelope)}\n`, encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
  const rejected = !result.error && result.status !== 0 && expectedError.test(result.stderr || '');
  if (!rejected) privateDiagnostics.errors.push({ phase, role, probe_result: { error: result.error?.message, status: result.status, stdout: result.stdout, stderr: result.stderr } });
  return { rejected, exit_code: result.status };
}
const textOf = message => message.type === 'assistant' ? (message.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n') : message.text || '';

// Parse the deliberately small shell subset used by the supplied CLI examples.
// Shell operators, substitutions, redirects and additional commands are denied.
function tokensOf(command) {
  if (typeof command !== 'string' || command.length > 20_000) return null;
  const tokens = []; let token = '', started = false, quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = null; else token += c; continue; }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === '$' || c === '`' || c === '\n' || c === '\r') return null;
      if (c === '\\') { if (++i >= command.length) return null; token += command[i]; } else token += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\') { if (++i >= command.length || /[\r\n]/.test(command[i])) return null; token += command[i]; started = true; continue; }
    if (';&|<>()$`\r\n'.includes(c)) return null;
    if (/\s/.test(c)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += c; started = true; }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}
function permittedCommand(role, command) {
  const tokens = tokensOf(command); if (!tokens) return null;
  const allowedEnvironment = { AGENT_DIALOGUE_STATE_DIR: nodes[role].stateDir, AGENT_DIALOGUE_CACHE_DIR: cacheDir, ...(serviceFile ? { AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: serviceFile } : {}) };
  const assigned = {};
  while (tokens[0]?.match(/^[A-Z_][A-Z0-9_]*=/)) {
    const token = tokens.shift(), split = token.indexOf('='), key = token.slice(0, split), value = token.slice(split + 1);
    if (!Object.hasOwn(allowedEnvironment, key) || assigned[key] || value !== allowedEnvironment[key]) return null;
    assigned[key] = value;
  }
  if (assigned.AGENT_DIALOGUE_STATE_DIR !== nodes[role].stateDir) return null;
  if (tokens.shift() !== process.execPath || tokens.shift() !== cli || tokens.shift() !== 'collab' || tokens.shift() !== 'send') return null;
  const fields = {}, allowed = new Set(['--room', '--from', '--to', '--message', '--reply-to', '--expected-session']);
  while (tokens.length) {
    const key = tokens.shift(); if (!allowed.has(key) || Object.hasOwn(fields, key) || !tokens.length) return null;
    fields[key] = tokens.shift();
  }
  const other = role === 'a' ? 'b' : 'a';
  if (fields['--room'] !== room?.id || fields['--from'] !== nodes[role].alias || fields['--to'] !== nodes[other].alias || !fields['--message']?.includes(runId) || fields['--message'].length > 4000) return null;
  if (fields['--expected-session'] !== undefined && fields['--expected-session'] !== nodes[other].session?.id) return null;
  if (role === 'a' && fields['--reply-to'] !== undefined) return null;
  if (role === 'b' && (!requestId || fields['--reply-to'] !== requestId)) return null;
  return fields;
}
async function permissionChecks(role) {
  const id = nodes[role].session?.id; if (!id) return;
  const response = await client.request('GET', `/api/session/${id}/permission`);
  for (const request of response.data || []) {
    if (permissionIds.has(request.id)) continue;
    if (role === 'b' && !requestId) continue;
    const metadataCommands = [request.metadata?.command, request.metadata?.cmd, request.metadata?.script].filter(value => typeof value === 'string');
    const resources = (request.resources || []).filter(value => typeof value === 'string');
    const commands = metadataCommands.length ? metadataCommands : resources;
    const allowed = approvedPerRole[role] === 0 && /bash|shell|execute/.test(request.action) && commands.length > 0 && commands.every(command => permittedCommand(role, command)) && resources.every(resource => permittedCommand(role, resource));
    await client.request('POST', `/api/session/${id}/permission/${request.id}/reply`, { decision: allowed ? 'once' : 'reject', message: allowed ? 'Owned signed cross-node collaboration CLI only; one execution.' : 'Outside bounded owned-node collaboration test.' });
    permissionIds.add(request.id); summary.permissions[allowed ? 'once' : 'rejected']++;
    if (allowed) approvedPerRole[role]++;
    else privateDiagnostics.errors.push({ phase, role, rejected_permission: { action: request.action, resources: request.resources, metadata: request.metadata } });
    await persist();
    if (!allowed) throw new Error('Unexpected permission request was rejected without saved permission changes.');
  }
}
function completedCalls(role, messages) {
  const calls = [];
  for (const message of messages) for (const part of message.content || []) {
    if (part.type !== 'tool' || part.state?.status !== 'completed' || part.state?.metadata?.exit !== 0) continue;
    const fields = permittedCommand(role, part.state.input?.command); if (!fields) continue;
    const text = (part.state.content || []).filter(piece => piece.type === 'text').map(piece => piece.text || '').join('\n');
    let receipt; try { receipt = JSON.parse(text); } catch { continue; }
    if (/^m_[0-9a-f-]{36}$/.test(receipt.messageId)) calls.push({ toolId: part.id, fields, receipt });
  }
  return calls;
}
async function waitForSeed(role, marker) {
  const begin = Date.now();
  while (Date.now() - begin < timeoutSeconds * 1000) {
    await permissionChecks(role);
    const messages = await client.messages(nodes[role].session.id, { limit: 100 });
    const complete = messages.find(message => message.type === 'assistant' && message.time?.completed && textOf(message).includes(marker));
    if (complete) return;
    if (messages.some(message => message.type === 'assistant' && message.error)) throw new Error('Owned model session failed while seeding project context.');
    await delay(1000);
  }
  throw new Error('Owned model session did not acknowledge its seeded project context.');
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function commandPrefix(role) {
  const values = { AGENT_DIALOGUE_STATE_DIR: nodes[role].stateDir, AGENT_DIALOGUE_CACHE_DIR: cacheDir, ...(serviceFile ? { AGENT_DIALOGUE_OPENCODE_SERVICE_FILE: serviceFile } : {}) };
  return `${Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')} ${shellQuote(process.execPath)} ${shellQuote(cli)}`;
}

try {
  client = await OpenCodeClient.discover(serviceFile ? { serviceFile } : {});
  const catalog = await client.request('GET', '/api/model');
  const model = catalog.data.find(item => item.id === summary.model.id && item.providerID === 'opencode');
  if (!model?.enabled || !Array.isArray(model.cost) || !model.cost.length || !model.cost.every(tier => tier.input === 0 && tier.output === 0 && tier.cache?.read === 0 && tier.cache?.write === 0)) throw new Error('The selected model must advertise only zero-cost input/output/cache tiers.');
  summary.model.zero_cost_verified = true;
  summary.model.service_version = client.identity.version;
  await stage('zero_cost_model_verified');
  for (const role of ['a', 'b']) {
    call(role, ['node', 'init', '--name', `owned-node-${role}-${suffix}`]);
    const session = await client.createSession({ title: `Owned independent node project ${suffix}`, agent: 'build', model: { id: summary.model.id, providerID: 'opencode' }, location: { directory: workspace }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    nodes[role].session = session; privateDiagnostics.sessions[role] = session.id;
    const marker = `SEED_READY_${role}_${suffix}`;
    const context = role === 'a'
      ? `You coordinate the event journal project as node-a. Your private preexisting project fact is an engineering budget of 17 units with marker ${facts.a}. You do not know node-b's compatibility requirement; ask node-b later. When a peer replies, combine your own fact and the peer fact. Do not send acknowledgement loops.`
      : `You own compatibility for the event journal project as node-b. Your private preexisting constraint is to preserve the .json extension and read old journal files without rewriting them, with marker ${facts.b}. When node-a asks, send exactly ONE CLI reply through the supplied collaboration command, using the incoming global m_ message ID as --reply-to. Include this constraint, your private marker, and run token ${runId}. Then stop; do not acknowledge again.`;
    await client.prompt(session.id, { id: `msg_${randomUUID().replaceAll('-', '')}`, text: `This is an owned bounded integration test in an empty fixture. Do not inspect or edit files, other chats, configuration or other projects. Do not use tools, spawn agents, or start collaboration now. ${context}\nRemember this context in THIS normal chat. For now respond exactly ${marker}.` });
    await waitForSeed(role, marker);
    await stage('normal_project_chat_seeded', { role });
    const binding = call(role, ['attach', 'opencode', '--session', session.id, '--alias', nodes[role].alias]);
    nodes[role].binding = binding; attached.push(role);
    await stage('existing_project_chat_attached', { role });
  }
  summary.assertions.seeded_before_attach = true;
  for (const role of ['a', 'b']) {
    const card = call(role, ['node', 'export']), cardPath = join(privateRoot, `card-${role}.json`);
    await writeFile(cardPath, `${JSON.stringify(card)}\n`, { mode: 0o600 }); nodes[role].cardPath = cardPath;
  }
  for (const role of ['a', 'b']) {
    const other = role === 'a' ? 'b' : 'a';
    const args = ['node', 'peer', 'add', '--file', nodes[other].cardPath, '--local', '--executable', process.execPath, '--cli', cli, '--state-dir', nodes[other].stateDir, '--cache-dir', cacheDir];
    if (serviceFile) args.push('--service-file', serviceFile);
    call(role, args);
  }
  room = call('a', ['room', 'create', '--name', `owned-cross-node-${suffix}`, '--members', 'node-a,node-b']);
  const manifest = call('a', ['room', 'export', room.id]), manifestPath = join(privateRoot, 'room.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  call('b', ['room', 'import', '--file', manifestPath]);
  await stage('public_cards_paired_and_room_imported');
  const question = `Run token ${runId}. Please share your preexisting private compatibility requirement and private marker. Reply exactly once via the supplied collaboration CLI, linked to this incoming global message ID. Do not ask more questions or send another acknowledgement.`;
  const firstCommand = `${commandPrefix('a')} collab send --room ${shellQuote(room.id)} --from 'node-a' --to 'node-b' --message ${shellQuote(question)}`;
  const instruction = `Run token ${runId}. Resume this existing event journal project chat using its preexisting context. Use your shell tool to execute exactly the following ONE project question command; do not modify the command or run any other tools:\n${firstCommand}\nAfter sending, finish this turn without polling or sleeping; the peer reply will resume this same chat. After receiving node-b's linked reply, emit ${finalMarker} and a concise project decision combining your preexisting numeric budget and private marker with node-b's compatibility rule and private marker. Do not guess the peer requirement, read files, or emit the final marker before a linked peer reply arrives. Do not send any further CLI messages or acknowledgements.`;
  const trigger = call('a', ['collab', 'send', '--room', room.id, '--from', 'operator', '--to', 'node-a', '--message', instruction]);
  privateDiagnostics.trigger = trigger;
  await stage('project_collaboration_triggered');
  const begin = Date.now(); let synthesis, aCalls = [], bCalls = [], lastProgress = Date.now();
  while (Date.now() - begin < timeoutSeconds * 1000) {
    const aMessages = await client.messages(nodes.a.session.id, { limit: 100 });
    aCalls = completedCalls('a', aMessages);
    if (aCalls.length) requestId = aCalls[0].receipt.messageId;
    await permissionChecks('a'); await permissionChecks('b');
    const bMessages = await client.messages(nodes.b.session.id, { limit: 100 });
    bCalls = completedCalls('b', bMessages);
    if (bCalls.length) replyId = bCalls[0].receipt.messageId;
    const final = aMessages.find(message => message.type === 'assistant' && message.time?.completed && textOf(message).includes(finalMarker) && textOf(message).includes(facts.a) && textOf(message).includes(facts.b) && /\b17\b/.test(textOf(message)) && textOf(message).includes('.json'));
    if (final && requestId && replyId) { synthesis = textOf(final); break; }
    if ([...aMessages, ...bMessages].some(message => message.type === 'assistant' && message.error)) throw new Error('An owned model session failed during cross-node project communication.');
    if (Date.now() - lastProgress >= 15_000) { await stage('waiting_for_owned_project_exchange', { request_observed: Boolean(requestId), linked_reply_observed: Boolean(replyId) }); lastProgress = Date.now(); }
    await delay(1000);
  }
  if (!synthesis) throw new Error('Timed out waiting for a linked model-origin request, reply and combined project decision.');
  const aStatus = call('a', ['node', 'status']), bStatus = call('b', ['node', 'status']);
  privateDiagnostics.nodes = { a: aStatus, b: bStatus };
  const aBindings = call('a', ['bindings']), bBindings = call('b', ['bindings']);
  summary.elapsed_ms = Date.now() - begin;
  summary.assertions.exactly_one_model_origin_request = aCalls.length === 1;
  summary.assertions.exactly_one_model_origin_linked_reply = bCalls.length === 1 && bCalls[0].fields['--reply-to'] === requestId;
  summary.assertions.remote_stored_receipts = aCalls[0].receipt.status === 'remote-stored' && bCalls[0].receipt.status === 'remote-stored';
  summary.assertions.original_session_ids_preserved = aBindings.bindings.some(binding => binding.alias === 'node-a' && binding.sessionId === nodes.a.session.id) && bBindings.bindings.some(binding => binding.alias === 'node-b' && binding.sessionId === nodes.b.session.id);
  summary.assertions.original_private_context_combined = synthesis.includes(facts.a) && synthesis.includes(facts.b) && /\b17\b/.test(synthesis) && synthesis.includes('.json');
  const nodeAId = aStatus.node?.nodeId, nodeBId = bStatus.node?.nodeId;
  summary.assertions.independent_node_identities = Boolean(nodeAId && nodeBId && nodeAId !== nodeBId);
  summary.assertions.request_and_reply_reconciled_on_both_nodes = [requestId, replyId].every(id => JSON.stringify(aStatus).includes(id) && JSON.stringify(bStatus).includes(id));
  summary.assertions.only_bounded_once_permissions = summary.permissions.rejected === 0;
  summary.message_ids = { request: requestId, reply: replyId };

  await stage('checking_same_id_replay_and_signed_ingress_guards');
  const before = { a: aStatus, b: bStatus }, ledgerBefore = { a: history('a'), b: history('b') };
  const nativeBefore = { a: await client.messages(nodes.a.session.id, { limit: 100 }), b: await client.messages(nodes.b.session.id, { limit: 100 }) };
  const originalInputIds = { a: aStatus.inbox[replyId]?.inputId, b: bStatus.inbox[requestId]?.inputId };
  if (!originalInputIds.a || !originalInputIds.b) throw new Error('Expected native input mappings were unavailable for replay verification.');
  const originalEvent = ledgerBefore.a.find(event => event.id === aStatus.outbox[requestId]?.eventId);
  const envelope = originalEvent && decodeFrame(originalEvent.data.text).wireEnvelope;
  const identityA = await loadOrCreateNode(runtimeEnvironment(environment('a')));
  if (!envelope || envelope.payload?.messageId !== requestId || envelope.payload.from.nodeId !== identityA.nodeId || envelope.payload.to.nodeId !== nodeBId) throw new Error('Owned outbound message could not be identified safely for ingress probes.');
  const replay = call('a', ['node', 'flush', '--message', requestId]);
  const replayReceipt = Array.isArray(replay) ? replay[0] : replay;
  summary.assertions.same_id_flush_returns_original_remote_event = replayReceipt?.messageId === requestId && replayReceipt.status === 'remote-stored' && replayReceipt.remoteEventId === aStatus.outbox[requestId].remoteEventId && replayReceipt.remoteEventId === bStatus.inbox[requestId].eventId;
  const collision = signObject(identityA, { ...envelope.payload, text: `${envelope.payload.text}\nOwned same-ID collision probe.` });
  const collisionProbe = receiveProbe('b', collision, /Global message ID was reused with different content/);
  summary.assertions.signed_same_id_different_body_rejected = collisionProbe.rejected;
  const tampered = { payload: envelope.payload, signature: `${envelope.signature[0] === 'A' ? 'B' : 'A'}${envelope.signature.slice(1)}` };
  const signatureProbe = receiveProbe('b', tampered, /Invalid node signature/);
  summary.assertions.tampered_signature_rejected_at_cli_ingress = signatureProbe.rejected;
  const unaccepted = signObject(identityA, { ...envelope.payload, messageId: `m_${randomUUID()}`, roomId: `r_${randomUUID()}` });
  const roomProbe = receiveProbe('b', unaccepted, /Unknown room ID/);
  summary.assertions.unaccepted_room_rejected_at_cli_ingress = roomProbe.rejected;
  await delay(1200);
  const after = { a: call('a', ['node', 'status']), b: call('b', ['node', 'status']) };
  const nativeAfter = { a: await client.messages(nodes.a.session.id, { limit: 100 }), b: await client.messages(nodes.b.session.id, { limit: 100 }) };
  const inboxMapping = status => Object.entries(status.inbox).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({ id, eventId: entry.eventId, inputId: entry.inputId, payloadHash: entry.payloadHash }));
  summary.assertions.replay_and_rejections_preserve_both_inbox_mappings = ['a', 'b'].every(role => JSON.stringify(inboxMapping(before[role])) === JSON.stringify(inboxMapping(after[role])));
  const stableCounts = { before: {}, after: {} };
  for (const role of ['a', 'b']) {
    stableCounts.before[role] = nativeBefore[role].filter(message => message.id === originalInputIds[role]).length;
    stableCounts.after[role] = nativeAfter[role].filter(message => message.id === originalInputIds[role]).length;
  }
  summary.assertions.duplicate_does_not_repeat_stable_native_inputs = ['a', 'b'].every(role => stableCounts.before[role] === 1 && stableCounts.after[role] === 1);
  const userInputs = messages => messages.filter(message => message.type === 'user').map(message => message.id).sort();
  summary.assertions.rejections_add_no_native_user_input = ['a', 'b'].every(role => JSON.stringify(userInputs(nativeBefore[role])) === JSON.stringify(userInputs(nativeAfter[role])));
  summary.assertions.replay_and_rejections_add_no_message_ledger_event = ['a', 'b'].every(role => history(role).length === ledgerBefore[role].length);
  summary.guards = { collision: collisionProbe, invalid_signature: signatureProbe, unaccepted_room: roomProbe, stable_native_input_counts: stableCounts };
  privateDiagnostics.nodes_after_guards = after;
  await stage('duplicate_and_signed_ingress_guards_completed', { collision_rejected: collisionProbe.rejected, signature_rejected: signatureProbe.rejected, unaccepted_room_rejected: roomProbe.rejected });
  summary.status = Object.values(summary.assertions).every(Boolean) ? 'passed' : 'failed_assertions';
  if (summary.status !== 'passed') process.exitCode = 1;
  await stage('project_collaboration_completed', { status: summary.status, elapsed_ms: summary.elapsed_ms });
} catch (error) {
  summary.status = 'failed'; summary.failure_phase = phase; summary.error = 'Owned integration failed; inspect its private diagnosis.';
  privateDiagnostics.errors.push({ phase, error: error.stack || error.message });
  process.exitCode = 1;
  await stage('scenario_failed', { failure_phase: summary.failure_phase });
} finally {
  for (const role of attached) {
    try { const result = call(role, ['detach', nodes[role].alias]); summary.cleanup.push({ role, detached: result.detached === true }); }
    catch (error) { summary.cleanup.push({ role, detached: false }); privateDiagnostics.errors.push({ phase: 'cleanup', role, error: error.message }); process.exitCode = 1; }
  }
  summary.finished_at = new Date().toISOString();
  if (summary.cleanup.some(item => !item.detached)) summary.status = 'cleanup_failed';
  await persist();
  console.log(JSON.stringify({ event: 'node_integration_completed', ...summary }));
}
