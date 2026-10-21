import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessId } from '../lib/adapters.mjs';
import { exchange, validateTransport } from '../lib/node-transport.mjs';
import { cliCommand } from '../lib/platform.mjs';
import { deliveryPrompt } from '../lib/bridge.mjs';
import { applyWindowsWorkerEnvironment } from '../lib/windows-worker.mjs';

test('Kimi native adapter has a distinct identity from legacy hcom launch', () => {
  assert.equal(harnessId('kimi'), 'kimi-code');
  assert.equal(harnessId('kimi-code'), 'kimi-code');
  assert.throws(() => harnessId('kimi-cli'), /Unsupported native harness/);
});

test('Kimi service descriptor follows the fixed peer route without moving its token', async () => {
  const response = { payload: { accepted: true }, signature: 'receipt' };
  const route = { kind: 'ssh', destination: 'project-server', executable: '/tools/node', args: ['/tools/agent-dialogue.mjs'], stateDir: '/private/state', kimiServiceFile: "/private/owner's kimi.json" };
  assert.equal(validateTransport(route).kimiServiceFile, route.kimiServiceFile);
  await exchange({ transport: route }, { payload: { text: 'project question' }, signature: 'message' }, { runner: async (_, args, options) => {
    assert.match(args.at(-1), /AGENT_DIALOGUE_KIMI_SERVICE_FILE='\/private\/owner'\\''s kimi\.json'/);
    assert.equal(options.env.AGENT_DIALOGUE_KIMI_SERVICE_FILE, route.kimiServiceFile);
    assert.equal(args.join(' ').includes('project question'), false);
    assert.equal(args.join(' ').includes('Bearer'), false);
    return { code: 0, stdout: JSON.stringify(response) };
  } });
  assert.throws(() => validateTransport({ ...route, kimiServiceFile: 'relative.json' }), /absolute path/);
});

test('generated Kimi shell commands carry the selected local descriptor on both platforms', () => {
  const context = { stateDir: '/private/state', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_KIMI_SERVICE_FILE: '/private/kimi.json' } };
  assert.match(cliCommand(context, ['bindings'], { shell: 'posix' }), /AGENT_DIALOGUE_KIMI_SERVICE_FILE='\/private\/kimi\.json'/);
  assert.match(cliCommand(context, ['bindings'], { shell: 'powershell' }), /\$env:AGENT_DIALOGUE_KIMI_SERVICE_FILE='\/private\/kimi\.json';/);
});

test('Kimi model replies enqueue locally and retain exact target session and global reply ID', () => {
  const result = deliveryPrompt({ stateDir: '/private/state', env: { AGENT_DIALOGUE_KIMI_SERVICE_FILE: '/private/kimi.json' } },
    { harness: 'kimi-code', commandShell: 'posix', alias: 'kimi-agent', sessionId: 'session_kimi' },
    { room: 'r_project', from: 'peer', text: 'Review this finding', globalMessageId: 'm_global' }, { id: 12 }, { sourceSession: 'ses_peer' });
  assert.match(result, /collab send --queue/);
  assert.match(result, /--expected-session 'ses_peer'/);
  assert.match(result, /--reply-to 'm_global'/);
});

test('Windows workers accept the selected Kimi descriptor path without changing OS context', () => {
  const env = { SystemRoot: 'C:\\Windows', AGENT_DIALOGUE_KIMI_SERVICE_FILE: 'D:/old/kimi.json', KIMI_SERVER_TOKEN: 'not-worker-config' };
  applyWindowsWorkerEnvironment({ AGENT_DIALOGUE_STATE_DIR: 'D:/state', AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_KIMI_SERVICE_FILE: 'D:/private/kimi.json' }, env);
  assert.equal(env.AGENT_DIALOGUE_KIMI_SERVICE_FILE, 'D:/private/kimi.json');
  assert.equal(env.SystemRoot, 'C:\\Windows');
});
