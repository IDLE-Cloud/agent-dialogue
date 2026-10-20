import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const operations = new Set(['lock-cli-fixture-root-protect', 'migration-files-fixture-root-protect']);
const codes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'E2BIG', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSYS', 'EINVAL', 'ETIMEDOUT', 'ESRCH', 'ECANCELED', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGHUP', 'SIGQUIT', 'SIGBREAK']);

/** Execution metadata only: code 0 still goes through the original ACL validator. */
export function sanitizeWindowsAclDiagnostic(operation, elapsedMs, value) {
  if (!operations.has(operation)) throw new Error('Invalid ACL fixture diagnostic operation.');
  const code = value?.code;
  return {
    operation,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : null,
    code: code === null || Number.isInteger(code) && code >= -2147483648 && code <= 4294967295 || codes.has(code) ? code : 'OTHER',
    signal: signals.has(value?.signal) ? value.signal : null,
    killed: value?.killed === true,
  };
}

/** Real execFile with the production nativeRunner options, without retry or
 * configurable execution/deadline seams. Never logs commands or error text. */
export function windowsAclDiagnosticRunner(context, operation) {
  if (typeof context?.diagnostic !== 'function' || !operations.has(operation)) throw new Error('Invalid ACL fixture diagnostic context.');
  return async (executable, args) => {
    const started = performance.now(); let result;
    try {
      result = await execute(executable, args, { windowsHide: true, timeout: 8000, maxBuffer: 65536, encoding: 'utf8' });
    } catch (error) {
      context.diagnostic(JSON.stringify(sanitizeWindowsAclDiagnostic(operation, performance.now() - started, error)));
      return { code: 1, stdout: '' };
    }
    context.diagnostic(JSON.stringify(sanitizeWindowsAclDiagnostic(operation, performance.now() - started, { code: 0, signal: null, killed: false })));
    return { code: 0, stdout: result.stdout };
  };
}
