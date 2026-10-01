import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Auth } from './auth.mjs';
import { Generations } from './generation.mjs';
import { HttpError, fail, id, now, body, text, object, settings, providerConfig, attachmentData } from './validation.mjs';
import { listModels } from './provider.mjs';
import { importConversations, exportConversations } from './transfer.mjs';
import { sandboxPolicy, sandboxDocument } from './sandbox.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/diagrams.js', ['diagrams.js', 'text/javascript; charset=utf-8']], ['/touch.js', ['touch.js', 'text/javascript; charset=utf-8']],
  ['/previews.js', ['previews.js', 'text/javascript; charset=utf-8']],
  ['/diagram-source.js', ['diagram-source.js', 'text/javascript; charset=utf-8']],
  ['/vendor/rich-text.js', ['vendor/rich-text.js', 'text/javascript; charset=utf-8']],
  ['/vendor/mermaid.js', ['vendor/mermaid.js', 'text/javascript; charset=utf-8']]
]);
export async function createApp(options = {}) {
  const store = new Store(options.dataDir ?? process.env.DATA_DIR ?? './data');
  const expectedOrigin = options.publicUrl ?? process.env.PUBLIC_URL ?? null;
  let publicUrl;
  try {
    if (expectedOrigin) {
      publicUrl = new URL(expectedOrigin);
      if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error();
    }
  } catch { store.close(); throw new Error('PUBLIC_URL must be an HTTP or HTTPS origin without a path or credentials.'); }
  // Trusted-local access requires a loopback listener and a restricted reverse proxy.
  const trustedLocal = options.trustedLocal ?? process.env.CHAT_TRUSTED_LOCAL === 'true';
  if (trustedLocal && !publicUrl) { store.close(); throw new Error('Trusted-local access requires an explicit PUBLIC_URL.'); }
  const auth = new Auth(store, publicUrl?.protocol === 'https:');
  let bootstrapPassword;
  try {
    const initialPassword = await auth.initialize(options.password ?? process.env.CHAT_PASSWORD);
    if (!trustedLocal) bootstrapPassword = initialPassword;
  }
  catch (e) { store.close(); throw e; }
  const subscribers = new Set();
  const emit = event => {
    for (const subscriber of subscribers) {
      if (subscriber.res.writableLength > 1024 * 1024) { subscriber.res.end(); subscribers.delete(subscriber); continue; }
      subscriber.res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const generations = new Generations(store, emit, options.generationOptions);
  function originFor(req) {
    return publicUrl?.origin ?? `http://${req.headers.host}`;
  }
  function checkHost(req) {
    const allowed = publicUrl?.host ?? `127.0.0.1:${server.address().port}`;
    const localAlias = !publicUrl && [`localhost:${server.address().port}`, `[::1]:${server.address().port}`].includes(req.headers.host);
    if (req.headers.host !== allowed && !localAlias) fail(403, 'Host not allowed. Set PUBLIC_URL to the browser-facing origin.');
  }
  function send(res, data, status = 200) {
    const bytes = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(bytes) }); res.end(bytes);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (publicUrl?.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      checkHost(req);
      if (trustedLocal && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403, 'Trusted-local access requires a loopback reverse proxy.');
      const url = new URL(req.url, 'http://internal'), path = url.pathname, method = req.method;
      if (method === 'GET' && path === '/healthz') { send(res, { status: 'ok' }); return; }
      // CORS applies only to this public renderer bundle, never to chat APIs.
      if (method === 'GET' && path === '/sandbox-mermaid.js') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(join(publicDir, 'vendor/mermaid.js'))); return;
      }
      if (method === 'GET' && path === '/sandbox') {
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy', sandboxPolicy(originFor(req), url.searchParams.get('external') === '1', url.searchParams.get('automatic') === '1'));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(sandboxDocument()); return;
      }
      if (method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        res.setHeader('Content-Type', type); res.end(readFileSync(join(publicDir, file))); return;
      }
      if (!path.startsWith('/api/')) fail(404, 'Not found.');
      if (req.headers.origin && req.headers.origin !== originFor(req)) fail(403, 'Cross-origin requests are not permitted.');
      if (!['GET', 'HEAD'].includes(method)) {
        if (req.headers['x-chat-request'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) fail(403, 'A same-origin JSON request is required.');
      }
      if (path === '/api/login' && method === 'POST') {
        if (trustedLocal) { send(res, { authenticated: true }); return; }
        const input = await body(req, 4096), token = await auth.login(req, input.password);
        res.setHeader('Set-Cookie', auth.cookie(token)); send(res, { authenticated: true }); return;
      }
      const tokenHash = trustedLocal ? null : auth.require(req);
      if (path === '/api/session' && method === 'GET') {
        send(res, { authenticated: true, authenticationRequired: !trustedLocal, account: 'owner', settings: JSON.parse(store.get('SELECT settings FROM account WHERE id=1').settings), version: '0.1.0' }); return;
      }
      if (path === '/api/logout' && method === 'POST') {
        if (trustedLocal) { send(res, { authenticated: true }); return; }
        store.run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
        for (const s of subscribers) if (s.tokenHash === tokenHash) { s.res.end(); subscribers.delete(s); }
        res.setHeader('Set-Cookie', auth.cookie('', 0)); send(res, { authenticated: false }); return;
      }
      if (path === '/api/preferences' && method === 'PUT') {
        const value = await body(req, 4096);
        const prefs = {};
        if (value.theme !== undefined) { if (!['light','dark','system'].includes(value.theme)) fail(400, 'Invalid theme.'); prefs.theme = value.theme; }
        if (value.providerId !== undefined) prefs.providerId = text(value.providerId, 'providerId', 100, true);
        if (value.model !== undefined) prefs.model = text(value.model, 'model', 300, true);
        const current = JSON.parse(store.get('SELECT settings FROM account WHERE id=1').settings);
        store.run('UPDATE account SET settings=? WHERE id=1', JSON.stringify({ ...current, ...prefs }));
        emit({ type: 'preferences' }); send(res, { ...current, ...prefs }); return;
      }
      if (path === '/api/events' && method === 'GET') {
        if (subscribers.size >= 50) fail(429, 'Too many live browser connections.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 1500\ndata: ${JSON.stringify({ type: 'hello' })}\n\n`);
        const subscriber = { res, tokenHash }; subscribers.add(subscriber);
        const heartbeat = setInterval(() => {
          const session = trustedLocal ? null : store.get('SELECT expires FROM sessions WHERE token_hash=?', tokenHash);
          if (!trustedLocal && (!session || session.expires <= now())) res.end();
          else res.write(': heartbeat\n\n');
        }, 15000);
        res.on('close', () => { clearInterval(heartbeat); subscribers.delete(subscriber); });
        return;
      }
      if (path === '/api/providers' && method === 'GET') { send(res, store.providers()); return; }
      const providerMatch = /^\/api\/providers\/([^/]+)(?:\/(models))?$/.exec(path);
      if ((path === '/api/providers' && method === 'POST') || (providerMatch && !providerMatch[2] && method === 'PUT')) {
        const input = await body(req, 256 * 1024), config = providerConfig(input);
        const existing = providerMatch ? store.provider(providerMatch[1]) : null;
        if (!existing && store.providers().length >= 100) fail(400, 'At most 100 connections are allowed.');
        const pid = existing?.id ?? id();
        let key = existing?.api_key ?? null;
        if (input.clearKey === true) key = null;
        if (input.apiKey) key = store.encrypt(text(input.apiKey, 'apiKey', 8000));
        store.run(`INSERT INTO providers(id,name,base_url,api_key,models,capabilities,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key=excluded.api_key,models=excluded.models,capabilities=excluded.capabilities`,
          pid, config.name, config.baseUrl, key, JSON.stringify(config.models), JSON.stringify(config.capabilities), now());
        emit({ type: 'providers' }); send(res, store.providers().find(p => p.id === pid), existing ? 200 : 201); return;
      }
      if (providerMatch && providerMatch[2] === 'models' && method === 'GET') {
        send(res, { models: await listModels(store.provider(providerMatch[1])) }); return;
      }
      if (providerMatch && !providerMatch[2] && method === 'DELETE') {
        store.provider(providerMatch[1]);
        const used = store.get("SELECT j.id FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.status='running' AND m.provider_id=?", providerMatch[1]);
        if (used) fail(409, 'Stop active generations before deleting this connection.');
        store.run('DELETE FROM providers WHERE id=?', providerMatch[1]); emit({ type: 'providers' }); send(res, { deleted: true }); return;
      }
      if (path === '/api/conversations' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''; text(q, 'search', 500, true);
        send(res, store.list(q)); return;
      }
      if (path === '/api/conversations' && method === 'POST') {
        const input = await body(req, 128 * 1024), cid = store.createConversation(text(input.title ?? 'New chat', 'title', 500), settings(input.settings ?? {}));
        emit({ type: 'changed', conversationId: cid }); send(res, store.snapshot(cid), 201); return;
      }
      const conversationMatch = /^\/api\/conversations\/([^/]+)(?:\/(generate|attachments|export))?$/.exec(path);
      if (conversationMatch) {
        const [, cid, action] = conversationMatch;
        if (!action && method === 'GET') { send(res, store.snapshot(cid)); return; }
        if (!action && method === 'PATCH') {
          const input = await body(req, 128 * 1024), c = store.conversation(cid);
          store.assertVersion(c, input.expectedVersion); store.assertIdle(cid);
          const title = input.title === undefined ? c.title : text(input.title, 'title', 500);
          let leaf = input.activeLeaf === undefined ? c.active_leaf : input.activeLeaf;
          if (leaf !== null) { text(leaf, 'activeLeaf', 100); store.path(cid, leaf); }
          const opts = input.settings === undefined ? c.settings : JSON.stringify(settings(input.settings));
          store.run('UPDATE conversations SET title=?,active_leaf=?,settings=? WHERE id=?', title, leaf, opts, cid);
          store.touch(cid); emit({ type: 'changed', conversationId: cid }); send(res, store.snapshot(cid)); return;
        }
        if (!action && method === 'DELETE') {
          const input = await body(req, 4096), c = store.conversation(cid);
          store.assertVersion(c, input.expectedVersion); store.assertIdle(cid); store.deleteConversation(cid);
          emit({ type: 'deleted', conversationId: cid }); send(res, { deleted: true }); return;
        }
        if (action === 'generate' && method === 'POST') { send(res, generations.submit(cid, await body(req, 2 * 1024 * 1024)), 202); return; }
        if (action === 'attachments' && method === 'POST') {
          store.conversation(cid);
          const pending = store.get('SELECT count(*) AS n FROM attachments WHERE conversation_id=? AND message_id IS NULL', cid).n;
          if (pending >= 100) fail(400, 'This conversation has too many unattached files. Remove unused files before upload.');
          send(res, store.addAttachment(cid, attachmentData(await body(req, 15 * 1024 * 1024))), 201); return;
        }
        if (action === 'export' && method === 'GET') {
          res.setHeader('Content-Disposition', 'attachment; filename="conversation.common-chat.json"');
          send(res, exportConversations(store, cid)); return;
        }
      }
      const fileMatch = /^\/api\/attachments\/([^/]+)$/.exec(path);
      if (fileMatch && method === 'GET') {
        const a = store.get('SELECT * FROM attachments WHERE id=?', fileMatch[1]);
        if (!a) fail(404, 'Attachment not found.');
        res.setHeader('Content-Type', a.kind === 'image' ? a.mime : 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `${a.kind === 'image' ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.name).replace(/'/g, '%27')}`);
        res.end(store.readAttachment(a)); return;
      }
      if (fileMatch && method === 'DELETE') {
        const a = store.get('SELECT * FROM attachments WHERE id=?', fileMatch[1]);
        if (!a) fail(404, 'Attachment not found.');
        if (a.message_id) fail(409, 'This file belongs to a saved message. Delete the conversation to remove it.');
        store.run('DELETE FROM attachments WHERE id=?', a.id);
        const { unlinkSync } = await import('node:fs');
        try { unlinkSync(join(store.files, a.id)); } catch {}
        send(res, { deleted: true }); return;
      }
      const requestMatch = /^\/api\/requests\/([^/]+)$/.exec(path);
      if (requestMatch && method === 'GET') {
        const request = store.get('SELECT response FROM requests WHERE id=?', requestMatch[1]);
        if (!request) fail(404, 'Request not found.');
        send(res, JSON.parse(request.response)); return;
      }
      const jobMatch = /^\/api\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(path);
      if (jobMatch && jobMatch[2] === 'cancel' && method === 'POST') { send(res, generations.cancel(jobMatch[1])); return; }
      if (jobMatch && !jobMatch[2] && method === 'GET') {
        const job = store.get('SELECT * FROM jobs WHERE id=?', jobMatch[1]);
        if (!job) fail(404, 'Generation not found.'); send(res, job); return;
      }
      if (path === '/api/import' && method === 'POST') {
        const result = importConversations(store, await body(req)); emit({ type: 'changed' }); send(res, result, 201); return;
      }
      if (path === '/api/export' && method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="common-chat-export.json"'); send(res, exportConversations(store)); return;
      }
      fail(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500 && options.logErrors !== false) console.error('Request failed:', error?.name, error?.code ?? 'internal error');
      send(res, { error: status === 500 ? 'An internal error occurred. Check the server logs.' : error.message }, status);
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxHeadersCount = 50;
  let stopped = false;
  return {
    server, store, auth, generations, bootstrapPassword,
    async listen(port = 3000, host = '127.0.0.1') {
      if (trustedLocal && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Trusted-local access must listen on loopback only.');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      return `http://${address}:${server.address().port}`;
    },
    async close() {
      if (stopped) return; stopped = true;
      await generations.stop();
      for (const subscriber of subscribers) subscriber.res.end(); subscribers.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      store.close();
    }
  };
}
