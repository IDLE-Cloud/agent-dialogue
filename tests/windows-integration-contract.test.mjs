import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWindowsAcceptanceCommand, permittedWindowsPermission, onceWindowsPermissionReply, hasZeroCostV1Model, selectZeroCostV1Model, publicWindowsMetrics } from '../scripts/windows-integration-contract.mjs';

const sessionId = 'ses_owned123';
const command = "$env:AGENT_DIALOGUE_STATE_DIR='C:/owned/state';\n& 'C:/owned/node.exe' 'C:/owned/cli.mjs' collab send --room 'r_fixture' --message 'reply fixture'";
const pattern = "& 'C:/owned/node.exe' 'C:/owned/cli.mjs' collab send --room 'r_fixture' --message 'reply fixture'";
const scope = { sessionId, commands: [{ command, patterns: [pattern] }] };
const permission = () => ({ id: 'per_request123', sessionID: sessionId, permission: 'bash', patterns: [pattern], metadata: { command }, always: ['& *'], tool: { messageID: 'msg_assistant123', callID: 'call_owned123' } });
const zero = () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } });
const model = () => ({ id: 'free-model', providerID: 'opencode', status: 'active', cost: { ...zero(), tiers: [{ ...zero(), tier: { type: 'context', size: 200000 } }], experimentalOver200K: zero() } });
const catalog = () => ({ all: [{ id: 'opencode', models: { 'free-model': model() } }], connected: ['opencode'], default: { opencode: 'free-model' } });

test('normalization changes only CRLF, preserving exact whitespace and wrappers', () => {
  assert.equal(normalizeWindowsAcceptanceCommand('  command\r\nnext\r\n'), '  command\nnext\n');
  assert.equal(normalizeWindowsAcceptanceCommand('powershell -Command "command"'), 'powershell -Command "command"');
  for (const input of ['', ' ', 'a\rb', 'a\0b', null, { command }]) assert.throws(() => normalizeWindowsAcceptanceCommand(input), /Invalid/);
});

test('permission once gate accepts only owner command, owned native session and exact patterns', () => {
  assert.equal(permittedWindowsPermission(permission(), scope), true);
  const windows = permission(); windows.metadata.command = command.replaceAll('\n', '\r\n');
  assert.equal(permittedWindowsPermission(windows, scope), true);
  assert.deepEqual(onceWindowsPermissionReply(windows, scope), { requestId: 'per_request123', body: { reply: 'once' } });
});

test('permission gate rejects other native sessions, other permission types and malformed requests', () => {
  for (const delta of [{ sessionID: 'ses_foreign' }, { sessionID: '' }, { permission: 'external_directory' }, { permission: 'edit' }, { id: 'per_bad/slash' }, { metadata: [] }, { patterns: [] }, { always: undefined }, { unknown: 'field' }]) {
    assert.equal(permittedWindowsPermission({ ...permission(), ...delta }, scope), false);
  }
  for (const delta of [{ metadata: { command, directories: ['C:/Other'] } }, { tool: { messageID: 'msg_wrong/session', callID: 'call' } }, { tool: { messageID: 'msg_assistant123', callID: '' } }]) assert.equal(permittedWindowsPermission({ ...permission(), ...delta }, scope), false);
});

test('permission gate never trims, unwraps, expands, reorders or appends commands', () => {
  for (const changed of [` ${command}`, `${command}\n`, `${command}; Get-Content secret`, `powershell -Command ${JSON.stringify(command)}`, command.replace('reply fixture', 'other reply'), command.replaceAll("'", '"'), command.replace('C:/owned', 'C:/other')]) {
    const request = permission(); request.metadata.command = changed;
    assert.equal(permittedWindowsPermission(request, scope), false);
  }
});

test('permission gate requires exact native pattern set without extra, broad or duplicate patterns', () => {
  for (const patterns of [[pattern, 'Get-Content *'], ['*'], [pattern, pattern], [pattern.replace('owned', 'other')], [' ' + pattern]]) assert.equal(permittedWindowsPermission({ ...permission(), patterns }, scope), false);
  assert.equal(permittedWindowsPermission(permission(), { sessionId, commands: [command] }), false);
  assert.equal(permittedWindowsPermission(permission(), { sessionId, commands: [{ command, patterns: [] }] }), false);
});

test('once reply ignores native always suggestions and refuses a nonmatching request', () => {
  const request = permission(); request.always = ['*', 'arbitrary prefix *'];
  assert.deepEqual(onceWindowsPermissionReply(request, scope).body, { reply: 'once' });
  request.sessionID = 'ses_foreign';
  assert.throws(() => onceWindowsPermissionReply(request, scope), error => !error.message.includes('ses_foreign'));
});

test('V1 zero cost checks base, every context tier and experimental over-200k costs', () => {
  assert.equal(hasZeroCostV1Model(model()), true);
  for (const key of ['input', 'output']) for (const section of ['base', 'tier', 'over']) {
    const value = model(), price = section === 'base' ? value.cost : section === 'tier' ? value.cost.tiers[0] : value.cost.experimentalOver200K;
    price[key] = 0.001; assert.equal(hasZeroCostV1Model(value), false);
  }
  for (const key of ['read', 'write']) for (const section of ['base', 'tier', 'over']) {
    const value = model(), price = section === 'base' ? value.cost : section === 'tier' ? value.cost.tiers[0] : value.cost.experimentalOver200K;
    price.cache[key] = 1; assert.equal(hasZeroCostV1Model(value), false);
  }
});

test('V1 zero cost refuses omitted, string, nonfinite and unexpected cost representations', () => {
  for (const cost of [undefined, [], { input: 0, output: 0 }, { ...zero(), input: '0' }, { ...zero(), output: NaN }, { ...zero(), cache: { read: 0 } }, { ...zero(), tiers: null }, { ...zero(), experimentalOver200K: null }, { ...zero(), reasoning: 1 }]) assert.equal(hasZeroCostV1Model({ ...model(), cost }), false);
  assert.equal(hasZeroCostV1Model({ ...model(), status: 'deprecated' }), false);
});

test('model selection requires exact connected provider and exact native model identity', () => {
  const result = selectZeroCostV1Model(catalog(), { providerID: 'opencode', modelID: 'free-model' });
  assert.equal(result.id, 'free-model');
  for (const mutate of [value => { value.connected = []; }, value => { value.all[0].models['free-model'].id = 'different'; }, value => { value.all[0].models['free-model'].providerID = 'other'; }, value => { value.all.push(structuredClone(value.all[0])); }, value => { value.all[0].models['free-model'].cost.cache.write = 1; }]) {
    const value = catalog(); mutate(value);
    assert.throws(() => selectZeroCostV1Model(value, { providerID: 'opencode', modelID: 'free-model' }), /zero.cost|catalog/);
  }
});

test('public metrics project only fixed facts and counts, never sessions, commands or arbitrary diagnostics', () => {
  const input = { runId: 'windows-integration-20261019-v1', status: 'passed', startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:01:00.000Z',
    versions: { node: 'v24.22.0', opencode: '1.19.0', path: 'C:/private/node.exe' }, checks: { first: true, second: true },
    permissions: { once: 2, rejected: 0, foreignIgnored: 1, password: 'private-password' }, zeroCostVerified: true,
    sessionId: 'ses_private', password: 'private-password', command, diagnostics: { path: 'C:/private/secret' } };
  const output = publicWindowsMetrics(input), serialized = JSON.stringify(output);
  assert.deepEqual(output.checks, { total: 2, passed: 2, failed: 0 });
  assert.equal(output.status, 'passed');
  for (const secret of ['ses_private', 'private-password', 'C:/private', 'AGENT_DIALOGUE_STATE_DIR', 'diagnostics']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(output.permissions, { once: 2, rejected: 0, foreign_ignored: 1 });
});

test('public metrics reject invalid run identifiers, misleading success and arbitrary string checks', () => {
  const input = { runId: 'windows-integration-20261019-v1', status: 'running', startedAt: '2026-10-19T00:00:00.000Z', versions: { node: 'v24.22.0', opencode: '1.19.0' }, checks: {}, permissions: { once: 0, rejected: 0, foreignIgnored: 0 }, zeroCostVerified: false };
  assert.equal(publicWindowsMetrics(input).finished_at, null);
  for (const delta of [{ runId: 'ses_private' }, { runId: 'windows-integration-20260230-v1' }, { checks: { secret: 'ses_private' } }, { status: 'passed' }, { versions: { node: 'C:/private/node', opencode: '1.19.0' } }, { permissions: { once: -1, rejected: 0, foreignIgnored: 0 } }]) assert.throws(() => publicWindowsMetrics({ ...input, ...delta }), /Invalid|passed/);
});
