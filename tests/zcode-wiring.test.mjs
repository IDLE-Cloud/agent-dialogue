import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessId } from '../lib/adapters.mjs';
import { exchange, validateTransport } from '../lib/node-transport.mjs';
import { cliCommand } from '../lib/platform.mjs';
import { applyWindowsWorkerEnvironment } from '../lib/windows-worker.mjs';

test('ZCode has an explicit contextual tools adapter rather than a guessed CLI launch', () => {
  assert.equal(harnessId('zcode'), 'zcode-tools');
  assert.equal(harnessId('zcode-tools'), 'zcode-tools');
  assert.throws(() => harnessId('zcode-cli'), /Unsupported native harness/);
});

test('a remote ZCode service path remains on the receiving machine and message text stays on stdin', async () => {
  const route = { kind: 'ssh', destination: 'windows-peer', shell: 'powershell', executable: 'D:/Tools/node.exe', args: ['D:/Tools/agent-dialogue.mjs'], stateDir: 'D:/Tools/state', zcodeServiceFile: "D:/Tools/private/owner's zcode.json", ledgerBackend: 'embedded' };
  assert.equal(validateTransport(route).zcodeServiceFile, route.zcodeServiceFile);
  await exchange({ transport: route }, { payload: { text: 'body-only-on-stdin' }, signature: 'message' }, { runner: async (_exe, args, options) => {
    assert.equal(options.env.AGENT_DIALOGUE_ZCODE_SERVICE_FILE, route.zcodeServiceFile);
    assert.equal(args.join(' ').includes('body-only-on-stdin'), false);
    return { code: 0, stdout: JSON.stringify({ payload: { stored: true }, signature: 'receipt' }) };
  } });
  assert.throws(() => validateTransport({ ...route, zcodeServiceFile: 'relative.json' }), /absolute path/);
});

test('generated local commands preserve a selected ZCode service descriptor on either shell', () => {
  const context = { stateDir: '/private/state', env: { AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: '/private/zcode.json' } };
  for (const shell of ['posix', 'powershell']) assert.match(cliCommand(context, ['bindings'], { shell }), /AGENT_DIALOGUE_ZCODE_SERVICE_FILE/);
});

test('Windows workers retain the ZCode service selection without copying unrelated secrets', () => {
  const env = { SystemRoot: 'C:\\Windows', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: 'D:/old.json' };
  applyWindowsWorkerEnvironment({ AGENT_DIALOGUE_STATE_DIR: 'D:/state', AGENT_DIALOGUE_LEDGER: 'embedded', AGENT_DIALOGUE_ZCODE_SERVICE_FILE: 'D:/private/zcode.json' }, env);
  assert.equal(env.AGENT_DIALOGUE_ZCODE_SERVICE_FILE, 'D:/private/zcode.json');
});
