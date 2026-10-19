import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { serveMcpStdio } from '../lib/mcp-stdio.mjs';

const moduleUrl = new URL('../lib/mcp-stdio.mjs', import.meta.url).href;
const tools = [{ name: 'dialogue.echo', description: 'Fixture echo', inputSchema: {
  type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 64 }, count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['text'], additionalProperties: false,
} }, { name: 'dialogue.fail', inputSchema: { type: 'object', additionalProperties: false } },
{ name: 'dialogue.wait', inputSchema: { type: 'object', additionalProperties: false } },
{ name: 'dialogue.large', inputSchema: { type: 'object', additionalProperties: false } }];

function child(t, options = {}) {
  const code = `import { serveMcpStdio } from ${JSON.stringify(moduleUrl)};
    await serveMcpStdio({ tools: ${JSON.stringify(tools)}, serverInfo: { name: 'test', version: '1.0' },
      ...${JSON.stringify(options)}, callTool: async (name, args, context) => {
      if (name === 'dialogue.fail') throw new Error('secret=DO_NOT_EXPOSE');
      if (name === 'dialogue.wait') await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      if (name === 'dialogue.large') return { content: [{ type: 'text', text: 'x'.repeat(10000) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ name, args, protocolVersion: context.protocolVersion, requestMeta: context.requestMeta }) }] };
    } });`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], waiters = [];
  let buffer = '', stderr = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const value = JSON.parse(line); messages.push(value);
      while (waiters.length && messages.length >= waiters[0].count) waiters.shift().resolve();
    }
  });
  proc.stderr.on('data', value => { stderr += value; });
  t.after(() => { proc.stdin.destroy(); proc.kill(); });
  const send = value => proc.stdin.write(`${JSON.stringify(value)}\n`);
  const wait = async count => {
    if (messages.length < count) await Promise.race([new Promise(resolve => waiters.push({ count, resolve })), new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP child timeout: ${stderr}`)), 3000).unref())]);
    return messages[count - 1];
  };
  const initialize = async (version = '2025-11-25') => {
    send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    const response = await wait(messages.length + 1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return response;
  };
  return { proc, messages, send, wait, initialize, getStderr: () => stderr };
}

test('real subprocess performs initialization, list and call with stdout containing only MCP frames', async t => {
  const h = child(t), init = await h.initialize();
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual((await h.wait(2)).result.tools, tools);
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: '你好\nworld', count: 2 } } });
  const result = (await h.wait(3)).result;
  assert.deepEqual(JSON.parse(result.content[0].text), { name: 'dialogue.echo', args: { text: '你好\nworld', count: 2 }, protocolVersion: '2025-11-25' });
  assert.equal(h.getStderr(), '');
});

test('supported historical versions are echoed and an unsupported version negotiates the latest', async t => {
  for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', 'future-unknown']) {
    const h = child(t), response = await h.initialize(version);
    assert.equal(response.result.protocolVersion, version === 'future-unknown' ? '2025-11-25' : version);
  }
});

test('tools/call metadata reaches its separate context and arguments cannot impersonate it', async t => {
  const h = child(t); await h.initialize();
  const requestMeta = { 'com.zcode/request-context': { session_id: 'real-native-session', runtime_scope: 'main', workspace_path: '/fixture', client_mode: 'gui' } };
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'ok' }, _meta: requestMeta } });
  const received = JSON.parse((await h.wait(2)).result.content[0].text);
  assert.deepEqual(received.requestMeta, requestMeta);
  assert.deepEqual(received.args, { text: 'ok' });
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'ok', _meta: requestMeta } } });
  assert.equal((await h.wait(3)).result.isError, true);
  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'ok' }, _meta: [] } });
  assert.equal((await h.wait(4)).error.code, -32602);
});

test('tools are gated behind both initialization messages and duplicate initialize is rejected', async t => {
  const h = child(t);
  h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await h.wait(1)).error.code, -32002);
  h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  await h.wait(2);
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal((await h.wait(3)).error.code, -32002);
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  assert.equal((await h.wait(4)).error.code, -32600);
});

test('parse failures, batch, malformed IDs, wrong RPC and unknown methods return bounded protocol errors', async t => {
  const h = child(t);
  h.proc.stdin.write('not json secret=DO_NOT_EXPOSE\n');
  assert.equal((await h.wait(1)).error.code, -32700);
  for (const [index, value] of [[], { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '1.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'ping', params: [] }].entries()) {
    h.send(value); assert.equal((await h.wait(index + 2)).error.code, -32600);
  }
  h.send({ jsonrpc: '2.0', id: 5, method: 'unknown.secret=DO_NOT_EXPOSE' });
  assert.equal((await h.wait(6)).error.code, -32601);
  assert.equal(JSON.stringify(h.messages).includes('DO_NOT_EXPOSE'), false);
});

test('notifications never produce replies or execute calls, while ping remains available before initialize', async t => {
  const h = child(t);
  h.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'notification' } } });
  h.send({ jsonrpc: '2.0', method: 'notifications/unknown' });
  h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.deepEqual(await h.wait(1), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(h.messages.length, 1);
});

test('invalid input schemas fail at startup rather than silently accepting unvalidated input', async () => {
  for (const inputSchema of [{ type: 'object', patternProperties: { x: { type: 'string' } } }, { type: 'object', properties: { x: { type: 'string', format: 'email' } } }, { type: 'object', required: ['missing'], properties: {} }, { type: 'object', $schema: 'unsupported' }]) {
    await assert.rejects(serveMcpStdio({ tools: [{ name: 'bad', inputSchema }], callTool: async () => ({}), input: new PassThrough(), output: new PassThrough() }), /schema/i);
  }
});

test('tool parameters are closed, typed and bounded; errors never include rejected argument values', async t => {
  const h = child(t); await h.initialize();
  const invalid = [{}, { text: '' }, { text: 'ok', count: 1.5 }, { text: 'ok', count: 4 }, { text: 'x'.repeat(65) }, { text: 'ok', secret: 'DO_NOT_EXPOSE' }, { text: 2 }];
  for (const [index, args] of invalid.entries()) {
    h.send({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'dialogue.echo', arguments: args } });
    const response = await h.wait(index + 2); assert.equal(response.result.isError, true);
  }
  assert.equal(JSON.stringify(h.messages).includes('DO_NOT_EXPOSE'), false);
});

test('unknown tool and malformed call envelopes are protocol errors, business exceptions are sanitized tool errors', async t => {
  const h = child(t); await h.initialize();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not-installed' } });
  assert.equal((await h.wait(2)).error.code, -32602);
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dialogue.echo', arguments: [] } });
  assert.equal((await h.wait(3)).error.code, -32602);
  h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dialogue.fail' } });
  assert.equal((await h.wait(4)).result.isError, true);
  assert.equal(JSON.stringify(h.messages).includes('DO_NOT_EXPOSE'), false);
  assert.equal(h.getStderr().includes('DO_NOT_EXPOSE'), false);
});

test('duplicate request IDs are rejected without executing a second call', async t => {
  const h = child(t); await h.initialize();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'one' } } });
  await h.wait(2);
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'two' } } });
  assert.equal((await h.wait(3)).error.code, -32600);
});

test('cancellation aborts the exact running call and a busy server remains responsive to ping', async t => {
  const h = child(t, { maxConcurrentCalls: 1 }); await h.initialize();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.wait' } });
  h.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: 'too busy' } } });
  assert.equal((await h.wait(2)).error.code, -32000);
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'secret=DO_NOT_EXPOSE' } });
  h.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  await h.wait(4);
  assert.deepEqual(h.messages.find(value => value.id === 4).result, {});
  assert.equal(h.messages.find(value => value.id === 2).result.isError, true);
  assert.equal(JSON.stringify(h.messages).includes('DO_NOT_EXPOSE'), false);
});

test('oversized frames are drained with one error and following messages can be read', async t => {
  const h = child(t, { maxFrameBytes: 1024 });
  h.proc.stdin.write('x'.repeat(8192)); h.proc.stdin.write('\n');
  h.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await h.wait(1)).error.code, -32600);
  assert.deepEqual((await h.wait(2)).result, {});
});

test('UTF-8 split across pipe chunks is preserved and malformed UTF-8 is rejected', async t => {
  const h = child(t); await h.initialize();
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.echo', arguments: { text: '中文' } } })}\n`);
  const position = bytes.indexOf(Buffer.from('中')) + 1;
  h.proc.stdin.write(bytes.subarray(0, position));
  h.proc.stdin.write(bytes.subarray(position));
  assert.equal(JSON.parse((await h.wait(2)).result.content[0].text).args.text, '中文');
  h.proc.stdin.write(Buffer.from([0xff, 10]));
  assert.equal((await h.wait(3)).error.code, -32700);
});

test('oversized results return bounded errors and EOF exits without extra protocol noise', async t => {
  const h = child(t, { maxResultBytes: 1024 }); await h.initialize();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.large' } });
  assert.equal((await h.wait(2)).result.isError, true);
  assert.ok(JSON.stringify(h.messages[1]).length < 1024);
  const closed = once(h.proc, 'close'); h.proc.stdin.end();
  assert.deepEqual(await closed, [0, null]); assert.equal(h.getStderr(), '');
});

test('EOF aborts an in-flight operation and incomplete final frames never execute', async t => {
  const h = child(t); await h.initialize();
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dialogue.wait' } });
  const closed = once(h.proc, 'close');
  h.proc.stdin.end('{"jsonrpc":"2.0","id":3,"method":"tools/call"');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(h.messages.some(value => value.id === 3), false);
});
