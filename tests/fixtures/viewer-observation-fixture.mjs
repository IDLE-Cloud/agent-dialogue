import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { makeSources, fixtureIDs } from './viewer-fixture.mjs';
import { payloadHash, signObject } from '../../lib/node-identity.mjs';

// Deterministic synthetic signing material, matching the existing viewer fixture.
export function observationTestNode(byte = 11, name = 'Synthetic laptop') {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  return { version: 1, nodeId: `n_${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')}`, name, publicKey,
    privateKey: key.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

export const framePrefix = 'agent-dialogue/1\n';
export const submitPrefix = 'agent-dialogue/submit/1\n';
export const readFrame = event => JSON.parse(event.data.text.slice(framePrefix.length));
export const writeFrame = (event, frame) => { event.data.text = framePrefix + JSON.stringify(frame); };

export function makeObservationFixture(index = 0) {
  const sources = makeSources({ sealedManifest: true });
  for (const [i, source] of sources.entries()) {
    source.generation = (i ? '2' : '1').repeat(32);
    source.error = null;
  }
  const source = sources[index], room = source.store.rooms[fixtureIDs.room];
  const request = { version: 1, type: 'viewer-observe', requestId: '0123456789abcdef'.repeat(2), expectedNodeId: source.node.nodeId,
    rooms: [{ id: room.id, revision: room.revision, manifestHash: room.manifestHash }] };
  return { source, sources, request, room };
}

export function resignFrame(event, change, identity = observationTestNode()) {
  const frame = readFrame(event);
  change(frame);
  frame.wireEnvelope = signObject(identity, frame.wireEnvelope.payload);
  writeFrame(event, frame);
  return frame;
}

export function addOtherSealedRoom(source) {
  const selected = source.store.rooms[fixtureIDs.room];
  const room = { id: 'r_10000000-0000-4000-8000-000000000099', name: 'UNSELECTED_ROOM_SECRET', revision: 1,
    ownerNodeId: selected.ownerNodeId, members: structuredClone(selected.members) };
  room.manifestHash = payloadHash({ type: 'room', version: 1, id: room.id, name: room.name, revision: room.revision,
    ownerNodeId: room.ownerNodeId, members: room.members });
  source.store.rooms[room.id] = room;
  const event = structuredClone(source.events.find(row => row.id === 42));
  event.id = 90; event.data.thread = room.id;
  resignFrame(event, frame => {
    frame.room = room.id; frame.text = 'UNSELECTED_BODY_SECRET'; frame.globalMessageId = 'm_30000000-0000-4000-8000-000000000099';
    Object.assign(frame.wireEnvelope.payload, { roomId: room.id, manifestHash: room.manifestHash, messageId: frame.globalMessageId, text: frame.text });
  });
  source.events.push(event);
  return room;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
