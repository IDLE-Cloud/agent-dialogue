import { inspectBinding } from './adapters.mjs';
import { payloadHash } from './node-identity.mjs';
import { isAbsolute } from 'node:path';

const INPUT = /^msg_[A-Za-z0-9_-]+(?![\s\S])/;
const HASH = /^[0-9a-f]{64}(?![\s\S])/;
const BINDING = /^b_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const needsReview = reason => ({ status: 'needs-review', reason });

/** Independent positive proof for recovery. Unlike the legacy admission
 * reconciler, ID-only inbox/history projections never establish this result.
 * promptHash is the persisted canonical JSON-string hash of the full rendered
 * prompt; callers need not reconstruct old installation or environment paths. */
export async function nativeInputEvidence(client, binding, options = {}) {
  if (!object(options) || Object.keys(options).some(key => !['inputId', 'text', 'promptHash'].includes(key)) || typeof options.inputId !== 'string' || !INPUT.test(options.inputId) || typeof options.promptHash !== 'string' || !HASH.test(options.promptHash)) return needsReview('invalid-expectation');
  const { inputId, text, promptHash } = options;
  if (text !== undefined) {
    try { if (typeof text !== 'string' || !text.trim() || payloadHash(text) !== promptHash) return needsReview('invalid-expectation'); }
    catch { return needsReview('invalid-expectation'); }
  }
  if (!object(binding) || typeof binding.id !== 'string' || !BINDING.test(binding.id) || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || binding.remote || binding.active === false || typeof binding.projectId !== 'string' || !binding.projectId || typeof binding.directory !== 'string' || !isAbsolute(binding.directory) || typeof binding.sessionId !== 'string' || !binding.sessionId || typeof binding.serviceId !== 'string' || !binding.serviceId || typeof binding.origin !== 'string' || !binding.origin || client?.identity?.serviceId !== binding.serviceId || client?.identity?.origin !== binding.origin) return needsReview('binding-mismatch');
  if (typeof client.inputEvidence !== 'function') return needsReview('unsupported-adapter');
  let record;
  try {
    // Discovery and possible cold-session loading remain the operator caller's
    // explicit capability decision. This helper performs no mutation or retry.
    await inspectBinding(client, binding);
    record = await client.inputEvidence(binding.sessionId, inputId);
  } catch { return needsReview('native-unavailable'); }
  if (record === null) return needsReview('input-not-found');
  if (!exact(record, ['sessionId', 'inputId', 'role', 'text', 'storage']) || record.sessionId !== binding.sessionId || record.inputId !== inputId || record.role !== 'user' || record.storage !== 'persisted' || typeof record.text !== 'string' || !record.text.trim()) return needsReview('input-mismatch');
  try { if (payloadHash(record.text) !== promptHash || text !== undefined && record.text !== text) return needsReview('input-mismatch'); }
  catch { return needsReview('input-mismatch'); }
  return { status: 'verified', source: 'persisted-user-message', inputId, promptHash };
}
