#!/usr/bin/env node
/** Explicit, model-free real-SSH observation with an isolated transport gate. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createViewer } from '../lib/viewer/server.mjs';
import { createSourceReader, fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';
import { buildObserverHashInvocation, claimObserverDirectories, createObserverGate, OBSERVER_HASH_SOURCE, observeRecovery, validateObserverConfig } from './vps-observer-contract.mjs';

const MAX_OUTPUT = 1024 * 1024;
const NORMAL_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SSH_AUTH_SOCK', 'PATH'];
const cleanEnvironment = () => Object.fromEntries(NORMAL_ENV.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
async function execute(executable, args, { input, env }) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const killOwned = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    const chunks = []; let bytes = 0, diagnostics = 0, failed = false, settled = false, killTimer, settleTimer;
    const finish = (code, error) => {
      if (settled) return; settled = true; killOwned('SIGKILL'); clearTimeout(timer); clearTimeout(killTimer); clearTimeout(settleTimer);
      if (error) reject(error);
      else { try { done({ code, failed, stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); } catch { reject(new Error('A hash process returned invalid UTF-8.')); } }
    };
    const stop = () => {
      failed = true; killOwned('SIGTERM');
      killTimer ??= setTimeout(() => killOwned('SIGKILL'), 100);
      settleTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(143); }, 1500);
    };
    const timer = setTimeout(stop, 20_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop(); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 64 * 1024) stop(); });
    child.stdin.on('error', () => {}); child.once('error', () => finish(null, new Error('A read-only hash process could not start.'))); child.once('close', code => finish(code)); child.stdin.end(input);
  });
}
async function readHash(invocation, env) {
  const result = await execute(invocation.executable, invocation.args, { env, input: invocation.input });
  if (result.code !== 0 || result.failed) throw new Error('Quiescent source hashing failed.');
  const response = JSON.parse(result.stdout), request = JSON.parse(invocation.input);
  if (response?.version !== 1 || response.type !== 'viewer-state-hashes' || response.requestId !== request.requestId || !response.files || typeof response.files !== 'object' || Array.isArray(response.files)) throw new Error('Read-only hash response did not match its request.');
  const entries = Object.entries(response.files);
  if (entries.length > 4096 || entries.some(([path, hash]) => !path || path.startsWith('/') || path.split('/').includes('..') || typeof hash !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(hash))) throw new Error('Read-only hash manifest was invalid.');
  return response.files;
}
async function readRequests(path) {
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) throw new Error('Observer gate audit log exceeded its limit.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n').filter(Boolean).map(line => {
    const entry = JSON.parse(line);
    if (!entry || Object.keys(entry).sort().join(',') !== 'at,requestId,status' || !/^[0-9a-f]{32}(?![\s\S])/.test(entry.requestId) || !['allowed', 'blocked'].includes(entry.status) || new Date(entry.at).toISOString() !== entry.at) throw new Error('Observer gate audit log was invalid.');
    return entry;
  });
}
async function sourceIdentity() {
  const output = {};
  for (const file of ['scripts/vps-observer-integration.mjs', 'scripts/vps-observer-contract.mjs', 'lib/viewer/readers/ssh.mjs', 'lib/viewer/observation.mjs', 'lib/viewer/readers/local.mjs', 'lib/viewer/stream.mjs']) output[file] = createHash('sha256').update(await readFile(new URL(`../${file}`, import.meta.url))).digest('hex');
  return output;
}
async function run(config) {
  await claimObserverDirectories(config);
  const sourceFiles = await sourceIdentity(), started = Date.now();
  const summary = { version: 1, run_id: config.runId, started_at: new Date().toISOString(), status: 'running',
    scenario: 'real-ssh-observation-controlled-transport-gate', actualSshSelected: true, modelCalls: 0, nativeHarnessApiCalls: 0,
    faultModel: 'A dedicated process-local observer SSH shim denies only the exact selected export invocation while closed. Allowed and recovered collections use the explicitly selected SSH executable. No network interface, firewall, SSH daemon, bridge route or global SSH configuration is changed.',
    sourceFiles, stages: [], assertions: {}, cleanup: [], sourceCount: 2, selectedRoomCount: config.remote.rooms.length };
  const diagnosis = { config, errors: [], hashManifests: {}, observations: {}, audit: [] };
  let viewer, reader, gate, cancelled = false, pathChanged = false;
  const oldPath = process.env.PATH, interrupt = () => { cancelled = true; };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  async function persist() {
    await writeFile(join(config.outputDir, 'metrics.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(config.privateDir, 'diagnosis.private.json'), JSON.stringify(diagnosis, null, 2) + '\n', { mode: 0o600 });
  }
  async function stage(name) { summary.stages.push({ name, at: new Date().toISOString() }); await persist(); console.log(JSON.stringify({ stage: name })); }
  function assertion(name, predicate) { summary.assertions[name] = Boolean(predicate); if (!predicate) throw new Error(`Observer acceptance assertion failed: ${name}.`); }
  const env = cleanEnvironment();
  function localHashInvocation() {
    return { executable: process.execPath, args: ['-e', OBSERVER_HASH_SOURCE], input: JSON.stringify({ version: 1, type: 'viewer-hash-state', requestId: randomBytes(16).toString('hex'), stateDir: config.localStateDir }) + '\n' };
  }
  try {
    await stage('hashing_quiescent_sources_before_observation');
    if (!(await lstat(config.localStateDir)).isDirectory()) throw new Error('The selected local source must be an existing state directory.');
    const before = { local: await readHash(localHashInvocation(), env), remote: await readHash(buildObserverHashInvocation(config), env) };
    diagnosis.hashManifests.before = before;
    assertion('both_explicit_sources_contain_existing_state', Object.keys(before.local).length > 0 && Object.keys(before.remote).length > 0);
    gate = await createObserverGate(config);
    process.env.PATH = `${gate.binDir}:${oldPath || '/usr/bin:/bin'}`; pathChanged = true;
    const remoteId = 'observer-vps', spec = { kind: 'ssh', id: remoteId, label: 'Owned VPS observation', ...config.remote };
    reader = createSourceReader({ remoteReader: async (selected, options) => {
      try { return await fetchSshObservation(selected, options); }
      catch (error) { diagnosis.errors.push({ phase: 'scoped-ssh-collection', category: error.message }); throw error; }
    }, intervalMs: 3000 });
    viewer = await createViewer({ sources: [{ kind: 'local', id: 'observer-local', label: 'Owned local observation', path: config.localStateDir }, spec], reader, pollMs: 750 });
    const refresh = viewer.model.refresh.bind(viewer.model);
    viewer.model.refresh = async () => { if (cancelled) throw new Error('Observer acceptance cancelled.'); return await refresh(); };
    const result = await observeRecovery({ viewer, remoteId, setGate: open => open ? gate.open() : gate.close(), onStage: async name => {
      if (name === 'stale-confirmed') {
        const deadline = Date.now() + 20_000;
        while ((await readRequests(gate.requestsFile)).filter(entry => entry.status === 'blocked').length < 2) {
          if (cancelled || Date.now() > deadline) throw new Error('A second gated export attempt was not confirmed.');
          await viewer.model.refresh(); await new Promise(done => setTimeout(done, 100));
        }
      }
      await stage(`observer_${name}`);
    } });
    diagnosis.observations = result;
    const pinsMatch = source => source?.node?.nodeId === config.remote.expectedNodeId && Object.keys(source.store.rooms).length === config.remote.rooms.length && config.remote.rooms.every(pin => { const room = source.store.rooms[pin.id]; return room?.revision === pin.revision && room.manifestHash === pin.manifestHash; });
    assertion('real_ssh_initial_and_recovered_snapshots_match_node_and_room_pins', pinsMatch(result.initial) && pinsMatch(result.recovered));
    assertion('selected_remote_history_is_nonempty', result.initial.events.length > 0 && result.messageIds.length > 0);
    assertion('closed_gate_marks_remote_unavailable_and_retains_last_good_history', result.stale.available === false && result.stale.events.length === result.initial.events.length && Date.parse(result.stale.observedAt) >= Date.parse(result.initial.observedAt));
    assertion('recovery_returns_live_fresh_snapshot_without_message_duplication', result.recovered.available === true && Date.parse(result.recovered.observedAt) > Date.parse(result.stale.observedAt) && JSON.stringify(viewer.model.projection.messages.map(message => message.id).sort()) === JSON.stringify(result.messageIds));
    const audit = await readRequests(gate.requestsFile); diagnosis.audit = audit;
    const allowed = audit.filter(entry => entry.status === 'allowed'), blocked = audit.filter(entry => entry.status === 'blocked');
    assertion('gate_blocked_at_least_two_export_attempts_without_running_ssh', blocked.length >= 2);
    assertion('initial_and_recovered_exports_used_the_allowed_ssh_route', allowed.length >= 2 && audit[0]?.status === 'allowed' && audit.at(-1)?.status === 'allowed');
    assertion('every_collection_attempt_has_a_fresh_protocol_nonce', new Set(audit.map(entry => entry.requestId)).size === audit.length);
    summary.observation = { initialAcceptedSnapshot: true, staleConfirmed: true, recoveredAcceptedSnapshot: true, logicalMessageCount: result.messageIds.length, selectedRemoteEvents: result.initial.events.length, allowedShimCalls: allowed.length, blockedShimCalls: blocked.length, auditSha256: createHash('sha256').update(await readFile(gate.requestsFile)).digest('hex') };
    await viewer.close(); viewer = null; await reader.close(); reader = null;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; pathChanged = false;
    await gate.dispose(); summary.cleanup.push({ target: 'observer-gate', closed: true });
    await stage('hashing_quiescent_sources_after_recovery');
    const after = { local: await readHash(localHashInvocation(), env), remote: await readHash(buildObserverHashInvocation(config), env) };
    diagnosis.hashManifests.after = after;
    assertion('local_state_bytes_unchanged_through_disconnect_and_recovery', JSON.stringify(before.local) === JSON.stringify(after.local));
    assertion('remote_state_bytes_unchanged_through_disconnect_and_recovery', JSON.stringify(before.remote) === JSON.stringify(after.remote));
    assertion('implementation_source_stable_during_acceptance', JSON.stringify(sourceFiles) === JSON.stringify(await sourceIdentity()));
    summary.hashedFiles = { local: Object.keys(before.local).length, remote: Object.keys(before.remote).length };
    summary.status = 'passed'; await stage('controlled_real_ssh_observer_recovery_completed');
  } catch (error) {
    if (viewer) diagnosis.failedObservation = { sources: viewer.model.sources, projection: viewer.model.projection };
    diagnosis.errors.push({ message: error.message, stack: error.stack }); summary.status = 'failed'; summary.failure = { category: cancelled ? 'cancelled' : 'observer-acceptance-failed', privateDiagnosisRetained: true };
  } finally {
    try { await viewer?.close(); await reader?.close(); summary.cleanup.push({ target: 'owned-viewer-and-collector', closed: true }); }
    catch (error) { diagnosis.errors.push({ phase: 'collector-cleanup', message: error.message }); summary.cleanup.push({ target: 'owned-viewer-and-collector', closed: false }); }
    if (gate) { try { await gate.dispose(); } catch (error) { diagnosis.errors.push({ phase: 'gate-cleanup', message: error.message }); summary.cleanup.push({ target: 'observer-gate', closed: false }); } }
    if (pathChanged) { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (summary.cleanup.some(item => item.closed === false)) summary.status = 'cleanup_failed';
    summary.finished_at = new Date().toISOString(); summary.elapsed_ms = Date.now() - started; await persist();
  }
  console.log(JSON.stringify({ status: summary.status, assertionsPassed: Object.values(summary.assertions).filter(Boolean).length, assertionsTotal: Object.keys(summary.assertions).length, modelCalls: 0, sanitizedMetrics: true }));
  if (summary.status !== 'passed') process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/vps-observer-integration.mjs --config /absolute/private/observer.json');
    console.log('Explicit v1 template: config/vps-observer.example.json. Requires existing quiescent local/remote communication state and exact node/room pins. Uses real scoped SSH observation, a private process-local gate to deny only export calls, last-good stale retention and fresh SSH recovery. Hashes both states with bounded O_RDONLY/O_NOFOLLOW file reads before and after; no models/native APIs, bridge mutation, network changes or global SSH changes. Public/private output directories must be fresh and named by the run ID. Private config belongs outside those directories.');
    return;
  }
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) throw new Error('Use one absolute explicit observer config.');
  const bytes = await readFile(args[1]); if (bytes.length > 64 * 1024) throw new Error('Observer config exceeds its limit.');
  await run(validateObserverConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
}
main().catch(() => { console.error('Observer acceptance could not start. Use --help, a complete private config and fresh run directories.'); process.exitCode = 1; });
