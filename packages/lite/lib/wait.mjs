import { setTimeout as delay } from 'node:timers/promises';

const pause = (ms, signal) => delay(ms, undefined, { signal });

/** Wait for mail in an assigned scope; reading is not evidence of task execution. */
export async function waitForInbox({ client, after = 0, limit = 10, signal, sleep = pause } = {}) {
  if (!client || typeof client.request !== 'function') throw new Error('A Hub client is required.');
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid inbox pagination.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid wait cancellation signal.');
  if (typeof sleep !== 'function') throw new Error('Invalid wait backoff.');
  const path = `/v1/inbox?${new URLSearchParams({ after: String(after), limit: String(limit), waitMs: '25000' })}`;
  let backoff = 1000;
  while (true) {
    signal?.throwIfAborted();
    const started = performance.now();
    try {
      const result = await client.request('GET', path, undefined, { signal, timeoutMs: 30_000 });
      signal?.throwIfAborted();
      if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.cursor) || result.cursor < after) throw new Error('Invalid Hub inbox response.');
      backoff = 1000;
      if (result.items.length) return result;
      // Empty long-poll replies do not complete the waiter or advance its cursor.
      // Older Hubs ignore waitMs. Bound empty polling even when the server
      // immediately replies, while a normal long poll adds no further delay.
      const remaining = Math.ceil(1000 - (performance.now() - started));
      if (remaining > 0) await sleep(remaining, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const status = error?.status ?? 0;
      if (status && status !== 408 && status !== 429 && !(status >= 500 && status <= 599)) throw error;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
