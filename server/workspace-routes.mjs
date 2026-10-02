import { body, fail, object } from './validation.mjs';
import { WORKSPACE_LIMITS } from './workspace.mjs';

function query(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'Invalid workspace query parameters.');
  }
  return Object.fromEntries(url.searchParams);
}
function fields(value, allowed) {
  object(value, 'workspace request');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Unknown workspace request field.');
  return value;
}

/** Call only after the application's Host, Origin, and authentication gates. */
export function createWorkspaceHandler(workspace) {
  return async function handleWorkspace({ req, res, url, method, send }) {
    const match = /^\/api\/conversations\/([^/]+)\/workspace(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    let cid;
    try { cid = decodeURIComponent(match[1]); }
    catch { fail(400, 'Invalid conversation ID.'); }
    const action = match[2] ?? 'files';
    if (action === 'files' && method === 'GET') {
      const { path, revision } = query(url, ['path', 'revision']);
      if (path === undefined && revision !== undefined) fail(400, 'A revision requires a workspace path.');
      send(res, path === undefined ? workspace.list(cid) : workspace.read(cid, path, { revision }));
    } else if (action === 'files' && method === 'PUT') {
      query(url, []);
      const input = await body(req, Math.ceil(WORKSPACE_LIMITS.binaryBytes / 3) * 4 + 8192);
      send(res, await workspace.write(cid, input), input.expectedRevision == null ? 201 : 200);
    } else if (action === 'files' && method === 'DELETE') {
      query(url, []);
      const input = fields(await body(req, 4096), ['path', 'expectedRevision', 'expectedSha256']);
      send(res, workspace.remove(cid, input.path, input.expectedRevision, input.expectedSha256));
    } else if (action === 'history' && method === 'GET') {
      const { path } = query(url, ['path']);
      send(res, workspace.history(cid, path));
    } else if (action === 'restore' && method === 'POST') {
      query(url, []);
      send(res, workspace.restore(cid, await body(req, 4096)), 201);
    } else if (action === 'search' && method === 'GET') {
      const { q, limit } = query(url, ['q', 'limit']);
      if (limit !== undefined && !/^[1-9][0-9]*$/.test(limit)) fail(400, 'Invalid workspace search limit.');
      send(res, workspace.search(cid, q, { limit: limit === undefined ? undefined : Number(limit) }));
    } else if (action === 'download' && method === 'GET') {
      const { path, revision } = query(url, ['path', 'revision']);
      const { file, bytes } = workspace.download(cid, path, { revision });
      const name = file.path.split('/').at(-1);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
        'Content-Disposition': `attachment; filename="workspace-file"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox"
      });
      res.end(bytes);
    } else fail(404, 'Workspace route not found.');
    return true;
  };
}
