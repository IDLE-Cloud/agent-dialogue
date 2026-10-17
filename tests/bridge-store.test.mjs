import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, createRoom, decodeFrame, encodeFrame, readStore, resolveBinding, resolveRoom, validateAlias, validateIncoming, validateRoute, withStore } from '../lib/bridge-store.mjs';

function storeFixture() {
  const store = { version: 1, bindings: {}, rooms: {} };
  const input = alias => ({ alias, harness: 'opencode', sessionId: `ses_${alias}`, projectId: 'project', directory: '/workspace/project', serviceId: 'service-one', origin: 'http://127.0.0.1:49374' });
  const alice = createBinding(store, input('alice')), bob = createBinding(store, input('bob'));
  const room = createRoom(store, { name: 'Project discussion', members: ['alice', 'bob'] });
  const frame = { version: 1, room: room.id, from: 'alice', to: 'bob', fromBindingId: alice.id, toBindingId: bob.id, fromRevision: alice.revision, toRevision: bob.revision, text: 'Review the project plan.', replyTo: null };
  return { store, input, alice, bob, room, frame };
}

test('binds an existing native session without storing messages or changing native identity', () => {
  const { store, alice } = storeFixture();
  assert.equal(alice.sessionId, 'ses_alice');
  assert.match(alice.id, /^b_/); assert.match(alice.hcomName, /^d[a-f0-9]{12}$/);
  assert.equal(alice.revision, 1); assert.equal(alice.active, true);
  assert.equal(resolveBinding(store, 'alice'), alice);
  assert.ok(!('messages' in store)); assert.ok(!('text' in alice));
});

test('aliases and native sessions cannot silently rebind or acquire a second active alias', () => {
  const { store, input, alice } = storeFixture();
  assert.throws(() => createBinding(store, input('alice')), /already exists/);
  assert.throws(() => createBinding(store, { ...input('charlie'), sessionId: alice.sessionId }), /already bound/);
  assert.throws(() => createBinding(store, input('operator')), /reserved/);
  alice.active = false;
  assert.throws(() => resolveBinding(store, 'alice'), /inactive/);
  assert.throws(() => createBinding(store, input('alice')), /already exists/);
  assert.equal(createBinding(store, { ...input('charlie'), sessionId: alice.sessionId }).sessionId, alice.sessionId);
  assert.equal(createBinding(store, { ...input('dora'), serviceId: 'different-service', sessionId: 'ses_bob' }).alias, 'dora');
});

test('room IDs are exact and membership pins bind identities rather than titles', () => {
  const { store, room, input } = storeFixture();
  assert.equal(resolveRoom(store, room.id), room);
  assert.throws(() => resolveRoom(store, room.name), /exact room ID/);
  assert.throws(() => createRoom(store, { name: 'one', members: ['alice'] }), /at least two/);
  assert.throws(() => createRoom(store, { name: 'twice', members: ['alice', 'alice'] }), /distinct/);
  assert.throws(() => createRoom(store, { name: 'unknown', members: ['alice', 'nobody'] }), /Unknown/);
  createBinding(store, input('charlie'));
  assert.throws(() => validateRoute(store, { room: room.id, from: 'charlie', to: 'bob' }), /not a member/);
  assert.throws(() => validateRoute(store, { room: room.id, from: 'alice', to: 'charlie' }), /not a member/);
});

test('route checks expected native session and both pinned revisions', () => {
  const { store, alice, bob, room } = storeFixture();
  const route = { room: room.id, from: 'alice', to: 'bob', expectedSession: bob.sessionId };
  assert.equal(validateRoute(store, route).to, bob);
  assert.throws(() => validateRoute(store, { ...route, expectedSession: 'ses_wrong' }), /Expected session/);
  assert.throws(() => validateRoute(store, { ...route, from: 'bob' }), /distinct/);
  alice.revision++;
  assert.throws(() => validateRoute(store, route), /Stale room binding/);
  alice.revision--; bob.revision++;
  assert.throws(() => validateRoute(store, route), /Stale room binding/);
});

test('operator may initiate to a pinned destination but cannot bypass destination validation', () => {
  const { store, bob, room, frame } = storeFixture();
  const operatorFrame = { ...frame, from: 'operator', fromBindingId: 'operator', fromRevision: 1 };
  assert.deepEqual(validateRoute(store, { room: room.id, from: 'operator', to: 'bob' }).from, { alias: 'operator', id: 'operator', revision: 1 });
  assert.equal(validateIncoming(store, bob, operatorFrame).to, bob);
  assert.throws(() => validateRoute(store, { room: room.id, from: 'operator', to: 'nobody' }), /Unknown/);
  assert.throws(() => validateIncoming(store, bob, { ...operatorFrame, fromBindingId: 'forged' }), /mismatched/);
});

test('incoming frames reject wrong destinations, stale IDs/revisions and changed binding snapshots', () => {
  const { store, alice, bob, frame } = storeFixture();
  assert.equal(validateIncoming(store, bob, frame).from, alice);
  assert.throws(() => validateIncoming(store, alice, frame), /different or stale destination/);
  for (const mismatch of [
    { fromBindingId: 'other' }, { toBindingId: 'other' }, { fromRevision: 9 }, { toRevision: 9 },
  ]) assert.throws(() => validateIncoming(store, bob, { ...frame, ...mismatch }), /mismatched/);
  assert.throws(() => validateIncoming(store, { ...bob, sessionId: 'ses_new' }, frame), /different or stale destination/);
  assert.throws(() => validateIncoming(store, { ...bob, directory: '/unrelated/project' }, frame), /different or stale destination/);
  assert.throws(() => validateIncoming(store, { ...bob, serviceId: 'different-service' }, frame), /different or stale destination/);
  const old = { ...bob }; bob.revision++;
  assert.throws(() => validateIncoming(store, old, frame), /Stale room binding/);
});

test('frames preserve literal project text and reject unframed or malformed traffic', () => {
  const { frame } = storeFixture();
  const literal = { ...frame, text: 'line\n`$(do-not-run)` --flag "quoted"', replyTo: '42' };
  assert.deepEqual(decodeFrame(encodeFrame(literal)), literal);
  for (const raw of ['hello', JSON.stringify(frame), 'agent-dialogue/1\n{', 'agent-dialogue/1\nnull', 'agent-dialogue/1\n[]']) assert.throws(() => decodeFrame(raw));
  for (const invalid of [
    { ...frame, version: 2 }, { ...frame, text: '' }, { ...frame, to: '@bob' },
    { ...frame, fromRevision: 0 }, { ...frame, toRevision: 1.5 }, { ...frame, replyTo: 42 },
  ]) assert.throws(() => encodeFrame(invalid));
  const missing = { ...frame }; delete missing.toBindingId;
  assert.throws(() => decodeFrame('agent-dialogue/1\n' + JSON.stringify(missing)), /missing toBindingId/);
});

test('invalid aliases are rejected before store access', () => {
  for (const alias of ['', 'Upper', '1name', '@alice', '__proto__', 'x'.repeat(41), 'a/b', 'a b']) assert.throws(() => validateAlias(alias));
  for (const alias of ['a', 'project-agent_1', 'x'.repeat(40)]) assert.equal(validateAlias(alias), alias);
});

test('persistent store saves control metadata atomically with private permissions', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-store-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir };
  assert.deepEqual(await readStore(context), { version: 1, bindings: {}, rooms: {} });
  const { input } = storeFixture();
  const result = await withStore(context, async store => { createBinding(store, input('alice')); createBinding(store, input('bob')); return createRoom(store, { name: 'Project', members: ['alice', 'bob'] }).id; });
  const saved = await readStore(context);
  assert.equal(saved.rooms[result].members.length, 2);
  assert.equal((await stat(join(stateDir, 'dialogue', 'store.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(stateDir, 'dialogue'))).sort(), ['store.json']);
  assert.ok(!(await readFile(join(stateDir, 'dialogue', 'store.json'), 'utf8')).includes('Review the project plan'));
});

test('lock contention fails closed and a failed mutation never replaces committed state', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-lock-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const context = { stateDir };
  await withStore(context, store => { store.note = 'committed'; });
  await mkdir(join(stateDir, 'dialogue', '.lock'));
  await assert.rejects(withStore(context, () => assert.fail('must not execute')), /busy/);
  await rm(join(stateDir, 'dialogue', '.lock'), { recursive: true });
  await assert.rejects(withStore(context, store => { store.note = 'uncommitted'; throw new Error('aborted'); }), /aborted/);
  assert.equal((await readStore(context)).note, 'committed');
  assert.deepEqual((await readdir(join(stateDir, 'dialogue'))).sort(), ['store.json']);
});
