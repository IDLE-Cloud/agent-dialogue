import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBinding, createRoom, decodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { initializeEmbedded } from '../lib/embedded-ledger.mjs';
import { createZCodeService, ZCodeToolsClient } from '../lib/zcode.mjs';
import { loadOrCreateNode, payloadHash } from '../lib/node-identity.mjs';
import { queueSubmission, decodeSubmission } from '../lib/submissions.mjs';
import { hcom, ledger, locked } from '../lib/bridge.mjs';
import { withDispatch, pauseBinding } from '../lib/lifecycle.mjs';
import * as nodes from '../lib/nodes.mjs';
import { forwardQueued, verifyForwardingEvidence, reconcileSubmission } from '../lib/recovery.mjs';
import { saveRuntime } from '../lib/bridge.mjs';

const meta = (id, directory) => {
  const value = { session_id:id,workspace_path:directory,runtime_scope:'main',client_mode:'desktop-continuous',delivery_kind:'desktop-continuous' };
  return {...value,'com.zcode/request-context':{...value}};
};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'ad-recovery-nodes-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'project');await mkdir(directory);
  const serviceFile=join(root,'private','zcode.json');await createZCodeService({path:serviceFile,directory,zcodeVersion:'3.14.3'});
  const client=await ZCodeToolsClient.discover({serviceFile});
  const make=async alias=>{
    const session=await client.register(meta(`sess_${alias}`,directory));
    const context={stateDir:join(root,alias),ledgerBackend:'embedded',env:{AGENT_DIALOGUE_LEDGER:'embedded',AGENT_DIALOGUE_ZCODE_SERVICE_FILE:serviceFile}};
    await initializeEmbedded(context);const node=await loadOrCreateNode(context);
    const binding=await withStore(context,store=>{const b=createBinding(store,{alias,harness:'zcode-tools',sessionId:session.id,projectId:session.projectID,directory,serviceId:client.identity.serviceId,origin:client.identity.origin});b.nodeId=node.nodeId;return b;});
    await hcom(context,['start','--name',binding.hcomName]);return {context,node,binding};
  };
  const a=await make('alice'),b=await make('bob');
  const transport=side=>({kind:'local-process',executable:process.execPath,args:[],stateDir:side.context.stateDir});
  await nodes.pairPeer(a.context,await nodes.exportNode(b.context),transport(b));await nodes.pairPeer(b.context,await nodes.exportNode(a.context),transport(a));
  let room=await withStore(a.context,store=>createRoom(store,{name:'Recovery fixture',members:['alice','bob']}));room=await nodes.sealRoom(a.context,room);await nodes.acceptRoom(b.context,await nodes.exportRoom(a.context,room.id));
  const options={room:room.id,from:'alice',to:'bob',expectedSession:b.binding.sessionId,text:'UNIQUE_RECOVERY_BODY',replyTo:null};
  const queued=await queueSubmission(a.context,options),submission=(await ledger(a.context)).find(event=>event.id===queued.event_id),request=decodeSubmission(submission.data.text);
  // Synthetic explicit offline v3 fixture: no old or native writer survives.
  const path=join(a.context.stateDir,'dialogue','store.json'),store=await readStore(a.context);
  Object.assign(store,{version:3,lifecycle:{},forwardings:{}});await writeFile(path,JSON.stringify(store,null,2)+'\n',{mode:0o600});
  const provenance={version:1,submissionId:request.id,submissionEventId:submission.id,submissionHash:payloadHash(request),dispatchId:randomUUID(),bindingId:a.binding.id,bindingRevision:a.binding.revision};
  const fixed={messageId:`m_${randomUUID()}`,createdAt:'2026-10-20T00:00:00.000Z',provenance};
  return {root,a,b,room,options,submission,request,provenance,fixed,path};
}
function forwarding(f, prepared, metadata) {
  return {version:1,submissionId:f.provenance.submissionId,submissionEventId:f.provenance.submissionEventId,submissionHash:f.provenance.submissionHash,bindingId:f.provenance.bindingId,bindingRevision:f.provenance.bindingRevision,roomId:f.room.id,routeHash:metadata.routeHash,kind:'remote',dispatchId:f.provenance.dispatchId,phase:'prepared',frameHash:payloadHash(decodeFrame(prepared.encoded)),formalEventId:null,result:null,createdAt:metadata.createdAt,messageId:metadata.messageId,payloadHash:metadata.payloadHash,recovery:null};
}
async function prepare(t) {
  const f=await fixture(t);let prepared,intent;
  await withDispatch(f.a.context,f.a.binding,async({permit})=>{
    prepared=await nodes.prepareRemoteForwarding(f.a.context,f.options,{...f.fixed,permit});
    intent=await locked(f.a.context,store=>{const metadata=nodes.buildRemoteForwarding(store,prepared);store.forwardings[f.request.id]=forwarding(f,prepared,metadata);return metadata;});
  });
  return {...f,prepared,intent};
}
function beforeAppend(f) { return (store,outbox)=>{
  const row=store.forwardings[f.request.id];assert.equal(row.phase,'prepared');assert.deepEqual(outbox.provenance,f.provenance);row.phase='append-started';
}; }

test('integrated v3 queue forwarding fixes one remote identity and verifies both actual embedded ledgers', async t => {
  const f = await fixture(t), state = { cursor: 0, receipts: {} }; let exchanges = 0;
  const result = await forwardQueued(f.a.context, f.a.binding, f.request, f.submission, state, {
    persist: async () => {}, flushImpl: (context, id, options) => nodes.flushMessage(context, id, { ...options, exchangeImpl: async (_, envelope) => { exchanges++; return nodes.receiveEnvelope(f.b.context, envelope); } }),
  });
  const row = (await readStore(f.a.context)).forwardings[f.request.id];
  assert.equal(row.phase, 'forwarded'); assert.equal(result.messageId, row.messageId); assert.equal(row.result.status, 'remote-stored');
  assert.equal(exchanges, 1); assert.equal((await ledger(f.a.context)).length, 2); assert.equal((await ledger(f.b.context)).length, 1);
  assert.equal((await verifyForwardingEvidence(f.a.context, f.a.binding, row)).status, 'verified');
  await forwardQueued(f.a.context, f.a.binding, f.request, f.submission, state, { persist: async () => assert.fail(), flushImpl: async () => assert.fail() });
});

test('integrated remote receipt loss keeps the same m, then evidence reconciliation repairs a stopped synthetic runtime', async t => {
  const f = await fixture(t), state = { cursor: 0, receipts: {} }; let exchanges = 0;
  await assert.rejects(forwardQueued(f.a.context, f.a.binding, f.request, f.submission, state, {
    persist: value => saveRuntime(f.a.context, f.a.binding.id, value),
    flushImpl: (context, id, options) => nodes.flushMessage(context, id, { ...options, exchangeImpl: async (_, envelope) => { exchanges++; await nodes.receiveEnvelope(f.b.context, envelope); throw Error('fixture lost receipt after remote storage'); } }),
  }), error => error.uncertain);
  let row = (await readStore(f.a.context)).forwardings[f.request.id]; const messageId = row.messageId;
  assert.equal(row.phase, 'local-stored'); assert.equal((await verifyForwardingEvidence(f.a.context, f.a.binding, row)).reason, 'remote-unconfirmed');
  await nodes.flushMessage(f.a.context, messageId, { exchangeImpl: async (_, envelope) => { exchanges++; return nodes.receiveEnvelope(f.b.context, envelope); } });
  state.pid = 912345; state.token = randomUUID(); state.status = 'error';
  await saveRuntime(f.a.context, f.a.binding.id, state);
  await locked(f.a.context, store => { store.workerLaunches = { [f.a.binding.id]: { version: 1, bindingRevision: 1, pid: state.pid, token: state.token, phase: 'stopped' } }; });
  await pauseBinding(f.a.context, 'alice');
  const result = await reconcileSubmission(f.a.context, 'alice', f.request.id, { probe: async () => 'confirmed-dead' });
  assert.equal(result.status, 'reconciled'); assert.equal(result.cursorPreserved, true); assert.equal(exchanges, 2);
  row = (await readStore(f.a.context)).forwardings[f.request.id];
  assert.equal(row.messageId, messageId); assert.equal(row.result.messageId, messageId); assert.equal(row.phase, 'forwarded');
  assert.equal((await ledger(f.a.context)).length, 2); assert.equal((await ledger(f.b.context)).length, 1);
});

test('remote q intent fixes m/time/hash and persists provenance with forwarding atomically without body or append',async t=>{
  const f=await prepare(t),store=await readStore(f.a.context),record=store.outbox[f.fixed.messageId];
  assert.equal(f.intent.messageId,f.fixed.messageId);assert.equal(f.intent.createdAt,f.fixed.createdAt);assert.deepEqual(record.provenance,f.provenance);
  assert.equal(record.dispatchPhase,'prepared');assert.equal(record.status,'preparing');assert.equal(record.eventId,undefined);
  assert.equal((await ledger(f.a.context)).length,1);assert.equal((await ledger(f.b.context)).length,0);
  assert.equal(JSON.stringify(store).includes('UNIQUE_RECOVERY_BODY'),false);assert.equal(JSON.stringify(store).includes('privateKey'),false);
  assert.deepEqual(Object.keys(f.prepared.envelope.payload).sort(),['type','version','messageId','roomId','roomRevision','manifestHash','from','to','text','replyToMessageId','createdAt'].sort());
});

test('one prepared-to-append-started claim appends once; a repeated call cannot append or exchange',async t=>{
  const f=await prepare(t);
  const result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)});
  assert.ok(Number.isSafeInteger(result.event_id));assert.equal(result.messageId,f.fixed.messageId);
  const rows=await ledger(f.a.context),event=rows.find(row=>row.id===result.event_id);assert.equal(rows.length,2);
  assert.equal((await nodes.verifyRemoteForwarding(f.a.context,f.intent,event)).event_id,event.id);
  assert.equal((await nodes.verifyRemoteForwarding(f.a.context,(await readStore(f.a.context)).forwardings[f.request.id],event)).event_id,event.id);
  await assert.rejects(nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)}));assert.equal((await ledger(f.a.context)).length,2);
  assert.equal((await ledger(f.b.context)).length,0);
});

test('append response loss retains fixed association and exact event can be verified without a second append',async t=>{
  const f=await prepare(t);let appends=0;
  await assert.rejects(nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f),hcomImpl:async(context,args)=>{
    const result=await hcom(context,args);if(args[0]==='send'){appends++;throw new Error('owned fixture lost append receipt');}return result;
  }}));
  const store=await readStore(f.a.context);assert.equal(store.forwardings[f.request.id].phase,'append-started');assert.equal(store.outbox[f.fixed.messageId].dispatchPhase,'append-started');
  const rows=await ledger(f.a.context),event=rows.find(row=>row.id!==f.submission.id);assert.equal(rows.length,2);
  await pauseBinding(f.a.context,'alice');
  const before=await readFile(f.path);assert.equal((await nodes.verifyRemoteForwarding(f.a.context,f.intent,event)).event_id,event.id);assert.deepEqual(await readFile(f.path),before);
  await assert.rejects(nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)}));assert.equal(appends,1);assert.equal((await ledger(f.a.context)).length,2);
});

test('concurrent remote append calls can claim only one ledger append',async t=>{
  const f=await prepare(t);
  const results=await Promise.allSettled([1,2].map(()=>nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
  assert.equal((await ledger(f.a.context)).length,2);
});

test('pause after durable preparation blocks claim and append while preserving its exact q/m metadata',async t=>{
  const f=await prepare(t);await pauseBinding(f.a.context,'alice');const before=await readFile(f.path);
  await assert.rejects(nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)}),{code:'BINDING_PAUSED'});
  await assert.rejects(nodes.prepareRemoteForwarding(f.a.context,f.options,f.fixed),{code:'BINDING_PAUSED'});
  assert.deepEqual(await readFile(f.path),before);assert.equal((await ledger(f.a.context)).length,1);
});

test('an async append-claim callback is rejected before durable phase transition or ledger append',async t=>{
  const f=await prepare(t),before=await readFile(f.path);
  await assert.rejects(nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:async(store)=>{store.forwardings[f.request.id].phase='append-started';}}));
  assert.deepEqual(await readFile(f.path),before);assert.equal((await ledger(f.a.context)).length,1);
});

test('remote formal-event verification checks complete frame, signature, sender kind, room, intent and exact recipient',async t=>{
  const f=await prepare(t),result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)}),event=(await ledger(f.a.context)).find(row=>row.id===result.event_id);
  for(const patch of [{from:'someone-else'},{sender_kind:'external'},{thread:'wrong-room'},{intent:'request'},{delivered_to:[]},{delivered_to:[...event.data.delivered_to,'other-endpoint']}]) {
    await assert.rejects(nodes.verifyRemoteForwarding(f.a.context,f.intent,{...event,data:{...event.data,...patch}}));
  }
  const frame=decodeFrame(event.data.text);frame.text='Changed local body';
  await assert.rejects(nodes.verifyRemoteForwarding(f.a.context,f.intent,{...event,data:{...event.data,text:'agent-dialogue/1\n'+JSON.stringify(frame)}}));
  const altered=structuredClone(f.intent);altered.provenance.dispatchId=randomUUID();await assert.rejects(nodes.verifyRemoteForwarding(f.a.context,altered,event));
});

test('remote preparation refuses stale q provenance and exact fixed IDs before any outbox intent',async t=>{
  const f=await fixture(t);
  for(const patch of [{submissionEventId:f.submission.id+1},{submissionHash:'f'.repeat(64)},{bindingId:f.b.binding.id},{submissionId:`q_${randomUUID()}`}]) {
    await assert.rejects(nodes.prepareRemoteForwarding(f.a.context,f.options,{...f.fixed,provenance:{...f.provenance,...patch}}));
  }
  for(const patch of [{messageId:'m_invalid'},{messageId:[f.fixed.messageId]},{createdAt:'2026-10-20'}])await assert.rejects(nodes.prepareRemoteForwarding(f.a.context,f.options,{...f.fixed,...patch}));
  assert.equal((await ledger(f.a.context)).length,1);assert.deepEqual((await readStore(f.a.context)).outbox??{},{});
});

test('exact m recovery scans beyond 1000 misleading rows and refuses an older/later duplicate before exchange',async t=>{
  const f=await prepare(t),result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)});
  const formal=(await ledger(f.a.context)).find(event=>event.id===result.event_id);
  function appendRows(data,count){
    const db=new DatabaseSync(join(f.a.context.stateDir,'hcom.db'));
    try{db.exec('BEGIN');const insert=db.prepare('INSERT INTO events(timestamp,type,data) VALUES(?,?,?)');for(let index=0;index<count;index++)insert.run(new Date().toISOString(),'message',JSON.stringify(data));db.exec('COMMIT');}finally{db.close();}
  }
  appendRows({...formal.data,text:`Unframed search decoy ${f.fixed.messageId}`},1001);
  await locked(f.a.context,store=>{delete store.outbox[f.fixed.messageId].eventId;});
  const recovered=await nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:(_peer,envelope)=>nodes.receiveEnvelope(f.b.context,envelope)});
  assert.equal(recovered.event_id,formal.id);assert.equal((await ledger(f.b.context)).length,1);
  appendRows(formal.data,1);
  await locked(f.a.context,store=>{delete store.outbox[f.fixed.messageId].eventId;});
  await assert.rejects(nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:()=>assert.fail('ambiguous source must not exchange')}),{code:'RECOVERY_EVIDENCE_INCOMPLETE'});
});

test('a same-m candidate with a different sender prevents false unique recovery before exchange',async t=>{
  const f=await prepare(t),result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)});
  const formal=(await ledger(f.a.context)).find(event=>event.id===result.event_id);
  const db=new DatabaseSync(join(f.a.context.stateDir,'hcom.db'));
  try{db.prepare('INSERT INTO events(timestamp,type,data) VALUES(?,?,?)').run(new Date().toISOString(),'message',JSON.stringify({...formal.data,from:'wrong-sender-same-global-id'}));}finally{db.close();}
  await locked(f.a.context,store=>{delete store.outbox[f.fixed.messageId].eventId;});
  const before=await readStore(f.a.context);let exchanges=0;
  await assert.rejects(nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:()=>{exchanges++;throw new Error('contradictory candidate must prevent exchange');}}),{code:'RECOVERY_EVIDENCE_INCOMPLETE'});
  assert.equal(exchanges,0);assert.deepEqual((await readStore(f.a.context)).outbox,before.outbox);assert.equal((await ledger(f.b.context)).length,0);
});

test('malformed same-m frames remain candidates rather than being filtered out of uniqueness evidence',async t=>{
  for(const change of [frame=>{frame.version=99;},frame=>{delete frame.globalMessageId;}]) {
    const f=await prepare(t),result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)});
    const formal=(await ledger(f.a.context)).find(event=>event.id===result.event_id),frame=decodeFrame(formal.data.text);change(frame);
    const db=new DatabaseSync(join(f.a.context.stateDir,'hcom.db'));
    try{db.prepare('INSERT INTO events(timestamp,type,data) VALUES(?,?,?)').run(new Date().toISOString(),'message',JSON.stringify({...formal.data,text:'agent-dialogue/1\n'+JSON.stringify(frame)}));}finally{db.close();}
    await locked(f.a.context,store=>{delete store.outbox[f.fixed.messageId].eventId;});let exchanges=0;
    await assert.rejects(nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:()=>{exchanges++;throw new Error('malformed candidate must prevent exchange');}}),{code:'RECOVERY_EVIDENCE_INCOMPLETE'});
    assert.equal(exchanges,0);assert.equal((await ledger(f.b.context)).length,0);
  }
});

test('remote reply preparation verifies signed parent content, exact parent identity and actual ingress metadata',async t=>{
  const f=await fixture(t);
  const parent=await nodes.sendRemote(f.b.context,{room:f.room.id,from:'bob',to:'alice',expectedSession:f.a.binding.sessionId,text:'Original parent project fact'},{exchangeImpl:(_peer,envelope)=>nodes.receiveEnvelope(f.a.context,envelope)});
  const options={...f.options,replyTo:parent.messageId},queued=await queueSubmission(f.a.context,options),events=await ledger(f.a.context);
  const submission=events.find(event=>event.id===queued.event_id),request=decodeSubmission(submission.data.text);
  const provenance={...f.provenance,submissionId:request.id,submissionEventId:submission.id,submissionHash:payloadHash(request),dispatchId:randomUUID()};
  const allocation={...f.fixed,provenance},parentRecord=(await readStore(f.a.context)).inbox[parent.messageId],event=events.find(event=>event.id===parentRecord.eventId);
  assert.equal((await nodes.prepareRemoteForwarding(f.a.context,options,allocation)).parentId,parent.messageId);
  const db=new DatabaseSync(join(f.a.context.stateDir,'hcom.db'));
  try{
    const update=db.prepare('UPDATE events SET data=? WHERE id=?');
    const changes=[
      data=>{const frame=decodeFrame(data.text);frame.wireEnvelope.payload.text='Tampered signed parent content';data.text='agent-dialogue/1\n'+JSON.stringify(frame);},
      data=>{const frame=decodeFrame(data.text);frame.globalMessageId=`m_${randomUUID()}`;data.text='agent-dialogue/1\n'+JSON.stringify(frame);},
      data=>{data.from='wrong-ingress-sender';},data=>{data.sender_kind='instance';},
      data=>{data.thread='wrong-parent-room';},data=>{data.intent='request';},
      data=>{data.delivered_to=[...data.delivered_to,'another-endpoint'];},
    ];
    for(const change of changes){
      const data=structuredClone(event.data);change(data);update.run(JSON.stringify(data),event.id);
      await assert.rejects(nodes.prepareRemoteForwarding(f.a.context,options,allocation));
      update.run(JSON.stringify(event.data),event.id);
    }
  }finally{db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(event.data),event.id);db.close();}
  assert.equal((await nodes.prepareRemoteForwarding(f.a.context,options,allocation)).parentId,parent.messageId);
  assert.deepEqual((await readStore(f.a.context)).outbox??{},{});
});

test('restoring a missing outbox event ID preserves unknown and confirmed remote evidence through failed retries',async t=>{
  for(const status of ['unknown','remote-stored']) {
    const f=await prepare(t),result=await nodes.appendRemoteForwarding(f.a.context,f.prepared,{beforeAppend:beforeAppend(f)});
    if(status==='unknown')await assert.rejects(nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:()=>{throw new Error('initial uncertain transport');}}));
    else await nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:(_peer,envelope)=>nodes.receiveEnvelope(f.b.context,envelope)});
    await locked(f.a.context,store=>{assert.equal(store.outbox[f.fixed.messageId].status,status);delete store.outbox[f.fixed.messageId].eventId;});
    const before=(await readStore(f.a.context)).outbox[f.fixed.messageId];let during;
    await assert.rejects(nodes.flushMessage(f.a.context,f.fixed.messageId,{exchangeImpl:async()=>{during=(await readStore(f.a.context)).outbox[f.fixed.messageId].status;throw new Error('retry transport remains unavailable');}}));
    const after=(await readStore(f.a.context)).outbox[f.fixed.messageId];
    assert.equal(during,status);assert.deepEqual(after,{...before,eventId:result.event_id});
    assert.equal(after.status,status);if(status==='remote-stored')assert.equal(after.remoteEventId,before.remoteEventId);
  }
});
