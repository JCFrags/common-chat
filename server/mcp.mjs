import { fail, id, now, hash, object } from './validation.mjs';
import { McpHttpClient, MCP_PROTOCOL } from './mcp-client.mjs';
import { boundedMcpJson, mcpSchema, validateMcpValue } from './mcp-schema.mjs';

export const MCP_LIMITS = Object.freeze({ connections: 16, tools: 32, pages: 4, selectedTools: 32,
  discoveryMs: 20000, callMs: 60000, concurrent: 4, catalogBytes: 128 * 1024, resultBytes: 48 * 1024 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, keys, label) => {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(400, `Unknown ${label} field.`);
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const toolName = /^[A-Za-z0-9_.-]{1,128}$/;
function cleanText(value, label, max, empty = false, status = 400) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(status, `${label} is invalid or too large.`);
  return value;
}
export function mcpSelections(value = []) {
  if (!Array.isArray(value) || value.length > MCP_LIMITS.connections) fail(400, 'MCP permissions must be a bounded array of exact tool selections.');
  const seen = new Set(); let total = 0;
  return Object.freeze(value.map(selection => {
    own(selection, ['connectionId', 'catalogRevision', 'tools'], 'MCP selection');
    if (typeof selection.connectionId !== 'string' || !uuid.test(selection.connectionId) || seen.has(selection.connectionId)) fail(400, 'Use distinct saved MCP connections.');
    seen.add(selection.connectionId);
    if (typeof selection.catalogRevision !== 'string' || !uuid.test(selection.catalogRevision)) fail(400, 'Use the current reviewed MCP catalog revision.');
    const tools = selection.tools;
    if (!Array.isArray(tools) || !tools.length || tools.length > MCP_LIMITS.selectedTools || new Set(tools).size !== tools.length || tools.some(name => typeof name !== 'string' || !toolName.test(name))) fail(400, 'Use a distinct bounded list of exact MCP tool names.');
    total += tools.length;
    if (total > MCP_LIMITS.selectedTools) fail(400, 'At most 32 MCP tools may be granted to a turn.');
    return Object.freeze({ connectionId: selection.connectionId, catalogRevision: selection.catalogRevision, tools: Object.freeze([...tools]) });
  }));
}
function config(input) {
  own(input, ['name', 'url', 'apiKey', 'clearKey'], 'MCP connection');
  const name = cleanText(input.name, 'MCP connection name', 100);
  if (/[\r\n\t]/.test(name)) fail(400, 'Use a single-line MCP connection name.');
  const rawUrl = cleanText(input.url, 'MCP endpoint URL', 500);
  let url;
  try { url = new URL(rawUrl); } catch { fail(400, 'Use an HTTPS MCP endpoint, or an HTTP loopback endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'Use HTTPS, or HTTP loopback, without URL credentials, query, or fragment.');
  if (input.apiKey !== undefined) cleanText(input.apiKey, 'MCP bearer key', 8000, true);
  if (input.apiKey && !/^[\x21-\x7e]+$/.test(input.apiKey)) fail(400, 'The MCP bearer key must use visible ASCII without whitespace.');
  if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean') fail(400, 'clearKey must be a boolean.');
  return { name, url: url.href };
}

function redactSecret(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[redacted]');
  if (Array.isArray(value)) return value.map(item => redactSecret(item, secret));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redactSecret(key, secret), redactSecret(item, secret)]));
  return value;
}

/** Common owns credentials, targets, catalogs, and dispatch. Saved connections start inactive. */
export class Mcp {
  constructor(store, emit = () => {}) {
    this.store = store; this.emit = emit; this.sessions = new Map(); this.errors = new Map();
    this.inflight = new Set(); this.closing = false;
    // Additive, empty migration. The shared Store schema version stays 1.
    store.db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, api_key TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }
  row(connectionId) {
    const row = this.store.get('SELECT * FROM mcp_connections WHERE id=?', connectionId);
    if (!row) fail(404, 'MCP connection not found.');
    return row;
  }
  signature(row) { return hash(JSON.stringify([row.name, row.url, row.api_key, row.updated_at])); }
  view(row) {
    const session = this.sessions.get(row.id);
    return { id: row.id, name: row.name, url: row.url, protocolVersion: MCP_PROTOCOL, hasKey: !!row.api_key,
      connected: !!session?.ready, catalogRevision: session?.ready ? session.catalogRevision : null,
      checkedAt: session?.ready ? session.checkedAt : null, tools: session?.ready ? structuredClone(session.tools) : [],
      error: this.errors.get(row.id) ?? null };
  }
  list() { return this.store.all('SELECT * FROM mcp_connections ORDER BY created_at,id').map(row => this.view(row)); }
  get(connectionId) { return this.view(this.row(connectionId)); }
  invalidate(connectionId) {
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    if (session) session.controller.abort();
    return session;
  }
  save(input, connectionId) {
    const validated = config(input), existing = connectionId ? this.row(connectionId) : null;
    if (!existing && this.list().length >= MCP_LIMITS.connections) fail(400, 'At most 16 MCP connections may be saved.');
    const key = input.apiKey ? this.store.encrypt(input.apiKey) : input.clearKey === true ? null : existing?.api_key ?? null;
    connectionId = existing?.id ?? id();
    this.invalidate(connectionId); this.errors.delete(connectionId);
    this.store.run(`INSERT INTO mcp_connections(id,name,url,api_key,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,api_key=excluded.api_key,updated_at=excluded.updated_at`,
      connectionId, validated.name, validated.url, key, existing?.created_at ?? now(), now());
    this.emit({ type: 'mcp' });
    return this.get(connectionId);
  }
  remove(connectionId) {
    this.row(connectionId); this.invalidate(connectionId); this.errors.delete(connectionId);
    this.store.run('DELETE FROM mcp_connections WHERE id=?', connectionId);
    this.emit({ type: 'mcp' }); return { deleted: true };
  }
  async bounded(operation) {
    if (this.closing) fail(503, 'MCP is stopping.');
    if (this.inflight.size >= MCP_LIMITS.concurrent) fail(429, 'Four MCP operations are already active. Wait for one to finish.');
    const pending = operation(); this.inflight.add(pending);
    try { return await pending; } finally { this.inflight.delete(pending); }
  }
  connect(connectionId, { signal } = {}) {
    const row = this.row(connectionId);
    if (this.sessions.get(connectionId)?.busy) fail(409, 'This MCP connection has active work. Stop it before connecting again.');
    return this.bounded(async () => {
      const previous = this.invalidate(connectionId);
      const controller = new AbortController();
      const client = new McpHttpClient({ url: row.url, apiKey: this.store.decrypt(row.api_key), signal: controller.signal });
      const session = { client, controller, signature: this.signature(row), ready: false, busy: true, tools: [] };
      this.sessions.set(connectionId, session); this.errors.delete(connectionId);
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(MCP_LIMITS.discoveryMs), ...(signal ? [signal] : [])]);
      try {
        if (previous) await previous.client.disconnect();
        combined.throwIfAborted();
        await client.initialize(combined);
        const tools = [], names = new Set(), cursors = new Set(); let cursor;
        for (let page = 0; page < MCP_LIMITS.pages; page++) {
          const result = await client.request('tools/list', cursor ? { cursor } : undefined, { signal: combined, bytes: 256 * 1024 });
          if (!Array.isArray(result.tools) || tools.length + result.tools.length > MCP_LIMITS.tools) fail(502, 'The MCP catalog exceeds the 32-tool limit.');
          for (const raw of result.tools) {
            if (!record(raw) || typeof raw.name !== 'string' || !toolName.test(raw.name) || names.has(raw.name)) fail(502, 'The MCP server returned invalid or duplicate tool names.');
            names.add(raw.name);
            const entry = { name: raw.name, modelName: `mcp_${hash(`${connectionId}\0${raw.name}`).slice(0, 32)}`,
              title: cleanText(raw.title ?? raw.name, 'MCP tool title', 200, false, 502),
              description: cleanText(raw.description ?? '', 'MCP tool description', 4096, true, 502),
              inputSchema: record(raw.inputSchema) ? raw.inputSchema : {}, available: true };
            try {
              if (raw.execution?.taskSupport === 'required') fail(502, 'MCP task-only tools are not supported.');
              entry.inputSchema = mcpSchema(raw.inputSchema);
              if (raw.outputSchema !== undefined) entry.outputSchema = mcpSchema(raw.outputSchema);
            } catch (error) {
              entry.available = false; entry.error = error?.status === 502 ? error.message : 'The MCP tool schema is unsupported.';
            }
            // Do not expose a reflected credential in discovered display text.
            const publicEntry = JSON.stringify(entry);
            if (client.apiKey && publicEntry !== JSON.stringify(redactSecret(entry, client.apiKey))) fail(502, 'The MCP catalog reflected a saved credential. It was not accepted.');
            tools.push(entry);
          }
          if (Buffer.byteLength(JSON.stringify(tools)) > MCP_LIMITS.catalogBytes) fail(502, 'The MCP catalog exceeds its total byte limit.');
          cursor = result.nextCursor;
          if (cursor === undefined) break;
          if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || cursors.has(cursor) || page === MCP_LIMITS.pages - 1) fail(502, 'The MCP catalog exceeded its bounded pagination limit.');
          cursors.add(cursor);
        }
        combined.throwIfAborted();
        if (this.sessions.get(connectionId) !== session || this.signature(this.row(connectionId)) !== session.signature) fail(409, 'The MCP connection changed during discovery. Connect and review it again.');
        session.tools = tools; session.catalogRevision = id(); session.checkedAt = now(); session.ready = true;
        client.onCatalogChanged = () => {
          session.ready = false;
          this.errors.set(connectionId, 'The MCP server reported a catalog change. Explicitly connect and review tools again.');
          this.emit({ type: 'mcp' });
        };
        this.emit({ type: 'mcp' }); return this.view(row);
      } catch (error) {
        if (this.sessions.get(connectionId) === session) {
          this.invalidate(connectionId);
          this.errors.set(connectionId, error?.status ? error.message : 'MCP discovery stopped or timed out. Connect explicitly to try again.');
          this.emit({ type: 'mcp' });
        }
        await client.disconnect();
        if (signal?.aborted) throw signal.reason;
        if (error?.status) throw error;
        fail(502, 'MCP discovery stopped or timed out. No automatic retry was made.');
      } finally { session.busy = false; }
    });
  }
  async disconnect(connectionId) {
    this.row(connectionId);
    const session = this.invalidate(connectionId); this.errors.delete(connectionId);
    this.emit({ type: 'mcp' });
    if (session) await session.client.disconnect();
    return this.get(connectionId);
  }
  prepare(selections) {
    const plan = [];
    for (const selection of selections) {
      const session = this.sessions.get(selection.connectionId);
      if (!session?.ready || session.catalogRevision !== selection.catalogRevision || this.signature(this.row(selection.connectionId)) !== session.signature) fail(409, 'The MCP connection or catalog changed. Connect explicitly and review its tools again.');
      for (const name of selection.tools) {
        const tool = session.tools.find(item => item.name === name);
        if (!tool?.available) fail(403, 'This exact MCP tool is unavailable or not in the reviewed catalog.');
        plan.push({ connectionId: selection.connectionId, catalogRevision: selection.catalogRevision, session, tool,
          connectionName: this.row(selection.connectionId).name });
      }
    }
    return Object.freeze(plan);
  }
  assertPlan(plan) {
    for (const item of plan) if (this.sessions.get(item.connectionId) !== item.session || !item.session.ready ||
      item.session.catalogRevision !== item.catalogRevision || this.signature(this.row(item.connectionId)) !== item.session.signature) fail(409, 'The reviewed MCP connection or catalog is no longer active. No new call was dispatched.');
  }
  definitions(plan) {
    this.assertPlan(plan);
    return plan.map(item => ({ type: 'function', function: { name: item.tool.modelName,
      description: `External MCP tool ${item.connectionName}: ${item.tool.name}. ${item.tool.description}`,
      parameters: structuredClone(item.tool.inputSchema) } }));
  }
  validate(call, plan) {
    this.assertPlan(plan);
    const item = plan.find(item => item.tool.modelName === call.function.name);
    if (!item) fail(403, 'The model requested an MCP tool that this submission does not permit.');
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { fail(400, 'The model returned invalid MCP argument JSON.'); }
    validateMcpValue(args, item.tool.inputSchema);
    return { call, args, mcp: item };
  }
  async run(item, args, signal) {
    this.assertPlan([item]);
    if (item.session.busy) fail(409, 'This MCP connection has active work. No call was dispatched.');
    return this.bounded(async () => {
      item.session.busy = true;
      try {
        const raw = await item.session.client.call(item.tool.name, args, signal);
        boundedMcpJson(raw, 502);
        if (!Array.isArray(raw.content) || raw.content.length > 64 || raw.isError !== undefined && typeof raw.isError !== 'boolean') fail(502, 'The MCP tool returned an invalid bounded result.');
        const content = raw.content.map(part => {
          if (!record(part) || part.type !== 'text') fail(502, 'Only MCP text and structured JSON results are supported. Remote resources and binary content were not opened.');
          return { type: 'text', text: cleanText(part.text, 'MCP result text', 65536, true, 502) };
        });
        const result = { content, isError: raw.isError === true };
        if (raw.structuredContent !== undefined) {
          if (!record(raw.structuredContent)) fail(502, 'MCP structured content must be a JSON object.');
          result.structuredContent = raw.structuredContent;
        }
        if (item.tool.outputSchema && !result.isError) {
          if (!result.structuredContent) fail(502, 'The MCP result omitted its declared structured output.');
          validateMcpValue(result.structuredContent, item.tool.outputSchema, 502);
        }
        // Redact decoded strings before serialization, including JSON-escaped credentials.
        const serialized = JSON.stringify(redactSecret(result, item.session.client.apiKey));
        if (Buffer.byteLength(serialized) > MCP_LIMITS.resultBytes) fail(502, 'The MCP result exceeded its 48 KiB saved-result limit. Inspect remote state before retrying.');
        return { content: serialized, activity: { source: 'mcp', connectionId: item.connectionId,
          connectionName: item.connectionName, toolName: item.tool.name, catalogRevision: item.catalogRevision,
          status: result.isError ? 'error' : 'complete', summary: result.isError ? 'The MCP tool returned an error result. No automatic retry was made.' : 'The MCP tool returned a validated result.', files: [] } };
      } catch (error) {
        // An uncertain remote outcome cannot become an automatic model retry.
        if (this.sessions.get(item.connectionId) === item.session) {
          item.session.ready = false;
          this.errors.set(item.connectionId, 'The MCP call had no validated saved result. Inspect remote state, then explicitly connect and review tools again.');
          this.emit({ type: 'mcp' });
        }
        throw error;
      } finally { item.session.busy = false; }
    });
  }
  async stop() {
    this.closing = true;
    const sessions = [...this.sessions.values()];
    for (const connectionId of this.sessions.keys()) this.invalidate(connectionId);
    await Promise.allSettled([...this.inflight, ...sessions.map(session => session.client.disconnect())]);
  }
}
