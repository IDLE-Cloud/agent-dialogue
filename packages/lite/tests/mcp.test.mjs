import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { callTool, serveTools } from '../lib/mcp.mjs';

const msg = 'msg_11111111-1111-4111-8111-111111111111';
const room = 'room_22222222-2222-4222-8222-222222222222';
const agent = 'agent_33333333-3333-4333-8333-333333333333';
const sendArgs = { id: msg, room, to: [agent], text: '请检查已有方案' };

async function session(t, request) {
  const input = new PassThrough(), output = new PassThrough(), replies = [], waiters = new Map();
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      replies.push(reply); waiters.get(reply.id)?.(reply); waiters.delete(reply.id);
    }
  });
  const done = serveTools({ client: { request }, input, output });
  t.after(async () => { input.end(); await done; });
  const send = (id, method, params) => {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP fixture response timed out.')), 2000); timeout.unref();
      waiters.set(id, value => { clearTimeout(timeout); resolve(value); });
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };
  const init = await send('init', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture-harness', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'agent-dialogue-lite');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { send, replies };
}

test('MCP wire offers exactly four closed tools; injected identity never reaches Hub', async t => {
  const requests = [], h = await session(t, async (...args) => { requests.push(args); return { accepted: true }; });
  const listed = (await h.send(1, 'tools/list')).result.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['context', 'send', 'inbox', 'status']);
  for (const tool of listed) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'from'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'self'), false);
  }
  for (const [index, arguments_] of [{ ...sendArgs, from: agent }, { ...sendArgs, self: agent }, { ...sendArgs, id: 'msg_random-label' }, { after: 0, room }].entries()) {
    const name = index === 3 ? 'inbox' : 'send';
    const response = await h.send(index + 2, 'tools/call', { name, arguments: arguments_ });
    assert.equal(response.result.isError, true);
  }
  assert.equal(requests.length, 0);
  const sent = await h.send(8, 'tools/call', { name: 'send', arguments: sendArgs, _meta: { self: 'spoofed' } });
  assert.equal(sent.result.structuredContent.accepted, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].slice(0, 3), ['POST', '/v1/messages', { ...sendArgs, replyTo: null }]);
  assert.equal(JSON.stringify(requests[0]).includes('spoofed'), false);
});

test('send failure retains original message ID and hides transport secrets; retry uses identical ID', async () => {
  const requests = [], client = { request: async (...args) => {
    requests.push(args);
    if (requests.length === 1) throw new Error('https://user:DO_NOT_EXPOSE@private/path');
    return { accepted: true, message: { id: msg } };
  } };
  const lost = await callTool(client, 'send', sendArgs);
  assert.equal(lost.isError, true);
  assert.equal(lost.structuredContent.messageId, msg);
  assert.match(lost.structuredContent.error.message, /same message ID/);
  assert.equal(JSON.stringify(lost).includes('DO_NOT_EXPOSE'), false);
  const retried = await callTool(client, 'send', sendArgs);
  assert.equal(retried.structuredContent.accepted, true);
  assert.deepEqual(requests[0].slice(0, 3), requests[1].slice(0, 3));
});

test('UTF-8 size bound rejects oversized multibyte message before sending', async () => {
  let called = false;
  const response = await callTool({ request: async () => { called = true; } }, 'send', { ...sendArgs, text: '文'.repeat(22000) });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, 'text_too_large');
  assert.equal(response.structuredContent.messageId, msg);
  assert.equal(called, false);
});

test('context and status are reads; inbox cursor can be repeated after a lost tool result', async () => {
  const requests = [], item = { seq: 42, message: { id: msg, text: '正文' }, delivery: { state: 'tool-read' } };
  const client = { request: async (...args) => { requests.push(args); return { items: [item], cursor: 42 }; } };
  const a = await callTool(client, 'inbox', { after: 12, limit: 10 });
  const b = await callTool(client, 'inbox', { after: 12, limit: 10 });
  assert.deepEqual(a.structuredContent, b.structuredContent);
  assert.equal(requests[0][1], '/v1/inbox?after=12&limit=10');
  assert.deepEqual(requests[0].slice(0, 3), requests[1].slice(0, 3));
  await callTool(client, 'context', {});
  await callTool(client, 'status', { id: msg });
  assert.deepEqual(requests.slice(2).map(args => args.slice(0, 2)), [['GET', '/v1/context'], ['GET', `/v1/status?id=${msg}`]]);
});

test('Hub authorization and ID conflict failures become useful sanitized errors', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const response = await callTool({ request: async () => { throw Object.assign(new Error('DO_NOT_EXPOSE'), { status }); } }, 'send', sendArgs);
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, `hub_${status}`);
    assert.equal(response.structuredContent.messageId, msg);
    assert.equal(JSON.stringify(response).includes('DO_NOT_EXPOSE'), false);
  }
});
