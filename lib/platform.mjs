import { posix, win32, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const printable = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
export const posixQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const powershellQuote = value => "'" + String(value).replaceAll("'", "''") + "'";

export function absoluteRemotePath(value, shell = 'posix') {
  if (!printable(value) || !value) return false;
  if (shell === 'posix') return posix.isAbsolute(value);
  if (shell === 'powershell') return /^[a-z]:[\\/]/i.test(value) && win32.isAbsolute(value);
  return false;
}

/** Signed directory metadata belongs to the peer's OS; never resolve it locally. */
export function canonicalPeerDirectory(value) {
  if (!printable(value) || !value) return false;
  return (posix.isAbsolute(value) && posix.normalize(value) === value) ||
    (/^[a-z]:[\\/]/i.test(value) && win32.isAbsolute(value) && win32.normalize(value) === value);
}

/** The encoded program contains only owner-selected paths/environment, never message text. */
export function powershellCommand(script) {
  if (typeof script !== 'string' || script.includes('\0')) throw new Error('Invalid PowerShell script.');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  if (command.length > 7600) throw new Error('PowerShell command exceeds the Windows cmd command limit.');
  return command;
}

export function remoteProcessCommand(executable, args, { shell = 'posix', env = {} } = {}) {
  if (!['posix', 'powershell'].includes(shell)) throw new Error('Unsupported remote shell.');
  if (!absoluteRemotePath(executable, shell)) throw new Error('Invalid absolute remote executable.');
  if (!Array.isArray(args) || args.some(value => !printable(value))) throw new Error('Invalid remote argument.');
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !printable(value)) throw new Error('Invalid remote environment.');
  }
  if (shell === 'posix') {
    const entries = Object.entries(env).map(([key, value]) => `${key}=${posixQuote(value)}`);
    return ['env', ...entries, posixQuote(executable), ...args.map(posixQuote)].join(' ');
  }
  const settings = Object.entries(env).map(([key, value]) => `$env:${key}=${powershellQuote(value)}`);
  const command = `& ${powershellQuote(executable)} ${args.map(powershellQuote).join(' ')}`;
  return powershellCommand([
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    ...settings, command, 'exit $LASTEXITCODE',
  ].join('; '));
}

export function windowsProcessQuery(pid, env = process.env) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid process PID.');
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -ne $p){[Console]::Out.Write($p.CommandLine)}`;
  return {
    executable: env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/** Native tool commands use the shell explicitly recorded by the owning service. */
export function cliCommand(context, args = [], { shell = process.platform === 'win32' ? 'powershell' : 'posix' } = {}) {
  const values = { AGENT_DIALOGUE_STATE_DIR: context.stateDir };
  if (context.cacheDir) values.AGENT_DIALOGUE_CACHE_DIR = context.cacheDir;
  for (const key of ['AGENT_DIALOGUE_LEDGER', 'AGENT_DIALOGUE_HCOM', 'AGENT_DIALOGUE_OPENCODE_SERVICE_FILE', 'AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE', 'CODEX_HOME', 'AGENT_DIALOGUE_CODEX_SOCKET']) {
    if (context.env?.[key]) values[key] = context.env[key];
  }
  if (!['posix', 'powershell'].includes(shell)) throw new Error('Unsupported native command shell.');
  const quote = shell === 'powershell' ? powershellQuote : posixQuote;
  for (const [key, value] of Object.entries(values)) if (!printable(value)) throw new Error(`Invalid command environment ${key}.`);
  const prefix = Object.entries(values).map(([key, value]) => shell === 'powershell' ? `$env:${key}=${quote(value)};` : `${key}=${quote(value)}`).join(' ');
  // The CLI is resolved relative to this module, independent of the working directory.
  const cliPath = fileURLToPath(new URL('../bin/agent-dialogue.mjs', import.meta.url));
  const executable = process.platform === 'win32' && shell === 'posix' ? process.execPath.replaceAll('\\', '/') : process.execPath;
  const tail = [executable, cliPath, ...args].map(quote).join(' ');
  return `${prefix} ${shell === 'powershell' ? '& ' : ''}${tail}`;
}
