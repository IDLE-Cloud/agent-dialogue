import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedCodexSeed } from '../scripts/vps-seed.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const inputId = `msg_${'2'.repeat(32)}`;
const marker = 'SYNTHETIC_CODEX_SEED_nonce';
function fixture() {
  return { threadId, inputId, marker, nativeStatus: 'idle',
    receipt: { id: inputId, sessionID: threadId, type: 'user', delivery: 'queue', execution: 'queued' },
    drain: { started: false, reason: 'not-ready' },
    messages: [
      { id: inputId, clientId: inputId, nativeId: 'native-user-uuid', sessionID: threadId, type: 'userMessage', turnId: 'seed-turn' },
      { id: 'native-agent-uuid', sessionID: threadId, type: 'agentMessage', turnId: 'seed-turn', text: marker },
    ],
  };
}

test('VPS seed accepts observed automatic execution when drain reports not-ready or empty', () => {
  assert.equal(verifiedCodexSeed(fixture()), true);
  const c = fixture(); c.drain = { started: false, reason: 'empty' };
  assert.equal(verifiedCodexSeed(c), true);
});

test('VPS seed also accepts explicitly drained execution of the same owned input', () => {
  const c = fixture(); c.drain = { started: true, inputId, turnId: 'seed-turn' };
  assert.equal(verifiedCodexSeed(c), true);
  c.drain.inputId = `msg_${'3'.repeat(32)}`;
  assert.equal(verifiedCodexSeed(c), false);
});

test('VPS seed requires one exact native client input and a matching completed turn response', () => {
  for (const mutate of [
    c => { c.receipt.id = 'other-input'; },
    c => { c.receipt.sessionID = 'other-thread'; },
    c => { c.messages[0].clientId = 'other-input'; },
    c => { delete c.messages[0].clientId; },
    c => { c.messages.push({ ...c.messages[0] }); },
    c => { c.messages[1].turnId = 'other-turn'; },
    c => { c.messages[1].text = 'unrelated'; },
    c => { c.nativeStatus = 'active'; },
    c => { c.messages[0].sessionID = 'other-thread'; },
  ]) {
    const c = fixture(); mutate(c); assert.equal(verifiedCodexSeed(c), false);
  }
});
