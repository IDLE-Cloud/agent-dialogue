import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, decodeFrame, encodeFrame, readStore, withStore } from '../lib/bridge-store.mjs';
import { loadOrCreateNode, payloadHash, signObject, verifyObject } from '../lib/node-identity.mjs';
import { acceptRoom, exportNode, exportRoom, flushMessage, nodeStatus, pairPeer, receiveEnvelope, sealRoom, sendRemote, validateIngress } from '../lib/nodes.mjs';

// A process boundary like the real CLI, with an independent ledger per HCOM_DIR.
// Failure injection persists the append but drops the response, never a model call.
const FAKE_HCOM = `#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2), dir=process.env.HCOM_DIR, path=join(dir,'fake-hcom.json');
await mkdir(dir,{recursive:true});
let db;try{db=JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;db={events:[],names:[],faulted:false}}
const value=flag=>args[args.indexOf(flag)+1];
const save=()=>writeFile(path,JSON.stringify(db));
if(args[0]==='start') {const n=value('--name');if(!db.names.includes(n))db.names.push(n);await save();console.log(JSON.stringify({name:n}));}
else if(args[0]==='send') {
 const sender=args.includes('--from')?value('--from'):value('--name');
 const target=args.find(a=>a.startsWith('@')).slice(1), text=args[args.indexOf('--')+1];
 const event={id:db.events.length+1,type:'message',data:{from:sender,text,thread:value('--thread'),delivered_to:[target],sender_kind:args.includes('--name')?'instance':'external'}};
 db.events.push(event);
 const fault=process.env.FAKE_HCOM_FAIL_SEND_AFTER_APPEND==='1'&&!db.faulted;if(fault)db.faulted=true;
 await save();if(fault){process.stderr.write('Injected response loss');process.exit(9)}
 console.log(JSON.stringify({event_id:event.id}));
} else if(args[0]==='events') {
 let events=db.events;
 const sql=args.includes('--sql')?value('--sql'):'';
 const id=sql.match(/^id = (\\d+)$/);if(id)events=events.filter(e=>e.id===Number(id[1]));
 const message=sql.match(/msg_text LIKE '%([^']+)%'/);if(message)events=events.filter(e=>e.data.text.includes(message[1]));
 const after=sql.match(/id > (\\d+)/);if(after)events=events.filter(e=>e.id>Number(after[1]));
 const last=args.includes('--last')?Number(value('--last')):events.length;
 events=events.slice(-last);for(const e of events)console.log(JSON.stringify(e));
} else {process.stderr.write('Unsupported fake hcom command');process.exit(8)}
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-nodes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-hcom.mjs'); await writeFile(binary, FAKE_HCOM); await chmod(binary, 0o700);
  const context = name => ({ stateDir: join(root, name), binary, env: { ...process.env, HCOM_DIR: join(root, name) } });
  const a = context('alpha'), b = context('beta');
  await mkdir(a.stateDir); await mkdir(b.stateDir);
  const input = alias => ({ alias, harness: 'opencode-v2', sessionId: `ses_${alias}`, projectId: `project-${alias}`, directory: '/work/project', serviceId: `native-${alias}`, origin: 'http://127.0.0.1:9876' });
  const alice = await withStore(a, store => createBinding(store, input('alice')));
  const bob = await withStore(b, store => createBinding(store, input('bob')));
  const nodeA = await loadOrCreateNode(a, { name: 'alpha' }), nodeB = await loadOrCreateNode(b, { name: 'beta' });
  const cardA = await exportNode(a), cardB = await exportNode(b);
  const transport = c => ({ kind: 'local-process', executable: process.execPath, args: [], stateDir: c.stateDir });
  await pairPeer(a, cardB, transport(b)); await pairPeer(b, cardA, transport(a));
  const created = await withStore(a, store => createRoom(store, { name: 'Project review', members: ['alice', 'bob'] }));
  await sealRoom(a, created);
  const signedRoom = await exportRoom(a, created.id), room = await acceptRoom(b, signedRoom);
  const wire = (changes = {}) => signObject(nodeA, {
    type: 'message', version: 1, messageId: `m_${randomUUID()}`, roomId: room.id,
    roomRevision: room.revision, manifestHash: room.manifestHash,
    from: { nodeId: nodeA.nodeId, bindingId: 'operator', revision: 1, alias: 'operator' },
    to: { nodeId: nodeB.nodeId, bindingId: bob.id, revision: bob.revision, alias: bob.alias },
    text: 'Please review this project boundary.', replyToMessageId: null,
    createdAt: new Date().toISOString(), ...changes,
  });
  return { root, a, b, alice, bob, nodeA, nodeB, cardA, cardB, room, signedRoom, wire, transport };
}
async function events(context) {
  try { return JSON.parse(await readFile(join(context.stateDir, 'fake-hcom.json'), 'utf8')).events; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

test('pairs two independent state cards and accepts a signed room with exact nodes', async t => {
  const f = await fixture(t), storeA = await readStore(f.a), storeB = await readStore(f.b);
  assert.notEqual(f.nodeA.nodeId, f.nodeB.nodeId);
  assert.equal(storeA.bindings.bob.remote, true);
  assert.equal(storeB.bindings.alice.remote, true);
  assert.equal(storeB.bindings.bob.remote, undefined);
  assert.equal(storeB.rooms[f.room.id].manifestHash, payloadHash(f.signedRoom.payload));
  assert.deepEqual(storeB.rooms[f.room.id].members.map(m => m.nodeId).sort(), [f.nodeA.nodeId, f.nodeB.nodeId].sort());
  await assert.rejects(exportRoom(f.b, f.room.id), /Only the room owner/);
  await assert.rejects(pairPeer(f.a, f.cardA, f.transport(f.a)), /itself|clone/);
});

test('node-card and room signature changes, alias collisions, and manifest replacement fail', async t => {
  const f = await fixture(t);
  const card = structuredClone(f.cardB); card.payload.bindings[0].sessionId = 'ses_replaced';
  await assert.rejects(pairPeer(f.a, card, f.transport(f.b)), /signature/);
  const conflictingCard = signObject(f.nodeB, { ...f.cardB.payload, bindings: [{ ...f.cardB.payload.bindings[0], alias: 'alice' }] });
  await assert.rejects(pairPeer(f.a, conflictingCard, f.transport(f.b)), /conflicts/);
  const changedRoom = signObject(f.nodeA, { ...f.signedRoom.payload, name: 'Different content under old ID' });
  await assert.rejects(acceptRoom(f.b, changedRoom), /different manifest/);
  assert.equal((await readStore(f.a)).bindings.alice.remote, undefined);
});

test('a valid peer alias matching an inherited object property can be imported', async t => {
  const f = await fixture(t);
  const binding = await withStore(f.b, store => createBinding(store, { ...f.bob, alias: 'constructor', sessionId: 'ses_constructor' }));
  await pairPeer(f.a, await exportNode(f.b), f.transport(f.b));
  const store = await readStore(f.a);
  assert.equal(Object.hasOwn(store.bindings, 'constructor'), true);
  assert.equal(store.bindings.constructor.id, binding.id);
  assert.equal(store.bindings.constructor.remote, true);
});

test('oversized encoded Unicode and escaped ledger frames are rejected before durable intents or messages', async t => {
  const f = await fixture(t);
  for (const text of ['中'.repeat(21_000), '\\'.repeat(31_000)]) {
    const incoming = f.wire({ text });
    await assert.rejects(receiveEnvelope(f.b, incoming), /encoded frame exceeds local ledger argv limit/i);
    assert.deepEqual((await nodeStatus(f.b)).inbox, {});
    await assert.rejects(sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text }, {
      exchangeImpl: async () => { assert.fail('Oversized frame must not invoke transport'); },
    }), /encoded frame exceeds local ledger argv limit/i);
    assert.deepEqual((await nodeStatus(f.a)).outbox, {});
    assert.equal((await events(f.a)).length, 0);
    assert.equal((await events(f.b)).length, 0);
  }
});

test('wire gate rejects unknown rooms, bad signatures, wrong nodes and nonmember aliases', async t => {
  const f = await fixture(t);
  const good = f.wire();
  const badSignature = { ...good, signature: Buffer.alloc(64).toString('base64') };
  await assert.rejects(receiveEnvelope(f.b, badSignature), /signature/);
  await assert.rejects(receiveEnvelope(f.b, f.wire({ roomId: `r_${randomUUID()}` })), /Unknown room/);
  await assert.rejects(receiveEnvelope(f.b, f.wire({ roomRevision: f.room.revision + 1 })), /manifest/);
  await assert.rejects(receiveEnvelope(f.b, f.wire({ manifestHash: '0'.repeat(64) })), /manifest/);
  await assert.rejects(receiveEnvelope(f.b, f.wire({ to: { nodeId: f.nodeA.nodeId, bindingId: f.alice.id, revision: 1, alias: 'alice' } })), /own|destination/);
  await assert.rejects(receiveEnvelope(f.b, f.wire({ from: { nodeId: f.nodeA.nodeId, bindingId: `b_${randomUUID()}`, revision: 1, alias: 'not-member' } })), /Unknown|member/);
  const charlie = await withStore(f.b, store => createBinding(store, { alias: 'charlie', harness: 'opencode-v2', sessionId: 'ses_charlie', projectId: 'other-project', directory: '/work/other', serviceId: 'native-charlie', origin: 'http://127.0.0.1:9876' }));
  await assert.rejects(receiveEnvelope(f.b, f.wire({ to: { nodeId: f.nodeB.nodeId, bindingId: charlie.id, revision: 1, alias: 'charlie' } })), /not a member/);
  assert.equal((await events(f.b)).length, 0);
});

test('receiving the same signed message twice appends once and rejects ID/content collision', async t => {
  const f = await fixture(t), message = f.wire();
  const first = verifyObject(await receiveEnvelope(f.b, message), f.nodeB.publicKey);
  const again = verifyObject(await receiveEnvelope(f.b, message), f.nodeB.publicKey);
  assert.equal(first.eventId, again.eventId);
  assert.equal(first.status, 'stored');
  assert.equal((await events(f.b)).length, 1);
  const collision = signObject(f.nodeA, { ...message.payload, text: 'Changed body under same message ID.' });
  await assert.rejects(receiveEnvelope(f.b, collision), /reused with different/);
  assert.equal((await events(f.b)).length, 1);
});

test('ingress validates the exact signed frame and its local ledger mapping', async t => {
  const f = await fixture(t), message = f.wire();
  await receiveEnvelope(f.b, message);
  const store = await readStore(f.b), event = (await events(f.b))[0], frame = decodeFrame(event.data.text);
  assert.equal((await validateIngress(f.b, store, store.bindings.bob, frame, event)).eventId, event.id);
  await assert.rejects(validateIngress(f.b, store, store.bindings.bob, { ...frame, text: 'Local modified text' }, event), /changed/);
  await assert.rejects(validateIngress(f.b, store, store.bindings.bob, { ...frame, replyTo: '999' }, event), /changed|mapping|reply/i);
  await assert.rejects(validateIngress(f.b, store, store.bindings.bob, frame, { ...event, id: event.id + 1 }), /mapping|sender/);
  await assert.rejects(validateIngress(f.b, store, store.bindings.bob, frame, { ...event, data: { ...event.data, from: 'forged' } }), /mapping|sender/);
  await assert.rejects(validateIngress(f.b, store, store.bindings.bob, frame, { ...event, data: { ...event.data, delivered_to: ['somebody-else'] } }), /mapping|sender|destination|addressed/i);
});

test('global replies reverse the exact original participants and reference committed source evidence', async t => {
  const f = await fixture(t);
  const request = f.wire({ from: { nodeId: f.nodeA.nodeId, bindingId: f.alice.id, revision: 1, alias: 'alice' } });
  await receiveEnvelope(f.b, request);
  // Represent a completed source append without invoking a native model adapter.
  const ingressCopy = (await events(f.b))[0];
  const sourceEvent = { ...ingressCopy, data: { ...ingressCopy.data, from: f.alice.hcomName } };
  await writeFile(join(f.a.stateDir, 'fake-hcom.json'), JSON.stringify({ events: [sourceEvent], names: [], faulted: false }));
  await withStore(f.a, store => {
    store.outbox = { [request.payload.messageId]: { eventId: sourceEvent.id, payloadHash: payloadHash(request.payload), peerNodeId: f.nodeB.nodeId, roomId: f.room.id, status: 'remote-stored' } };
  });
  const reply = signObject(f.nodeB, { ...request.payload, messageId: `m_${randomUUID()}`, from: request.payload.to, to: request.payload.from, text: 'Project review completed.', replyToMessageId: request.payload.messageId });
  const result = verifyObject(await receiveEnvelope(f.a, reply), f.nodeA.publicKey);
  assert.equal(result.status, 'stored');
  const forgedSource = signObject(f.nodeB, { ...reply.payload, messageId: `m_${randomUUID()}`, from: { nodeId: f.nodeB.nodeId, bindingId: 'operator', revision: 1, alias: 'operator' } });
  await assert.rejects(receiveEnvelope(f.a, forgedSource), /reverse/);
  const unknownParent = signObject(f.nodeB, { ...reply.payload, messageId: `m_${randomUUID()}`, replyToMessageId: `m_${randomUUID()}` });
  await assert.rejects(receiveEnvelope(f.a, unknownParent), /uncommitted|unknown/);
  assert.equal((await events(f.a)).length, 2);
});

test('lost transport receipt retries the same outbox ID without duplicate remote append', async t => {
  const f = await fixture(t);
  let messageId;
  await assert.rejects(sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text: 'Review the project.' }, {
    exchangeImpl: async (_peer, envelope) => { await receiveEnvelope(f.b, envelope); throw new Error('Receipt lost after remote storage'); },
  }), error => { messageId = error.messageId; return error.uncertain === true && Boolean(messageId); });
  assert.equal((await nodeStatus(f.a)).outbox[messageId].status, 'unknown');
  const result = await flushMessage(f.a, messageId, { exchangeImpl: async (_peer, envelope) => receiveEnvelope(f.b, envelope) });
  assert.equal(result.status, 'remote-stored');
  assert.equal((await events(f.a)).length, 1);
  assert.equal((await events(f.b)).length, 1);
  assert.equal((await nodeStatus(f.a)).outbox[messageId].remoteEventId, 1);
});

test('a failed retry preserves an earlier confirmed remote-stored receipt', async t => {
  const f = await fixture(t);
  const result = await sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text: 'Keep confirmed storage evidence.' }, {
    exchangeImpl: async (_peer, envelope) => receiveEnvelope(f.b, envelope),
  });
  const before = (await nodeStatus(f.a)).outbox[result.messageId];
  assert.equal(before.status, 'remote-stored');
  await assert.rejects(flushMessage(f.a, result.messageId, {
    exchangeImpl: async () => { throw new Error('Peer is temporarily offline'); },
  }), error => error.uncertain === true && error.messageId === result.messageId && /prior remote-stored evidence is retained/.test(error.message));
  assert.deepEqual((await nodeStatus(f.a)).outbox[result.messageId], before);
  assert.equal((await events(f.a)).length, 1);
  assert.equal((await events(f.b)).length, 1);
});

test('ingress append followed by lost hcom response is reconciled without replaying send', async t => {
  const f = await fixture(t), message = f.wire();
  f.b.env.FAKE_HCOM_FAIL_SEND_AFTER_APPEND = '1';
  await assert.rejects(receiveEnvelope(f.b, message), /hcom send failed/);
  assert.equal((await events(f.b)).length, 1);
  assert.equal((await nodeStatus(f.b)).inbox[message.payload.messageId].status, 'preparing');
  const result = verifyObject(await receiveEnvelope(f.b, message), f.nodeB.publicKey);
  assert.equal(result.eventId, 1);
  assert.equal((await events(f.b)).length, 1);
});

test('outbound append followed by lost hcom response can be reconciled with node flush', async t => {
  const f = await fixture(t);
  f.a.env.FAKE_HCOM_FAIL_SEND_AFTER_APPEND = '1';
  await assert.rejects(sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text: 'Recover this source event.' }, {
    exchangeImpl: async (_peer, envelope) => receiveEnvelope(f.b, envelope),
  }));
  const outbox = (await nodeStatus(f.a)).outbox, messageId = Object.keys(outbox)[0];
  assert.equal((await events(f.a)).length, 1);
  const result = await flushMessage(f.a, messageId, { exchangeImpl: async (_peer, envelope) => receiveEnvelope(f.b, envelope) });
  assert.equal(result.status, 'remote-stored');
  assert.equal((await events(f.a)).length, 1);
  assert.equal((await events(f.b)).length, 1);
});

test('a signed receipt for another payload does not mark the outbox delivered', async t => {
  const f = await fixture(t);
  let messageId;
  await assert.rejects(sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text: 'Require an exact receipt.' }, {
    exchangeImpl: async (_peer, envelope) => {
      const correct = verifyObject(await receiveEnvelope(f.b, envelope), f.nodeB.publicKey);
      return signObject(f.nodeB, { ...correct, payloadHash: '0'.repeat(64) });
    },
  }), error => { messageId = error.messageId; return error.uncertain === true; });
  assert.equal((await nodeStatus(f.a)).outbox[messageId].status, 'unknown');
  assert.equal((await events(f.b)).length, 1);
});

test('outbox replay verifies the source signature before invoking transport', async t => {
  const f = await fixture(t);
  let messageId;
  await assert.rejects(sendRemote(f.a, { room: f.room.id, from: 'operator', to: 'bob', text: 'Do not forward modified source evidence.' }, {
    exchangeImpl: async () => { throw new Error('Transport unavailable before receipt'); },
  }), error => { messageId = error.messageId; return error.uncertain === true; });
  const path = join(f.a.stateDir, 'fake-hcom.json'), db = JSON.parse(await readFile(path, 'utf8'));
  const frame = decodeFrame(db.events[0].data.text);
  frame.wireEnvelope.signature = Buffer.alloc(64).toString('base64');
  db.events[0].data.text = encodeFrame(frame); await writeFile(path, JSON.stringify(db));
  let exchanged = false;
  await assert.rejects(flushMessage(f.a, messageId, { exchangeImpl: async () => { exchanged = true; } }), /signature/);
  assert.equal(exchanged, false);
  assert.equal((await events(f.b)).length, 0);
});

test('pending ingress with no ledger evidence remains paused rather than appending blindly', async t => {
  const f = await fixture(t), message = f.wire();
  await withStore(f.b, store => {
    store.inbox = { [message.payload.messageId]: { payloadHash: payloadHash(message.payload), senderNodeId: f.nodeA.nodeId, roomId: f.room.id, status: 'preparing' } };
  });
  await assert.rejects(receiveEnvelope(f.b, message), error => error.uncertain === true);
  assert.equal((await events(f.b)).length, 0);
});
