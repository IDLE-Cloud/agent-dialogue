import { constants } from 'node:fs';
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { run } from '../bin/agent-dialogue.mjs';
import { absoluteRemotePath, powershellCommand, powershellQuote } from './platform.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BINDING = new RegExp(`^b_${UUID}$`), TOKEN = new RegExp(`^${UUID}$`);
const ENV_KEYS = new Set(['AGENT_DIALOGUE_STATE_DIR', 'AGENT_DIALOGUE_CACHE_DIR', 'AGENT_DIALOGUE_LEDGER', 'AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE', 'AGENT_DIALOGUE_KIMI_SERVICE_FILE', 'AGENT_DIALOGUE_ZCODE_SERVICE_FILE', 'AGENT_DIALOGUE_CODEX_SOCKET', 'CODEX_HOME', 'PATH', 'SSH_AUTH_SOCK']);
const CONFIG_KEYS = ['version', 'bindingId', 'token', 'taskName', 'executable', 'workerPath', 'projectDir', 'logPath', 'arguments', 'env'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const printable = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const fail = message => { throw new Error(`Windows worker: ${message}`); };
function identity(bindingId, token) {
  if (!BINDING.test(bindingId || '') || !TOKEN.test(token || '')) fail('invalid binding ID or worker token.');
  return `AgentDialogue-${bindingId}-${token}`;
}
function launchDirectory(stateDir) { return join(stateDir, 'dialogue', 'windows-workers'); }
function launchPath(stateDir, bindingId, token) { return join(launchDirectory(stateDir), `${bindingId}.${token}.launch.json`); }

/** Windows CRT argv encoding, for an Exec action that never runs through a shell. */
export function windowsArgument(value) {
  if (!printable(value)) fail('invalid native action argument.');
  return '"' + value.replace(/(\\*)"/g, (_, slashes) => slashes + slashes + '\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function actionArguments(config, path) { return [config.workerPath, config.bindingId, '--token', config.token, '--launch-config', path].map(windowsArgument).join(' '); }
function selectedEnvironment(context) {
  const env = {};
  for (const key of ENV_KEYS) if (context.env?.[key] !== undefined) env[key] = context.env[key];
  if (!env.PATH && typeof context.env?.Path === 'string') env.PATH = context.env.Path;
  env.AGENT_DIALOGUE_STATE_DIR = context.stateDir;
  if (context.cacheDir) env.AGENT_DIALOGUE_CACHE_DIR = context.cacheDir;
  env.AGENT_DIALOGUE_LEDGER = context.ledgerBackend || env.AGENT_DIALOGUE_LEDGER || 'embedded';
  validateEnvironment(env);
  return env;
}
function validateEnvironment(env) {
  if (!object(env) || Object.keys(env).some(key => !ENV_KEYS.has(key))) fail('unexpected launch environment field.');
  for (const [key, value] of Object.entries(env)) if (!printable(value) || Buffer.byteLength(value) > (key === 'PATH' ? 32768 : 8192)) fail('invalid launch environment.');
  if (!isAbsolute(env.AGENT_DIALOGUE_STATE_DIR || '') && !absoluteRemotePath(env.AGENT_DIALOGUE_STATE_DIR, 'powershell')) fail('launch state directory must be absolute.');
  if (!['embedded', 'hcom'].includes(env.AGENT_DIALOGUE_LEDGER)) fail('invalid launch ledger.');
}
export function parseWorkerArguments(args) {
  if (!Array.isArray(args) || ![3, 5].includes(args.length) || args[1] !== '--token') fail('expected exact binding ID and worker token.');
  const [bindingId, , token] = args; identity(bindingId, token);
  if (args.length === 5 && (args[3] !== '--launch-config' || !printable(args[4]))) fail('invalid worker launch-config option.');
  return { bindingId, token, launchConfigPath: args.length === 5 ? args[4] : null };
}
async function regular(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('launch path must be a regular private file or directory.');
  return info;
}
function validateConfig(config, path, bindingId, token) {
  if (!object(config) || Object.keys(config).length !== CONFIG_KEYS.length || CONFIG_KEYS.some(key => !Object.hasOwn(config, key)) || config.version !== 1) fail('invalid launch configuration schema.');
  if (config.bindingId !== bindingId || config.token !== token || config.taskName !== identity(bindingId, token)) fail('launch identity/token does not match this worker.');
  validateEnvironment(config.env);
  const expectedPath = launchPath(config.env.AGENT_DIALOGUE_STATE_DIR, bindingId, token);
  if (resolve(path) !== resolve(expectedPath)) fail('launch configuration is outside the matching worker scope.');
  for (const key of ['executable', 'workerPath', 'projectDir']) if (!absoluteRemotePath(config[key], 'powershell')) fail('native action paths must be absolute Windows paths.');
  if (!printable(config.logPath) || resolve(config.logPath) !== resolve(join(config.env.AGENT_DIALOGUE_STATE_DIR, 'dialogue', `${bindingId}.worker.log`))) fail('launch log must be the exact binding log.');
  if (config.arguments !== actionArguments(config, path) || config.arguments.length > 16000) fail('native task arguments do not match this exact worker.');
  return config;
}
export async function loadWindowsWorkerConfig(path, { bindingId, token } = {}) {
  identity(bindingId, token);
  if (!isAbsolute(path || '')) fail('launch config path must be absolute.');
  await regular(dirname(path), true);
  const before = await regular(path);
  if (before.size > 65536) fail('launch config exceeds its limit.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let value;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > 65536) fail('launch config changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length > 65536) fail('launch config exceeds its limit.');
    value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
  return validateConfig(value, path, bindingId, token);
}
export function applyWindowsWorkerEnvironment(selected, env = process.env) {
  validateEnvironment(selected);
  for (const key of Object.keys(env)) if (/^(?:HCOM_|AGENT_DIALOGUE_|CODEX_|CLAUDE_)/.test(key) || key.toLowerCase() === 'path') delete env[key];
  Object.assign(env, selected);
}
function powershellInvocation(script, env) {
  const words = powershellCommand(script).split(' ');
  const executable = env?.SystemRoot && absoluteRemotePath(env.SystemRoot, 'powershell')
    ? win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : words[0];
  return { executable, args: words.slice(1) };
}
async function invoke(script, { runner, env, category }) {
  const { executable, args } = powershellInvocation(script, env);
  let result;
  try { result = await runner(executable, args, { capture: true, timeout: 15000, env }); }
  catch { throw Object.assign(new Error(`Windows worker: ${category} outcome is uncertain; inspect the owned task before retrying.`), { uncertain: true }); }
  if (result?.code !== 0) fail(`${category} failed; inspect the exact owned task locally.`);
  try { return JSON.parse(result.stdout); }
  catch { throw Object.assign(new Error(`Windows worker: ${category} returned invalid evidence; inspect the owned task.`), { uncertain: true }); }
}
const comSetup = "$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\');$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;";
const findTask = '$t=$null;foreach($x in $f.GetTasks(1)){if($x.Name -ceq $n){$t=$x;break}};';
// Definition checks intentionally precede DeleteTask. No Stop/kill API is used.
const assertOwned = "$d=$t.Definition;if($d.Triggers.Count-ne 0-or $d.Actions.Count-ne 1){throw 'Task ownership mismatch'};$a=$d.Actions.Item(1);$u=$d.Principal.UserId;if($u-ne $sid){$u=([Security.Principal.NTAccount]$u).Translate([Security.Principal.SecurityIdentifier]).Value};if($d.RegistrationInfo.Description-cne $mark-or $u-ne $sid-or $d.Principal.LogonType-ne 3-or $d.Principal.RunLevel-ne 0-or $a.Type-ne 0-or $a.Path-cne $c.executable-or $a.Arguments-cne $c.arguments-or $a.WorkingDirectory-cne $c.projectDir){throw 'Task ownership mismatch'};";
function preamble(path) { return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$c=Get-Content -LiteralPath ${powershellQuote(path)} -Raw -Encoding UTF8|ConvertFrom-Json;$n=$c.taskName;$mark='agent-dialogue/windows-worker/1 '+$c.bindingId+' '+$c.token;`; }

/** Start one demand-only, current-user task. It survives the SSH client's job. */
export async function startWindowsWorker(context, { bindingId, token, workerPath, projectDir, logPath, runner = run, nodeExecutable = process.execPath } = {}) {
  const taskName = identity(bindingId, token);
  if (!isAbsolute(context?.stateDir || '')) fail('dedicated absolute state directory is required.');
  const dir = launchDirectory(context.stateDir), path = launchPath(context.stateDir, bindingId, token);
  for (const part of [context.stateDir, join(context.stateDir, 'dialogue'), dir]) {
    await mkdir(part, { recursive: true, mode: 0o700 });
    await regular(part, true);
  }
  try { await lstat(path); fail('launch config already exists; refusing overwrite.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const acl = `$ErrorActionPreference='Stop';$p=${powershellQuote(dir)};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r);[IO.Directory]::SetAccessControl($p,$a);[Console]::Out.Write('{"secured":true}');`;
  const secured = await invoke(acl, { runner, env: context.env, category: 'private launch-directory ACL' });
  if (secured?.secured !== true) fail('private launch directory was not secured.');
  const config = { version: 1, bindingId, token, taskName, executable: nodeExecutable, workerPath, projectDir, logPath, arguments: '', env: selectedEnvironment(context) };
  config.arguments = actionArguments(config, path);
  validateConfig(config, path, bindingId, token);
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const script = preamble(path) + comSetup + findTask +
    "if($null-ne $t){throw 'Task already exists; refusing overwrite'};$d=$s.NewTask(0);$d.RegistrationInfo.Description=$mark;$d.Principal.UserId=$sid;$d.Principal.LogonType=3;$d.Principal.RunLevel=0;$d.Settings.ExecutionTimeLimit='PT0S';$d.Settings.MultipleInstances=2;$d.Settings.DisallowStartIfOnBatteries=$false;$d.Settings.StopIfGoingOnBatteries=$false;$d.Settings.AllowDemandStart=$true;$a=$d.Actions.Create(0);$a.Path=$c.executable;$a.Arguments=$c.arguments;$a.WorkingDirectory=$c.projectDir;" +
    // An elevated SSH creator otherwise gives the Limited principal only FR.
    // Grant this current SID full access to this one task so it can clean itself.
    "$sd='D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;'+$sid+')';$t=$f.RegisterTaskDefinition($n,$d,2,$sid,$null,3,$sd);try{$t.Run($null)|Out-Null}catch{$f.DeleteTask($n,0);throw};[Console]::Out.Write((@{taskName=$n;registered=$true;started=$true}|ConvertTo-Json -Compress));";
  try {
    const result = await invoke(script, { runner, env: context.env, category: 'task registration/start' });
    if (result?.taskName !== taskName || result.registered !== true || result.started !== true) throw Object.assign(new Error('Windows worker: task registration returned mismatched ownership evidence.'), { uncertain: true });
  } catch (error) {
    // Known failures never remove a foreign task. Unknown scheduler outcomes
    // retain this small descriptor so an operator can reconcile ownership.
    if (!error.uncertain) await rm(path, { force: true });
    throw error;
  }
  return { taskName, launchConfigPath: path, launcher: 'windows-scheduled-task' };
}

/** Called by this exact worker after its native/ledger cleanup has completed. */
export async function cleanupWindowsWorker(bindingId, token, { launchConfigPath, runner = run, env = process.env } = {}) {
  const config = await loadWindowsWorkerConfig(launchConfigPath, { bindingId, token });
  const script = preamble(launchConfigPath) + comSetup + findTask +
    "if($null-eq $t){[Console]::Out.Write((@{taskName=$n;removed=$false}|ConvertTo-Json -Compress));exit 0};" + assertOwned +
    "$f.DeleteTask($n,0);[Console]::Out.Write((@{taskName=$n;removed=$true}|ConvertTo-Json -Compress));";
  const result = await invoke(script, { runner, env, category: 'task cleanup' });
  if (result?.taskName !== config.taskName || typeof result.removed !== 'boolean') fail('task cleanup returned mismatched ownership evidence.');
  await rm(launchConfigPath);
  return result;
}
