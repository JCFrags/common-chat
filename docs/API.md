# HTTP API

This reference describes the community 0.2 preview. See [release status](RELEASES.md) for acceptance boundaries.

All API responses use JSON except attachment/workspace download bytes and server-sent events. Normal authentication uses the `chat_session` cookie. The opt-in [trusted-local mode](OPERATIONS.md#trusted-local-deployment) has separate deployment requirements. Mutation requests must include these headers.

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
| GET | `/api/session` | Read account preferences and loaded release identity. See [release metadata](RELEASES.md). |
| POST | `/api/logout` | Delete the current session. |
| PUT | `/api/preferences` | Save theme, selected chat provider/model, or atomic dictation selection. |
| GET | `/api/events` | Subscribe to server changes. |
| GET, POST | `/api/providers` | List or create model connections. |
| PUT, DELETE | `/api/providers/:id` | Replace or delete a connection. |
| GET | `/api/providers/:id/models` | Read model IDs and display/thinking details. `?refresh=1` requests a fresh check. |
| PATCH | `/api/providers/:id/models` | Save one model nickname or thinking declaration without changing keys or other connection fields. |
| POST | `/api/transcriptions` | Transcribe an ephemeral audio clip using the saved dictation selection. |
| GET, POST | `/api/conversations` | Search or create conversations. Search uses `?q=...`. |
| GET, PATCH, DELETE | `/api/conversations/:id` | Read, edit, or delete a conversation. |
| POST | `/api/conversations/:id/generate` | Commit a submission and start a server-owned job. |
| POST | `/api/conversations/:id/messages` | Save a manual system/user/assistant branch node. |
| PATCH, DELETE | `/api/conversations/:id/messages/:messageId` | Edit message text/reasoning or delete its subtree. |
| POST | `/api/conversations/:id/fork` | Copy a selected message path and attachments into a new conversation. |
| POST | `/api/conversations/:id/attachments` | Upload a base64-encoded file. |
| GET | `/api/conversations/:id/export` | Export one conversation. |
| GET, DELETE | `/api/attachments/:id` | Read a file or delete an unattached upload. |
| GET | `/api/jobs/:id` | Read generation state. |
| POST | `/api/jobs/:id/cancel` | Request generation cancellation. |
| GET | `/api/requests/:id` | Reconcile a submission after a network failure. |
| POST | `/api/import` | Import text or a base64-encoded export. |
| GET | `/api/export` | Export all conversations. |
| GET | `/api/conversations/:id/workspace` | List current file heads, including deleted heads, and workspace usage. |
| GET, PUT, DELETE | `/api/conversations/:id/workspace/files` | Read a file with `?path=...&revision=...`, create/edit a file, or create a deletion revision. |
| GET | `/api/conversations/:id/workspace/history` | Read revisions for `?path=...`. |
| POST | `/api/conversations/:id/workspace/restore` | Copy an earlier revision into a new head. |
| GET | `/api/conversations/:id/workspace/search` | Search current document passages with `?q=...&limit=...`. |
| GET | `/api/conversations/:id/workspace/download` | Download exact bytes with `?path=...&revision=...`. |
| GET | `/api/runtime` | Read optional execution readiness, limits, verified bundled inventory, and sanitized blocked reasons. |
| GET, POST | `/api/conversations/:id/executions` | List recent executions or submit an isolated Python/shell operation. |
| GET | `/api/conversations/:id/executions/:executionId` | Read status, bounded output, and saved file links. |
| POST | `/api/conversations/:id/executions/:executionId/cancel` | Cancel an execution or package operation. |
| GET, POST | `/api/conversations/:id/packages` | Read or verify and replace saved package specifications. |

Workspace route shapes and revision rules are defined in [WORKSPACE.md](WORKSPACE.md). Execution/package schemas are defined in [TOOLS.md](TOOLS.md). Browser composer drafts have no server storage API. Their local persistence and submission recovery use the existing generation/request routes, as described in [DRAFTS.md](DRAFTS.md).

## Connection example

```json
{
  "name": "Local model server",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "apiKey": "",
  "models": [],
  "modelConfig": { "discovery": "auto", "metadata": "generic", "profiles": [] },
  "capabilities": {
    "streaming": true,
    "llamaCppTimings": false,
    "llamaCppSampling": false,
    "llamaCppThinkingBudget": false,
    "presencePenalty": false,
    "frequencyPenalty": false,
    "seed": false,
    "systemPrompt": true,
    "vision": false,
    "tools": false,
    "audioInput": "none",
    "videoInput": "none",
    "temperature": true,
    "topP": true,
    "maxTokens": true,
    "tokenParameter": "max_tokens"
  }
}
```

An empty key on update retains the saved key. `clearKey: true` removes it. Connection responses return `hasKey`, never the saved key. Unknown generation settings are rejected.

`capabilities.llamaCppTimings` defaults to false. Only an enabled streaming connection sends the llama.cpp request extensions `timings_per_token: true` and `return_progress: true`. Enable this capability only for an endpoint that supports both fields. The server still consumes validated interim usage, timings, and prompt progress when supplied without this option.

`capabilities.tools` also defaults to false. It declares function-tool protocol support. The web interface computes permissions for all available native tools automatically before each turn. The API still uses an explicit `tools` object per submission, and omitted API permissions remain false.

`capabilities.audioInput` and `capabilities.videoInput` accept only `none` or `llama_cpp`, with `none` as the default. These are independent of vision, tools, and statistics. Enable them only when the endpoint and selected model support the native input. See [MEDIA.md](MEDIA.md) for exact payloads, codec checks, and branch limits.

Legacy `capabilities.thinking` accepts `none` (default), `llama_cpp`, `reasoning_effort`, or `openrouter_reasoning`. Effort protocols require `thinkingLevels`, a nonempty supported subset of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Per-model declarations take precedence over the connection declaration. Do not infer support from names, vision, or returned reasoning.

Omitted `settings.thinking` sends no override. With `llama_cpp`, `on` or `off` sends `chat_template_kwargs: { "enable_thinking": true or false }`. With `reasoning_effort`, a supported level sends top-level `reasoning_effort`. With `openrouter_reasoning`, it sends `reasoning: { "effort": "..." }`. A mismatched or unsupported value fails before messages are saved. The selected value stays in the response's settings. See [thinking controls](INTERFACE.md#thinking).

## Typed sampling controls

Existing camelCase settings remain valid. `temperature` maps to `temperature`, `topP` maps to `top_p`, and positive `maxTokens` maps to the configured `tokenParameter`. Each requires its existing capability. `maxTokens: -1` means omit the token-limit override, even when the connection does not support a token-limit field. It does not promise unlimited output or send `-1` to the provider. Zero remains invalid.

The following settings retain their snake_case names in provider requests. `capabilities.llamaCppSampling` must be explicitly true for llama-only fields. It defaults to false, including for older saved connections. No endpoint or model name enables it automatically.

| Setting | Accepted value |
| --- | --- |
| `dynatemp_range`, `dynatemp_exponent` | Finite number from 0 to 10. |
| `top_k` | Integer from -1 to 1000000. |
| `min_p`, `xtc_probability`, `xtc_threshold`, `typ_p` | Finite number from 0 to 1. |
| `repeat_last_n`, `dry_penalty_last_n` | Integer from -1 to 1000000. |
| `repeat_penalty` | Finite number from 0 to 10. |
| `dry_multiplier` | Finite number from 0 to 100. |
| `dry_base` | Finite number from 1 to 100. |
| `dry_allowed_length` | Integer from 0 to 1000000. |
| `backend_sampling` | Boolean. Explicit false is retained. |
| `samplers` | Distinct array, or semicolon-separated string, of `dry`, `top_k`, `typ_p`, `top_p`, `min_p`, `top_n_sigma`, `xtc`, `temperature`, `penalties`, or `infill`. Stored and sent as an array. |
| `presence_penalty`, `frequency_penalty` | Finite number from -2 to 2. Require `llamaCppSampling` or independent `presencePenalty`/`frequencyPenalty` capabilities. |
| `seed` | Integer from -1 to 4294967295. Requires `llamaCppSampling` or the independent `seed` capability. |

The independent generic capabilities also default to false. Empty/null numeric controls are omitted. Unknown settings fail with HTTP 400 before a submission is saved. An upstream Custom JSON editor may translate only these typed fields and existing settings. It is not a request-payload override. The server owns model, messages, stream, tools, URL, and credentials.

`settings.thinking_budget_tokens` accepts an integer from -1 to 1000000. Non-negative budgets require explicit `capabilities.llamaCppThinkingBudget: true` and a resolved `llama_cpp` thinking declaration for the selected model. They cannot be combined with `thinking: "off"`. `-1` omits the budget override. The current llama UI Low/Medium/High choices use 512/2048/8192 tokens. Max omits the override. Do not convert these llama token budgets into remote reasoning-effort levels. Existing thinking protocols remain separate.

## Model catalogs and profiles

`modelConfig.discovery` is `auto` or `manual`. Omitted configuration preserves an existing connection's model configuration on PUT. Older nonempty `models` lists infer manual mode. Empty lists infer automatic mode. Automatic mode calls `/models` even when saved IDs exist. It does not replace the saved manual list. An API failure can return saved IDs with a clear unverified fallback state.

`modelConfig.metadata` is `generic` (default) or `openrouter`. The latter recognizes compatible `/models` reasoning metadata. The exact OpenRouter endpoint is also recognized. Generic `/models` does not enumerate thinking levels.

GET returns the backward-compatible `models: string[]` plus `details: [{ id, name?, nickname?, thinking: { protocol, levels, source } }]`. It also returns `reachable`, `source`, `checkedAt`, and `catalogState`, with an optional sanitized `error`.

| Result | reachable | source | catalogState |
| --- | --- | --- | --- |
| Fresh API success | `true` | `api` | `fresh` |
| Cached result | `null` | `cache` | `cached` |
| Manual IDs | `null` | `manual` | `manual` |
| Failed discovery and saved-ID fallback | `false` | `fallback` | `failed` |

Cached results retain the original check time. A catalog invalidated during its request can return `stale`. Neither caching nor manual mode is a fresh reachability check. API model listing does not verify inference readiness.

Profiles have `{ id, nickname?, thinking?: { protocol, levels? } }`. Nicknames are display-only. PATCH accepts `{ model, nickname?, thinking? }` for one profile. An empty/null nickname clears it. `thinking: null` removes that model declaration, allowing automatic or connection resolution. `{ "protocol": "none" }` explicitly disables overrides. `llama_cpp` supports on/off. Effort declarations require documented supported levels. No credential or model-ID rewrite is part of a profile update.

## Dictation

PUT `/api/preferences` accepts `dictation: null` to disable the service, or `dictation: { providerId, model }`. The pair is saved atomically and independently of the chat selection. The connection must exist.

POST `/api/transcriptions` accepts `{ providerId, model, name, mime, data }`, with base64 audio data. The provider/model pair must still match the saved dictation selection. The server sends multipart `file` and `model` to the connection's fixed `/audio/transcriptions` path, using its server-owned key. Success returns `{ text }` without creating a conversation, attachment, message, or job.

Supported containers are WAV, MP3, WebM, and MP4/M4A. MIME/signature and 10 MiB byte limits are enforced. The JSON request is limited to 15 MiB. At most two upstream calls run concurrently per app process. The upstream deadline is 60 seconds and response bound is 64 KiB. Browser recordings stop after 60 seconds. The server does not establish compressed-file duration.

Only the main app page permits same-origin microphone access. Sandbox pages still deny it. Browser capture requires a secure context and explicit permission. File transcription works without capture. Cancellation disconnects the transport and prevents transcript insertion. It does not prove that provider processing or billing stopped. See [dictation use and privacy](INTERFACE.md#dictation).

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
  "tools": {
    "workspace": false,
    "execute": false,
    "packages": false
  },
  "settings": {
    "systemPrompt": "Answer clearly.",
    "temperature": 0.4,
    "maxTokens": 2048
  }
}
```

A successful submission returns HTTP 202 with `jobId`, `messageId`, and `conversationId`. It does not keep the submission response open for model tokens. Clients subscribe to `/api/events` or read the conversation again.

An identical retry must preserve the entire request object and request ID. The server returns the original job instead of creating another response. A different request with an existing ID receives HTTP 409.

Regeneration sets `regenerate: true` and uses a user message ID as `parentId`. It supplies no new content or attachments. A normal submission under the original user's parent node creates an edited user branch without changing the original node.

Continuation sets `continue: true` with a complete assistant message ID as `parentId`. It supplies no new content or attachments and cannot also request regeneration. The server starts an ordinary assistant job as a new child of that assistant. It preserves the previous node and adds no user message. The same request receipt, exact retry, capability checks, tool preflight, version guard, cancellation, and saved-state events apply. It does not use a browser tool loop or a provider-specific final-message override.

Optional `settings.toolCalls` and `settings.toolRounds` are local per-turn work budgets. Each accepts an integer from 1 to 1000000. Omit a budget to turn it off. These settings are not sent as provider sampling controls. The final text answer does not count as a tool round. A reached budget preserves completed work, records blocked calls without dispatch, and requests a final answer from saved results.

Omitted tool permissions are false. `workspace` enables scoped file tools. `execute` enables isolated Python/shell access to a copied conversation workspace, even if direct workspace tools are off. `packages` permits package verification and restoration of saved dependencies. Permissions apply only to this submission and its bounded follow-up rounds. The web interface checks available tools again for regeneration. Imported permissions, model arguments, and document contents cannot grant permission. See [TOOLS.md](TOOLS.md).

## Conversation UI metadata and manual actions

Snapshots and conversation-list entries expose `ui` separately from sampling `settings`. Supported UI fields are:

- `pinned` and `thinkingEnabled`: booleans.
- `reasoningEffort`: `default`, `on`, `off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. This is a preference, not a provider-protocol declaration.
- `disabledTools`: at most 256 distinct nonempty strings, each at most 200 characters without control characters.
- `disabledToolCategories`: a distinct subset of `browser`, `custom`, `mcp`, `server`, `native`, `workspace`, `execute`, and `packages`.
- `forkedFromConversationId`: a nonempty string of at most 100 characters.

POST `/api/conversations` accepts `{ title?, settings?, ui? }`. PATCH `/api/conversations/:id` accepts `ui` with the existing `expectedVersion` guard. UI patches merge supplied fields. Use false, empty arrays, or `reasoningEffort: "default"` to reset preferences. Unknown UI fields fail. Validated preferences are stored inside the existing private `source` JSON without removing import provenance. Supported legacy preferences at the source root are also projected. UI fields cannot grant tool permission or change model capabilities.

POST `/api/conversations/:id/messages` accepts `{ expectedVersion, parentId, role, content, reasoning?, attachments? }`. `parentId` is null or an existing node in this conversation. `role` is `system`, `user`, or `assistant`. `attachments` is an array of at most ten distinct known attachment IDs in this conversation. Previously attached files are copied to new attachment records and bytes. Unattached uploads are bound to the new node. Empty system nodes are permitted. Other manual nodes need content, reasoning, or a file. Combined text and reasoning are limited to 2 MiB. The server assigns the ID, complete status, and timestamps. Clients cannot supply tool grants, provider provenance, status, or arbitrary metadata. Success returns HTTP 201 with the authoritative snapshot and makes the node the active leaf.

PATCH `/api/conversations/:id/messages/:messageId` accepts `{ expectedVersion, content?, reasoning? }`, with at least one editable field. It changes only the supplied text. If text actually changes, the server archives any saved tool transcript and grants, preserving the original tool context privately. It retains historical usage and provider details and marks `metadata.editedAt`. The edited transcript is not accepted as local tool authority. A no-op does not change the version. Success returns the snapshot.

DELETE on the same message path accepts `{ expectedVersion }`. It removes that node and descendants, including their attachment bytes and job records, but keeps unrelated branches. If the active leaf was removed, it selects the deleted node's parent. It keeps generation request receipts to prevent replay. Deleted job IDs no longer resolve. It does not undo tool side effects or remove workspace revisions. Success returns the snapshot.

POST `/api/conversations/:id/fork` accepts `{ expectedVersion, messageId, title? }`. It copies only the path from the root through the selected message, with new conversation, message, and attachment IDs and separate attachment bytes. The copy retains saved text, reasoning, terminal status, timestamps, provider details, sampling settings, UI preferences, and private import provenance. It sets `ui.forkedFromConversationId` and records message origins in `metadata.forkedFrom`. No jobs or tool grants are copied. Tool transcripts and grants are archived rather than treated as newly executed local history. Forks are limited to 10,000 path messages and 30 MiB of attachments. Success returns HTTP 201 with the new snapshot.

All manual actions require the current version and an idle conversation, including no active execution or package operation. They emit the existing `changed` event. Invalid fields or ownership fail before durable changes. File-copy transactions remove newly created bytes on failure.

Snapshots include a `warnings` array. Fork warnings state that workspace files, revisions, executions, and package settings were not copied. Existing workspace links refer to the original conversations. Tool-history warnings state that paths containing archived tool context cannot be sent to a model. Select a path without archived context or start a new chat. Read-only archived history cannot grant permission or replay calls. These limits remain visible after rereading a snapshot.

## Event handling

Events are JSON objects carried in the SSE `data` field. Types include `hello`, `delta`, `changed`, `deleted`, `providers`, and `preferences`.

The `delta` event contains an updated message and conversation version. It is a saved-state update, not a raw provider token event. Metadata-only upstream chunks can emit a delta without changing answer or reasoning text. Updates are bounded to ten per second, with server elapsed observations at most once per second during quiet periods. On `hello` or reconnection, the client reloads the current conversation and list.

Assistant message metadata includes validated `usage`, `timings`, `promptProgress`, and `observed`. Upstream `prompt_progress` maps to `promptProgress: { total, cache, processed, time_ms }`. Processed includes cached tokens. The last progress sample remains after completion. Later validated values replace earlier values. `observed.durationMs` updates from the monotonic server clock and becomes the final duration when the job ends. Missing upstream counts or rates are not estimated. These fields persist in native exports without a schema migration.

Tool-enabled assistant metadata can include `toolActivity` for display and `toolBudget` with `callLimit`, `roundLimit`, `executedCalls`, `executedRounds`, and `stopReason`. A null limit means off. Visible `toolPermissions` records only validated local-job grant booleans for provenance. The private saved `toolTranscript` is used only for eligible local provider continuation. These fields are not an execution queue. Imported transcripts and permissions are archived rather than accepted as local authority. Render activity and execution output as untrusted text. See [saved tool history](TOOLS.md#visible-activity-and-saved-history).

SSE does not supply a persistent replay cursor. A missed event is resolved with an authoritative snapshot. Client disconnection never implies cancellation. Workspace mutations update the conversation version, so a stale generation or file edit must reread current state.

## Attachments and imports

An attachment request contains `name`, `mime`, and base64 `data`. Uploaded files remain unattached until a generation submission references their IDs. A saved file cannot be deleted separately from its conversation.

Supported audio/video files require server inspection of their original bytes. The application does not trust client or imported duration, codec, or dimension fields. Provider protocol and combined selected-branch limits are checked before accepting a generation. Audio/video responses use their actual MIME types for local playback. Native video input is visual-only, even when browser playback includes a soundtrack. See [MEDIA.md](MEDIA.md).

An import request contains either `text` or base64 `data`. ZIP files require `data`. The importer returns conversation IDs, counts, and warnings. Imports are transactional and use new conversation IDs.

Native exports use `format: "common-chat"` and `version: 1`. Conversation JSON exports do not include workspace files or device-local drafts. The existing full offline backup includes workspace state and other server data. See [backup operations](OPERATIONS.md#native-backup).

## Workspace and execution safety

Workspace paths are relative logical names, never host paths. Reads and revisions are scoped to the route's conversation. Existing or deleted paths require their current `expectedRevision`. `expectedSha256` is an optional additional check. Missing/null revision means create-only. Search returns revision-bound source citations, not generated summaries. PDF/DOCX reads can include extracted passages, with explicit status when extraction is unavailable or fails. See [WORKSPACE.md](WORKSPACE.md).

The application fixes the conversation ID for model tools. Tool arguments cannot choose another conversation, a host path, an engine option, or a permission. Successful runner outputs use captured per-path revisions and commit as one batch. A conflict rejects the whole output batch without replacing a newer user edit.

Execution POST is not the idempotent generation API. If its response is lost, inspect recent executions and the current workspace before submitting code again. Cancellation stops active work but does not undo prior committed tool actions. There is no automatic execution retry. Runtime readiness and execution/package details are defined in [TOOLS.md](TOOLS.md).
