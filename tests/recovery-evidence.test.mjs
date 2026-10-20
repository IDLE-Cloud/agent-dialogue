import test from 'node:test';
import assert from 'node:assert/strict';
import { scanUniqueLedger } from '../lib/recovery-evidence.mjs';

const row = (id, text = '') => ({ id, type: 'message', data: { text } });
const reader = rows => async (_, after, count) => rows.filter(row => row.id > after).slice(0, count);
test('recovery scans every bounded page and detects a duplicate beyond the last-N window', async () => {
  const rows = Array.from({ length: 1202 }, (_, i) => row(i + 1, [1, 1202].includes(i + 1) ? 'same-id' : 'other'));
  assert.equal((await scanUniqueLedger({}, r => r.data.text === 'same-id', { ledgerImpl: reader(rows), pageSize: 1000 })).status, 'ambiguous');
});
test('a single match is unique only after the complete suffix has been inspected', async () => {
  const rows = [row(2, 'match'), row(5), row(9)], calls = [];
  const result = await scanUniqueLedger({}, r => r.data.text === 'match', { pageSize: 2, ledgerImpl: async (...args) => { calls.push(args.slice(1)); return reader(rows)(...args); } });
  assert.equal(result.status, 'unique'); assert.equal(result.event.id, 2); assert.equal(result.scanned, 3); assert.equal(result.complete, true);
  assert.deepEqual(calls, [[0, 2], [5, 2]]);
});
test('a match before the scan budget does not turn a truncated history into proof', async () => {
  const result = await scanUniqueLedger({}, r => r.id === 1, { maxEvents: 2, pageSize: 2, ledgerImpl: reader([row(1), row(2), row(3)]) });
  assert.equal(result.status, 'incomplete'); assert.equal(result.complete, false); assert.equal(result.event, undefined);
});
test('exactly the maximum needs an empty look-ahead page and yields complete evidence', async () => {
  const result = await scanUniqueLedger({}, r => r.id === 1, { maxEvents: 2, pageSize: 2, ledgerImpl: reader([row(1), row(2)]) });
  assert.equal(result.status, 'unique'); assert.equal(result.scanned, 2); assert.equal(result.complete, true);
});
test('complete absence never authorizes append and malformed or nonincreasing pages fail closed', async () => {
  assert.equal((await scanUniqueLedger({}, () => false, { ledgerImpl: reader([row(1)]) })).status, 'absent');
  for (const rows of [[row(1), row(1)], [row(3), row(2)], [{ id: 1, type: 'other', data: {} }], [row(0)]]) {
    await assert.rejects(scanUniqueLedger({}, () => false, { ledgerImpl: async () => rows }), { code: 'RECOVERY_EVIDENCE_INVALID' });
  }
});
