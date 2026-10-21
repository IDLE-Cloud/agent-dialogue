/** Post-execution Codex evidence only; never a tool-permission decision. */
import { permittedVpsCommand, shellTokens } from './vps-integration-contract.mjs';

const SUPPORTED_SHELLS = new Set(['/bin/zsh', '/bin/bash', '/usr/bin/bash']);

export function permittedCodexEvidenceCommand(command, scope) {
  if (permittedVpsCommand(command, scope)) return true;
  try {
    const tokens = shellTokens(command);
    return tokens.length === 3 && SUPPORTED_SHELLS.has(tokens[0]) && tokens[1] === '-lc' && permittedVpsCommand(tokens[2], scope);
  } catch { return false; }
}
