import { ledger } from './bridge.mjs';

const fail = () => { throw Object.assign(new Error('Recovery ledger evidence is malformed or incomplete; no retry was authorized.'), { code: 'RECOVERY_EVIDENCE_INVALID' }); };

/** A match is usable only after the entire bounded suffix has been read.
 * No body-based deduplication, last-N uniqueness claim, or second append. */
export async function scanUniqueLedger(context, matcher, { ledgerImpl = ledger, maxEvents = 10000, pageSize = 1000, after = 0 } = {}) {
  if (typeof matcher !== 'function' || typeof ledgerImpl !== 'function' || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isSafeInteger(after) || after < 0) fail();
  let cursor = after, scanned = 0, found;
  for (;;) {
    // One look-ahead row is necessary to prove that exactly maxEvents ends.
    const remaining = maxEvents - scanned;
    const count = Math.min(pageSize, remaining + 1);
    const rows = await ledgerImpl(context, cursor, count);
    if (!Array.isArray(rows) || rows.length > count) fail();
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.id) || row.id <= cursor || row.type !== 'message' || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) fail();
      if (scanned === maxEvents) return { status: 'incomplete', scanned, complete: false };
      cursor = row.id; scanned++;
      if (await matcher(row)) {
        if (found) return { status: 'ambiguous', scanned, complete: false };
        found = row;
      }
    }
    if (rows.length < count) return { status: found ? 'unique' : 'absent', ...(found ? { event: found } : {}), scanned, complete: true };
  }
}
