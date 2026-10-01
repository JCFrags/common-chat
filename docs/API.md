# HTTP API

STE-style, not verified for ASD-STE100 compliance.

All API responses use JSON except attachment bytes and server-sent events. Authentication uses the `chat_session` cookie. Mutation requests must include these headers.

```http
Content-Type: application/json
X-Chat-Request: 1
```

When supplied, `Origin` must equal `PUBLIC_URL`. Host validation also applies to health and static asset requests. Non-browser clients may omit Origin but still require authentication and mutation headers.

## Routes

| Method | Path | Action |
| --- | --- | --- |
| GET | `/healthz` | Check server availability. |
| POST | `/api/login` | Submit `{ "password": "..." }` and receive a session cookie. |
| GET | `/api/session` | Read account preferences and server version. |
| POST | `/api/logout` | Delete the current session. |
| PUT | `/api/preferences` | Save theme, selected provider ID, or model. |
| GET | `/api/events` | Subscribe to server changes. |
| GET, POST | `/api/providers` | List or create model connections. |
| PUT, DELETE | `/api/providers/:id` | Replace or delete a connection. |
| GET | `/api/providers/:id/models` | Read configured or discovered model names. |
| GET, POST | `/api/conversations` | Search or create conversations. Search uses `?q=...`. |
| GET, PATCH, DELETE | `/api/conversations/:id` | Read, edit, or delete a conversation. |
| POST | `/api/conversations/:id/generate` | Commit a submission and start a server-owned job. |
| POST | `/api/conversations/:id/attachments` | Upload a base64-encoded file. |
| GET | `/api/conversations/:id/export` | Export one conversation. |
| GET, DELETE | `/api/attachments/:id` | Read a file or delete an unattached upload. |
| GET | `/api/jobs/:id` | Read generation state. |
| POST | `/api/jobs/:id/cancel` | Request generation cancellation. |
| GET | `/api/requests/:id` | Reconcile a submission after a network failure. |
| POST | `/api/import` | Import text or a base64-encoded export. |
| GET | `/api/export` | Export all conversations. |

## Connection example

```json
{
  "name": "Local model server",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "apiKey": "",
  "models": ["model-name"],
  "capabilities": {
    "streaming": true,
    "llamaCppTimings": false,
    "systemPrompt": true,
    "vision": false,
    "temperature": true,
    "topP": true,
    "maxTokens": true,
    "tokenParameter": "max_tokens"
  }
}
```

An empty key on update retains the saved key. `clearKey: true` removes it. Connection responses return `hasKey`, never the saved key. Unknown generation settings are rejected.

`capabilities.llamaCppTimings` defaults to false. Only an enabled streaming connection sends the llama.cpp request extensions `timings_per_token: true` and `return_progress: true`. Enable this capability only for an endpoint that supports both fields. The server still consumes validated interim usage, timings, and prompt progress when supplied without this option.

## Generation example

```json
{
  "requestId": "a-client-generated-unique-id",
  "expectedVersion": 1,
  "providerId": "connection-id",
  "model": "model-name",
  "parentId": null,
  "content": "Explain the attached text.",
  "attachments": [],
  "settings": {
    "systemPrompt": "Answer clearly.",
    "temperature": 0.4,
    "maxTokens": 2048
  }
}
```

A successful submission returns HTTP 202 with `jobId`, `messageId`, and `conversationId`. It does not keep the submission response open for model tokens. Clients subscribe to `/api/events` or read the conversation again.

An identical retry must preserve the entire request object and request ID. The server returns the original job instead of creating another response. A different request with an existing ID receives HTTP 409.

Regeneration sets `regenerate: true` and uses a user message ID as `parentId`. It supplies no new content or attachments. Message editing creates a normal submission under the original user's parent node.

## Event handling

Events are JSON objects carried in the SSE `data` field. Types include `hello`, `delta`, `changed`, `deleted`, `providers`, and `preferences`.

The `delta` event contains an updated message and conversation version. It is a saved-state update, not a raw provider token event. Metadata-only upstream chunks can emit a delta without changing answer or reasoning text. Updates are bounded to ten per second, with server elapsed observations at most once per second during quiet periods. On `hello` or reconnection, the client reloads the current conversation and list.

Assistant message metadata includes validated `usage`, `timings`, `promptProgress`, and `observed`. Upstream `prompt_progress` maps to `promptProgress: { total, cache, processed, time_ms }`. Processed includes cached tokens. The last progress sample remains after completion. Later validated values replace earlier values. `observed.durationMs` updates from the monotonic server clock and becomes the final duration when the job ends. Missing upstream counts or rates are not estimated. These fields persist in native exports without a schema migration.

SSE does not supply a persistent replay cursor. A missed event is resolved with an authoritative snapshot. Client disconnection never implies cancellation.

## Attachments and imports

An attachment request contains `name`, `mime`, and base64 `data`. Uploaded files remain unattached until a generation submission references their IDs. A saved file cannot be deleted separately from its conversation.

An import request contains either `text` or base64 `data`. ZIP files require `data`. The importer returns conversation IDs, counts, and warnings. Imports are transactional and use new conversation IDs.

The limits and supported attachment formats appear in the README. Native exports use `format: "common-chat"` and `version: 1`.
