import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliFixture, mcpClient, hostMeta, toolValue, until } from './helpers/zcode-cli-fixture.mjs';

// Background-process ownership is exercised on POSIX only. Windows CI runs the
// separate real stdio/bootstrap/scope tests without starting scheduled workers.
test('POSIX CLI ZCode worker exposes tool-available, MCP records tool-read and detach stops only its owned worker', { skip: process.platform === 'win32' }, async t => {
  const f = await cliFixture(t, { cleanup: false });
  const aliases = ['worker-zcode-self', 'worker-zcode-peer'];
  let h;
  // Cleanup uses the exact fixture aliases through the production detach path.
  // Keep the temp tree for diagnosis if a worker cannot be proved stopped.
  t.after(async () => {
    if (h) await h.close();
    const status = await f.json(['bindings']);
    for (const binding of status.bindings) {
      if (!aliases.includes(binding.alias)) throw new Error('Unexpected binding in isolated worker fixture');
      if (binding.active) await f.json(['detach', binding.alias]);
    }
    await until(async () => {
      const final = await f.json(['bindings']);
      return final.bindings.every(binding => !binding.worker.running);
    }, { timeout: 12000, label: 'all exact owned workers to stop before deleting state' });
    await rm(f.temp, { recursive: true, force: true });
  });

  h = await mcpClient(t, f);
  const selfMeta = hostMeta('sess_worker_selected', f.directory);
  toolValue(await h.call('dialogue_identity', {}, selfMeta));
  toolValue(await h.call('dialogue_identity', {}, hostMeta('sess_worker_reference', f.directory)));
  await f.json(['setup']);
  const self = await f.json(['attach', 'zcode', '--session', 'sess_worker_selected', '--alias', aliases[0]]);
  const peer = await f.json(['attach', 'zcode', '--session', 'sess_worker_reference', '--alias', aliases[1]]);
  assert.equal(self.harness, 'zcode-tools'); assert.equal(peer.harness, 'zcode-tools');
  const initial = await f.json(['bindings']);
  const ownInitial = initial.bindings.find(b => b.alias === self.alias), referenceInitial = initial.bindings.find(b => b.alias === peer.alias);
  for (const binding of [ownInitial, referenceInitial]) {
    assert.equal(binding.worker.status, 'ready'); assert.equal(binding.worker.running, true);
    assert.ok(Number.isSafeInteger(binding.worker.pid)); assert.equal(typeof binding.worker.token, 'string');
  }
  assert.notEqual(ownInitial.worker.pid, referenceInitial.worker.pid);

  const room = await f.json(['room', 'create', '--name', 'Owned worker fixture', '--members', aliases.join(',')]);
  await f.json(['mcp-context', '--room', room.id, '--from', self.alias, '--to', peer.alias, '--output', f.scopeFile]);
  assert.equal(toolValue(await h.call('dialogue_context', {}, selfMeta)).self.sessionId, self.sessionId);
  const sent = await f.json(['collab', 'send', '--room', room.id, '--from', 'operator', '--to', self.alias, '--expected-session', self.sessionId, '--message', 'Synthetic project question for the tool inbox.']);
  assert.ok(Number.isSafeInteger(sent.event_id));
  const receipt = await until(async () => {
    const status = await f.json(['bindings']);
    return status.bindings.find(binding => binding.alias === self.alias).worker.receipts?.[sent.event_id];
  }, { label: 'tool inbox availability receipt' });
  assert.equal(receipt.status, 'tool-available'); assert.equal(receipt.sessionId, self.sessionId);
  assert.equal(receipt.inputId, undefined); assert.equal(receipt.nativeAdmitted, undefined);
  const runtime = JSON.parse(await readFile(join(f.context.stateDir, 'dialogue', `${self.id}.worker.json`), 'utf8'));
  assert.equal(runtime.pending, undefined);
  assert.equal(Object.values(runtime.receipts).some(item => item.status === 'admitted' || item.status === 'native-admitted'), false);

  const inbox = toolValue(await h.call('dialogue_inbox', { after: 0, limit: 10 }, selfMeta));
  assert.equal(inbox.messages.length, 1); assert.equal(inbox.messages[0].localEventId, sent.event_id);
  assert.equal(inbox.messages[0].from, 'operator'); assert.equal(inbox.messages[0].evidence, 'tool-read');
  assert.equal(inbox.nativeAdmitted, false); assert.equal(inbox.deliveryMode, 'tool-pull');
  const control = JSON.parse(await readFile(join(f.context.stateDir, 'dialogue', 'store.json'), 'utf8'));
  const read = control.toolReads[`${self.id}:${sent.event_id}`];
  assert.equal(read.status, 'tool-read'); assert.equal(read.sessionId, self.sessionId); assert.equal(read.inputId, undefined);
  assert.equal(toolValue(await h.call('dialogue_inbox', { after: inbox.nextCursor }, selfMeta)).messages.length, 0);

  const candidateFiles = (await readdir(f.service.runtimeDir)).filter(name => name.endsWith('.json')).sort();
  const candidateBytes = await Promise.all(candidateFiles.map(name => readFile(join(f.service.runtimeDir, name))));
  const descriptorBytes = await readFile(f.serviceFile);
  const detached = await f.json(['detach', self.alias]);
  assert.equal(detached.detached, true); assert.equal(detached.nativeSessionPreserved, true);
  const after = await until(async () => {
    const status = await f.json(['bindings']);
    const selected = status.bindings.find(b => b.alias === self.alias);
    return !selected.worker.running && selected.worker.status === 'stopped' ? status : null;
  }, { label: 'selected worker shutdown' });
  const referenceAfter = after.bindings.find(b => b.alias === peer.alias);
  assert.equal(referenceAfter.active, true); assert.equal(referenceAfter.worker.running, true);
  assert.equal(referenceAfter.worker.pid, referenceInitial.worker.pid); assert.equal(referenceAfter.worker.token, referenceInitial.worker.token);
  assert.equal((await h.call('dialogue_context', {}, selfMeta)).isError, true);
  assert.deepEqual(await readFile(f.serviceFile), descriptorBytes);
  for (const [index, name] of candidateFiles.entries()) assert.deepEqual(await readFile(join(f.service.runtimeDir, name)), candidateBytes[index], 'detach must preserve native candidate registration bytes');
  const candidates = await f.json(['sessions', 'zcode', '--cwd', f.directory]);
  assert.deepEqual(candidates.sessions.map(item => item.id).sort(), ['sess_worker_reference', 'sess_worker_selected']);
});
