import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { powershellCommand, powershellQuote, absoluteRemotePath } from './platform.mjs';

const execute = promisify(execFile);
const SID = /^S-1-\d+(?:-\d+)+$/;
const ADMINS = 'S-1-5-32-544', SYSTEM = 'S-1-5-18';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }

/** Windows counterparts to root are SYSTEM and local Administrators. All other
 * Allow principals, including broad inherited groups, fail closed. SID values
 * avoid translated account names and machine language differences. */
export function validateWindowsPrivateAcl(value, { directory = false } = {}) {
  if (!exact(value, ['version', 'currentUserSid', 'ownerSid', 'protected', 'directory', 'reparse', 'aces']) || value.version !== 1 || !SID.test(value.currentUserSid || '') || !SID.test(value.ownerSid || '') || typeof value.protected !== 'boolean' || value.directory !== directory || value.reparse !== false || !Array.isArray(value.aces) || !value.aces.length || value.aces.length > 256) fail('Private path Windows ACL evidence is invalid.');
  const trusted = new Set([value.currentUserSid, SYSTEM, ADMINS]);
  if (!trusted.has(value.ownerSid)) fail('Private path Windows owner is not the current user or a trusted administrator.');
  let readGrant = false;
  for (const rule of value.aces) {
    if (!exact(rule, ['sid', 'type', 'rights', 'inherited']) || !SID.test(rule.sid || '') || !['allow', 'deny'].includes(rule.type) || !Number.isSafeInteger(rule.rights) || rule.rights < -2147483648 || rule.rights > 4294967295 || typeof rule.inherited !== 'boolean') fail('Private path Windows ACL rule is invalid.');
    if (rule.type === 'allow' && rule.rights !== 0) {
      if (!trusted.has(rule.sid)) fail('Private path Windows ACL allows another user or broad group.');
      if ((rule.rights & 1) !== 0) readGrant = true;
    }
  }
  if (!readGrant) fail('Private path Windows ACL has no supported private read grant.');
  return true;
}
async function nativeRunner(executable, args) {
  try {
    const result = await execute(executable, args, { windowsHide: true, timeout: 8000, maxBuffer: 65536, encoding: 'utf8' });
    return { code: 0, stdout: result.stdout };
  } catch { return { code: 1, stdout: '' }; }
}
function invocation(script) {
  const words = powershellCommand(script).split(' '), root = process.env.SystemRoot;
  return { executable: absoluteRemotePath(root, 'powershell') ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : words[0], args: words.slice(1) };
}
function scriptHead(path, directory) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f]/.test(path)) fail('Invalid private path.');
  return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=${powershellQuote(path)};$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $i.PSIsContainer -ne $${directory ? 'true' : 'false'}){throw 'Private path kind mismatch'};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;`;
}
function inspectScript(directory) {
  const type = directory ? '[IO.Directory]' : '[IO.File]';
  return `$a=${type}::GetAccessControl($p);$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString().ToLowerInvariant();rights=[long]$_.FileSystemRights;inherited=[bool]$_.IsInherited}});[Console]::Out.Write((@{version=1;currentUserSid=$sid.Value;ownerSid=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=[bool]$a.AreAccessRulesProtected;directory=$${directory ? 'true' : 'false'};reparse=$false;aces=$rules}|ConvertTo-Json -Depth 4 -Compress));`;
}
async function collect(script, { runner, directory }) {
  const { executable, args } = invocation(script);
  let result;
  try { result = await runner(executable, args); }
  catch { fail('Private path Windows ACL inspection failed.'); }
  if (result?.code !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 65536) fail('Private path Windows ACL inspection failed.');
  let evidence;
  try { evidence = JSON.parse(result.stdout); }
  catch { fail('Private path Windows ACL inspection returned invalid evidence.'); }
  validateWindowsPrivateAcl(evidence, { directory });
  return evidence;
}

/** Metadata-only read: never changes ACLs or reads a key's contents. */
export async function inspectWindowsPrivatePath(path, { directory = false, runner = nativeRunner } = {}) {
  return await collect(scriptHead(path, directory) + inspectScript(directory), { runner, directory });
}

/** Explicit provisioning helper. Updates only owner/DACL metadata, never bytes. */
export async function protectWindowsPrivatePath(path, { directory = false, runner = nativeRunner } = {}) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('Private path must be a regular file or directory.');
  const type = directory ? '[IO.Directory]' : '[IO.File]';
  const aclType = directory ? 'DirectorySecurity' : 'FileSecurity';
  const rule = directory ? "$sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'" : "$sid,'FullControl','Allow'";
  const script = scriptHead(path, directory) + `$a=New-Object Security.AccessControl.${aclType};$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$r=New-Object Security.AccessControl.FileSystemAccessRule(${rule});$a.AddAccessRule($r);${type}::SetAccessControl($p,$a);` + inspectScript(directory);
  const result = await collect(script, { runner, directory });
  if (!result.protected || result.ownerSid !== result.currentUserSid) throw Object.assign(new Error('Private path Windows ACL provisioning was not confirmed.'), {
    aclProtected: result.protected === true,
    aclOwnerMatchesCurrentUser: result.ownerSid === result.currentUserSid,
  });
  return result;
}

export async function assertPrivateFile(path, info, { platform = process.platform, runner = nativeRunner } = {}) {
  if (!info?.isFile() || !Number.isSafeInteger(info.size) || info.size > 16384) fail('Node identity must be a private regular file (0600 on POSIX; private ACL on Windows).');
  if (platform === 'win32') await inspectWindowsPrivatePath(path, { runner });
  else if ((info.mode & 0o077) !== 0) fail('Node identity must be a private regular file (0600).');
}
