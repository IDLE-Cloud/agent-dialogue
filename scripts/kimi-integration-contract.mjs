import { posix, win32 } from 'node:path';

// Verification fixture only, never called by the production adapter. Official
// Kimi 2.1.1/2.2.0 Bash.resolveExecution exposes this command display. Omitting
// approval body.scope grants only the pending call; scope:'session' is forbidden.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clean = value => typeof value === 'string' && value.length > 0 && value.length <= 40000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
function directory(value) {
  if (!clean(value)) return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) return win32.normalize(value).toLowerCase();
  return posix.isAbsolute(value) ? posix.normalize(value) : null;
}
function reject() { throw new Error('Kimi acceptance approval did not match the explicit owned command scope.'); }

/** A future promise or quoted marker is not an actual final answer. */
export function kimiAcceptanceAnswer(text, marker) {
  if (typeof text !== 'string' || typeof marker !== 'string' || !/^[A-Za-z0-9_-]+$/.test(marker)) return false;
  const value = text.trim();
  return value.startsWith(marker) && (value.length === marker.length || /^[\s:]/.test(value[marker.length]));
}

/** Global ingress carries no local numeric reply ID; the signed wire is authoritative. */
export function kimiAcceptanceRequest(frame, from, to) {
  const payload = frame?.wireEnvelope?.payload;
  return frame?.from === from && frame?.to === to && payload?.from?.alias === from && payload?.to?.alias === to && payload?.replyToMessageId === null;
}

export function kimiOnceApproval(request, scope) {
  if (!keys(scope, ['sessionId', 'directory', 'commands']) || typeof scope.sessionId !== 'string' || !/^session_[A-Za-z0-9_-]+$/.test(scope.sessionId) || !directory(scope.directory) || !Array.isArray(scope.commands) || scope.commands.length < 1 || scope.commands.length > 16 || scope.commands.some(command => !clean(command))) reject();
  if (!keys(request, ['approval_id', 'session_id', 'agent_id', 'turn_id', 'tool_call_id', 'tool_name', 'action', 'tool_input_display', 'created_at', 'expires_at']) || !clean(request.approval_id) || !/^[A-Za-z0-9_-]+$/.test(request.approval_id) || request.session_id !== scope.sessionId || request.agent_id !== 'main' || request.tool_name !== 'Bash' || !clean(request.tool_call_id)) reject();
  const display = request.tool_input_display;
  if (!keys(display, ['kind', 'command', 'cwd', 'description', 'language']) || display.kind !== 'command' || !clean(display.command) || directory(display.cwd) !== directory(scope.directory) || display.language !== undefined && display.language !== 'bash' || display.description !== undefined && typeof display.description !== 'string') reject();
  if (!scope.commands.includes(display.command)) reject();
  return { approvalId: request.approval_id, body: { decision: 'approved' } };
}
