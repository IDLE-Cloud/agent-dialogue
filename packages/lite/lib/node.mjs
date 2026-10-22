import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeAdapter } from './adapters.mjs';

/** One connector per machine. The Hub alone owns messages and dispatch grants. */
export async function runNode({ client, port = 0, host = '127.0.0.1', pollMs = 25_000,
  adapterFactory, services = {}, toolConfigs = {}, cliPath, signal } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Node health listener must bind loopback.');
  if (!client || typeof client.request !== 'function' || !Number.isInteger(pollMs) || pollMs < 0 || pollMs > 25_000) throw new Error('Invalid Node client or polling interval.');
  const controller = new AbortController(), runId = randomUUID();
  const tasks = new Map(), adapters = new Map(), statuses = new Map();
  const blocked = new Set();
  let closing = false, connected = false;
  let statusVersion = 0, sentVersion = -1, lastHeartbeat = 0, sendingHeartbeat;
  const request = (method, path, body, options = {}) => client.request(method, path, body, { ...options, signal: controller.signal });
  const heartbeat = () => sendingHeartbeat ??= (async () => {
    const version = statusVersion;
    await request('POST', '/v1/node/heartbeat', { runId, statuses: [...statuses.values()] });
    sentVersion = version; lastHeartbeat = Date.now();
  })().finally(() => { sendingHeartbeat = null; });
  const state = (agentId, value, detail) => {
    const next = { agentId, state: value, ...(detail ? { detail } : {}), ...(value === 'blocked' ? { uncertain: true } : {}) };
    if (JSON.stringify(statuses.get(agentId)) !== JSON.stringify(next)) { statuses.set(agentId, next); statusVersion++; }
    if (value === 'blocked' && connected) void heartbeat().catch(() => { connected = false; });
  };
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, connected, activeChats: tasks.size, statuses: [...statuses.values()] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const url = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;

  async function dispatch(agent, item) {
    let grant;
    try {
      let adapter = adapters.get(agent.id);
      if (!adapter) { adapter = await (adapterFactory ? adapterFactory(agent) : nativeAdapter(agent, { services, toolConfigs, cliPath })); adapters.set(agent.id, adapter); }
      const readiness = await adapter.inspect();
      if (readiness?.state !== 'ready') {
        state(agent.id, readiness?.state === 'busy' ? 'busy' : 'unavailable'); return;
      }
      state(agent.id, 'ready');
      if (!item) return;
      if (controller.signal.aborted) return;
      let begin;
      try {
        begin = await request('POST', '/v1/deliveries/begin', { messageId: item.message.id, agentId: agent.id, runId });
        if (!begin || typeof begin.granted !== 'boolean' || begin.granted && (typeof begin.grant !== 'string' || !begin.grant)) throw new Error('Invalid dispatch grant response.');
      }
      catch {
        blocked.add(agent.id); state(agent.id, 'blocked', 'dispatch-begin-outcome-unknown'); return;
      }
      if (!begin.granted) return;
      grant = begin.grant;
      let deliveryState = 'delivered', detail;
      try { await adapter.submit(item.message); }
      catch (error) {
        deliveryState = error.notSubmitted && error.retryable ? 'queued' : error.notSubmitted ? 'failed' : 'unknown';
        detail = deliveryState === 'queued' ? 'native-busy-before-submit' : deliveryState === 'failed' ? 'native-preflight-rejected' : 'native-submission-outcome-unknown';
      }
      if (deliveryState === 'unknown') { blocked.add(agent.id); state(agent.id, 'blocked', detail); }
      else if (deliveryState === 'failed') state(agent.id, 'unavailable', detail);
      else if (deliveryState === 'queued') state(agent.id, 'busy', detail);
      try {
        await request('POST', '/v1/deliveries/result', { messageId: item.message.id, agentId: agent.id, grant, state: deliveryState,
          ...(deliveryState === 'queued' ? { notSubmitted: true } : {}), ...(detail ? { detail } : {}) });
      } catch {
        // The native action may have succeeded. Never request a fresh grant or resubmit it.
        blocked.add(agent.id); state(agent.id, 'blocked', 'dispatch-result-outcome-unknown');
      }
    } catch {
      if (grant) { blocked.add(agent.id); state(agent.id, 'blocked', 'native-submission-outcome-unknown'); }
      else state(agent.id, 'unavailable', 'native-session-unavailable-or-mismatched');
    }
  }

  const loop = (async () => {
    let firstPoll = true;
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        if (Date.now() - lastHeartbeat > 10_000 || sentVersion !== statusVersion) await heartbeat();
        connected = true;
        const result = await request('GET', `/v1/node/poll?waitMs=${firstPoll ? 0 : pollMs}`, undefined, { timeoutMs: pollMs + 5000 });
        firstPoll = false;
        const agents = new Map(result.agents.map(agent => [agent.id, agent]));
        for (const agent of agents.values()) if (agent.mode === 'tool-pull') state(agent.id, 'tool-pull');
        const pending = new Map();
        for (const item of result.deliveries) {
          const id = item.delivery.agentId ?? item.delivery.recipientAgentId;
          if (!pending.has(id)) pending.set(id, item);
        }
        for (const [id, agent] of agents) {
          if (agent.mode !== 'native-push' || tasks.has(id) || blocked.has(id)) continue;
          const task = dispatch(agent, pending.get(id)).finally(() => tasks.delete(id));
          tasks.set(id, task);
        }
      } catch { connected = false; }
      // Busy/offline queues may return immediately. Keep retries bounded without delaying other chats.
      const pause = connected ? Math.max(0, 250 - (Date.now() - started)) : 1000;
      if (pause) try { await sleep(pause, undefined, { signal: controller.signal }); } catch { /* closing */ }
    }
  })();

  async function close() {
    if (closing) return;
    closing = true; controller.abort(); signal?.removeEventListener('abort', stop);
    await loop;
    await Promise.allSettled(tasks.values());
    try { await client.request('POST', '/v1/node/heartbeat', { runId, statuses: [...statuses.values()] }, { timeoutMs: 2000 }); } catch { /* A later Node run also marks stranded work unknown. */ }
    // Native requests are bounded by their protocol client. New run heartbeat turns unfinished delivery into unknown.
    await new Promise(resolve => server.close(resolve));
  }
  const stop = () => { void close(); };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) void close();
  return { url, runId, close };
}
