import { lstat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'];
const unchanged = (a, b) => a === null && b === null || a !== null && b !== null && IDENTITY_FIELDS.every(key => a[key] === b[key]);
async function fingerprint(path, code, lstatImpl) {
  let info;
  try { info = await lstatImpl(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || IDENTITY_FIELDS.some(key => typeof info[key] !== 'bigint') || info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER) || info.dev < 0n || info.ino < 0n || info.mode < 0n) fail(code, 'Atomic publication requires unchanged regular files; evidence was retained.');
  // atime is intentionally excluded: concurrent snapshot readers may update it.
  // NTFS inode IDs may exceed Number precision; never coerce identity or clocks.
  return Object.fromEntries(IDENTITY_FIELDS.map(key => [key, info[key]]));
}

/** Publish one immutable temp under the caller's existing writer mutex.
 * Windows sharing/AV denials may be transient; never unlink the destination,
 * rebuild the temp, change ACLs, or retry another source/destination pair. */
export async function renameImmutable(source, destination, {
  platform = process.platform, renameImpl = rename, lstatImpl = lstat, timeoutMs = 1500,
  retryDelayMs = 20, maxAttempts = 80, now = () => performance.now(), wait = delay,
} = {}) {
  if (typeof source !== 'string' || !source || source.includes('\0') || typeof destination !== 'string' || !destination || destination.includes('\0') || resolve(source) === resolve(destination) || typeof renameImpl !== 'function' || typeof lstatImpl !== 'function' || typeof now !== 'function' || typeof wait !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5000 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 1000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000) fail('ATOMIC_RENAME_OPTIONS_INVALID', 'Invalid immutable publication options.');
  const expectedSource = await fingerprint(source, 'ATOMIC_RENAME_SOURCE_CHANGED', lstatImpl);
  const expectedDestination = await fingerprint(destination, 'ATOMIC_RENAME_DESTINATION_CHANGED', lstatImpl);
  if (!expectedSource) fail('ATOMIC_RENAME_SOURCE_CHANGED', 'Atomic publication source is missing; evidence was retained.');
  if (expectedDestination && expectedSource.dev === expectedDestination.dev && expectedSource.ino === expectedDestination.ino) fail('ATOMIC_RENAME_OPTIONS_INVALID', 'Atomic publication source and destination must be distinct files.');
  const started = now();
  if (!Number.isFinite(started)) fail('ATOMIC_RENAME_OPTIONS_INVALID', 'Invalid immutable publication clock.');
  const deadline = started + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const actualSource = await fingerprint(source, 'ATOMIC_RENAME_SOURCE_CHANGED', lstatImpl);
    if (!unchanged(expectedSource, actualSource)) fail('ATOMIC_RENAME_SOURCE_CHANGED', 'Atomic publication source changed; evidence was retained.');
    const actualDestination = await fingerprint(destination, 'ATOMIC_RENAME_DESTINATION_CHANGED', lstatImpl);
    if (!unchanged(expectedDestination, actualDestination)) fail('ATOMIC_RENAME_DESTINATION_CHANGED', 'Atomic publication destination changed; evidence was retained.');
    try { return await renameImpl(source, destination); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= maxAttempts || now() >= deadline) throw error;
      await wait(Math.min(retryDelayMs, Math.max(0, deadline - now())));
    }
  }
}
