import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPrivateFile, inspectWindowsPrivatePath, protectWindowsPrivatePath, validateWindowsPrivateAcl } from '../lib/private-files.mjs';

const sid = 'S-1-5-21-100-200-300-1001';
const acl = () => ({ version: 1, currentUserSid: sid, ownerSid: 'S-1-5-32-544', protected: false, directory: false, reparse: false,
  aces: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(value => ({ sid: value, type: 'allow', rights: 2032127, inherited: true })) });
const info = mode => ({ isFile: () => true, size: 100, mode });
const decode = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ad-private-file-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'identity.json'); await writeFile(path, 'PRIVATE-IDENTITY-SENTINEL', { mode: 0o600 });
  return { root, path };
}

test('Windows private identity accepts only the owner/user and trusted administrative SIDs, including inherited rules', () => {
  assert.equal(validateWindowsPrivateAcl(acl()), true);
  assert.equal(validateWindowsPrivateAcl({ ...acl(), ownerSid: sid, protected: true }), true);
  assert.equal(validateWindowsPrivateAcl({ ...acl(), ownerSid: 'S-1-5-18' }), true);
  for (const other of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-21-999-888-777-1002']) {
    assert.throws(() => validateWindowsPrivateAcl({ ...acl(), aces: [...acl().aces, { sid: other, type: 'allow', rights: 1, inherited: false }] }), /private|ACL/i);
    assert.throws(() => validateWindowsPrivateAcl({ ...acl(), ownerSid: other }), /private|owner/i);
  }
});

test('ACL evidence rejects null/empty/malformed rules, unsupported versions, reparse points and wrong path kind', () => {
  for (const bad of [null, {}, { ...acl(), version: 2 }, { ...acl(), currentUserSid: 'z' }, { ...acl(), aces: [] },
    { ...acl(), reparse: true }, { ...acl(), directory: true }, { ...acl(), aces: [{ sid, type: 'allow', rights: 'FullControl', inherited: false }] },
    { ...acl(), aces: [{ sid, type: 'allow', rights: 0, inherited: false }] }, { ...acl(), aces: [{ sid, type: 'other', rights: 1, inherited: false }] }]) {
    assert.throws(() => validateWindowsPrivateAcl(bad));
  }
});

test('Windows ACL policy is checked even when POSIX mode appears 0600, and private ACL permits Windows synthetic 0666', async t => {
  const f = await fixture(t), valid = async () => ({ code: 0, stdout: JSON.stringify(acl()) });
  await assertPrivateFile(f.path, info(0o666), { platform: 'win32', runner: valid });
  const broad = { ...acl(), aces: [...acl().aces, { sid: 'S-1-1-0', type: 'allow', rights: 1, inherited: true }] };
  await assert.rejects(assertPrivateFile(f.path, info(0o600), { platform: 'win32', runner: async () => ({ code: 0, stdout: JSON.stringify(broad) }) }), /private|ACL/i);
  let calls = 0;
  await assertPrivateFile(f.path, info(0o600), { platform: 'linux', runner: async () => { calls++; } });
  await assert.rejects(assertPrivateFile(f.path, info(0o644), { platform: 'darwin', runner: async () => { calls++; } }), /0600/);
  assert.equal(calls, 0);
});

test('ACL inspection queries metadata with literal encoded paths and never reads, repairs or discloses key contents', async t => {
  const f = await fixture(t), before = await readFile(f.path), mode = (await stat(f.path)).mode;
  let script;
  await inspectWindowsPrivatePath(f.path, { runner: async (_, args) => { script = decode(args); return { code: 0, stdout: JSON.stringify(acl()) }; } });
  assert.match(script, /GetAccessControl/);
  assert.match(script, /GetAccessRules\(\$true,\$true/);
  assert.match(script, /SecurityIdentifier/);
  assert.equal(/Get-Content|ReadAllText|SetAccessControl|Set-Acl/.test(script), false);
  assert.equal(script.includes('PRIVATE-IDENTITY-SENTINEL'), false);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal((await stat(f.path)).mode, mode);
});

test('failed ACL collection fails closed with redacted errors instead of skipping Windows privacy', async t => {
  const f = await fixture(t);
  for (const runner of [async () => { throw new Error('PRIVATE-PATH-AND-KEY'); }, async () => ({ code: 1, stdout: 'PRIVATE-PATH-AND-KEY' }), async () => ({ code: 0, stdout: 'PRIVATE-PATH-AND-KEY' })]) {
    await assert.rejects(assertPrivateFile(f.path, info(0o666), { platform: 'win32', runner }), error => !error.message.includes('PRIVATE-PATH-AND-KEY') && /ACL|private/i.test(error.message));
  }
});

test('explicit Windows protection changes only ACL metadata and rejects nonprivate results', async t => {
  const f = await fixture(t), before = await readFile(f.path); let script;
  await protectWindowsPrivatePath(f.path, { runner: async (_, args) => { script = decode(args); return { code: 0, stdout: JSON.stringify({ ...acl(), ownerSid: sid, protected: true }) }; } });
  assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(script, /SetOwner/);
  assert.match(script, /SetAccessControl/);
  assert.equal(/WriteAllText|WriteAllBytes|Get-Content|ReadAllText/.test(script), false);
  assert.deepEqual(await readFile(f.path), before);
  const directory = join(f.root, 'directory'); await mkdir(directory);
  await protectWindowsPrivatePath(directory, { directory: true, runner: async () => ({ code: 0, stdout: JSON.stringify({ ...acl(), directory: true, ownerSid: sid, protected: true }) }) });
});
