import test from 'node:test';
import assert from 'node:assert/strict';
import { inputId } from '../lib/native-admission.mjs';
import { ownedCodexActiveTurn } from '../scripts/vps-cleanup.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const binding = { id: 'b_22222222-2222-4222-8222-222222222222', revision: 2,
  harness: 'codex-app-server', sessionId: threadId };
const seedId = `msg_${'3'.repeat(32)}`;
const pendingId = inputId(binding, 42);
function fixture() {
  return { threadId, thread: { id: threadId, turns: [
    { id: 'turn-completed-seed', status: 'completed' }, { id: 'turn-active', status: 'inProgress' },
  ] }, inputIds: [seedId], binding: { ...binding },
  worker: { pending: { eventId: 42, inputId: pendingId, bindingRevision: 2, status: 'submitting' }, receipts: {} },
  messages: [
    { id: pendingId, turnId: 'turn-active', type: 'userMessage' },
    { id: seedId, turnId: 'turn-completed-seed', type: 'userMessage' },
  ] };
}

test('VPS Codex cleanup recognizes a deterministic pending admission before its receipt exists', () => {
  assert.deepEqual(ownedCodexActiveTurn(fixture()), { turnId: 'turn-active', inputId: pendingId });
});

test('VPS Codex cleanup recognizes exact admitted and explicitly submitted active inputs', () => {
  const admitted = fixture();
  admitted.worker = { receipts: { 42: { status: 'admitted', inputId: pendingId, sessionId: threadId } } };
  assert.deepEqual(ownedCodexActiveTurn(admitted), { turnId: 'turn-active', inputId: pendingId });
  const explicit = fixture(); explicit.worker = null; explicit.binding = null;
  explicit.inputIds.push(pendingId);
  assert.deepEqual(ownedCodexActiveTurn(explicit), { turnId: 'turn-active', inputId: pendingId });
});

test('VPS Codex cleanup never falls back to a completed owned seed when the active turn is unowned', () => {
  const c = fixture(); c.messages[0].id = `msg_${'4'.repeat(32)}`;
  assert.equal(ownedCodexActiveTurn(c), null);
  c.thread.turns[1].status = 'completed';
  assert.equal(ownedCodexActiveTurn(c), null);
});

test('VPS Codex cleanup rejects stale, mismatched or malformed pending ownership metadata', () => {
  for (const patch of [
    { eventId: 43 }, { inputId: seedId }, { bindingRevision: 1 }, { bindingRevision: undefined },
    { eventId: '42x' }, { eventId: -1 }, { eventId: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const c = fixture(); Object.assign(c.worker.pending, patch);
    assert.equal(ownedCodexActiveTurn(c), null);
  }
  for (const patch of [{ sessionId: 'other-thread' }, { harness: 'opencode' }, { revision: 1 }, { id: 'other-binding' }]) {
    const c = fixture(); Object.assign(c.binding, patch);
    assert.equal(ownedCodexActiveTurn(c), null);
  }
});

test('VPS Codex cleanup rejects unrelated or nonadmitted receipts', () => {
  for (const patch of [{ sessionId: 'other-thread' }, { status: 'rejected' }, { inputId: seedId }]) {
    const c = fixture(); c.worker = { receipts: { 42: { status: 'admitted', inputId: pendingId, sessionId: threadId, ...patch } } };
    assert.equal(ownedCodexActiveTurn(c), null);
  }
});

test('VPS Codex cleanup requires exactly one verified active turn in the selected thread', () => {
  for (const mutate of [
    c => { c.thread.id = 'other-thread'; },
    c => { delete c.thread.turns; },
    c => { c.thread.turns.push({ id: 'another-active', status: 'inProgress' }); },
    c => { c.messages[0].turnId = 'other-turn'; },
    c => { c.messages[0].type = 'agentMessage'; },
  ]) {
    const c = fixture(); mutate(c); assert.equal(ownedCodexActiveTurn(c), null);
  }
});

test('VPS Codex cleanup uses active turn clientId when the messages index has not caught up', () => {
  const c = fixture(); c.messages = [];
  c.thread.turns[1].items = [{ type: 'userMessage', id: 'native-generated-uuid', clientId: pendingId, content: [] }];
  assert.deepEqual(ownedCodexActiveTurn(c), { turnId: 'turn-active', inputId: pendingId });
});

test('VPS Codex cleanup preserves active turn inputs with missing, foreign or mixed ownership', () => {
  for (const items of [
    [{ type: 'userMessage', id: 'native-generated-uuid', content: [] }],
    [{ type: 'userMessage', id: 'native-generated-uuid', clientId: seedId + 'x', content: [] }],
    [{ type: 'userMessage', id: 'owned-native-uuid', clientId: pendingId },
      { type: 'userMessage', id: 'foreign-native-uuid', clientId: `msg_${'5'.repeat(32)}` }],
  ]) {
    const c = fixture(); c.thread.turns[1].items = items;
    assert.equal(ownedCodexActiveTurn(c), null);
  }
});
