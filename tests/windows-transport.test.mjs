import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTransport, exchange } from '../lib/node-transport.mjs';
import { ledgerBackend } from '../lib/paths.mjs';

const route = {
  kind: 'ssh', destination: 'win-frp', shell: 'powershell',
  executable: 'D:/Tools/node.exe', args: ['D:/Tools/app/bin/agent-dialogue.mjs'],
  stateDir: 'D:/Tools/state', opencodeV1ServiceFile: 'D:/Tools/service.json',
};

test('Windows native routing accepts only explicit PowerShell absolute paths', () => {
  const value = validateTransport(route);
  assert.equal(value.shell, 'powershell');
  assert.equal(value.opencodeV1ServiceFile, route.opencodeV1ServiceFile);
  for (const change of [{ shell: 'cmd' }, { executable: 'node.exe' }, { stateDir: 'D:relative' }, { executable: '/node' }]) {
    assert.throws(() => validateTransport({ ...route, ...change }));
  }
  assert.throws(() => validateTransport({ ...route, shell: undefined }));
});

test('Windows SSH command has fixed executable and paths, envelope stays in stdin', async () => {
  const envelope = { payload: { text: '中文 ; $(must remain data)' }, signature: 'signature' };
  const receipt = { payload: { status: 'stored' }, signature: 'reply' };
  let captured;
  const result = await exchange({ transport: route }, envelope, {
    runner: async (executable, args, options) => {
      captured = { executable, args, options };
      return { code: 0, stdout: JSON.stringify(receipt) };
    },
  });
  assert.deepEqual(result, receipt);
  assert.equal(captured.executable, 'ssh');
  assert.equal(captured.options.input, JSON.stringify(envelope) + '\n');
  const script = Buffer.from(captured.args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("$env:AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE='D:/Tools/service.json'"));
  assert.ok(script.includes("'node' 'receive'"));
  assert.equal(script.includes(envelope.payload.text), false);
});

test('Windows selects embedded ledger while existing POSIX defaults remain hcom', () => {
  assert.equal(ledgerBackend({}, 'win32'), 'embedded');
  assert.equal(ledgerBackend({}, 'darwin'), 'hcom');
  assert.equal(ledgerBackend({ AGENT_DIALOGUE_LEDGER: 'embedded' }, 'linux'), 'embedded');
  assert.throws(() => ledgerBackend({ AGENT_DIALOGUE_LEDGER: 'hcom' }, 'win32'), /Windows/);
  assert.throws(() => ledgerBackend({ AGENT_DIALOGUE_LEDGER: 'unknown' }, 'linux'), /ledger/i);
});

test('an explicit SSH config is controller-owned argv, never a remote environment value', async () => {
  let captured;
  await exchange({ transport: { ...route, sshConfig: '/tmp/private config' } }, { payload: {}, signature: 's' }, {
    runner: async (executable, args) => { captured = args; return { code: 0, stdout: '{"payload":{},"signature":"s"}' }; },
  });
  assert.deepEqual(captured.slice(0, 2), ['-F', '/tmp/private config']);
  assert.equal(captured.at(-1).includes('/tmp/private config'), false);
  assert.throws(() => validateTransport({ ...route, sshConfig: 'relative' }), /config/);
});
