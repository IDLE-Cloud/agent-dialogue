import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPrivateFile, protectWindowsPrivatePath } from './private-files.mjs';

const MAX_PAYLOAD = 256 * 1024;
const HEX_HASH = /^[a-f0-9]{64}(?![\s\S])/;
const NODE_ID = /^n_[a-f0-9]{64}(?![\s\S])/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MESSAGE_ID = new RegExp(`^m_${UUID}(?![\\s\\S])`);
const BINDING_ID = new RegExp(`^b_${UUID}(?![\\s\\S])`);
const ROOM_ID = new RegExp(`^r_${UUID}(?![\\s\\S])`);
const ALIAS = /^[a-z][a-z0-9_-]{0,39}(?![\s\S])/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw new Error(message); }
function exactKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`Invalid ${label} fields.`);
}
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid node name.');
  return value;
}
function jsonValue(value, ancestors, depth) {
  if (depth > 64) fail('Canonical payload is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Canonical payload requires finite JSON numbers.'); return value; }
  if (typeof value !== 'object') fail('Canonical payload must contain only JSON values.');
  if (ancestors.has(value)) fail('Canonical payload must not contain cycles.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail('Canonical payload must not contain sparse arrays.');
      result.push(jsonValue(value[i], ancestors, depth + 1));
    }
    if (Object.keys(value).length !== value.length) fail('Canonical arrays must not contain extra fields.');
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail('Canonical payload requires plain JSON objects.');
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('Canonical payload must not contain accessors.');
      result[key] = jsonValue(descriptor.value, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
  return result;
}
function sortedJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sortedJson(value[key])).join(',') + '}';
}
function canonical(payload) {
  const text = sortedJson(jsonValue(payload, new Set(), 0));
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_PAYLOAD) fail('Canonical payload exceeds 256 KiB.');
  return bytes;
}
function base64(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(`Invalid ${label} encoding.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(`Invalid ${label} encoding.`);
  return bytes;
}
function publicKeyOf(value) {
  const bytes = base64(value, 'node public key');
  let key;
  try { key = createPublicKey({ key: bytes, format: 'der', type: 'spki' }); }
  catch { fail('Invalid node public key.'); }
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format: 'der', type: 'spki' }).equals(bytes)) fail('Node public key must be canonical Ed25519 SPKI.');
  return key;
}
function nodeIdOf(publicKey) { return `n_${createHash('sha256').update(base64(publicKey, 'node public key')).digest('hex')}`; }

export function validatePublicNode(node) {
  exactKeys(node, ['nodeId', 'name', 'publicKey'], 'public node');
  validName(node.name); publicKeyOf(node.publicKey);
  if (!NODE_ID.test(node.nodeId) || node.nodeId !== nodeIdOf(node.publicKey)) fail('Node ID does not match its public key.');
  return { nodeId: node.nodeId, name: node.name, publicKey: node.publicKey };
}

function validateIdentity(identity) {
  exactKeys(identity, ['version', 'nodeId', 'name', 'publicKey', 'privateKey'], 'node identity');
  if (identity.version !== 1) fail('Unsupported node identity version.');
  validatePublicNode({ nodeId: identity.nodeId, name: identity.name, publicKey: identity.publicKey });
  const bytes = base64(identity.privateKey, 'node private key');
  let key;
  try { key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' }); }
  catch { fail('Invalid node private key.'); }
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format: 'der', type: 'pkcs8' }).equals(bytes) || createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== identity.publicKey) fail('Node private key does not match the public identity.');
  return key;
}

async function readIdentity(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) fail('Node identity must be a private regular file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino) fail('Node identity changed while opening.');
    await assertPrivateFile(path, info);
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) fail('Node identity changed during privacy validation.');
    let identity;
    try { identity = JSON.parse(await handle.readFile('utf8')); }
    catch { fail('Invalid stored node identity JSON.'); }
    validateIdentity(identity);
    return identity;
  } finally { await handle.close(); }
}

/** Read and validate an existing private identity without changing directories, modes or keys. */
export async function readExistingNode(context) {
  if (typeof context?.stateDir !== 'string' || !context.stateDir || context.stateDir.includes('\0')) fail('Node identity needs a state directory.');
  return await readIdentity(join(context.stateDir, 'dialogue', 'node.json'));
}

/** Atomic first-writer-wins initialization; readers never see a half-written key. */
export async function loadOrCreateNode(context, { name = 'node' } = {}) {
  validName(name);
  if (typeof context?.stateDir !== 'string' || !context.stateDir || context.stateDir.includes('\0')) fail('Node identity needs a state directory.');
  const dir = join(context.stateDir, 'dialogue'), path = join(dir, 'node.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  try { return await readIdentity(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Existing identities are read-only. Secure a new identity's containing
  // directory before writing any temporary private key on Windows.
  if (process.platform === 'win32') await protectWindowsPrivatePath(dir, { directory: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const encodedPublic = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const identity = { version: 1, nodeId: nodeIdOf(encodedPublic), name, publicKey: encodedPublic, privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
  const temporary = join(dir, `.node-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(identity) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await readIdentity(path);
  } finally { await rm(temporary, { force: true }); }
}

export function nodePublic(identity) {
  validateIdentity(identity);
  return validatePublicNode({ nodeId: identity.nodeId, name: identity.name, publicKey: identity.publicKey });
}

export function payloadHash(payload) { return createHash('sha256').update(canonical(payload)).digest('hex'); }

export function signObject(identity, payload) {
  const key = validateIdentity(identity), bytes = canonical(payload);
  return { payload: JSON.parse(bytes.toString('utf8')), signature: sign(null, bytes, key).toString('base64') };
}

export function verifyObject(envelope, publicKey) {
  exactKeys(envelope, ['payload', 'signature'], 'signed envelope');
  const key = publicKeyOf(publicKey), bytes = canonical(envelope.payload), signature = base64(envelope.signature, 'signature', 128);
  if (signature.length !== 64 || !verify(null, bytes, key, signature)) fail('Invalid node signature.');
  return envelope.payload;
}

function participant(value, label, allowOperator = false) {
  exactKeys(value, ['nodeId', 'bindingId', 'revision', 'alias'], label);
  if (!NODE_ID.test(value.nodeId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !ALIAS.test(value.alias)) fail(`Invalid ${label} identity.`);
  if (value.bindingId === 'operator' || value.alias === 'operator') {
    if (!allowOperator || value.bindingId !== 'operator' || value.alias !== 'operator' || value.revision !== 1) fail(`Invalid ${label} operator.`);
  } else if (!BINDING_ID.test(value.bindingId)) fail(`Invalid ${label} binding ID.`);
}

export function validateWireMessage(payload) {
  exactKeys(payload, ['type', 'version', 'messageId', 'roomId', 'roomRevision', 'manifestHash', 'from', 'to', 'text', 'replyToMessageId', 'createdAt'], 'wire message');
  if (payload.type !== 'message' || payload.version !== 1 || !MESSAGE_ID.test(payload.messageId)) fail('Invalid wire message type, version or ID.');
  if (typeof payload.roomId !== 'string' || !ROOM_ID.test(payload.roomId) || !Number.isSafeInteger(payload.roomRevision) || payload.roomRevision < 1 || !HEX_HASH.test(payload.manifestHash)) fail('Invalid wire room manifest reference.');
  participant(payload.from, 'wire source', true); participant(payload.to, 'wire destination');
  if (payload.from.nodeId === payload.to.nodeId && payload.from.bindingId === payload.to.bindingId) fail('Wire source and destination must differ.');
  if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 40000) fail('Wire text must contain 1–40000 characters.');
  if (payload.replyToMessageId !== null && !MESSAGE_ID.test(payload.replyToMessageId)) fail('Invalid wire reply reference.');
  if (typeof payload.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.createdAt) || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) fail('Wire createdAt must be a canonical ISO timestamp.');
  canonical(payload);
  return payload;
}
