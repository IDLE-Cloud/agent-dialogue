import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { LiteStore } from './store.mjs';

const BODY_LIMIT = 96 * 1024;
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
async function bodyOf(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) fail(415, 'content_type', 'Use application/json.');
  if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) fail(413, 'body_limit', 'Request body is too large.');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > BODY_LIMIT) fail(413, 'body_limit', 'Request body is too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_input', 'Expected a JSON object.'); return value; }
  catch (error) { if (error.status) throw error; fail(400, 'invalid_json', 'Invalid JSON body.'); }
}
function respond(response, status, body, headers = {}) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); response.end(JSON.stringify(body)); }

export async function startHub({ dbPath, adminToken, host = '127.0.0.1', port = 0, publicOrigin }) {
  if (publicOrigin !== undefined) {
    let value;
    try { value = new URL(publicOrigin); } catch { fail(400, 'invalid_origin', 'Public origin must be an HTTPS origin.'); }
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash) fail(400, 'invalid_origin', 'Public origin must be an uncredentialed HTTPS origin.');
    publicOrigin = value.origin;
  }
  const store = new LiteStore({ dbPath, adminToken });
  const waiters = new Set(); let closing = false;
  const wake = () => { for (const fn of waiters) fn(); };
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let body;
    try {
      const path = new URL(request.url, 'http://local.invalid');
      if (request.method === 'GET' && assets.has(path.pathname) && !path.search) {
        const [file, type] = assets.get(path.pathname);
        const bytes = await readFile(new URL(`../web/${file}`, import.meta.url));
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(bytes); return;
      }
      if (!path.pathname.startsWith('/v1/')) fail(404, 'not_found', 'Endpoint not found.');
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'method', 'Method not allowed.');
      const origin = request.headers.origin;
      // No CORS. Validate browser Origin against the actual listener host, not a client Host header.
      const allowedOrigins = [`http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`];
      if (publicOrigin) allowedOrigins.push(publicOrigin);
      if (['127.0.0.1', '::1', 'localhost'].includes(host)) for (const name of ['127.0.0.1', 'localhost', '[::1]']) allowedOrigins.push(`http://${name}:${server.address().port}`);
      if (origin && !allowedOrigins.includes(origin)) fail(403, 'origin', 'Cross-origin API requests are not allowed.');
      if (request.method === 'POST') body = await bodyOf(request);
      if (request.method === 'POST' && path.pathname === '/v1/enroll') { const result = store.enroll(body); wake(); respond(response, 200, result); return; }
      if (request.method === 'POST' && path.pathname === '/v1/viewer-session') {
        if (!origin || !allowedOrigins.includes(origin)) fail(403, 'origin', 'Viewer login requires the same browser origin.');
        const auth = store.authenticate(body.token); store.role(auth, 'viewer');
        // The cookie holds only the existing read-only viewer credential; never return it in a URL.
        respond(response, 200, { ok: true }, { 'set-cookie': `adl_viewer=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Strict; Path=/v1/${publicOrigin ? '; Secure' : ''}` }); return;
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]{24,512})$/.exec(request.headers.authorization ?? '');
      let credential = bearer?.[1], cookieAuth = false;
      if (!credential) {
        const cookie = /(?:^|;\s*)adl_viewer=([^;]+)/.exec(request.headers.cookie ?? '');
        if (cookie) { try { credential = decodeURIComponent(cookie[1]); cookieAuth = true; } catch { fail(401, 'unauthorized', 'Invalid viewer session.'); } }
      }
      const auth = store.authenticate(credential);
      if (cookieAuth) { store.role(auth, 'viewer'); if (request.method !== 'GET') fail(403, 'read_only', 'Viewer sessions are read-only.'); }
      const query = Object.fromEntries(path.searchParams);
      let result;
      const route = `${request.method} ${path.pathname}`;
      switch (route) {
        case 'POST /v1/enrollments': result = store.createEnrollment(auth); break;
        case 'POST /v1/rooms': result = store.createRoom(auth, body); break;
        case 'POST /v1/agents': result = store.registerAgent(auth, body); break;
        case 'POST /v1/members': result = store.addMember(auth, body); break;
        case 'POST /v1/scopes': result = store.issueScope(auth, body); break;
        case 'POST /v1/viewers': result = store.issueScope(auth, body, true); break;
        case 'GET /v1/context': result = store.context(auth); break;
        case 'POST /v1/messages': result = store.send(auth, body); break;
        case 'GET /v1/inbox': result = store.inbox(auth, query); break;
        case 'GET /v1/status': result = store.status(auth, query.id); break;
        case 'GET /v1/history': result = store.history(auth, query); break;
        case 'POST /v1/node/heartbeat': result = store.heartbeat(auth, body); break;
        case 'GET /v1/node/poll': {
          const waitMs = Number(query.waitMs ?? 25000);
          if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) fail(400, 'invalid_input', 'Poll wait must be 0–25000ms.');
          result = store.poll(auth);
          if (!result.deliveries.length && waitMs && !closing) {
            await new Promise(resolve => {
              const done = () => { clearTimeout(timer); waiters.delete(done); response.off('close', done); resolve(); };
              const timer = setTimeout(done, waitMs); waiters.add(done); response.once('close', done);
            });
            if (closing || response.destroyed) return;
            result = store.poll(auth);
          }
          break;
        }
        case 'POST /v1/deliveries/begin': result = store.begin(auth, body); break;
        case 'POST /v1/deliveries/result': result = store.result(auth, body); break;
        case 'POST /v1/deliveries/resolve': result = store.resolve(auth, body); break;
        default: fail(404, 'not_found', 'Endpoint not found.');
      }
      if (request.method === 'POST' && path.pathname !== '/v1/node/heartbeat') wake();
      respond(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const status = Number.isInteger(error.status) ? error.status : 500;
      respond(response, status, { error: { code: error.code && error.status ? error.code : 'internal', message: error.status ? error.message : 'Hub operation failed.' }, ...(typeof body?.id === 'string' && body.id.startsWith('msg_') ? { messageId: body.id } : {}) });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { store.close(); throw error; }
  const address = server.address();
  let closePromise;
  return { url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`, store, close() {
    if (!closePromise) {
      closing = true; wake();
      closePromise = new Promise((resolve, reject) => server.close(error => { try { store.close(); } catch (err) { reject(err); return; } if (error) reject(error); else resolve(); }));
      server.closeAllConnections();
    }
    return closePromise;
  } };
}
