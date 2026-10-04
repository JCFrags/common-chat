# Server-owned MCP tools

Common supports a bounded, tool-only subset of Model Context Protocol (MCP). The Common server owns connections, encrypted credentials, discovery, and tool calls. The browser uses same-origin Common APIs. It does not connect to MCP endpoints or run an MCP tool loop.

This is not feature parity with the imported llama UI. MCP prompts, resources, binary results, OAuth, stdio, WebSocket, deprecated HTTP+SSE, server-initiated client requests, and task execution are not supported. There is no host-process, browser, working-directory, or isolated-runner fallback.

## Connection and consent

1. Save a name, exact Streamable HTTP endpoint, and optional bearer key.
2. Explicitly choose Connect and discover. Review the endpoint, descriptions, and schemas.
3. Select individual available tools. Selection is page-only. It is not standing permission.
4. Confirm the exact selected tools and target before each new submission, regeneration, or continuation. The model connection must enable the function-tool protocol.

Use HTTPS, or HTTP on literal loopback (`localhost`, `127.0.0.1`, or `[::1]`). URL credentials, query strings, fragments, custom authentication headers, and redirects are rejected. The server never follows a tool-supplied URL. It sends the saved key only to the saved endpoint. A blank key on update retains it. `clearKey: true` removes it unless a new nonempty key is supplied. Responses expose `hasKey`, never the key.

Saving, listing, loading settings, and startup make no MCP network request. Saved connections start inactive after a server restart. Connect performs initialization and bounded tool discovery only. It does not call a tool. Connect and rediscover replaces the catalog revision and clears the page's choices. Edit, delete, disconnect, and sign-out also clear affected page choices. There is no automatic reconnect, background health check, discovery subscription, or request replay.

MCP tools run with the remote server's permissions, not Common's sandbox policy. A tool can access data or make changes wherever that server permits. Establish the intended server and access before connecting. Tool descriptions, schemas, annotations, and results are untrusted. Common does not infer safety from a name or a read-only annotation. Server instructions are not added to the system prompt.

The selected model provider receives the selected tool definitions and saved results. The MCP endpoint receives the model's validated arguments for the selected tool. Common does not send the complete conversation, attachments, workspace, or host paths automatically. Model arguments can still contain user data. Consent must account for the selected server's actual access and disclosure.

## HTTP API

All routes use normal Common authentication, Host/Origin checks, and JSON mutation headers. See [API.md](API.md).

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/mcp/connections` | Saved connections and current in-memory catalogs. No remote request. |
| POST | `/api/mcp/connections` | Save `{name, url, apiKey?, clearKey?}`. Return inactive connection with HTTP 201. |
| GET | `/api/mcp/connections/:id` | One saved connection and its current state. |
| PUT | `/api/mcp/connections/:id` | Replace name/URL and retain, replace, or clear key. Always invalidate the active catalog. |
| DELETE | `/api/mcp/connections/:id` | Delete saved configuration and invalidate local active work. Saved receipts remain. |
| POST | `/api/mcp/connections/:id/connect` | Accept `{}`. Initialize and discover the bounded catalog. |
| POST | `/api/mcp/connections/:id/disconnect` | Accept `{}`. Invalidate local active work and request legacy session termination when a session ID exists. |

A connection response has `id`, `name`, `url`, `protocolVersion`, `hasKey`, `connected`, `catalogRevision`, `checkedAt`, `tools`, and `error`. Inactive connections have a null revision/time and an empty tool list. Errors are sanitized. Discovery does not prove that a tool works or that its access is safe.

Each catalog tool has its remote `name`, collision-free Common `modelName`, `title`, `description`, `inputSchema`, optional `outputSchema`, `available`, and optional `error`. Unsupported schemas and task-only tools are visible but unavailable. No remote icons or resources are fetched.

Generation accepts the exact reviewed selection in the existing per-submission permission object:

```json
{
  "tools": {
    "workspace": true,
    "execute": false,
    "packages": false,
    "mcp": [
      {
        "connectionId": "saved-connection-uuid",
        "catalogRevision": "current-catalog-uuid",
        "tools": ["remote_tool_name"]
      }
    ]
  }
}
```

Omitted or empty `mcp` means no MCP permission. Use distinct connection IDs and distinct exact remote tool names. The server resolves the endpoint, credential, and function definition from its registered catalog. Clients cannot submit those targets, executable definitions, transcripts, or credentials as generation arguments.

Common freezes the submitted values. Preflight, the durable submission boundary, whole-batch tool validation, and dispatch check the saved configuration and active catalog again. A changed, disconnected, unavailable, or expired catalog fails closed. A new Connect and review is required. A received session HTTP 404 marks the catalog inactive. An uncertain transport or invalid result also marks it inactive, so the model cannot automatically retry an uncertain remote operation.

An identical generation retry preserves the entire request ID and object, including the exact `mcp` array. The existing saved request receipt is checked before discovery or effects. A changed request with that ID returns HTTP 409. Do not select again, reconnect, or replace permissions as part of an unresolved retry.

## Protocol and validation limits

Initial support is pinned to **2025-11-25 Streamable HTTP**, matching the imported SDK's protocol. Common uses `initialize`, verifies the exact returned version and tools capability, sends `notifications/initialized`, and calls `tools/list` and `tools/call`. POST advertises both JSON and request-scoped SSE. Subsequent requests include `MCP-Protocol-Version` and the server-issued session ID when present.

There is no automatic version or transport fallback. GET subscriptions, SSE resumption, and server-initiated roots, sampling, or elicitation requests are not supported. The client declares no such capabilities. Request-scoped progress notifications are ignored. An observed tool-list-change notification makes the catalog unavailable until explicit rediscovery. Without subscriptions, a server-side catalog change can be detected only during an explicit discovery or request. Catalog checks do not prove unchanged remote implementation or access.

The later **2026-07-28** stateless protocol is not supported in this initial subset. It removes initialization-based sessions and uses per-request metadata and additional HTTP headers. Selecting that revision is not an implicit fallback.

| Bound | Value |
| --- | --- |
| Saved connections | 16 |
| Tools per discovered connection | 32 |
| Discovery pages | 4, with distinct cursors of at most 1024 characters |
| Total accepted catalog per connection | 128 KiB |
| JSON Schema per input/output | 16 KiB, 128 schema nodes, depth 8 |
| MCP tools granted per submission | 32 across all connections |
| Concurrent MCP operations | 4, at most one per connection |
| Total connect/discovery deadline | 20 seconds |
| Tool call deadline | 60 seconds, or the generation's earlier deadline |
| Discovery response per page | 256 KiB |
| Tool response transport | 64 KiB |
| Saved tool result | 48 KiB, at most 64 text items |
| JSON structure | 4096 nodes, depth 16 |

The existing [tool argument, transcript, work-budget, and total-generation limits](TOOLS.md#model-protocol) also apply. Calls are sequential within each generation.

Accepted schemas use object roots, primitive types and type unions, properties, required fields, additional properties, homogeneous array items, size/numeric bounds, unique items, enum/const, and bounded `anyOf`, `oneOf`, and `allOf`. Bounded title, description, default, examples, and boolean annotations are accepted. Unsupported keywords, remote/local references, regex patterns, formats, schema definitions, conditional schemas, and header annotations are rejected, not ignored. Supported dialect declarations are JSON Schema 2020-12 and draft-07. Validation has a finite work limit. This is deliberately not a complete JSON Schema implementation.

Results support text content and optional structured JSON. Declared output schemas are checked for successful results. Resource links, embedded resources, images, audio, and other binary content fail without being opened or executed. Unknown metadata is not copied into saved results. Results remain untrusted text/JSON. A reflected saved bearer key is rejected in discovery and redacted from saved results.

## Receipts, cancellation, and history

MCP uses Common's existing server generation loop, request receipts, work budgets, saved pending placeholders, and cancellation API. There is no second browser loop. All calls in a batch are validated before the first effect. Pending activity already identifies `source: "mcp"`, `connectionId`, `connectionName`, remote `toolName`, and `catalogRevision`. Successful, failed, blocked, and interrupted activity keeps those fields.

`toolPermissions.mcp` records the exact submitted selection for a job-owned assistant. It is read-only provenance, not future authority. Imports, forks, and edited tool history use the existing archived-tool-context rules. Historical receipts and tool transcripts never become a new execution queue or restore page selection.

Stop aborts the active HTTP request and sends a bounded best-effort MCP `notifications/cancelled` when possible. Disconnect invalidates local active work. Legacy session termination uses DELETE when a session ID exists. None of these actions proves that the remote server stopped processing, prevented billing, or undid side effects. Completed saved actions remain. Inspect remote state before another explicit attempt after an uncertain outcome. Common never replays an MCP tool automatically.

## Persistence and migration

The MCP service creates this additive empty table on the existing Store connection:

```sql
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`PRAGMA user_version` stays at the existing Store version, `1`. No conversations, account preferences, providers, files, or runner inputs are rewritten. Existing installations gain no saved connections by default. Active sessions, catalogs, and page selections are not persisted. Credentials use the existing Store AES-256-GCM encryption and `master.key`.

Include the database, WAL/SHM when present, files, and matching `master.key` in the existing complete stopped backup. Conversation exports do not contain MCP connections or credentials. An older server ignores the additional table. It cannot execute the new MCP permission shape. Saved MCP tool history still requires the existing local-job provenance checks and has no replay authority.

## Frontend integration

Mount `CommonMcp.svelte` in the authenticated Common settings panel. It uses the shared page-only `commonMcpState` from `$lib/services/common-mcp.svelte.ts`. Do not use the imported browser `mcpStore` or restore its old local settings as server authority.

Before a new submission, call `confirmSelections(provider, conversationId, requestId?)`. The helper returns actual frozen `selections` and readable `labels` after a same-origin registered-catalog check only. It does not show the confirmation or contact an MCP server. The parent must confirm the labels with the frozen provider/conversation target, recheck that target, and put the exact returned selections in the request. Apply the same fresh review to regeneration and continuation. Preserve exact unresolved retries without another prompt or changed selection. Call `commonMcpState.reset()` on sign-out.

`/api/runtime` and `nativeTools` remain native-only. MCP selection must not introduce a default-false native-tool checkbox. Manual code Run and package consent remain separate. The server emits `type: "mcp"` after saved/active MCP state changes. Clients can reread the registered state without a remote request.

## Official protocol references

- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [2025-11-25 tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

Synthetic loopback acceptance establishes only the application protocol and consent boundaries. It does not approve or verify a real server, external account, service, remote permission policy, or live data access.
