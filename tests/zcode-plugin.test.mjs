import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../config/zcode-plugin/', import.meta.url));
const plugin = join(root, 'plugins', 'agent-dialogue');
const hook = join(plugin, 'hooks', 'context.mjs');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const scope = directory => ({ version: 1, room: { id: 'room_fixture', revision: 1 }, self: { alias: 'fixture-zcode', harness: 'zcode-tools', sessionId: 'sess_fixture_exact', directory } });
async function fixture(t, config) {
  const dir = await mkdtemp(join(tmpdir(), 'dialogue-zcode-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'context.json');
  await writeFile(file, JSON.stringify(config ?? scope(dir)), { mode: 0o600 });
  return { dir, file };
}
function run(input, env = {}) {
  const environment = { ...process.env };
  for (const key of ['AGENT_DIALOGUE_ZCODE_CONTEXT', 'ZCODE_PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']) delete environment[key];
  const result = spawnSync(process.execPath, [hook], { input: typeof input === 'string' ? input : JSON.stringify(input) + '\n', encoding: 'utf8', env: { ...environment, ...env }, timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('ZCode marketplace references an in-tree plugin with matching published version and canonical MCP config', async () => {
  const market = await json(join(root, 'marketplace.json'));
  const manifest = await json(join(plugin, '.zcode-plugin', 'plugin.json'));
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, './plugins/agent-dialogue');
  assert.equal(market.plugins[0].name, manifest.name);
  assert.equal(market.plugins[0].version, manifest.version);
  assert.equal(manifest.hooks, undefined, 'standard hooks/hooks.json must not be registered twice');
  assert.equal(manifest.mcpServers, '.mcp.json');
  assert.equal(manifest.userConfig.service_file.type, 'file');
  assert.equal(manifest.userConfig.service_file.required, true);
  assert.equal(manifest.userConfig.context_file.type, 'string', 'bootstrap must accept a not-yet-created private context path');
  const mcp = (await json(join(plugin, '.mcp.json'))).mcpServers['agent-dialogue'];
  assert.equal(mcp.type, 'stdio');
  assert.equal(mcp.protocolVersion, 'legacy', 'declare the verified tools JSON-RPC era explicitly');
  assert.equal(mcp.command, '${user_config.node_executable}');
  assert.deepEqual(mcp.args, ['${user_config.agent_dialogue_root}/bin/agent-dialogue.mjs', 'mcp', '--zcode-service', '${user_config.service_file}', '--context', '${user_config.context_file}']);
  assert.equal(mcp.env.AGENT_DIALOGUE_STATE_DIR, '${user_config.state_dir}');
  assert.equal(mcp.env.AGENT_DIALOGUE_LEDGER, 'embedded');
});

test('plugin uses only synchronous SessionStart process hook and does not modify permissions or Stop', async () => {
  const hooks = (await json(join(plugin, 'hooks', 'hooks.json'))).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
  assert.equal(hooks.SessionStart.length, 1);
  const item = hooks.SessionStart[0].hooks[0];
  assert.equal(item.type, 'process');
  assert.equal(item.command, 'node');
  assert.deepEqual(item.args, ['${ZCODE_PLUGIN_ROOT}/hooks/context.mjs']);
  assert.equal(item.async, undefined);
  assert.equal(item.timeoutMs, 5000);
});

test('matching exact native session and directory receives identity and pull-only communication guidance', async t => {
  const f = await fixture(t);
  const result = run({ hook_event_name: 'SessionStart', session_id: 'sess_fixture_exact', cwd: f.dir, source: 'startup', transcript_path: '/do-not-read/transcript.jsonl' }, { AGENT_DIALOGUE_ZCODE_CONTEXT: f.file });
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /sess_fixture_exact/);
  assert.match(output.hookSpecificOutput.additionalContext, /dialogue_inbox/);
  assert.match(output.hookSpecificOutput.additionalContext, /sessionId/);
  assert.equal(result.stderr, '');
});

test('wrong session, wrong directory and non-SessionStart never inject another chat context', async t => {
  const f = await fixture(t);
  for (const input of [
    { hook_event_name: 'SessionStart', session_id: 'other_session', cwd: f.dir },
    { hook_event_name: 'SessionStart', session_id: 'sess_fixture_exact', cwd: join(f.dir, 'other') },
    { hook_event_name: 'Stop', session_id: 'sess_fixture_exact', cwd: f.dir },
    { hook_event_name: 'SessionStart', session_id: { value: 'sess_fixture_exact' }, cwd: f.dir },
  ]) {
    const result = run(input, { AGENT_DIALOGUE_ZCODE_CONTEXT: f.file });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('sess_fixture_exact'), false);
    assert.equal(result.stderr.includes(f.dir), false);
  }
});

test('plugin-data context lookup is explicit and does not search a workspace or transcript', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'agent-dialogue-context.json'), JSON.stringify(scope(f.dir)), { mode: 0o600 });
  const input = { hook_event_name: 'SessionStart', session_id: 'sess_fixture_exact', cwd: f.dir };
  assert.equal(run(input).stdout, '');
  assert.match(JSON.parse(run(input, { ZCODE_PLUGIN_DATA: f.dir }).stdout).hookSpecificOutput.additionalContext, /fixture-zcode/);
});

test('missing or malformed context, invalid JSON, multiple frames and oversized input remain non-blocking and private', async t => {
  const f = await fixture(t);
  const input = { hook_event_name: 'SessionStart', session_id: 'sess_fixture_exact', cwd: f.dir };
  assert.equal(run(input, { AGENT_DIALOGUE_ZCODE_CONTEXT: join(f.dir, 'missing') }).stdout, '');
  await writeFile(f.file, '{bad private=DO_NOT_EXPOSE');
  for (const raw of [JSON.stringify(input), '{bad private=DO_NOT_EXPOSE', JSON.stringify(input)+'\n'+JSON.stringify(input), 'x'.repeat(65537)]) {
    const result = run(raw, { AGENT_DIALOGUE_ZCODE_CONTEXT: f.file });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('DO_NOT_EXPOSE'), false);
  }
});

test('context shape does not coerce session identity or accept an unrelated harness', async t => {
  const f = await fixture(t);
  const input = { hook_event_name: 'SessionStart', session_id: 'sess_fixture_exact', cwd: f.dir };
  for (const changed of [{ ...scope(f.dir), self: { ...scope(f.dir).self, sessionId: ['sess_fixture_exact'] } }, { ...scope(f.dir), self: { ...scope(f.dir).self, harness: 'opencode' } }]) {
    await writeFile(f.file, JSON.stringify(changed));
    assert.equal(run(input, { AGENT_DIALOGUE_ZCODE_CONTEXT: f.file }).stdout, '');
  }
});


test('plugin usage distinguishes candidate registration, exact operator assignment and tool-read', async () => {
  for (const path of [join(plugin, 'commands', 'dialogue.md'), join(plugin, 'skills', 'agent-dialogue', 'SKILL.md')]) {
    const text = await readFile(path, 'utf8');
    assert.match(text, /dialogue_identity/);
    assert.match(text, /candidate/);
    assert.match(text, /operator/i);
    assert.match(text, /requestKey/);
    assert.match(text, /not.*native|not.*injected native/);
    assert.match(text, /dialogue_status/);
  }
});


test('ZCode guide distinguishes UI MCP import wrapper from native project config and pins legacy mode', async () => {
  const text = await readFile(new URL('../docs/ZCODE.md', import.meta.url), 'utf8');
  // Git may check Markdown out as CRLF on Windows; the example contract is
  // independent of checkout line endings. Exercise both from the same source.
  for (const content of [text.replaceAll('\r\n', '\n'), text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')]) {
    const blocks = [...content.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match => JSON.parse(match[1]));
    const imported = blocks.find(block => block.mcpServers)?.mcpServers?.['agent-dialogue'];
    const native = blocks.find(block => block.mcp?.servers)?.mcp?.servers?.['agent-dialogue'];
    assert.ok(imported, 'UI complete configuration example must use mcpServers');
    assert.ok(native, 'native project configuration must use mcp.servers');
    assert.deepEqual(native, imported, 'only the wrapper differs between the two examples');
    assert.equal(native.protocolVersion, 'legacy');
  }
  assert.match(text, /29628c9acdb81b703bbd4080c207a0e7ce5e276e/);
  assert.match(text, /plugins\/mcp\.ts/);
});
