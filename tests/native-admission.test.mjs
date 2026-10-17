import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, inputId } from '../lib/native-admission.mjs';

const binding = { id: 'b_fixed', revision: 1, sessionId: 'ses_existing' };

function fixture(overrides = {}) {
  const calls = [];
  const client = {
    prompt: async (session, body) => { calls.push(['prompt', session, body]); },
    inbox: async session => { calls.push(['inbox', session]); return []; },
    messages: async (session, options) => { calls.push(['messages', session, options]); return []; },
    ...overrides,
  };
  const args = { client, binding, eventId: 42, text: 'Review existing project context.', metadata: { room: 'r_existing' }, onPending: async pending => { calls.push(['persist', pending]); } };
  return { calls, client, args };
}

test('persists metadata before the sole exact-session POST, with deterministic input ID', async () => {
  const { calls, args } = fixture();
  const result = await admit(args), id = inputId(binding, 42);
  assert.deepEqual(result, { inputId: id, reconciled: false });
  assert.equal(calls[0][0], 'persist'); assert.equal(calls[1][0], 'prompt');
  assert.equal(calls[1][1], binding.sessionId);
  assert.deepEqual(calls[0][1], { eventId: 42, inputId: id, bindingRevision: 1, status: 'submitting' });
  assert.equal(calls[1][2].id, id); assert.equal(calls[1][2].text, args.text);
  assert.deepEqual(calls[1][2].metadata, args.metadata);
  assert.ok(!('text' in calls[0][1]));
  assert.equal(inputId(binding, '42'), id);
  assert.notEqual(inputId({ ...binding, revision: 2 }, 42), id);
  assert.notEqual(inputId({ ...binding, id: 'b_other' }, 42), id);
});

test('accepted POST with a disconnected response reconciles the durable inbox without a second POST', async () => {
  let posts = 0, reads = 0;
  const id = inputId(binding, 42);
  const { args } = fixture({
    prompt: async () => { posts++; throw new Error('response disconnected'); },
    inbox: async session => { reads++; assert.equal(session, binding.sessionId); return [{ id }]; },
    messages: async () => assert.fail('inbox evidence should suffice'),
  });
  assert.deepEqual(await admit(args), { inputId: id, reconciled: true });
  assert.equal(posts, 1); assert.equal(reads, 1);
});

test('pending restart reconciles projected native message shapes and never POSTs again', async () => {
  const id = inputId(binding, 42);
  for (const item of [{ id }, { info: { id } }, { message: { id } }]) {
    const { args, calls } = fixture({
      prompt: async () => assert.fail('pending must not POST'),
      messages: async (session, options) => { assert.equal(session, binding.sessionId); assert.equal(options.limit, 100); return [item]; },
    });
    const pending = { eventId: 42, inputId: id, bindingRevision: 1, status: 'submitting' };
    assert.deepEqual(await admit({ ...args, pending }), { inputId: id, reconciled: true });
    assert.ok(calls.every(call => call[0] !== 'persist'));
  }
});

test('unknown POST result and unavailable reconciliation preserve uncertainty', async () => {
  let posts = 0;
  const { args } = fixture({
    prompt: async () => { posts++; throw new Error('accepted response was lost'); },
    inbox: async () => { throw new Error('service temporarily down'); },
  });
  await assert.rejects(admit(args), error => error.uncertain === true && /outcome is unknown/.test(error.message));
  assert.equal(posts, 1);
  const pending = { eventId: 42, inputId: inputId(binding, 42) };
  await assert.rejects(admit({ ...args, pending }), error => error.uncertain === true);
  assert.equal(posts, 1, 'restart while service is unavailable must not duplicate the POST');
});

test('absent pending input, unrelated evidence, and stale pending generation all pause', async () => {
  const { args, calls } = fixture({
    prompt: async () => assert.fail('pending must not POST'),
    messages: async () => [{ id: 'msg_unrelated' }],
  });
  const pending = { eventId: 42, inputId: inputId(binding, 42) };
  for (const value of [pending, { ...pending, eventId: 43 }, { ...pending, inputId: 'msg_other' }, { ...pending, bindingRevision: 2 }]) {
    await assert.rejects(admit({ ...args, pending: value }), error => error.uncertain === true);
  }
  assert.ok(calls.every(call => call[0] !== 'persist'));
});

test('failed durable intent write never submits or reconciles an input', async () => {
  const { args, calls } = fixture();
  await assert.rejects(admit({ ...args, onPending: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.deepEqual(calls, []);
});

test('invalid control metadata and missing persistence callback fail before HTTP', async () => {
  const { args, calls } = fixture();
  for (const change of [
    { eventId: -1 }, { binding: { ...binding, revision: 0 } }, { binding: { ...binding, sessionId: '' } },
    { text: '' }, { metadata: [] }, { onPending: undefined },
  ]) await assert.rejects(admit({ ...args, ...change }));
  assert.deepEqual(calls, []);
});
