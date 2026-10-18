import test from 'node:test';
import assert from 'node:assert/strict';
import { permittedVpsCommand } from '../scripts/vps-integration-contract.mjs';
import { permittedCodexEvidenceCommand } from '../scripts/vps-command-evidence.mjs';

// All identities and paths are synthetic; this test executes no shell or model.
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const runId = 'vps-integration-20990101-v1';
function scope(extra = {}) {
  return { node: '/synthetic/node', cli: '/synthetic/tool/bin/agent-dialogue.mjs',
    stateDir: '/synthetic/owned/state', cacheDir: '/synthetic/cache',
    codexHome: '/synthetic/codex-home', codexSocket: '/synthetic/control.sock',
    room: 'r_11111111-1111-4111-8111-111111111111', from: 'owned-codex', to: 'owned-vps',
    expectedSession: 'ses_synthetic_owned_vps', runId, replyTo: null, queue: true, ...extra };
}
function command(s = scope(), body = `Owned synthetic discussion ${runId}.`) {
  return [
    `AGENT_DIALOGUE_STATE_DIR=${quote(s.stateDir)}`, `AGENT_DIALOGUE_CACHE_DIR=${quote(s.cacheDir)}`,
    `CODEX_HOME=${quote(s.codexHome)}`, `AGENT_DIALOGUE_CODEX_SOCKET=${quote(s.codexSocket)}`,
    quote(s.node), quote(s.cli), 'collab', 'send', ...(s.queue ? ['--queue'] : []),
    '--room', quote(s.room), '--from', quote(s.from), '--to', quote(s.to),
    '--expected-session', quote(s.expectedSession), ...(s.replyTo ? ['--reply-to', quote(s.replyTo)] : []),
    '--message', quote(body),
  ].join(' ');
}
const wrapper = (inner = command(), shell = '/bin/zsh') => `${shell} -lc ${quote(inner)}`;

test('Codex command evidence accepts a bare strict pinned communication command', () => {
  assert.equal(permittedCodexEvidenceCommand(command(), scope()), true);
  const replyScope = scope({ replyTo: 'm_22222222-2222-4222-8222-222222222222' });
  assert.equal(permittedCodexEvidenceCommand(command(replyScope), replyScope), true);
});

test('Codex command evidence accepts only one exact supported absolute shell -lc wrapper', () => {
  for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/bash']) {
    assert.equal(permittedCodexEvidenceCommand(wrapper(command(), shell), scope()), true, shell);
  }
});

test('Codex evidence wrapper preserves safe literal message punctuation without evaluating it', () => {
  const inner = command(scope(), `Literal '$()' and \`text\` ; | < > & ${runId}.`);
  assert.equal(permittedCodexEvidenceCommand(wrapper(inner), scope()), true);
});

test('Codex evidence does not widen the OpenCode permission matcher', () => {
  const wrapped = wrapper();
  assert.equal(permittedCodexEvidenceCommand(wrapped, scope()), true);
  assert.equal(permittedVpsCommand(wrapped, scope()), false);
  assert.equal(permittedVpsCommand(command(), scope()), true);
});

test('Codex evidence rejects unsupported or relative shells and alternate outer flags', () => {
  for (const outer of [
    wrapper(command(), 'zsh'), wrapper(command(), '/usr/bin/zsh'), wrapper(command(), '/bin/sh'),
    wrapper(command(), '/synthetic/bash'), wrapper(command(), '/bin/../bin/zsh'),
    `/bin/zsh -c ${quote(command())}`, `/bin/zsh --login ${quote(command())}`,
    `/bin/bash -l -c ${quote(command())}`, `/bin/zsh -lc`,
    `/bin/zsh --noprofile -lc ${quote(command())}`, `env ${wrapper()}`,
  ]) assert.equal(permittedCodexEvidenceCommand(outer, scope()), false, outer);
});

test('Codex evidence rejects extra outer arguments, environment assignments and shell operators', () => {
  for (const outer of [
    `${wrapper()} extra`, `${wrapper()} --`, `${wrapper()} 'extra argument'`,
    `HOME=/synthetic/other ${wrapper()}`, `PATH=/synthetic/other ${wrapper()}`,
    `${wrapper()}; arbitrary`, `${wrapper()} && arbitrary`, `${wrapper()} | arbitrary`,
    `${wrapper()} > /synthetic/output`, `/bin/zsh -lc "$(arbitrary)"`,
  ]) assert.equal(permittedCodexEvidenceCommand(outer, scope()), false);
});

test('Codex evidence rejects nested wrappers even when their innermost command is strict', () => {
  assert.equal(permittedCodexEvidenceCommand(wrapper(wrapper()), scope()), false);
  assert.equal(permittedCodexEvidenceCommand(wrapper(wrapper(command(), '/bin/bash'), '/usr/bin/bash'), scope()), false);
});

test('Codex evidence revalidates every inner route, session, runtime pin and queue flag', () => {
  for (const [field, value] of Object.entries({
    node: '/synthetic/other-node', cli: '/synthetic/other-cli', stateDir: '/synthetic/other-state',
    cacheDir: '/synthetic/other-cache', codexHome: '/synthetic/other-home', codexSocket: '/synthetic/other-socket',
    room: 'r_33333333-3333-4333-8333-333333333333', from: 'other-agent', to: 'operator',
    expectedSession: 'ses_synthetic_wrong', queue: false,
  })) assert.equal(permittedCodexEvidenceCommand(wrapper(command(scope({ [field]: value }))), scope()), false, field);
  assert.equal(permittedCodexEvidenceCommand(wrapper(command().replace(/--expected-session '[^']+'/, '')), scope()), false);
});

test('Codex evidence rejects inner injections and unknown flags despite safe outer quoting', () => {
  for (const inner of [
    `${command()}; arbitrary`, `${command()} && arbitrary`, `${command()} | arbitrary`,
    `${command()} > /synthetic/output`, `${command()} --force`, `${command()} --queue`,
    command().replace(quote(scope().node), '"$(arbitrary)"'),
    command().replace('collab send', 'node flush'), `OPENAI_API_KEY=synthetic ${command()}`,
  ]) assert.equal(permittedCodexEvidenceCommand(wrapper(inner), scope()), false);
});

test('Codex evidence preserves strict run marker and global reply requirements', () => {
  assert.equal(permittedCodexEvidenceCommand(wrapper(command(scope(), 'Unrelated text')), scope()), false);
  assert.equal(permittedCodexEvidenceCommand(wrapper(command(scope(), 'vps-integration-20990101-v10')), scope()), false);
  for (const replyTo of ['42', 'q_22222222-2222-4222-8222-222222222222']) {
    const selected = scope({ replyTo });
    assert.equal(permittedCodexEvidenceCommand(wrapper(command(selected)), selected), false);
  }
});

test('Codex evidence fails closed for malformed input and leaves scope unchanged', () => {
  const selected = scope(), original = structuredClone(selected);
  for (const value of [null, undefined, {}, [], 42, '', "'unterminated", 'x'.repeat(20001)]) {
    assert.equal(permittedCodexEvidenceCommand(value, selected), false);
  }
  assert.equal(permittedCodexEvidenceCommand(wrapper(), selected), true);
  assert.deepEqual(selected, original);
});
