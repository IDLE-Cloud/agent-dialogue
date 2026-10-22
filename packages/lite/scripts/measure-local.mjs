// Deterministic HTTP control-path sample; adapters are stubs, no model or remote host.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHub } from '../lib/hub.mjs';
import { runNode } from '../lib/node.mjs';
import { HubClient, newId } from '../lib/client.mjs';

const dir = await mkdtemp(join(tmpdir(), 'adl-measure-'));
const token = randomBytes(32).toString('base64url'), started = performance.now();
const hub = await startHub({ dbPath: join(dir, 'hub.sqlite'), adminToken: token });
const admin = new HubClient({ url: hub.url, token }), nodes = [], roles = [], calls = new Map();
const acceptanceMs = [], deliveryMs = [];
const percentile = (values, fraction) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length * fraction)-1];
try {
  const room = await admin.request('POST', '/v1/rooms', { label: 'controlled local sample' });
  for (const label of ['a','b']) {
    const { code } = await admin.request('POST', '/v1/enrollments', {});
    const enrolled = await new HubClient({ url: hub.url }).request('POST', '/v1/enroll', { code, label });
    const client = new HubClient({ url: hub.url, token: enrolled.token });
    const agent = await client.request('POST', '/v1/agents', { alias: label, harness: 'stub', mode: 'native-push',
      binding: { serviceIdentity: { serviceId: label, origin: 'http://127.0.0.1:1' }, sessionId: `ses_${label}`, projectDirectory: dir, projectId: 'sample' } });
    await admin.request('POST', '/v1/members', { room: room.id, agentId: agent.id });
    const scoped = await admin.request('POST', '/v1/scopes', { agentId: agent.id, rooms: [room.id] });
    roles.push({ client, scope: new HubClient({ url: hub.url, token: scoped.token }), agent });
  }
  for (const role of roles) nodes.push(await runNode({ client: role.client, adapterFactory: () => ({ inspect: async () => ({ state: 'ready' }), submit: async message => { calls.set(message.id, (calls.get(message.id) || 0) + 1); } }) }));
  const readyMs = performance.now() - started;
  let previous = null;
  for (let i=0;i<10;i++) {
    const self=roles[i%2], peer=roles[(i+1)%2], before=performance.now();
    const message = { id: newId(), room: room.id, to: [peer.agent.id], text: `controlled message ${i}`, replyTo: previous };
    const accepted = await self.scope.request('POST', '/v1/messages', message);
    acceptanceMs.push(performance.now()-before); assert.equal(accepted.accepted,true);
    const deadline=Date.now()+5000;
    for (;;) {
      const status=await self.scope.request('GET',`/v1/status?id=${message.id}`);
      if(status.deliveries[0].state==='delivered')break;
      assert.ok(Date.now()<deadline,'control path timeout'); await sleep(5);
    }
    deliveryMs.push(performance.now()-before); previous=message.id;
  }
  assert.equal(calls.size,10); assert.ok([...calls.values()].every(n=>n===1));
  const idleBefore=process.cpuUsage(); await sleep(1000); const idleCpu=process.cpuUsage(idleBefore);
  console.log(JSON.stringify({ schemaVersion:1, observedAt:new Date().toISOString(), status:'passed',nodeVersion:process.version,
    topology:{physicalHosts:1,nodeIdentities:2,nodeConnectors:2,hubProcesses:1,allInOneMeasurementProcess:true,nativeAdapter:'stub',modelCalls:0},
    samples:10,messages:10,replyLinks:9,duplicateNativeAttempts:0,readyMs,
    acceptedLatencyMs:{samples:acceptanceMs,p95:percentile(acceptanceMs,.95)},
    sendToDeliveredMs:{samples:deliveryMs,p95:percentile(deliveryMs,.95)},
    combinedProcess:{rssBytes:process.memoryUsage().rss,idleWindowMs:1000,idleCpuMs:(idleCpu.user+idleCpu.system)/1000},
    limitations:['small local controlled sample; no SLA','latency excludes real model execution','combined RSS is not per-service RSS','no remote physical hosts'] },null,2));
} finally { await Promise.all(nodes.map(n=>n.close())); await hub.close(); await rm(dir,{recursive:true,force:true}); }
