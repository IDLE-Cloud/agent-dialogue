#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../lib/codex.mjs';
import { OpenCodeClient } from '../lib/opencode.mjs';
import { runtimeEnvironment } from '../lib/paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cli = join(project, 'bin/agent-dialogue.mjs');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    console.log('node scripts/codex-integration.mjs --owned-codex-thread UUID --codex-cwd ABSOLUTE_PATH [--state-dir ABSOLUTE_PATH] [--active-cli-only] [--validation-server] [--timeout SECONDS] [--output DIRECTORY]');
    console.log('Explicitly resumes only the named owned test thread through the selected running Codex server, preserves its model/permissions, and creates one owned free-model OpenCode chat. --validation-server labels a separately started test server; this script never starts one. Uses an isolated local room. Never approves Codex shell requests. Raw errors and transcripts stay under ignored .state; published metrics contain no chat IDs, paths, credentials or message bodies.');
    process.exit(0);
  }
  if (['--active-cli-only', '--validation-server'].includes(arg)) { options[arg.slice(2)] = true; continue; }
  if (!['--owned-codex-thread', '--codex-cwd', '--state-dir', '--timeout', '--output'].includes(arg) || !process.argv[i + 1]) throw new Error('Unknown or incomplete integration option.');
  options[arg.slice(2)] = process.argv[++i];
}
const codexId = options['owned-codex-thread'], expectedCwd = options['codex-cwd'];
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(codexId || '') || !expectedCwd || !isAbsolute(expectedCwd)) throw new Error('Explicit owned Codex thread UUID and absolute expected cwd are required.');
const seconds = Number(options.timeout || 150);
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) throw new Error('--timeout must be 30..600 seconds.');
const suffix = randomUUID().replaceAll('-', '').slice(0, 8), runId = `codex-room-${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
const privateRoot = join(project, '.state', runId), stateDir = options['state-dir'] ? resolve(options['state-dir']) : join(privateRoot, 'space'), workspace = join(privateRoot, 'workspace');
const output = resolve(options.output || join(privateRoot, 'result')), cacheDir = runtimeEnvironment().cacheDir;
const aliases = { codex: 'owned-codex', opencode: 'owned-opencode' }, model = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' };
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(HCOM_|CODEX_(SESSION|THREAD|PARENT|AGENT|PROCESS|APP|INTERNAL)|CLAUDE_)/.test(key)) delete env[key];
env.AGENT_DIALOGUE_STATE_DIR = stateDir; env.AGENT_DIALOGUE_CACHE_DIR = cacheDir;
const summary = { run_id: runId, started_at: new Date().toISOString(), status: 'running', scope: 'one existing explicitly selected owned Codex test thread and one new owned normal OpenCode chat, one local room', codex: { explicit_resume_requested: true, model_changed: false, permissions_changed: false, approvals_granted: 0 }, opencode: { model, zero_cost_verified: false, approvals_once: 0 }, stages: [], assertions: {}, cleanup: [] };
summary.active_cli_only = Boolean(options['active-cli-only']);
summary.codex.connection_kind = options['validation-server'] ? 'separately-started-local-validation-server' : 'selected-existing-codex-server';
summary.codex.outbound_delivery = 'local-submission-queue-then-owning-worker-forward';
summary.communication_state_in_selected_workspace = stateDir.startsWith(resolve(expectedCwd) + '/');
const privateData = { codex_thread: codexId, expected_cwd: expectedCwd, state_dir: stateDir, errors: [], snapshots: {} };
let codex, opencode, openId, room, phase = 'initializing', attached = [], latestCodexMessages = [], baselineCodexIds = new Set();
let requestEvent, requestReplyEvent, reverseEvent, reverseReplyEvent, codexFact = `CODEX_FACT_${suffix}`, openFact = `OPEN_FACT_${suffix}`;
const seenPermissions = new Set();

await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(output, { recursive: true });
async function persist() {
  await writeFile(join(output, 'metrics.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(privateRoot, 'diagnosis.private.json'), JSON.stringify(privateData, null, 2) + '\n', { mode: 0o600 });
}
async function stage(name, extra = {}) {
  phase = name; summary.stages.push({ name, at: new Date().toISOString(), ...extra });
  await persist(); console.log(JSON.stringify({ stage: name, ...extra }));
}
function call(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 35000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    privateData.errors.push({ phase, command: args.slice(0, 2), stderr: result.stderr, stdout: result.stdout, error: result.error?.message });
    throw new Error('Owned integration CLI operation failed; raw diagnosis retained privately.');
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error('Owned integration CLI response was not JSON.'); }
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function prefix() {
  const values = { AGENT_DIALOGUE_STATE_DIR: stateDir, AGENT_DIALOGUE_CACHE_DIR: cacheDir };
  for (const key of ['AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'AGENT_DIALOGUE_CODEX_SOCKET', 'CODEX_HOME']) if (env[key]) values[key] = env[key];
  return `${Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} ${quote(process.execPath)} ${quote(cli)}`;
}
function textOf(item) {
  if (item.type === 'agentMessage') return item.text || '';
  if (item.type === 'assistant') return (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
  return item.text || '';
}
function ledgerFrames() {
  // history is JSON Lines, so read it separately from ordinary JSON commands.
  const result = spawnSync(process.execPath, [cli, 'history', '--last', '500', '--thread', room.id], { env, encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw new Error('Owned room ledger query failed.');
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).map(event => {
    try { return { ...event, frame: JSON.parse(event.data.text.slice('agent-dialogue/1\n'.length)) }; } catch { return null; }
  }).filter(event => event && event.frame.room === room.id);
}
// A deliberately small non-evaluating shell parser; reject operators and substitutions.
function tokensOf(command) {
  if (typeof command !== 'string' || command.length > 20000) return null;
  const tokens = []; let token = '', started = false, quoted = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quoted === "'") { if (c === "'") quoted = null; else token += c; continue; }
    if (quoted === '"') {
      if (c === '"') { quoted = null; continue; }
      if ('$`\r\n'.includes(c)) return null;
      if (c === '\\') { if (++i >= command.length) return null; token += command[i]; } else token += c;
      continue;
    }
    if (c === "'" || c === '"') { quoted = c; started = true; continue; }
    if (c === '\\') { if (++i >= command.length || /[\r\n]/.test(command[i])) return null; token += command[i]; started = true; continue; }
    if (';&|<>()$`\r\n'.includes(c)) return null;
    if (/\s/.test(c)) { if (started) { tokens.push(token); token = ''; started = false; } } else { token += c; started = true; }
  }
  if (quoted) return null; if (started) tokens.push(token); return tokens;
}
function allowedOpenCodeCommand(command) {
  const tokens = tokensOf(command); if (!tokens) return false;
  const expected = { AGENT_DIALOGUE_STATE_DIR: stateDir, AGENT_DIALOGUE_CACHE_DIR: cacheDir };
  for (const key of ['AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'AGENT_DIALOGUE_CODEX_SOCKET', 'CODEX_HOME']) if (env[key]) expected[key] = env[key];
  const assigned = {};
  while (tokens[0]?.match(/^[A-Z_][A-Z0-9_]*=/)) {
    const token = tokens.shift(), split = token.indexOf('='), key = token.slice(0, split), value = token.slice(split + 1);
    if (!Object.hasOwn(expected, key) || assigned[key] || expected[key] !== value) return false; assigned[key] = value;
  }
  if (assigned.AGENT_DIALOGUE_STATE_DIR !== stateDir || tokens.shift() !== process.execPath || tokens.shift() !== cli || tokens.shift() !== 'collab' || tokens.shift() !== 'send') return false;
  const fields = {};
  while (tokens.length) {
    const key = tokens.shift(); if (!['--room', '--from', '--to', '--reply-to', '--message'].includes(key) || Object.hasOwn(fields, key) || !tokens.length) return false;
    fields[key] = tokens.shift();
  }
  if (fields['--room'] !== room.id || fields['--from'] !== aliases.opencode || fields['--to'] !== aliases.codex || !fields['--message']?.includes(runId) || fields['--message'].length > 4000) return false;
  return requestEvent && fields['--reply-to'] === String(requestEvent.id) || reverseEvent === undefined && fields['--reply-to'] === undefined;
}
async function permissionChecks() {
  if (!openId || !room) return;
  const response = await opencode.request('GET', `/api/session/${openId}/permission`);
  for (const permission of response.data || []) {
    if (seenPermissions.has(permission.id)) continue;
    const commands = [permission.metadata?.command, permission.metadata?.cmd, permission.metadata?.script].filter(value => typeof value === 'string');
    const resources = (permission.resources || []).filter(value => typeof value === 'string');
    const candidates = commands.length ? commands : resources;
    const allow = summary.opencode.approvals_once < 2 && /bash|shell|execute/.test(permission.action) && candidates.length > 0 && candidates.every(allowedOpenCodeCommand) && resources.every(allowedOpenCodeCommand);
    await opencode.request('POST', `/api/session/${openId}/permission/${permission.id}/reply`, { decision: allow ? 'once' : 'reject', message: allow ? 'Exact owned cross-harness collaboration CLI only; one execution.' : 'Outside the bounded owned collaboration test.' });
    seenPermissions.add(permission.id); if (allow) summary.opencode.approvals_once++;
    else { privateData.errors.push({ phase, rejected_permission: permission }); throw new Error('Unrelated OpenCode tool request rejected.'); }
  }
}
async function waitFor(role, marker, { timeout = seconds, ledgerCheck } = {}) {
  const begin = Date.now(); let progress = Date.now();
  while (Date.now() - begin < timeout * 1000) {
    if (ledgerCheck) ledgerCheck(ledgerFrames());
    await permissionChecks();
    const messages = role === 'codex' ? await codex.messages(codexId, { limit: 100 }) : await opencode.messages(openId, { limit: 100 });
    if (role === 'codex') latestCodexMessages = messages;
    if (role === 'codex') {
      const failed = messages.find(message => !baselineCodexIds.has(message.id) && message.type === 'commandExecution' && message.command?.includes(runId) && message.exitCode !== null && message.exitCode !== undefined && message.exitCode !== 0);
      if (failed) {
        privateData.errors.push({ phase, failed_native_command: failed });
        throw new Error('Owned native commandExecution reported a nonzero exit; raw tool result retained privately.');
      }
    }
    const answer = messages.find(message => (role !== 'codex' || !baselineCodexIds.has(message.id)) && ['assistant', 'agentMessage'].includes(message.type) && (role === 'codex' || message.time?.completed) && textOf(message).includes(marker));
    const idle = role === 'codex' ? (await codex.session(codexId)).nativeStatus === 'idle' : messages.some(message => message.type === 'idle');
    if (answer && idle) return answer;
    if (role === 'codex' && idle) {
      const latest = messages.find(message => !baselineCodexIds.has(message.id) && message.type === 'agentMessage');
      if (latest && /\bEPERM\b|command failed|request was not sent/i.test(textOf(latest))) {
        privateData.errors.push({ phase, assistant_reported_command_failure: textOf(latest) });
        throw new Error('Owned model reported a local command failure; tool outcome is not inferred from model text.');
      }
    }
    if (messages.some(message => message.type === 'assistant' && message.error)) throw new Error('Owned model session failed; raw native response retained privately.');
    if (Date.now() - progress >= 15000) { await stage('waiting_for_owned_native_response', { role, elapsed_seconds: Math.round((Date.now() - begin) / 1000) }); progress = Date.now(); }
    await delay(1000);
  }
  throw new Error(`Owned ${role} response timeout; no permission changes attempted.`);
}

try {
  codex = await CodexClient.discover({ env });
  summary.codex.transport_version = codex.identity.version;
  const before = await codex.session(codexId);
  if (before.location.directory !== resolve(expectedCwd)) throw new Error('Owned Codex thread cwd differs from the explicit expected project.');
  privateData.codex_before = before; summary.codex.was_loaded = before.loaded;
  await stage('explicit_owned_codex_thread_verified', { loaded_before: before.loaded });
  opencode = await OpenCodeClient.discover({ serviceFile: env.AGENT_DIALOGUE_OPENCODE_SERVICE_FILE });
  let selected, catalogReads = 0;
  for (; catalogReads < 5; catalogReads++) {
    selected = (await opencode.request('GET', '/api/model')).data.find(item => item.id === model.id && item.providerID === model.providerID);
    // A freshly started service can still be hydrating its model catalog.
    // Re-read only an absent exact model; a disabled or priced model is rejected immediately.
    if (selected || catalogReads === 4) break;
    await delay(1000);
  }
  summary.opencode.model_catalog_reads = catalogReads + 1;
  privateData.selected_model_check = { found: Boolean(selected), enabled: selected?.enabled, cost: selected?.cost };
  if (!selected?.enabled || !selected.cost?.length || !selected.cost.every(tier => tier.input === 0 && tier.output === 0 && tier.cache?.read === 0 && tier.cache?.write === 0)) throw new Error('Owned OpenCode model must advertise only zero-cost tiers.');
  summary.opencode.zero_cost_verified = true;
  const open = await opencode.createSession({ title: `Owned cross-harness room test ${suffix}`, agent: 'build', model, location: { directory: workspace }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
  openId = open.id; privateData.opencode_session = openId;
  const seed = `OPEN_SEED_${suffix}`;
  await opencode.prompt(openId, { id: `msg_${randomUUID().replaceAll('-', '')}`, text: `This is an owned bounded integration test. Do not inspect or edit files, other chats, settings, or projects. Do not spawn agents. Your private project compatibility fact is preserve .json and read old files without rewriting; marker ${openFact}. Later reply to a peer request exactly once via the supplied CLI with this fact, marker and run token ${runId}. Never send acknowledgement loops. Now use no tools and respond exactly ${seed}.` });
  await waitFor('opencode', seed);
  call(['node', 'init', '--name', `owned-codex-room-${suffix}`]);
  const cb = call(['attach', 'codex', '--session', codexId, '--alias', aliases.codex, '--resume']); attached.push(aliases.codex);
  const ob = call(['attach', 'opencode', '--session', openId, '--alias', aliases.opencode]); attached.push(aliases.opencode);
  privateData.bindings = { codex: cb, opencode: ob };
  room = call(['room', 'create', '--name', `owned-cross-harness-${suffix}`, '--members', `${aliases.codex},${aliases.opencode}`]);
  privateData.room = room;
  baselineCodexIds = new Set((await codex.messages(codexId, { limit: 100 })).map(item => item.id));
  await stage('exact_threads_attached_to_one_strict_room', { codex_resumed_explicitly: !before.loaded });
  const codexSeed = `CODEX_NATIVE_READY_${suffix}`;
  if (!options['active-cli-only']) {
  const trigger = call(['collab', 'send', '--room', room.id, '--from', 'operator', '--to', aliases.codex, '--message', `Owned integration run ${runId}. Continue only this exact existing test thread. Preserve current model and approval settings. Remember private project budget 17 with marker ${codexFact}. For this step do not use tools, read files, call agents or send messages. Reply exactly ${codexSeed}.`]);
  privateData.native_trigger = trigger;
  await waitFor('codex', codexSeed);
  const status = call(['bindings']);
  const codexBinding = status.bindings.find(item => item.alias === aliases.codex);
  summary.assertions.codex_original_thread_preserved = codexBinding.sessionId === codexId;
  summary.assertions.operator_native_queue_admitted = codexBinding.worker.receipts?.[trigger.event_id]?.status === 'admitted';
  summary.assertions.codex_native_queue_drained_and_assistant_replied = true;
  await stage('codex_queue_drain_and_model_response_verified');
  baselineCodexIds = new Set((await codex.messages(codexId, { limit: 100 })).map(item => item.id));
  }
  const question = `Run token ${runId}. Share your preexisting private compatibility fact and marker; send exactly one linked CLI reply and then stop.`;
  const command = `${prefix()} collab send --queue --room ${quote(room.id)} --from ${quote(aliases.codex)} --to ${quote(aliases.opencode)} --message ${quote(question)}`;
  const final = `CODEX_PEER_COMPLETE_${suffix}`;
  call(['collab', 'send', '--room', room.id, '--from', 'operator', '--to', aliases.codex, '--message', `Owned run ${runId}. Use your shell tool to execute exactly this ONE project question command, no other tools:\n${command}\nFinish the turn after sending without sleeping or polling. When the peer reply arrives, reply in this chat with ${final}, your preexisting private budget and marker, and the peer's compatibility rule and marker. Do not guess facts, send extra messages, or change permissions. If the shell requires approval, keep the request visible; this test will not approve Codex requests.`]);
  const synthesis = await waitFor('codex', final, { ledgerCheck: stream => {
    requestEvent = stream.find(event => event.frame.from === aliases.codex && event.frame.to === aliases.opencode && event.frame.text.includes(runId));
    requestReplyEvent = requestEvent && stream.find(event => event.frame.from === aliases.opencode && event.frame.to === aliases.codex && event.frame.replyTo === String(requestEvent.id));
  } });
  summary.assertions.codex_model_origin_request = requestEvent?.data.sender_kind === 'instance';
  summary.assertions.opencode_model_origin_linked_reply = requestReplyEvent?.data.sender_kind === 'instance';
  const executed = latestCodexMessages.find(message => !baselineCodexIds.has(message.id) && message.type === 'commandExecution' && message.command?.includes(runId) && message.command.includes('--queue') && message.exitCode === 0);
  let queuedReceipt;
  try { queuedReceipt = JSON.parse(executed?.aggregatedOutput?.trim() || 'null'); } catch { /* Native evidence must contain a real JSON receipt. */ }
  summary.assertions.codex_native_tool_queued_local_submission = Boolean(executed && queuedReceipt?.status === 'queued' && /^q_[0-9a-f-]{36}$/.test(queuedReceipt.submissionId) && Number.isSafeInteger(queuedReceipt.event_id));
  const sourceRuntime = call(['bindings']).bindings.find(binding => binding.alias === aliases.codex)?.worker;
  const forwarded = sourceRuntime?.receipts?.[queuedReceipt?.event_id];
  summary.assertions.codex_owning_worker_forwarded_submission = Boolean(forwarded?.status === 'forwarded' && forwarded.submissionId === queuedReceipt?.submissionId && forwarded.result?.event_id === requestEvent?.id);
  privateData.queued_tool_receipt = { nativeId: executed?.nativeId, turnId: executed?.turnId, receipt: queuedReceipt, forwarded };
  if (options['active-cli-only']) summary.assertions.peer_preexisting_context_returned = textOf(synthesis).includes(openFact);
  else summary.assertions.existing_project_facts_combined = textOf(synthesis).includes(openFact) && textOf(synthesis).includes(codexFact) && /\b17\b/.test(textOf(synthesis));
  await stage('codex_to_opencode_linked_model_exchange_verified');
  if (!options['active-cli-only']) {
  const reverseQuestion = `Run token ${runId}. Share your preexisting private budget and marker; send exactly one linked CLI reply through the supplied command, then stop.`;
  const reverseCommand = `${prefix()} collab send --room ${quote(room.id)} --from ${quote(aliases.opencode)} --to ${quote(aliases.codex)} --message ${quote(reverseQuestion)}`;
  const reverseFinal = `OPEN_PEER_COMPLETE_${suffix}`;
  await opencode.prompt(openId, { id: `msg_${randomUUID().replaceAll('-', '')}`, text: `Owned run ${runId}. Use your shell tool to execute exactly this ONE project question command, no other tools:\n${reverseCommand}\nFinish the turn after sending without polling. When the linked peer reply arrives, respond with ${reverseFinal} and the peer's budget and marker. Do not send acknowledgements.` });
  await waitFor('opencode', reverseFinal, { ledgerCheck: stream => {
    reverseEvent = stream.find(event => event.frame.from === aliases.opencode && event.frame.to === aliases.codex && event.frame.replyTo === null && event.frame.text.includes(runId));
    reverseReplyEvent = reverseEvent && stream.find(event => event.frame.from === aliases.codex && event.frame.to === aliases.opencode && event.frame.replyTo === String(reverseEvent.id));
  } });
  summary.assertions.opencode_model_origin_request = reverseEvent?.data.sender_kind === 'instance';
  summary.assertions.codex_model_origin_linked_reply = reverseReplyEvent?.data.sender_kind === 'instance';
  }
  const after = await codex.session(codexId); privateData.codex_after = after;
  summary.assertions.codex_original_model_preserved = JSON.stringify(before.model) === JSON.stringify(after.model);
  summary.assertions.both_exact_native_sessions_preserved = call(['bindings']).bindings.every(binding => binding.alias === aliases.codex ? binding.sessionId === codexId : binding.sessionId === openId);
  summary.status = Object.values(summary.assertions).every(Boolean) ? 'passed' : 'partial';
} catch (error) {
  privateData.errors.push({ phase, name: error.name, message: error.message, stack: error.stack });
  summary.status = summary.assertions.codex_native_queue_drained_and_assistant_replied ? 'partial' : 'failed';
  summary.failure = { stage: phase, category: error.message.includes('timeout') ? 'native-model-or-permission-timeout' : 'owned-integration-error', raw_diagnosis_private: true };
} finally {
  if (codex) {
    try {
      const after = await codex.session(codexId);
      if (after.nativeStatus !== 'idle' && after.nativeStatus !== 'notLoaded') {
        const status = call(['bindings']), worker = status.bindings.find(item => item.alias === aliases.codex)?.worker;
        const inputs = new Set(Object.values(worker?.receipts || {}).filter(item => item.status === 'admitted' && item.sessionId === codexId).map(item => item.inputId));
        const ownTurn = latestCodexMessages.find(item => item.type === 'userMessage' && !baselineCodexIds.has(item.id) && inputs.has(item.id))?.turnId;
        if (ownTurn) { await codex.request('turn/interrupt', { threadId: codexId, turnId: ownTurn }); summary.cleanup.push({ target: 'owned-codex-test-turn', interrupted: true }); }
      }
      privateData.snapshots.codex = (await codex.messages(codexId, { limit: 100 })).filter(item => !baselineCodexIds.has(item.id));
    } catch (error) { privateData.errors.push({ phase: 'codex-cleanup', message: error.message }); }
  }
  for (const alias of attached.reverse()) {
    try { call(['detach', alias]); summary.cleanup.push({ target: alias === aliases.codex ? 'codex-binding' : 'opencode-binding', detached: true, native_chat_preserved: true }); }
    catch { summary.cleanup.push({ target: 'owned-binding', detached: false }); }
  }
  if (opencode && openId) { try { privateData.snapshots.opencode = await opencode.messages(openId, { limit: 100 }); } catch {} }
  await codex?.close?.(); await opencode?.close?.();
  summary.finished_at = new Date().toISOString(); await persist();
}
console.log(JSON.stringify({ status: summary.status, assertions: summary.assertions, failure: summary.failure, sanitized_metrics: true }));
if (summary.status !== 'passed') process.exitCode = 2;
