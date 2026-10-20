import test from 'node:test';
import assert from 'node:assert/strict';
import * as lifecycle from '../lib/lifecycle.mjs';

test('pure migration transform returns a v4 copy and preserves unknown fields without mutating its source', () => {
  const source = { version: 2, bindings: {}, rooms: {}, lifecycle: {}, retained: { pending: ['original'] } };
  const before = structuredClone(source);
  const result = lifecycle.prepareControlUpgrade(source, 4);
  assert.deepEqual(source, before); assert.notEqual(result, source);
  assert.deepEqual(result, { ...source, version: 4, forwardings: {}, nativeIntents: {} });
  result.retained.pending.push('copy-only'); assert.deepEqual(source, before);
});
test('pure v3 transform preserves exact existing forwarding and MCP values', () => {
  const source = { version: 3, bindings: {}, rooms: {}, lifecycle: {}, forwardings: {}, mcpSends: {}, marker: 'original' };
  assert.deepEqual(lifecycle.prepareControlUpgrade(source, 4), { ...source, version: 4, nativeIntents: {} });
});
test('pure transform rejects legacy feature conflicts and downgrades before modifying input', () => {
  for (const source of [
    { version: 2, bindings: {}, rooms: {}, lifecycle: {}, nativeIntents: { unknown: true } },
    { version: 2, bindings: {}, rooms: {}, lifecycle: {}, forwardings: { unknown: true } },
  ]) {
    const before = structuredClone(source);
    assert.throws(() => lifecycle.prepareControlUpgrade(source, 4), { code: 'STATE_FEATURE_CONFLICT' });
    assert.deepEqual(source, before);
  }
  const v4 = { version: 4, bindings: {}, rooms: {}, lifecycle: {}, forwardings: {}, nativeIntents: {} };
  assert.throws(() => lifecycle.prepareControlUpgrade(v4, 3), { code: 'STATE_DOWNGRADE_UNSUPPORTED' });
  assert.throws(() => lifecycle.prepareControlUpgrade(v4, 5), { code: 'INVALID_UPGRADE_TARGET' });
});
test('pure transform validates input and preserves the existing default upgrade contract', () => {
  assert.throws(() => lifecycle.prepareControlUpgrade({ version: 99 }, 4));
  assert.deepEqual(lifecycle.prepareControlUpgrade({ version: 1, bindings: {}, rooms: {} }, 2), { version: 2, bindings: {}, rooms: {}, lifecycle: {} });
  const v4 = { version: 4, bindings: {}, rooms: {}, lifecycle: {}, forwardings: {}, nativeIntents: {} };
  assert.deepEqual(lifecycle.prepareControlUpgrade(v4, 4), v4);
});
