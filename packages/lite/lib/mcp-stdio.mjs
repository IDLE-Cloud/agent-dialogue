// Reused unchanged transport from agent-dialogue lib/mcp-stdio.mjs at
// f576ecba35c1819ff0fb96278e51ea92541ba772; Lite supplies its own business tools.
// A bounded MCP tools-only stdio server. Wire format and lifecycle follow:
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// This is deliberately not a general MCP SDK or JSON Schema implementation.
// Static tool schemas use the validated 2020-12 subset below; unknown keywords
// fail before the server reads stdin. No HTTP, resources, prompts or sampling.
import { TextDecoder } from 'node:util';

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 || Number.isSafeInteger(value);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolError = message => ({ content: [{ type: 'text', text: message }], isError: true });
const interrupted = () => toolError('Tool call interrupted; its outcome may be unknown. Reconcile by request key before retrying.');

// Supported input schema subset: object/properties/required/additionalProperties
// (boolean); string/minLength/maxLength/pattern; integer or number/minimum/maximum;
// boolean/null; array/items/minItems/maxItems; scalar enum/const; descriptive
// title/description; optional $schema must be JSON Schema 2020-12. Schema ownership
// belongs to this program, never the connecting client. Arguments stay uncoerced.
function schemaValidator(schema, depth = 0) {
  if (!object(schema) || depth > 16) throw new Error('Unsupported MCP tool schema.');
  const fields = {
    object: ['properties', 'required', 'additionalProperties'], string: ['minLength', 'maxLength', 'pattern'],
    integer: ['minimum', 'maximum'], number: ['minimum', 'maximum'], boolean: [], null: [],
    array: ['items', 'minItems', 'maxItems'],
  };
  if (!own(fields, schema.type)) throw new Error('Unsupported MCP tool schema type.');
  const allowed = new Set(['type', 'title', 'description', '$schema', 'enum', 'const', ...fields[schema.type]]);
  if (Object.keys(schema).some(key => !allowed.has(key))) throw new Error('Unsupported MCP tool schema keyword.');
  if (own(schema, '$schema') && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('Unsupported MCP tool schema dialect.');
  if (['title', 'description'].some(key => own(schema, key) && typeof schema[key] !== 'string')) throw new Error('Invalid MCP tool schema metadata.');
  const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  if (own(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256 || !schema.enum.every(scalar))) throw new Error('Invalid MCP tool schema enum.');
  if (own(schema, 'const') && !scalar(schema.const)) throw new Error('Unsupported MCP tool schema const.');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (own(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) throw new Error('Invalid MCP tool schema bound.');
  for (const key of ['minimum', 'maximum']) if (own(schema, key) && !Number.isFinite(schema[key])) throw new Error('Invalid MCP tool schema bound.');
  for (const [min, max] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']]) if (own(schema, min) && own(schema, max) && schema[min] > schema[max]) throw new Error('Invalid MCP tool schema bound order.');
  let regex, validators = new Map(), item;
  if (schema.type === 'string' && own(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string' || schema.pattern.length > 1024) throw new Error('Invalid MCP tool schema pattern.');
    try { regex = new RegExp(schema.pattern, 'u'); } catch { throw new Error('Invalid MCP tool schema pattern.'); }
  }
  if (schema.type === 'object') {
    if (own(schema, 'properties') && !object(schema.properties)) throw new Error('Invalid MCP tool schema properties.');
    if (Object.keys(schema.properties ?? {}).length > 128) throw new Error('Too many MCP tool schema properties.');
    validators = new Map(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, schemaValidator(value, depth + 1)]));
    if (own(schema, 'required') && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !validators.has(key)) || new Set(schema.required).size !== schema.required.length)) throw new Error('Invalid MCP tool schema required fields.');
    if (own(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') throw new Error('Unsupported MCP tool schema additionalProperties.');
  }
  if (schema.type === 'array') {
    if (!own(schema, 'items')) throw new Error('MCP array schema needs an items schema.');
    item = schemaValidator(schema.items, depth + 1);
  }
  return value => {
    if (own(schema, 'enum') && !schema.enum.some(candidate => candidate === value) || own(schema, 'const') && schema.const !== value) return false;
    switch (schema.type) {
      case 'object':
        return object(value) && (schema.required ?? []).every(key => own(value, key))
          && Object.entries(value).every(([key, entry]) => validators.has(key) ? validators.get(key)(entry) : schema.additionalProperties !== false);
      case 'string': {
        if (typeof value !== 'string') return false;
        const length = [...value].length;
        return (!own(schema, 'minLength') || length >= schema.minLength) && (!own(schema, 'maxLength') || length <= schema.maxLength) && (!regex || regex.test(value));
      }
      case 'integer': case 'number':
        return (schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === 'number' && Number.isFinite(value))
          && (!own(schema, 'minimum') || value >= schema.minimum) && (!own(schema, 'maximum') || value <= schema.maximum);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      case 'array': return Array.isArray(value) && (!own(schema, 'minItems') || value.length >= schema.minItems) && (!own(schema, 'maxItems') || value.length <= schema.maxItems) && value.every(item);
      default: return false;
    }
  };
}

function prepareTools(tools) {
  if (!Array.isArray(tools) || tools.length > 64) throw new Error('MCP tools must be a bounded array.');
  let copy;
  try { copy = JSON.parse(JSON.stringify(tools)); } catch { throw new Error('MCP tools must be JSON values.'); }
  const definitions = new Map(), validators = new Map();
  for (const tool of copy) {
    if (!object(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || definitions.has(tool.name)) throw new Error('MCP tool names must be valid and unique.');
    if (!object(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('MCP tool input schema must be an object schema.');
    if (Object.keys(tool).some(key => !['name', 'title', 'description', 'inputSchema', 'annotations'].includes(key))) throw new Error('Unsupported MCP tool definition field.');
    if (['title', 'description'].some(key => own(tool, key) && typeof tool[key] !== 'string')) throw new Error('Invalid MCP tool description.');
    if (own(tool, 'annotations') && !object(tool.annotations)) throw new Error('Invalid MCP tool annotations.');
    definitions.set(tool.name, tool); validators.set(tool.name, schemaValidator(tool.inputSchema));
  }
  return { tools: copy, definitions, validators };
}

function validToolResult(result) {
  return object(result) && Array.isArray(result.content) && result.content.length <= 64
    && result.content.every(item => object(item) && item.type === 'text' && typeof item.text === 'string' && Object.keys(item).every(key => ['type', 'text'].includes(key)))
    && (!own(result, 'isError') || typeof result.isError === 'boolean')
    && (!own(result, 'structuredContent') || object(result.structuredContent))
    && Object.keys(result).every(key => ['content', 'isError', 'structuredContent'].includes(key));
}

/**
 * Serve one MCP tools session until stdin closes. `callTool(name, args, context)`
 * returns a text-only CallToolResult. Context has signal/requestId/clientInfo/
 * protocolVersion/requestMeta. requestMeta is the tools/call params._meta, not
 * model-supplied arguments; the business layer must authenticate its namespace.
 * Aborting a signal is advisory: it cannot undo a committed
 * send. The business handler must reconcile uncertain writes using its own key.
 * Handler errors are never interpolated into protocol output or diagnostics.
 */
export async function serveMcpStdio({ tools, callTool, serverInfo = { name: 'agent-dialogue', version: '0.3.0' }, instructions,
  input = process.stdin, output = process.stdout, maxFrameBytes = 262144, maxResultBytes = 524288,
  maxConcurrentCalls = 4, maxRequests = 10000 } = {}) {
  const prepared = prepareTools(tools);
  if (typeof callTool !== 'function') throw new Error('MCP callTool handler is required.');
  if (!object(serverInfo) || typeof serverInfo.name !== 'string' || !serverInfo.name || typeof serverInfo.version !== 'string' || !serverInfo.version) throw new Error('Invalid MCP serverInfo.');
  if (instructions !== undefined && typeof instructions !== 'string') throw new Error('Invalid MCP instructions.');
  for (const [name, value, min, max] of [['maxFrameBytes', maxFrameBytes, 512, 16777216], ['maxResultBytes', maxResultBytes, 512, 16777216], ['maxConcurrentCalls', maxConcurrentCalls, 1, 64], ['maxRequests', maxRequests, 1, 1000000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid MCP ${name}.`);
  }
  const listed = { tools: prepared.tools }, info = { name: serverInfo.name, version: serverInfo.version };
  if (Buffer.byteLength(JSON.stringify(listed)) > maxResultBytes || instructions && Buffer.byteLength(instructions) > maxResultBytes / 2) throw new Error('MCP metadata exceeds result bound.');
  let stage = 'new', protocolVersion, clientInfo, connected = true, writeQueue = Promise.resolve();
  const seen = new Set(), running = new Map();
  const send = message => {
    if (!connected) return Promise.resolve();
    let serialized;
    try { serialized = JSON.stringify(message); } catch { serialized = JSON.stringify(error(message.id, -32603, 'Internal result error.')); }
    if (Buffer.byteLength(serialized) > maxResultBytes) serialized = JSON.stringify(success(message.id, toolError('Tool result exceeds the configured size limit.')));
    writeQueue = writeQueue.then(() => new Promise(resolve => {
      if (!connected || output.destroyed) return resolve();
      try { output.write(`${serialized}\n`, err => { if (err) connected = false; resolve(); }); }
      catch { connected = false; resolve(); }
    }));
    return writeQueue;
  };
  // Never log stream errors, which can contain filesystem or transport details.
  const outputError = () => { connected = false; for (const controller of running.values()) controller.abort(); };
  output.on('error', outputError);
  const handle = message => {
    const hasId = object(message) && own(message, 'id');
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method || message.method.length > 256 || hasId && !validId(message.id) || own(message, 'params') && !object(message.params) || own(message, 'result') || own(message, 'error')) {
      void send(error(hasId && validId(message.id) ? message.id : null, -32600, 'Invalid request.')); return;
    }
    const { method, id, params = {} } = message;
    if (!hasId) {
      if (method === 'notifications/initialized' && stage === 'initializing') stage = 'ready';
      if (method === 'notifications/cancelled' && validId(params.requestId)) running.get(params.requestId)?.abort();
      return; // Notifications, including unknown ones, MUST NOT elicit responses.
    }
    if (seen.has(id)) { void send(error(id, -32600, 'Request ID already used in this session.')); return; }
    if (seen.size >= maxRequests) { void send(error(id, -32000, 'Session request limit reached; reconnect.')); return; }
    seen.add(id);
    if (method === 'ping') { void send(success(id, {})); return; }
    if (method === 'initialize') {
      if (stage !== 'new') { void send(error(id, -32600, 'Session already initialized.')); return; }
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion || params.protocolVersion.length > 128 || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version) { void send(error(id, -32602, 'Invalid initialization parameters.')); return; }
      protocolVersion = MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
      clientInfo = { name: params.clientInfo.name, version: params.clientInfo.version }; stage = 'initializing';
      const result = { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: info };
      if (instructions !== undefined) result.instructions = instructions;
      void send(success(id, result)); return;
    }
    if (!['tools/list', 'tools/call'].includes(method)) { void send(error(id, -32601, 'Method not found.')); return; }
    if (stage !== 'ready') { void send(error(id, -32002, 'Initialization is not complete.')); return; }
    if (method === 'tools/list') {
      if (own(params, 'cursor')) { void send(error(id, -32602, 'Unknown tools cursor.')); return; }
      void send(success(id, listed)); return;
    }
    if (typeof params.name !== 'string' || !prepared.definitions.has(params.name) || own(params, 'arguments') && !object(params.arguments) || own(params, '_meta') && !object(params._meta)) { void send(error(id, -32602, 'Unknown tool or invalid tool parameters.')); return; }
    const args = params.arguments ?? {};
    if (!prepared.validators.get(params.name)(args)) { void send(success(id, toolError('Tool arguments do not match the declared input schema.'))); return; }
    if (running.size >= maxConcurrentCalls) { void send(error(id, -32000, 'Tool concurrency limit reached; wait for an existing call.')); return; }
    const controller = new AbortController(); running.set(id, controller);
    const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(interrupted()), { once: true }));
    const operation = Promise.resolve().then(() => controller.signal.aborted ? interrupted() : callTool(params.name, args, { signal: controller.signal, requestId: id, clientInfo: { ...clientInfo }, protocolVersion, requestMeta: params._meta }))
      .then(result => validToolResult(result) ? result : toolError('Tool returned an invalid result.'))
      .catch(() => toolError('Tool execution failed. Inspect local status and reconcile by request key before retrying.'))
      .finally(() => running.delete(id));
    // Cancellation returns promptly, but an uncooperative running handler keeps
    // occupying its slot until it actually settles. No unbounded zombie calls.
    void Promise.race([operation, aborted]).then(result => send(success(id, controller.signal.aborted ? interrupted() : result)));
  };
  let fragments = [], frameBytes = 0, overflow = false;
  const frame = () => {
    if (overflow) { void send(error(null, -32600, 'Input frame exceeds the configured size limit.')); }
    else if (frameBytes) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments, frameBytes));
        handle(JSON.parse(text));
      } catch { void send(error(null, -32700, 'Parse error.')); }
    }
    fragments = []; frameBytes = 0; overflow = false;
  };
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let index = 0; index <= bytes.length; index++) {
        if (index !== bytes.length && bytes[index] !== 10) continue;
        const part = bytes.subarray(start, index);
        if (!overflow) {
          if (frameBytes + part.length > maxFrameBytes) { fragments = []; frameBytes = 0; overflow = true; }
          else if (part.length) { fragments.push(Buffer.from(part)); frameBytes += part.length; }
        }
        if (index < bytes.length) {
          frame();
          // Bound queued output even when a client keeps writing without
          // reading. Tool calls remain concurrent; only actual writes drain.
          await writeQueue;
        }
        start = index + 1;
      }
    }
    // An incomplete trailing frame is never executed, including on clean EOF.
    await writeQueue;
  } catch { /* Input transport diagnostics may be sensitive; close silently. */ }
  finally {
    connected = false;
    for (const controller of running.values()) controller.abort();
    output.off('error', outputError);
  }
}
