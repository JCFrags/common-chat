# Architecture

STE-style, not verified for ASD-STE100 compliance.

## Process boundaries

The browser accesses only the chat server. The chat server serves the interface, owns SQLite, stores attachments, and calls configured model endpoints. The model server remains a separate service. Common Chat does not load model weights.

```text
Browser
  HTTP API and event subscription
Common Chat process
  SQLite and attachment directory
  OpenAI-compatible chat completion client
Model endpoint
```

`server/app.mjs` provides HTTP routing and authentication checks. `server/store.mjs` owns database operations and file records. `server/generation.mjs` owns generation jobs. `server/provider.mjs` handles endpoint requests and streamed records. `server/transfer.mjs` validates imports and exports.

The browser uses ordinary JavaScript modules. No build step or browser database is required. The theme derives from a pinned llama.cpp stylesheet. The Markdown renderer is new and deliberately restricted.

## Durable state

The database contains conversations, message graphs, jobs, request IDs, connections, account settings, and hashed sessions. Each message identifies its parent. Edits create new user nodes. Regeneration creates a new assistant child without removing siblings.

A conversation identifies its active node and version. The active branch is shared across devices. An edit or generation request includes the expected version. The server rejects stale requests with HTTP 409.

Attachment records reference generated filesystem IDs. Original filenames are display metadata, not filesystem paths. Saved message attachments are immutable. Editing a message copies its attachment records and bytes to the new branch.

SQLite uses write-ahead logging and synchronous FULL mode. One process owns each data directory. Filesystem and database writes cannot form one atomic transaction. The implementation cleans failed import files and retains crash orphans conservatively.

## Generation lifecycle

A submitted request includes a client-generated request ID. The server checks for an earlier identical request before it starts another model call. Reusing an ID with different content causes HTTP 409.

The server validates the branch, connection, capabilities, settings, and attachments before saving a message. It then commits the user message, assistant placeholder, job, and request result together. The model request begins after that commit.

A background operation within the same server process consumes the model response. It commits partial text at approximately 100-millisecond intervals. This interval is not a hard durability guarantee. A crash can lose the latest uncommitted text.

An event subscription carries changes to connected browsers. Closing a subscription does not cancel the job. A browser reconnect obtains a new authoritative snapshot instead of relying on a replayed token log.

The cancel API aborts the upstream request. The final transaction saves partial text, the terminal status, usage, and any error. Terminal states are complete, cancelled, interrupted, and error.

On startup, the server marks orphaned running jobs interrupted. It preserves their committed messages. It does not restart model requests automatically.

## Provider scope

The client uses `/models` for optional discovery and `/chat/completions` for generation. It supports streamed completion deltas and ordinary JSON completion responses. Model names can be configured manually when discovery is unavailable.

Each connection defines streaming, vision, system prompt, temperature, top-p, and token limit capabilities. The token limit parameter can be `max_tokens` or `max_completion_tokens`. Capabilities do not imply that all models at the endpoint behave identically.

Only visible text and supported attachments enter the request history. Separate reasoning output is stored for display but not resent as conversation text. Tool calls cause an explicit error. The server does not execute model-produced commands.

## Security boundaries

The owner account can access all conversations and edit endpoints. This is not a multi-user authorization model. Endpoint editing intentionally permits private network addresses for local inference. Anyone with the owner password therefore has access to this outbound request capability.

The server stores a salted password hash and hashed session tokens. It uses HttpOnly, SameSite=Strict cookies. HTTPS configuration also sets Secure cookies. State changes require authenticated, same-origin JSON requests with a custom header.

Provider keys use AES-256-GCM encryption with a local `master.key`. The key is not returned by normal API responses or conversation exports. Browser users can submit a new key, but cannot retrieve the stored value.

The application does not encrypt chat text or attachment files at rest. Possession of both the database and `master.key` permits decryption of stored API keys. Disk encryption and encrypted backups require separate deployment controls.

The renderer escapes raw HTML and rejects script URLs. It does not fetch remote Markdown images. Uploaded images require recognized MIME types and signatures. The server does not perform malware scanning or full image validation.

## Known scaling limits

Synchronous SQLite and file operations can block the Node event loop. Search scans stored text. Large histories and imports can therefore delay other requests. This release targets one owner rather than high-throughput shared hosting.

A migration to multiple processes would require a coordinated job queue, shared locking, and a revised storage design. Simply starting another replica is not supported.
