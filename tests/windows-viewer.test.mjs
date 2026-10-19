import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSshSource, fetchSshObservation } from '../lib/viewer/readers/ssh.mjs';
import { readViewerConfig, registerSources } from '../lib/viewer/config.mjs';
import { exportObservation } from '../lib/viewer/observation.mjs';
import { fixtureIDs, makeSources } from './fixtures/viewer-fixture.mjs';

const nonce = '0123456789abcdef0123456789abcdef';
function fixture() {
  const source = makeSources({ sealedManifest: true })[0];
  source.generation = '1'.repeat(32);
  const room = source.store.rooms[fixtureIDs.room];
  const spec = { kind: 'ssh', id: 'windows-source', label: 'Windows project', destination: 'win-frp', shell: 'powershell',
    executable: 'C:\\Agent Tools\\Node\\node.exe', cli: 'C:\\Agent Tools\\agent-dialogue\\bin\\agent-dialogue.mjs', stateDir: 'D:\\Agent State\\project',
    expectedNodeId: source.node.nodeId, rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] };
  return { source, spec };
}
function reply(source, input) { return { code: 0, stdout: Buffer.from(JSON.stringify(exportObservation(source, JSON.parse(input)))) }; }

test('Windows viewer source requires an explicit PowerShell shell and absolute Windows paths', () => {
  const { spec } = fixture();
  assert.deepEqual(validateSshSource(spec), spec);
  for (const shell of [true, 'cmd', 'bash', '', null]) assert.throws(() => validateSshSource({ ...spec, shell }));
  const noShell = { ...spec }; delete noShell.shell;
  assert.throws(() => validateSshSource(noShell), /paths|POSIX/i);
  for (const patch of [{ executable: 'node.exe' }, { cli: 'C:relative\\cli.mjs' }, { stateDir: '\\relative\\state' }, { stateDir: 'D:\\state\ncommand' }]) assert.throws(() => validateSshSource({ ...spec, ...patch }));
  const posix = { ...spec, shell: 'posix', executable: '/opt/node', cli: '/opt/cli.mjs', stateDir: '/srv/state' };
  assert.doesNotThrow(() => validateSshSource(posix));
});

test('Windows viewer command encodes fixed literal paths while room and identity travel only on stdin', async () => {
  const { source, spec } = fixture();
  const literal = { ...spec, cli: "C:\\Agent's Tools\\$(Write-Output BAD);literal\\cli.mjs", stateDir: "D:\\Project's State\\$(Write-Output BAD)" };
  let calls = 0;
  const result = await fetchSshObservation(literal, { requestId: nonce, runner: async (executable, args, options) => {
    calls++;
    assert.equal(executable, 'ssh');
    assert.deepEqual(args.slice(0, -1), ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', '-o', 'ClearAllForwardings=yes', '--', spec.destination]);
    const command = args.at(-1);
    assert.match(command, /^powershell(?:\.exe)? /i);
    assert.match(command, /-NoProfile/);
    assert.match(command, /-NonInteractive/);
    const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/i)?.[1];
    assert.ok(encoded);
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.ok(script.includes("C:\\Agent''s Tools\\$(Write-Output BAD);literal\\cli.mjs"));
    assert.ok(script.includes("D:\\Project''s State\\$(Write-Output BAD)"));
    assert.match(script, /'view-export'/);
    assert.match(script, /'--state-dir'/);
    for (const secret of [nonce, spec.expectedNodeId, spec.rooms[0].manifestHash, spec.rooms[0].id]) {
      assert.equal(command.includes(secret), false);
      assert.equal(script.includes(secret), false);
    }
    const request = JSON.parse(options.input);
    assert.equal(request.requestId, nonce);
    assert.equal(request.expectedNodeId, spec.expectedNodeId);
    assert.deepEqual(request.rooms, spec.rooms);
    return reply(source, options.input);
  } });
  assert.equal(calls, 1);
  assert.equal(result.available, true);
  assert.equal(result.node.nodeId, spec.expectedNodeId);
});

test('Windows viewer still rejects arbitrary command fields and out-of-scope responses before exposure', async () => {
  const { source, spec } = fixture();
  let calls = 0;
  for (const extra of [{ command: 'Get-Content secrets' }, { args: ['--all'] }, { sshOptions: ['-oStrictHostKeyChecking=no'] }, { env: { TOKEN: 'secret' } }]) {
    await assert.rejects(fetchSshObservation({ ...spec, ...extra }, { requestId: nonce, runner: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
  await assert.rejects(fetchSshObservation(spec, { requestId: nonce, runner: async (_, __, { input }) => {
    const request = JSON.parse(input), response = exportObservation(source, request);
    response.requestId = 'f'.repeat(32);
    return { code: 0, stdout: JSON.stringify(response) };
  } }), /invalid|out-of-scope/i);
});

test('viewer JSON configuration accepts only the optional shell addition and preserves fixed execution fields', async t => {
  const { spec } = fixture(), root = await mkdtemp(join(tmpdir(), 'ad-windows-viewer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'viewer.json');
  const { id, ...configured } = spec; void id;
  const save = row => writeFile(path, JSON.stringify({ version: 1, sources: [row] }));
  await save(configured);
  const read = await readViewerConfig(path);
  assert.equal(read[0].shell, 'powershell');
  assert.equal(read[0].stateDir, spec.stateDir);
  for (const extra of [{ shell: 'cmd' }, { args: [] }, { command: 'something' }, { authorization: 'secret' }]) {
    await save({ ...configured, ...extra });
    await assert.rejects(readViewerConfig(path), /Invalid viewer/i);
  }
});

test('viewer source identity pins its remote shell and equivalent default POSIX sources deduplicate', async () => {
  const { spec } = fixture();
  const powershell = await registerSources([spec]);
  const endpoint = JSON.stringify(['ssh', spec.destination, spec.stateDir, 'powershell']);
  const pinnedIdentity = `src_${createHash('sha256').update(JSON.stringify([endpoint, spec.expectedNodeId, spec.rooms])).digest('hex').slice(0, 24)}`;
  assert.equal(powershell[0].id, pinnedIdentity);
  const posix = { ...spec, executable: '/opt/node', cli: '/opt/cli.mjs', stateDir: '/srv/state' }; delete posix.shell;
  const explicitPosix = { ...posix, shell: 'posix' };
  const sources = await registerSources([posix, { ...posix, shell: 'powershell', executable: spec.executable, cli: spec.cli, stateDir: spec.stateDir }]);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].id, sources[1].id);
  assert.equal(powershell[0].shell, 'powershell');
  await assert.rejects(registerSources([posix, explicitPosix]), /same SSH source/i);
});
