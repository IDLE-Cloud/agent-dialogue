import test from 'node:test';
import assert from 'node:assert/strict';
import { kimiOnceApproval, kimiAcceptanceAnswer, kimiAcceptanceRequest } from '../scripts/kimi-integration-contract.mjs';

const scope = { sessionId: 'session_owned', directory: '/project/test', commands: ["env NODE_ENV='test' /tools/node /tools/cli collab send --queue"] };
const request = { approval_id: 'approval_owned', session_id: scope.sessionId, agent_id: 'main', turn_id: 'turn_one', tool_call_id: 'call_one', tool_name: 'Bash', action: 'execute', tool_input_display: { kind: 'command', command: scope.commands[0], cwd: scope.directory, description: 'Send project result', language: 'bash' }, created_at: '2026-10-19T00:00:00Z', expires_at: '2026-10-20T00:00:00Z' };

test('an assistant mentioning a future completion marker does not complete acceptance', () => {
  assert.equal(kimiAcceptanceAnswer("Sent once. Awaiting the peer; then I will answer starting `FORWARD_DONE_win`.", 'FORWARD_DONE_win'), false);
  assert.equal(kimiAcceptanceAnswer('FORWARD_DONE_win: peer fact and prior context', 'FORWARD_DONE_win'), true);
  assert.equal(kimiAcceptanceAnswer('FORWARD_DONE_windows: another marker', 'FORWARD_DONE_win'), false);
});

test('global request detection uses the signed global parent rather than the empty local reply field', () => {
  const frame = { from: 'a', to: 'b', replyTo: null, wireEnvelope: { payload: { from: { alias: 'a' }, to: { alias: 'b' }, replyToMessageId: 'm_parent' } } };
  assert.equal(kimiAcceptanceRequest(frame, 'a', 'b'), false);
  frame.wireEnvelope.payload.replyToMessageId = null;
  assert.equal(kimiAcceptanceRequest(frame, 'a', 'b'), true);
  assert.equal(kimiAcceptanceRequest(frame, 'b', 'a'), false);
  assert.equal(kimiAcceptanceRequest({ from: 'a', to: 'b', replyTo: null }, 'a', 'b'), false);
});

test('owned Kimi acceptance grants one exact Bash command without remembering a session rule', () => {
  const reply = kimiOnceApproval(request, scope);
  assert.deepEqual(reply, { approvalId: request.approval_id, body: { decision: 'approved' } });
  assert.equal(Object.hasOwn(reply.body, 'scope'), false);
});

test('foreign Kimi chats, agents, tools and directories are never approved', () => {
  for (const patch of [{ session_id: 'session_foreign' }, { agent_id: 'other-agent' }, { tool_name: 'WriteFile' }, { tool_input_display: { ...request.tool_input_display, cwd: '/other' } }]) {
    assert.throws(() => kimiOnceApproval({ ...request, ...patch }, scope), /explicit|scope|match/i);
  }
});

test('Kimi acceptance command matching never trims, unwraps or evaluates a command', () => {
  for (const command of [scope.commands[0]+'; echo altered', ' '+scope.commands[0], 'bash -c '+JSON.stringify(scope.commands[0]), scope.commands[0]+'\n']) {
    assert.throws(() => kimiOnceApproval({ ...request, tool_input_display: { ...request.tool_input_display, command } }, scope));
  }
});

test('unknown display fields and plain text descriptions cannot authorize tool execution', () => {
  for (const display of [scope.commands[0], { ...request.tool_input_display, kind: 'text' }, { ...request.tool_input_display, extra_command: 'unexpected' }, { command: scope.commands[0] }]) {
    assert.throws(() => kimiOnceApproval({ ...request, tool_input_display: display }, scope));
  }
});

test('Windows Bash display paths compare using Windows rules while preserving literal command text', () => {
  const win = { ...scope, directory: 'D:/Projects/Test' };
  assert.ok(kimiOnceApproval({ ...request, tool_input_display: { ...request.tool_input_display, cwd: 'd:\\Projects\\Test' } }, win));
  assert.throws(() => kimiOnceApproval({ ...request, tool_input_display: { ...request.tool_input_display, cwd: 'D:/Other/Test' } }, win));
});

test('malformed approval and empty command scopes fail closed', () => {
  for (const patch of [{ approval_id: 'bad/id' }, { tool_call_id: '' }, { tool_input_display: null }, { surprise: true }]) assert.throws(() => kimiOnceApproval({ ...request, ...patch }, scope));
  assert.throws(() => kimiOnceApproval(request, { ...scope, commands: [] }));
});
