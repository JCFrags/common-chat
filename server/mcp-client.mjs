import { fail, id } from './validation.mjs';
import { sseRecords } from './provider.mjs';
import { boundedMcpJson } from './mcp-schema.mjs';

export const MCP_PROTOCOL = '2025-11-25';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the reviewed Streamable HTTP endpoint is contacted. No fallback or replay. */
export class McpHttpClient {
  constructor({ url, apiKey = '', signal }) {
    this.url = url; this.apiKey = apiKey; this.signal = signal; this.sessionId = null;
    this.initialized = false; this.onCatalogChanged = () => {};
  }
  headers() {
    return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(this.initialized ? { 'MCP-Protocol-Version': MCP_PROTOCOL } : {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }
  async post(message, { signal, bytes = 65536, notification = false, initialize = false } = {}) {
    signal = AbortSignal.any([this.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    let response;
    try {
      response = await fetch(this.url, { method: 'POST', headers: this.headers(),
        body: JSON.stringify(message), redirect: 'error', credentials: 'omit', signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 && this.sessionId) fail(502, 'The MCP session expired. Explicitly connect and review tools again. No call was retried.');
        fail(502, `MCP HTTP ${response.status}. Check the saved endpoint, credentials, and server status. No request was retried.`);
      }
      if (notification) {
        await response.body?.cancel();
        if (response.status !== 202) fail(502, 'The MCP server did not acknowledge its notification with HTTP 202.');
        return null;
      }
      if (initialize) {
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId !== null) {
          if (!/^[\x21-\x7e]{1,256}$/.test(sessionId)) fail(502, 'The MCP server returned an invalid session ID.');
          this.sessionId = sessionId;
        }
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const client = this;
      async function* boundedStream() {
        let total = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const chunk of response.body ?? []) {
          total += chunk.length;
          if (total > bytes) fail(502, 'The MCP response exceeded its byte limit.');
          decoder.decode(chunk, { stream: true });
          yield chunk;
        }
        decoder.decode();
      }
      const parse = value => {
        let message;
        try { message = JSON.parse(value); } catch { fail(502, 'The MCP server returned invalid JSON.'); }
        boundedMcpJson(message, 502);
        if (!record(message) || message.jsonrpc !== '2.0') fail(502, 'The MCP server returned an invalid JSON-RPC message.');
        if (message.method !== undefined) {
          if (Object.hasOwn(message, 'id')) fail(502, 'MCP server-initiated requests are not supported. No client action was taken.');
          if (typeof message.method !== 'string' || message.method.length > 128) fail(502, 'The MCP server returned an invalid notification.');
          if (message.method === 'notifications/tools/list_changed') client.onCatalogChanged();
          return null;
        }
        if (message.id !== argumentsId || Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) fail(502, 'The MCP response did not match its request.');
        if (message.error) fail(502, 'The MCP server reported a protocol error. Check its logs. No request was retried.');
        if (!record(message.result)) fail(502, 'The MCP server returned an invalid result object.');
        return message.result;
      };
      const argumentsId = message.id;
      if (contentType === 'application/json') {
        const chunks = [];
        for await (const chunk of boundedStream()) chunks.push(Buffer.from(chunk));
        const result = parse(Buffer.concat(chunks).toString('utf8'));
        if (!result) fail(502, 'The MCP server returned a notification instead of its result.');
        return result;
      }
      if (contentType !== 'text/event-stream') fail(502, 'The MCP server returned an unsupported HTTP content type.');
      for await (const data of sseRecords(boundedStream())) {
        if (!data.trim()) continue;
        const result = parse(data);
        if (result) return result;
      }
      fail(502, 'The MCP stream ended without a result. Inspect remote state before retrying.');
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (Number.isInteger(error?.status)) throw error;
      fail(502, 'The MCP transport failed. Check the endpoint and server status. No request was retried.');
    } finally {
      // Stop reading after the matching response, even if the server leaves SSE open.
      try { await response?.body?.cancel(); } catch {}
    }
  }
  request(method, params, options) {
    return this.post({ jsonrpc: '2.0', id: id(), method, ...(params === undefined ? {} : { params }) }, options);
  }
  notify(method, params, signal) {
    return this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, { signal, notification: true });
  }
  async initialize(signal) {
    const result = await this.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {},
      clientInfo: { name: 'common-chat', version: '0.2' } }, { signal, initialize: true });
    if (result.protocolVersion !== MCP_PROTOCOL) fail(502, 'This MCP connection supports only protocol 2025-11-25. No version fallback was attempted.');
    if (!record(result.capabilities) || !record(result.capabilities.tools)) fail(502, 'The MCP server did not declare tool support.');
    this.initialized = true;
    await this.notify('notifications/initialized', undefined, signal);
  }
  async cancel(requestId) {
    // Cancellation is best-effort and does not prove that remote side effects stopped.
    try {
      await this.notify('notifications/cancelled', { requestId, reason: 'Common Chat stopped waiting.' }, AbortSignal.timeout(1500));
    } catch {}
  }
  async call(name, args, signal) {
    const requestId = id();
    const combined = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    let finished = false;
    const cancel = () => { if (!finished && !this.signal.aborted) void this.cancel(requestId); };
    combined.addEventListener('abort', cancel, { once: true });
    try { return await this.post({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }, { signal: combined }); }
    finally { finished = true; combined.removeEventListener('abort', cancel); }
  }
  async disconnect() {
    if (!this.sessionId) return;
    let response;
    try {
      response = await fetch(this.url, { method: 'DELETE', headers: this.headers(),
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(1500) });
    } catch {}
    finally { try { await response?.body?.cancel(); } catch {} this.sessionId = null; }
  }
}
