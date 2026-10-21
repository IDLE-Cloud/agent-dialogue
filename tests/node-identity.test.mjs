import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateNode, readExistingNode, nodePublic, payloadHash, signObject, validatePublicNode, validateWireMessage, verifyObject } from '../lib/node-identity.mjs';
import { inspectWindowsPrivatePath } from '../lib/private-files.mjs';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dialogue-node-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir };
}
function message(a, b) {
  return {
    type: 'message', version: 1, messageId: 'm_12345678-1234-1234-1234-123456789abc', roomId: 'r_12345678-1234-1234-1234-123456789abc', roomRevision: 1,
    manifestHash: 'a'.repeat(64),
    from: { nodeId: a.nodeId, bindingId: 'b_11111111-1111-1111-1111-111111111111', revision: 1, alias: 'code-a' },
    to: { nodeId: b.nodeId, bindingId: 'b_22222222-2222-2222-2222-222222222222', revision: 1, alias: 'code-b' },
    text: 'Continue the existing project discussion.', replyToMessageId: null, createdAt: '2026-10-17T12:00:00.000Z',
  };
}

test('persistent node uses private keys and a public hash identity, without exposing secrets in nodePublic', async t => {
  const context = await fixture(t), node = await loadOrCreateNode(context, { name: 'Mac node' });
  assert.equal(node.version, 1); assert.match(node.nodeId, /^n_[a-f0-9]{64}$/);
  if (process.platform === 'win32') await inspectWindowsPrivatePath(join(context.stateDir, 'dialogue', 'node.json'));
  else {
    assert.equal((await stat(join(context.stateDir, 'dialogue', 'node.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(context.stateDir, 'dialogue'))).mode & 0o777, 0o700);
  }
  assert.deepEqual(nodePublic(node), { nodeId: node.nodeId, name: 'Mac node', publicKey: node.publicKey });
  assert.ok(!('privateKey' in nodePublic(node)));
  assert.deepEqual(await loadOrCreateNode(context, { name: 'must not rename existing' }), node);
  assert.deepEqual(JSON.parse(await readFile(join(context.stateDir, 'dialogue', 'node.json'), 'utf8')), node);
});

test('concurrent creation converges on one complete identity and cleans temporary files', async t => {
  const context = await fixture(t);
  const nodes = await Promise.all(Array.from({ length: 12 }, (_, i) => loadOrCreateNode(context, { name: `candidate ${i}` })));
  assert.equal(new Set(nodes.map(node => node.nodeId)).size, 1);
  assert.equal(new Set(nodes.map(node => node.privateKey)).size, 1);
  assert.deepEqual(await readdir(join(context.stateDir, 'dialogue')), ['node.json']);
});

test('existing malformed, mismatched, or publicly readable identity is rejected without overwriting', async t => {
  const context = await fixture(t), node = await loadOrCreateNode(context);
  const other = await loadOrCreateNode(await fixture(t));
  const path = join(context.stateDir, 'dialogue', 'node.json');
  for (const invalid of [
    '{broken', JSON.stringify({ ...node, nodeId: 'n_' + '0'.repeat(64) }),
    JSON.stringify({ ...node, privateKey: other.privateKey }), JSON.stringify({ ...node, publicKey: 'not-base64' }),
    JSON.stringify({ ...node, version: 2 }),
  ]) {
    await writeFile(path, invalid, { mode: 0o600 });
    await assert.rejects(loadOrCreateNode(context));
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
  await writeFile(path, JSON.stringify(node));
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises'); await chmod(path, 0o644);
    await assert.rejects(loadOrCreateNode(context), /private regular file/);
  }
});

test('existing identity reads preserve exact key bytes, node ID, and file metadata', async t => {
  const context = await fixture(t), node = await loadOrCreateNode(context, { name: 'Keep original' });
  const path = join(context.stateDir, 'dialogue', 'node.json'), before = await readFile(path), info = await stat(path);
  const existing = await readExistingNode(context);
  assert.deepEqual(existing, node);
  assert.deepEqual(await readFile(path), before);
  const after = await stat(path);
  assert.equal(after.ino, info.ino); assert.equal(after.mode, info.mode); assert.equal(after.mtimeMs, info.mtimeMs);
});

test('identity file symlinks are rejected without reading or replacing the target key', async t => {
  const context = await fixture(t), target = await fixture(t);
  await loadOrCreateNode(context); const original = await loadOrCreateNode(target);
  const path = join(context.stateDir, 'dialogue', 'node.json'), targetPath = join(target.stateDir, 'dialogue', 'node.json');
  const before = await readFile(targetPath);
  await rm(path);
  try { await symlink(targetPath, path, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows account lacks symlink permission'); throw error; }
  await assert.rejects(readExistingNode(context), /private regular file/i);
  await assert.rejects(loadOrCreateNode(context), /private regular file/i);
  assert.deepEqual(await readFile(targetPath), before);
  assert.equal((await readExistingNode(target)).nodeId, original.nodeId);
});

test('canonical signatures bind all fields and the exact paired key', async t => {
  const a = await loadOrCreateNode(await fixture(t)), b = await loadOrCreateNode(await fixture(t));
  const payload = message(a, b), envelope = signObject(a, payload);
  assert.deepEqual(verifyObject(envelope, a.publicKey), payload);
  assert.throws(() => verifyObject(envelope, b.publicKey), /signature/);
  for (const tampered of [
    { ...envelope, payload: { ...envelope.payload, text: 'tampered' } },
    { ...envelope, payload: { ...envelope.payload, from: { ...envelope.payload.from, nodeId: b.nodeId } } },
    { ...envelope, signature: Buffer.alloc(64).toString('base64') },
    { ...envelope, publicKey: b.publicKey },
  ]) assert.throws(() => verifyObject(tampered, a.publicKey));
  assert.throws(() => validatePublicNode({ ...nodePublic(a), nodeId: b.nodeId }), /does not match/);
  payload.text = 'mutated after signing';
  assert.notEqual(envelope.payload.text, payload.text, 'signing snapshots JSON instead of retaining a mutable caller reference');
});

test('canonical JSON sorts nested object keys and rejects non-JSON and oversized values', async t => {
  const node = await loadOrCreateNode(await fixture(t));
  const a = { z: { b: 2, a: 1 }, a: [true, null, 'text'] }, b = { a: [true, null, 'text'], z: { a: 1, b: 2 } };
  assert.equal(payloadHash(a), payloadHash(b));
  assert.equal(signObject(node, a).signature, signObject(node, b).signature);
  assert.equal(payloadHash({ 2: 'second', 10: 'tenth' }), createHash('sha256').update('{"10":"tenth","2":"second"}').digest('hex'), 'numeric object keys must also be sorted lexically');
  const circular = {}; circular.self = circular;
  for (const invalid of [{ a: undefined }, { a: NaN }, { a: 1n }, { a: new Date() }, circular, new Array(1), { text: 'x'.repeat(256 * 1024) }]) {
    assert.throws(() => payloadHash(invalid));
    assert.throws(() => signObject(node, invalid));
  }
});

test('wire message validates exact routing fields, reply IDs, sizes and timestamp without a TTL', async t => {
  const a = await loadOrCreateNode(await fixture(t)), b = await loadOrCreateNode(await fixture(t));
  const payload = message(a, b);
  assert.equal(validateWireMessage(payload), payload);
  assert.equal(validateWireMessage({ ...payload, createdAt: '2000-01-01T00:00:00.000Z' }).version, 1);
  assert.equal(validateWireMessage({ ...payload, text: 'x'.repeat(40000), replyToMessageId: payload.messageId }).text.length, 40000);
  for (const change of [
    { version: 2 }, { type: 'launch' }, { messageId: '42' }, { roomId: 'latest' }, { roomRevision: 0 }, { manifestHash: 'bad' },
    { messageId: payload.messageId + '\n' }, { manifestHash: 'a'.repeat(64) + '\n' }, { roomId: payload.roomId + '\n' },
    { text: '' }, { text: 'x'.repeat(40001) }, { replyToMessageId: '42' }, { createdAt: 'yesterday' }, { createdAt: '2026-02-31T00:00:00.000Z' },
    { from: { ...payload.from, nodeId: 'short' } }, { to: { ...payload.to, revision: 1.5 } }, { to: { ...payload.to, alias: 'Upper' } },
    { from: { ...payload.from, bindingId: 'unbound' } }, { extraAction: 'execute' },
  ]) assert.throws(() => validateWireMessage({ ...payload, ...change }));
});

test('operator is a node-scoped source only and never an implicit destination', async t => {
  const a = await loadOrCreateNode(await fixture(t)), b = await loadOrCreateNode(await fixture(t));
  const payload = message(a, b), operator = { nodeId: a.nodeId, bindingId: 'operator', revision: 1, alias: 'operator' };
  assert.equal(validateWireMessage({ ...payload, from: operator }).from.bindingId, 'operator');
  for (const from of [{ ...operator, alias: 'code-a' }, { ...operator, revision: 2 }, { ...payload.from, alias: 'operator' }]) {
    assert.throws(() => validateWireMessage({ ...payload, from }), /operator/);
  }
  assert.throws(() => validateWireMessage({ ...payload, to: operator }), /operator/);
});
