import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWindowsAclDiagnostic } from './helpers/windows-acl-diagnostic.mjs';

test('ACL diagnostic preserves only bounded native result metadata for fixed fixture operations', () => {
  assert.deepEqual(sanitizeWindowsAclDiagnostic('lock-cli-fixture-root-protect', 8122.4, { code: null, signal: 'SIGTERM', killed: true }), {
    operation: 'lock-cli-fixture-root-protect', elapsedMs: 8122, code: null, signal: 'SIGTERM', killed: true,
  });
  assert.deepEqual(sanitizeWindowsAclDiagnostic('migration-files-fixture-root-protect', 12.6, { code: 1, signal: null, killed: false }), {
    operation: 'migration-files-fixture-root-protect', elapsedMs: 13, code: 1, signal: null, killed: false,
  });
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) assert.equal(sanitizeWindowsAclDiagnostic('lock-cli-fixture-root-protect', 0, { code }).code, code);
});

test('ACL diagnostic rejects unknown operation labels and cannot expose error content through metadata', () => {
  const secret = 'PRIVATE-CREDENTIAL-AND-PATH';
  const value = sanitizeWindowsAclDiagnostic('migration-files-fixture-root-protect', Number.NaN, {
    code: secret, signal: secret, killed: secret, stdout: secret, stderr: secret, message: secret, stack: secret, path: secret, args: [secret], ownerSid: secret,
  });
  assert.deepEqual(value, { operation: 'migration-files-fixture-root-protect', elapsedMs: null, code: 'OTHER', signal: null, killed: false });
  assert.equal(JSON.stringify(value).includes(secret), false);
  for (const code of [{ secret }, true, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) assert.equal(sanitizeWindowsAclDiagnostic('lock-cli-fixture-root-protect', 1, { code }).code, 'OTHER');
  assert.throws(() => sanitizeWindowsAclDiagnostic(secret, 1, {}), error => !error.message.includes(secret));
});
