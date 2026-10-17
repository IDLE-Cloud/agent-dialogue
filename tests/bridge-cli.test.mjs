import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, PROJECT_DIR } from '../bin/agent-dialogue.mjs';

test('CLI loads optional bridge without an awaited import cycle or touching native services', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dialogue-bridge-cli-'));
  try {
    const result = await run(process.execPath, [join(PROJECT_DIR, 'bin/agent-dialogue.mjs'), 'bindings', '--json'], { env: { ...process.env, AGENT_DIALOGUE_STATE_DIR: state }, capture: true, timeout: 5000 });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { bindings: [], rooms: [] });
    assert.equal(result.stderr, '');
  } finally { await rm(state, { recursive: true, force: true }); }
});
