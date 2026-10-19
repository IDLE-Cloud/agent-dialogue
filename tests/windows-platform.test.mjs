import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteRemotePath, powershellCommand, remoteProcessCommand, windowsProcessQuery } from '../lib/platform.mjs';

test('remote paths use the selected target shell, independent of controller OS', () => {
  assert.equal(absoluteRemotePath('D:/Tools/agent-dialogue/node.exe', 'powershell'), true);
  assert.equal(absoluteRemotePath('C:\\Program Files\\node.exe', 'powershell'), true);
  for (const bad of ['D:relative', '/tmp/node', '\\\\server\\share\\node.exe', 'node.exe', 'D:/x\nnode']) {
    assert.equal(absoluteRemotePath(bad, 'powershell'), false, bad);
  }
  assert.equal(absoluteRemotePath('/opt/node', 'posix'), true);
  assert.equal(absoluteRemotePath('D:/node.exe', 'posix'), false);
});

test('PowerShell transport uses encoded literal code and UTF-8 without a profile', () => {
  const command = remoteProcessCommand('D:/Tools/node.exe', ['D:/Tools/cli.mjs', 'node', 'receive'], {
    shell: 'powershell', env: { AGENT_DIALOGUE_STATE_DIR: "D:/a'b;$(bad)" },
  });
  assert.match(command, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("$env:AGENT_DIALOGUE_STATE_DIR='D:/a''b;$(bad)'"));
  assert.ok(script.includes("& 'D:/Tools/node.exe' 'D:/Tools/cli.mjs' 'node' 'receive'"));
  assert.ok(script.includes('[Console]::OutputEncoding'));
  assert.ok(script.endsWith('exit $LASTEXITCODE'));
});

test('POSIX transport retains literal quoting and rejects hostile environment names', () => {
  assert.equal(remoteProcessCommand('/opt/node', ['/opt/cli', 'node', 'receive'], {
    env: { AGENT_DIALOGUE_STATE_DIR: "/tmp/a'b" },
  }), "env AGENT_DIALOGUE_STATE_DIR='/tmp/a'\\''b' '/opt/node' '/opt/cli' 'node' 'receive'");
  assert.throws(() => remoteProcessCommand('/node', [], { env: { 'X;rm': 'x' } }), /environment/i);
  assert.throws(() => remoteProcessCommand('/node', ['x\0y']), /argument/i);
  assert.throws(() => remoteProcessCommand('/node', [], { shell: 'cmd' }), /shell/i);
  assert.throws(() => powershellCommand('x'.repeat(30000)), /limit/i);
});

test('Windows process ownership checks inspect one PID without interpolated code', () => {
  const query = windowsProcessQuery(1234);
  assert.equal(query.executable.toLowerCase().endsWith('powershell.exe'), true);
  assert.deepEqual(query.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(query.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('ProcessId=1234'));
  assert.throws(() => windowsProcessQuery('1234;exit'), /PID/);
  assert.throws(() => windowsProcessQuery(0), /PID/);
});
