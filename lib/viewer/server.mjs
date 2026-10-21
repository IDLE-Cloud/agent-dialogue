import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ViewerModel } from './stream.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const WEB = new URL('../../web/viewer/', import.meta.url);
const digest = input => createHash('sha256').update(input).digest('hex');
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function reject(status, message) { const error = new Error(message); error.status = status; throw error; }
function parameters(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) reject(400, 'Unknown or repeated query parameter.');
  }
}
function filters(url, model) {
  const result = {};
  for (const key of ['source', 'participant', 'status', 'q']) {
    const value = url.searchParams.get(key);
    if (value) {
      if (value.length > (key === 'q' ? 200 : 256)) reject(400, 'Filter is too long.');
      result[key] = value;
    }
  }
  if (result.source && !model.specs.some(s => s.id === result.source)) reject(400, 'Unknown registered source.');
  return result;
}
function selection(url, model) {
  const roomId = url.searchParams.get('room');
  const room = model.projection.rooms.find(item => item.id === roomId);
  if (!room) reject(404, 'Room is not present in the registered sources.');
  const selected = filters(url, model);
  const messages = model.projection.messages.filter(message => message.roomId === room.id &&
    (!selected.source || message.sourceIds.includes(selected.source)) &&
    (!selected.participant || [message.from, message.to].some(person => person?.alias === selected.participant || person?.bindingId === selected.participant)) &&
    (!selected.status || message.statuses.includes(selected.status)) &&
    (!selected.q || message.text.toLocaleLowerCase().includes(selected.q.toLocaleLowerCase())));
  return { room, messages, filters: selected };
}
export function markdownExport(document) {
  const { room, messages, scope } = document;
  const lines = [`# Agent dialogue: ${room.name}`, '', `Room: ${room.roomId}`, `Exported: ${document.exportedAt}`, `Scope: ${JSON.stringify(scope)}`, '', 'Evidence is an observation of the selected local sources, not proof of model completion.', ''];
  for (const message of messages) {
    const runs = message.text.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    lines.push(`## ${message.from?.alias || '?'} → ${message.to?.alias || '?'} · ${message.timestamp || 'time unknown'}`, '', `Message ID: ${message.id}`, `Identity: ${JSON.stringify({ from: message.from, to: message.to })}`, `Evidence states: ${message.statuses.join(', ') || 'unconfirmed'}`, `Reply: ${JSON.stringify(message.replyTo)}`, '', fence, message.text, fence, '', 'Evidence:', '', ...message.evidence.map(item => `- ${JSON.stringify(item)}`), '', ...message.issues.map(issue => `Issue: ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`), '');
  }
  return lines.join('\n');
}

/** Only serves the sources given by the CLI. No endpoint can send, resume, or mutate a source. */
export async function createViewer({ sources, port = 0, pollMs = 750, reader, projector, ringSize = 128 } = {}) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('At least one explicit source is required.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535.');
  const model = new ViewerModel(sources, { pollMs, ...(reader ? { reader } : {}), ...(projector ? { projector } : {}), ringSize });
  await model.refresh();
  const token = randomBytes(32).toString('base64url');
  const cookieName = `ad_view_${randomBytes(8).toString('hex')}`;
  const clients = new Set();
  const secret = randomBytes(32);
  let origin, host;
  function cursor(value) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  }
  function decodeCursor(encoded) {
    if (encoded.length > 4096) reject(400, 'Invalid page cursor.');
    const [payload, signature, extra] = encoded.split('.');
    if (extra || !equal(signature, createHmac('sha256', secret).update(payload || '').digest('base64url'))) reject(400, 'Invalid page cursor.');
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { reject(400, 'Invalid page cursor.'); }
  }
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const server = createServer(async (req, res) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== host) reject(403, 'Unexpected Host. Use the printed loopback URL.');
      if (req.headers.origin && req.headers.origin !== origin) reject(403, 'Cross-origin access is disabled.');
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); reject(405, 'This viewer only accepts GET.'); }
      const url = new URL(req.url, origin);
      if (url.pathname === '/' && url.searchParams.has('token')) {
        parameters(url, ['token']);
        if (!equal(url.searchParams.get('token'), token)) reject(403, 'Invalid viewer access link.');
        res.writeHead(303, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
        res.end(); return;
      }
      const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
      if (!cookies.some(cookie => equal(cookie, `${cookieName}=${token}`))) reject(401, 'Open the access link printed by agent-dialogue view.');
      if (req.headers['sec-fetch-site'] === 'cross-site') reject(403, 'Cross-site requests are disabled.');
      if (assets.has(url.pathname)) {
        parameters(url, []);
        const [name, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(new URL(name, WEB))); return;
      }
      if (url.pathname === '/api/snapshot') { parameters(url, []); json(model.snapshot()); return; }
      if (url.pathname === '/api/message') {
        parameters(url, ['id']);
        const message = model.projection.messages.find(m => m.id === url.searchParams.get('id'));
        if (!message) reject(404, 'Message is outside the loaded source history.');
        json({ message }); return;
      }
      if (url.pathname === '/api/messages') {
        parameters(url, ['room', 'before', 'limit', 'source', 'participant', 'status', 'q']);
        const selected = selection(url, model);
        const requested = url.searchParams.get('limit') || '100';
        if (!/^\d{1,3}$/.test(requested) || +requested < 1 || +requested > 100) reject(400, 'Page limit must be 1–100.');
        const scopeHash = digest(JSON.stringify([selected.room.id, selected.filters]));
        let end = selected.messages.length;
        if (url.searchParams.has('before')) {
          const previous = decodeCursor(url.searchParams.get('before'));
          if (previous.scope !== scopeHash || previous.epoch !== model.epoch) reject(409, 'Page scope changed; reload the room.');
          end = selected.messages.findIndex(message => message.id === previous.anchor);
          if (end < 0) reject(409, 'Page anchor changed; reload the room.');
        }
        const start = Math.max(0, end - +requested);
        const messages = selected.messages.slice(start, end);
        json({ revision: model.revision, messages, hasMore: start > 0, nextCursor: start > 0 ? cursor({ scope: scopeHash, epoch: model.epoch, anchor: messages[0].id }) : null, scope: { roomId: selected.room.id, filters: selected.filters, count: messages.length, total: selected.messages.length, range: 'registered-source-history', sourceFilterMode: 'message-membership', evidenceScope: 'all-collected-copies' } });
        return;
      }
      if (url.pathname === '/api/export') {
        parameters(url, ['room', 'format', 'source', 'participant', 'status', 'q']);
        const format = url.searchParams.get('format') || 'json';
        if (!['json', 'markdown'].includes(format)) reject(400, 'Export format must be json or markdown.');
        const selected = selection(url, model);
        // A source filter selects logical messages with a copy in that source. Their other
        // collected evidence remains attached, with freshness metadata for every referenced source.
        const sourceIds = [...new Set([...(selected.filters.source ? [selected.filters.source] : selected.room.sourceIds), ...selected.messages.flatMap(message => message.sourceIds)])];
        const document = { version: 1, exportedAt: new Date().toISOString(), scope: { roomId: selected.room.id, filters: selected.filters, count: selected.messages.length, range: 'registered-source-history', sourceFilterMode: 'message-membership', evidenceScope: 'all-collected-copies' }, sources: model.snapshot().sources.filter(source => sourceIds.includes(source.id)), room: selected.room, messages: selected.messages, diagnostics: model.projection.diagnostics.filter(item => !item.sourceId || sourceIds.includes(item.sourceId)) };
        res.setHeader('Content-Disposition', `attachment; filename="agent-dialogue.${format === 'json' ? 'json' : 'md'}"`);
        if (format === 'json') json(document);
        else { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); res.end(markdownExport(document)); }
        return;
      }
      if (url.pathname === '/api/events') {
        parameters(url, []);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const emit = event => {
          if (res.writableLength > 1024 * 1024) { res.end(); return; }
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        };
        for (const event of model.replay(req.headers['last-event-id'])) emit(event);
        const beat = setInterval(() => res.write(': observation heartbeat\n\n'), 15000);
        beat.unref();
        model.on('update', emit);
        clients.add(res);
        req.on('close', () => { clearInterval(beat); model.off('update', emit); clients.delete(res); });
        return;
      }
      reject(404, 'Unknown read-only viewer endpoint.');
    } catch (error) {
      if (!res.headersSent) json({ error: error.status ? error.message : 'Viewer request failed.' }, error.status || 500);
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  await new Promise((done, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => { server.off('error', rejectListen); done(); });
  }).catch(async error => { await model.close(); throw error; });
  host = `127.0.0.1:${server.address().port}`;
  origin = `http://${host}`;
  model.start();
  return { origin, url: `${origin}/?token=${token}`, model, async close() {
    await model.close();
    for (const client of clients) client.end();
    await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
  } };
}
