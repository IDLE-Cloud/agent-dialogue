import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, PROJECT_DIR } from '../bin/agent-dialogue.mjs';

test('node CLI persists independent identities, exports only public data and pairs explicit cards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dialogue-node-cli-'));
  const cli = join(PROJECT_DIR, 'bin/agent-dialogue.mjs');
  const call = (role, args) => run(process.execPath, [cli, ...args], { env: { ...process.env, AGENT_DIALOGUE_STATE_DIR: join(root, role) }, capture: true, timeout: 5000 });
  try {
    const a = JSON.parse((await call('a', ['node', 'init', '--name', 'test-a'])).stdout);
    const b = JSON.parse((await call('b', ['node', 'init', '--name', 'test-b'])).stdout);
    assert.notEqual(a.nodeId, b.nodeId);
    const card = await call('b', ['node', 'export']);
    assert.equal(card.code, 0, card.stderr);
    assert.equal(card.stdout.includes('privateKey'), false);
    const path = join(root, 'b.json'); await writeFile(path, card.stdout);
    const paired = await call('a', ['node', 'peer', 'add', '--file', path, '--local', '--executable', process.execPath, '--cli', cli, '--state-dir', join(root, 'b')]);
    assert.equal(paired.code, 0, paired.stderr);
    const status = JSON.parse((await call('a', ['node', 'status'])).stdout);
    assert.equal(status.node.nodeId, a.nodeId);
    assert.deepEqual(status.peers, [{ nodeId: b.nodeId, name: 'test-b' }]);
    assert.deepEqual(status.inbox, {});
    assert.deepEqual(status.outbox, {});
    const persisted = JSON.parse(await readFile(join(root, 'a', 'dialogue', 'node.json'), 'utf8'));
    assert.ok(persisted.privateKey);
    assert.equal(JSON.stringify(status).includes(persisted.privateKey), false);
    const ambiguous = await call('a', ['node', 'peer', 'add', '--file', path, '--ssh', 'host', '--local']);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /exactly one transport/);
    const relative = await call('a', ['node', 'peer', 'add', '--file', path, '--ssh', 'host', '--executable', 'node', '--state-dir', '/tmp/test-state']);
    assert.equal(relative.code, 1);
    assert.match(relative.stderr, /absolute/);
    const unknown = await call('a', ['node', 'flush', '--message', 'm_not-a-uuid']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /exact global message ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
