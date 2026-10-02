# Architecture

This document describes the community 0.2 preview. The [release guide](RELEASES.md) separates preview integration and first-deployment acceptance from the earlier baseline.

## Process boundaries

For chat APIs and model requests, the browser accesses the chat server. The server serves the interface, owns SQLite, stores attachments and workspace files, and calls configured model endpoints. The model server remains a separate service. Common Chat does not load model weights or start model services.

```text
Browser
  HTTP API and event subscription
  Device-local drafts in localStorage
Common Chat process
  SQLite, attachments, and opaque workspace blobs
  OpenAI-compatible chat completion client
  Optional restricted runner client
Separate services
  Model endpoint
  Rootless runner broker and disposable workers
```

The supplied runner backend uses rootless Podman on Linux with cgroup v2. Its broker runs under a separate operating-system account. The application uses a restricted broker socket, not the container engine socket. The broker stages copies of selected bytes into disposable workers. Neither the application data directory nor provider credentials enter a worker. Package fetching is a separate restricted phase, and code execution has no network. See [runner boundaries and installation](RUNNER.md).

`server/app.mjs` provides HTTP routing and authentication checks. `server/store.mjs` owns database operations and attachment records. `server/generation.mjs` owns generation jobs, and `server/provider.mjs` handles endpoint requests and streamed records. `server/transfer.mjs` validates imports and exports.

`server/workspace.mjs` owns revision storage and document search. `server/executions.mjs` records isolated execution jobs, and `server/tools.mjs` exposes the permitted model tools. `server/runner-client.mjs` crosses the broker boundary. `server/media.mjs` validates inspected media and maps explicitly enabled native input protocols.

The browser uses ordinary JavaScript modules and shipped assets, so server startup requires no browser build. Chat history stays in SQLite, not a browser database. Unsent drafts use localStorage. The theme derives from a pinned llama.cpp stylesheet.

## Durable state

The database contains conversations, message graphs, jobs, request IDs, connections, account settings, and hashed sessions. Each message identifies its parent. Edits create new user nodes. Regeneration creates a new assistant child without removing siblings.

A conversation identifies its active node and version. The active branch is shared across devices. An edit or generation request includes the expected version. The server rejects stale requests with HTTP 409.

Attachment records reference generated filesystem IDs. Original filenames are display metadata, not filesystem paths. Saved message attachments are immutable. Editing a message copies its attachment records and bytes to the new branch.

Workspace state uses additive tables for logical paths, revision heads, and extracted passages. Immutable blobs have generated IDs under the data directory. Logical names never select host paths. A write checks its captured revision and optional hash before extraction and again inside its commit. Runner output batches compare only affected paths and commit together. An unrelated file edit does not invalidate a batch. Citations bind a passage to a revision, hash, and available page/paragraph location. See [workspace storage](WORKSPACE.md).

Execution records and saved package specifications also belong to the conversation. Package dependency directories are not saved as workspace files. Imported tool transcripts and permissions become archived context rather than local execution authority. See [tool provenance](TOOLS.md).

Unsent composer drafts belong to the browser profile and origin, not the account's shared server state. They include text, attachment references, edit state, and an exact unresolved submission when needed. Server events do not replace the composer. Explicit sign-out removes the feature's local records, but session expiry does not. Composer drafts are not encrypted or included in server exports/backups. Workspace file/code/package editor buffers are separate in-memory state and do not persist across page reloads. See [draft persistence and recovery](DRAFTS.md) and [workspace interface behavior](WORKSPACE-UI.md).

SQLite uses write-ahead logging and synchronous FULL mode. One process owns each data directory. Filesystem and database writes cannot form one atomic transaction. Failed imports and workspace writes remove their new files where possible. Crash orphans remain for recovery. A complete offline backup includes workspace blobs and all additive tables. Conversation JSON exports do not include workspaces.

## Generation lifecycle

A submitted request includes a client-generated request ID. The server checks for an earlier identical request before it starts another model call. Reusing an ID with different content causes HTTP 409.

The server validates the branch, connection, capabilities, settings, attachments, and requested tool permissions before saving a message. Media preflight can require asynchronous inspection. After that work, submission rechecks request idempotency, conversation version, idle state, and attachment ownership. It then commits the user message, assistant placeholder, job, and request result together. The model request begins after that commit.

A background operation within the same server process consumes the model response. It commits partial text at approximately 100-millisecond intervals. This interval is not a hard durability guarantee. A crash can lose the latest uncommitted text.

An event subscription carries changes to connected browsers. Closing a subscription does not cancel the job. A browser reconnect obtains a new authoritative snapshot instead of relying on a replayed token log.

When explicitly enabled, a generation can make bounded sequential tool calls before its final answer. The application validates the complete tool-call round before any operation. The saved protocol transcript and visible activity summaries serve different purposes. A local job record establishes transcript provenance. Model arguments and imported records cannot grant permission. Code fences never execute these tools. See [tool protocol and limits](TOOLS.md).

The cancel API aborts the upstream request and an active tool operation. The final transaction saves partial text, terminal status, usage, and any error. Generation terminal states are complete, cancelled, interrupted, and error. Cancellation does not undo earlier completed tool actions. Failed or cancelled individual executions do not import their outputs. Workspace writes check cancellation immediately before committing.

On startup, the server marks orphaned running jobs interrupted and preserves committed messages. Execution records also become interrupted instead of replaying code. A crash can occur after a workspace commit but before its execution receipt is saved. Inspect current state before retrying. Neither model requests nor tool operations restart automatically.

## Provider scope

The client uses `/models` for optional discovery and `/chat/completions` for generation. It supports streamed completion deltas and ordinary JSON completion responses. Model names can be configured manually when discovery is unavailable.

Each connection defines streaming, vision, system prompt, sampling, token limits, and optional tools. The token limit parameter can be `max_tokens` or `max_completion_tokens`. Audio and video use separate protocol selections, each defaulting to `none`. The explicit `llama_cpp` choice does not follow from an endpoint URL, vision support, or statistics support. Capabilities do not imply that all models at the endpoint behave identically.

Visible text, supported attachments, and eligible local tool transcripts enter request history. Separate reasoning output is stored for display but is not resent as conversation text. Tool calls without the connection capability and a current submission permission fail explicitly. Permitted code goes only to the isolated runner, with no host-process fallback.

Audio/video inspection validates actual uploaded bytes before durable import or generation. Imported metadata is not trusted. Native video conveys sampled visual frames, not the soundtrack. The application does not transcode files, capture microphones/cameras, or generate audio/video. See [media protocol and limits](MEDIA.md).

## Security boundaries

The owner account can access all conversations and edit endpoints. This is not a multi-user authorization model. Endpoint editing intentionally permits private network addresses for local inference. Anyone with the owner password therefore has access to this outbound request capability.

The server stores a salted password hash and hashed session tokens. It uses HttpOnly, SameSite=Strict cookies. HTTPS configuration also sets Secure cookies. State changes require authenticated, same-origin JSON requests with a custom header.

Provider keys use AES-256-GCM encryption with a local `master.key`. The key is not returned by normal API responses or conversation exports. Browser users can submit a new key, but cannot retrieve the stored value.

The application does not encrypt chat text, attachments, workspace files, or browser drafts at rest. Possession of both the database and `master.key` permits decryption of stored API keys. Disk encryption and encrypted backups require separate deployment controls.

Documents, search passages, tool output, and model arguments are untrusted content. They cannot select another conversation, change execution policy, or grant tool permission. Execution permission exposes the current workspace to code even when direct file tools are off. Package permission permits the documented registry work and dependency restoration. Rootless container isolation is not a virtual-machine boundary or an independent security audit.

The renderer escapes raw HTML and rejects script URLs. It does not fetch remote Markdown images. Uploaded images require recognized MIME types and signatures. The server does not perform malware scanning or full image validation.

## Known scaling limits

Synchronous SQLite and file operations can block the Node event loop. Conversation search scans stored text, and workspace search ranks literal keyword matches in current extracted passages. Neither uses embeddings or a search service. Workspace storage, extraction, snapshots, and outputs have fixed bounds. Large histories and imports can still delay other requests. The preview targets one owner rather than high-throughput shared hosting.

A migration to multiple processes would require a coordinated job queue, shared locking, and a revised storage design. Simply starting another replica is not supported.
