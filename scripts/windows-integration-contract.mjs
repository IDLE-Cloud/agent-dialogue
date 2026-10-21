/** Pure contracts for explicitly owned Windows acceptance. No network or process operations. */
// Official V1 tag 1.19.0 (733b2c627e5aec39cb33cc22373bdce33053ef2c):
// packages/opencode/src/tool/shell.ts: ask() puts the complete command in metadata.command;
// patterns are independently parsed command sources. Native always suggestions are not approved.
// GET /permission returns PermissionV1.Request[]; POST /permission/{requestID}/reply accepts {reply:'once'}.
// Provider V1 costs are one object with optional tiers/experimentalOver200K, not V2 cost arrays.

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 20000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
const sessionId = value => typeof value === 'string' && /^ses_[A-Za-z0-9]+$/.test(value);
const exactKeys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
function invalid() { throw new Error('Invalid owned Windows acceptance contract.'); }

/** Deliberately no trimming, tokenization, shell interpretation, or wrapper removal. */
export function normalizeWindowsAcceptanceCommand(command) {
  if (typeof command !== 'string') invalid();
  const normalized = command.replaceAll('\r\n', '\n');
  if (!text(normalized)) invalid();
  return normalized;
}

function patternsOf(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) invalid();
  const normalized = values.map(normalizeWindowsAcceptanceCommand);
  if (new Set(normalized).size !== normalized.length) invalid();
  return normalized;
}

export function permittedWindowsPermission(request, scope) {
  try {
    if (!plain(scope) || !sessionId(scope.sessionId) || !Array.isArray(scope.commands) || scope.commands.length < 1 || scope.commands.length > 16) return false;
    if (!exactKeys(request, ['id', 'sessionID', 'permission', 'patterns', 'metadata', 'always', 'tool']) ||
        !/^per_[A-Za-z0-9]+$/.test(request.id ?? '') || request.sessionID !== scope.sessionId || request.permission !== 'bash' ||
        !plain(request.metadata) || Object.keys(request.metadata).length !== 1 || !Object.hasOwn(request.metadata, 'command') ||
        !Array.isArray(request.always) || request.always.length > 32 || request.always.some(value => !text(value))) return false;
    if (request.tool !== undefined && (!exactKeys(request.tool, ['messageID', 'callID']) || Object.keys(request.tool).length !== 2 ||
        !/^msg_[A-Za-z0-9_-]+$/.test(request.tool.messageID ?? '') || !text(request.tool.callID))) return false;
    const command = normalizeWindowsAcceptanceCommand(request.metadata.command), patterns = patternsOf(request.patterns);
    const candidates = scope.commands.map(entry => {
      if (!exactKeys(entry, ['command', 'patterns']) || Object.keys(entry).length !== 2) invalid();
      return { command: normalizeWindowsAcceptanceCommand(entry.command), patterns: patternsOf(entry.patterns) };
    });
    return candidates.some(entry => entry.command === command && entry.patterns.length === patterns.length && patterns.every(pattern => entry.patterns.includes(pattern)));
  } catch { return false; }
}

/** Only construct once after a positive check; never remember patterns or touch foreign sessions. */
export function onceWindowsPermissionReply(request, scope) {
  if (!permittedWindowsPermission(request, scope)) throw new Error('Owned Windows permission did not match the explicit command scope.');
  return { requestId: request.id, body: { reply: 'once' } };
}

function zeroPrice(value, extraKeys = []) {
  return exactKeys(value, ['input', 'output', 'cache', ...extraKeys]) && value.input === 0 && value.output === 0 &&
    exactKeys(value.cache, ['read', 'write']) && Object.keys(value.cache).length === 2 && value.cache.read === 0 && value.cache.write === 0;
}

export function hasZeroCostV1Model(model) {
  if (!plain(model) || model.status !== 'active' || model.enabled === false || !zeroPrice(model.cost, ['tiers', 'experimentalOver200K'])) return false;
  if (Object.hasOwn(model.cost, 'tiers')) {
    if (!Array.isArray(model.cost.tiers) || !model.cost.tiers.every(tier => zeroPrice(tier, ['tier']) && exactKeys(tier.tier, ['type', 'size']) && tier.tier.type === 'context' && typeof tier.tier.size === 'number' && Number.isFinite(tier.tier.size) && tier.tier.size > 0)) return false;
  }
  if (Object.hasOwn(model.cost, 'experimentalOver200K') && !zeroPrice(model.cost.experimentalOver200K)) return false;
  return true;
}

export function selectZeroCostV1Model(catalog, { providerID, modelID } = {}) {
  const fail = () => { throw new Error('V1 catalog does not establish an exact connected zero-cost model.'); };
  if (!plain(catalog) || !Array.isArray(catalog.all) || !Array.isArray(catalog.connected) || !text(providerID) || !text(modelID)) fail();
  if (catalog.connected.filter(id => id === providerID).length !== 1) fail();
  const providers = catalog.all.filter(provider => plain(provider) && provider.id === providerID);
  if (providers.length !== 1 || !plain(providers[0].models) || !Object.hasOwn(providers[0].models, modelID)) fail();
  const selected = providers[0].models[modelID];
  if (!plain(selected) || selected.id !== modelID || selected.providerID !== providerID || !hasZeroCostV1Model(selected)) fail();
  return selected;
}

function runIdOf(value) {
  if (typeof value !== 'string') invalid();
  const match = /^windows-integration-([0-9]{4})([0-9]{2})([0-9]{2})-v([1-9][0-9]{0,5})$/.exec(value);
  if (!match) invalid();
  const iso = `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) invalid();
  return value;
}
function dateOf(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; }
function countOf(value) { if (!Number.isSafeInteger(value) || value < 0) invalid(); return value; }

/** Closed projection: native identities, raw errors, commands, paths, and arbitrary labels never pass through. */
export function publicWindowsMetrics(input) {
  if (!plain(input) || !plain(input.versions) || !plain(input.checks) || !plain(input.permissions) ||
      !['running', 'passed', 'failed'].includes(input.status) || typeof input.zeroCostVerified !== 'boolean' ||
      typeof input.versions.node !== 'string' || !/^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(input.versions.node) || input.versions.opencode !== '1.19.0') invalid();
  const checks = Object.values(input.checks);
  if (checks.some(value => typeof value !== 'boolean')) invalid();
  const runId = runIdOf(input.runId), startedAt = dateOf(input.startedAt), finishedAt = input.finishedAt == null ? null : dateOf(input.finishedAt);
  if (finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) invalid();
  const passed = checks.filter(Boolean).length;
  if (input.status === 'passed' && (!finishedAt || !checks.length || passed !== checks.length || !input.zeroCostVerified)) throw new Error('Invalid passed Windows acceptance metrics.');
  return {
    version: 1, run_id: runId, status: input.status, started_at: startedAt, finished_at: finishedAt,
    scope: 'one owned native Windows OpenCode V1 chat; signed room; existing FRP SSH transport', transport: 'ssh-frp',
    software: { node: input.versions.node, opencode: input.versions.opencode }, zero_cost_verified: input.zeroCostVerified,
    checks: { total: checks.length, passed, failed: checks.length - passed },
    permissions: { once: countOf(input.permissions.once), rejected: countOf(input.permissions.rejected), foreign_ignored: countOf(input.permissions.foreignIgnored) },
  };
}
