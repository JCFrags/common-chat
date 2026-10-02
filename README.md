# Common Chat 0.2 community preview

A single-owner chat server with shared history, device-local drafts, conversation files, and configurable model connections.

This preview is for a first deployment and user feedback before a stable release. Integration and deployment acceptance for the new features are still in progress. See [release status and update procedures](docs/RELEASES.md).

Common Chat uses Node.js and browser JavaScript, with theme tokens adapted from llama.cpp. It is not an extraction of the full upstream Svelte interface. See [source provenance](UPSTREAM.md).

## What this version does

| Area | Implementation |
| --- | --- |
| Shared history | SQLite stores conversations, branches, messages, settings, and generation status. Devices access the same server. |
| Model connections | The server calls configurable OpenAI-compatible chat completion endpoints. Keys stay server-side. |
| Independent generation | A response continues after the browser disconnects. A new browser connection loads the saved state. |
| Editing | Message edits create branches. Regeneration keeps earlier responses. Branch selection is shared across devices. |
| Drafts | Unsent composer text, attachment references, edit state, and unresolved submissions persist in this browser's localStorage. They do not sync between devices. See [drafts](docs/DRAFTS.md). |
| Workspace | Each conversation has logical files, immutable revisions, restore, and keyword search with source citations. PDF/DOCX extraction requires the isolated runner. See [workspaces](docs/WORKSPACE.md). |
| Optional tools | Explicit per-submission permissions enable scoped file tools, Python/shell execution, and package operations. Execution needs a separately configured runner. See [tools](docs/TOOLS.md) and [runner setup](docs/RUNNER.md). |
| Attachments | UTF-8 text and PNG, JPEG, WebP, or GIF images remain supported. Image requests require vision capability. Audio/video require inspection and the explicit `llama_cpp` input protocol. See [media](docs/MEDIA.md). |
| Migration | The importer accepts llama.cpp legacy JSON, current JSONL, and ZIP archives of conversation exports. |
| Authentication | One owner account can have separate sessions on multiple devices. API keys use authenticated encryption at rest. |
| Recovery | The server retains committed partial output. Backup and restore scripts include the database, files, and encryption key. |

## Start locally

Use Node.js 24. The minimum version is 22.16.0, with the built-in `node:sqlite` module. The core server has no npm runtime dependencies. Pinned browser assets ship in `public/vendor`, so startup does not require npm install or a build. Rebuilding these assets requires the build-only dependencies. See [operations](docs/OPERATIONS.md).

The optional runner is a separate installation. Starting Common Chat does not provision a container engine, install runner packages, or start a model server.

1. Obtain the preview source or archive described in the [release guide](docs/RELEASES.md).
2. Open a terminal in the `common-chat` directory.
3. Start the server.

```sh
npm start
```

4. Open `http://localhost:3000` in a browser.
5. Sign in with the initial owner password from the server terminal.

The server creates `./data` on first startup. Without `CHAT_PASSWORD`, it generates a random password. It prints that password only when it creates the account.

Some Node.js 22 versions print an experimental warning for `node:sqlite`. The original release's runtime evidence is retained in the [historical verification report](docs/VERIFICATION.md).

## Connect a model server

The chat server must be able to reach the model endpoint. The browser does not connect to that endpoint directly. The base URL must include the API prefix, usually `/v1`. The application adds `/models` or `/chat/completions` to this URL.

1. Open "Connections".
2. Enter a connection name.
3. Enter the base URL for the model server.
4. Enter its API key when the endpoint requires one.
5. Enter model names or leave the list empty for model discovery.
6. Enable only the capabilities that the endpoint and selected models support.
7. Select "Save connection".
8. Select a connection and model above the conversation.
9. Enter a message.
10. Select "Send".

Example base URLs for native deployment on the same host follow. Actual ports depend on the model server configuration.

```text
llama.cpp: http://127.0.0.1:8080/v1
Ollama:    http://127.0.0.1:11434/v1
Other:    http://model-server:8000/v1
```

Both named projects document OpenAI-compatible endpoints. The backend baseline uses a simulated compatible endpoint. It does not establish live compatibility with those servers. Compatibility varies by model and feature. Source references are in `UPSTREAM.md`.

Capabilities are configured per connection. Separate connections can use the same endpoint with different model lists and capabilities. Unsupported settings cause explicit errors rather than silent omission. The settings dialog hides unsupported controls. For a compatible llama.cpp server, enable "Live llama.cpp statistics (llama.cpp only)" to request interim timing and prompt-progress records. This option defaults to off. Do not enable it for other providers.

Audio input, video input, and model tools each need their own explicit capability. Vision and statistics settings do not enable them. Audio/video protocol selections default to `none`; choose `llama_cpp` only when the endpoint and selected model support that input. Native video supplies visual frames, not its soundtrack. Tools also require a fresh permission grant on each submission. See [media](docs/MEDIA.md) and [tool permissions](docs/TOOLS.md).

## Drafts, files, and optional execution

Composer drafts survive page reloads and browser restarts when the browser retains site data. They are local to the browser profile and server origin, are not encrypted, and are not part of server backups. Explicit Sign out clears Common Chat drafts for that origin in the current browser. Storage failures leave a visible warning. See [draft recovery and privacy](docs/DRAFTS.md).

Workspace file, code, and package editor buffers are separate in-page drafts. Save or copy those edits before reloading or closing the page. The [Files and Run code interface](docs/WORKSPACE-UI.md) documents their recovery limits.

Workspace files are separate from message attachments. Their logical names never select host files. Edits require the current revision, and search results identify an exact revision and page or paragraph. Text and common source formats are indexed locally. PDF/DOCX extraction uses the isolated runner and reports missing extraction, failures, or scanned-PDF limitations instead of pretending the document was indexed. See [workspace storage and search](docs/WORKSPACE.md).

Python and shell execution require the optional rootless Podman broker on Linux with cgroup v2, under a separate operating-system account. The app connects only to the restricted broker socket, never the engine socket. Code runs on copied workspace inputs, with bounded outputs and no execution-phase network. Package operations require separate permission. Code fences do not trigger model tools. See [runner setup](docs/RUNNER.md) and [tool behavior](docs/TOOLS.md).

## Response statistics

Each assistant message has a collapsed, keyboard-accessible statistics section. Its summary shows PP and TG rates, plus prompt progress during a stream when reported. Select the summary to show token counts, latency, MTP counts when reported, and the explanation. Open sections remain open during thread updates. Supported statistics update during generation. Missing fields remain unavailable:

- **PP** is prompt-processing speed in tokens/s. **TG** is token-generation speed in tokens/s. These are the model server's reported rates, not estimates from chat duration.
- Input and output token counts use upstream usage. If usage is absent, llama.cpp timing counts are used. "Input tokens (timed)" can exclude cached input. llama.cpp output counts include reasoning tokens and the answer. Other providers define their own counts. A separate reasoning count appears only if the provider reports it.
- Elapsed time updates during generation. Final duration is the chat server's time from model request start to response end or failure. First text is the time from request start to the first nonempty answer or reasoning delta. Both include queue and transport time. First text is unavailable for non-streaming JSON responses.
- Prompt progress shows the last upstream processed/total token sample, including cached tokens. It is not an estimated count. Cached tokens and upstream prompt elapsed time appear in the expanded section.
- MTP accepted / drafted shows accepted and proposed multi-token prediction tokens when the model server reports them.

Streaming requests ask for usage with `stream_options.include_usage`. The explicit llama.cpp option also sends `timings_per_token: true` and `return_progress: true`, only for streaming requests. Supplied interim metadata is saved and displayed even without that option. Updates are bounded to ten per second. Quiet requests update server elapsed time at most once per second. Final validated values replace interim values, including final usage-only chunks. Initial zero rates with zero corresponding tokens display "pending" while streaming.

Validated numeric usage, timings, prompt progress, and chat-server observations are retained in native exports. No database migration is required. Missing or invalid values show "unavailable". Historical messages show only recorded data. Stopped or failed streams can lack final upstream statistics. A hard crash can also leave no chat-server observations.

## Use another device

Both devices must use the same chat server address and owner password. The default address listens only on the server itself.

WARNING

Use HTTPS or a private encrypted tunnel before remote access. HTTP sends passwords, session cookies, and conversations without transport encryption.

For direct access on a trusted local network, the environment file can specify the server address. This example still uses HTTP. Replace `chat.example` with your reachable server name.

```dotenv
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=http://chat.example:3000
DATA_DIR=./data
```

1. Copy `.env.example` to `.env`.
2. Set `PUBLIC_URL` to the exact browser-facing origin.
3. Set `HOST` to the required listen address.
4. Restart the server.
5. Open the configured address on both devices.
6. Sign in on each device.

`PUBLIC_URL` must have no application path, query, or fragment. HTTPS deployment requires a reverse proxy or tunnel that provides TLS. The Node server itself serves HTTP. See `docs/OPERATIONS.md` for proxy and Docker configuration.

## Import existing conversations

The application cannot read another browser's IndexedDB directly. Export the conversations from the original llama.cpp interface first.

1. Select "Import conversations" in Common Chat.
2. Select the exported JSON, JSONL, or ZIP file.
3. Review the import result and any warnings.
4. Open an imported conversation from the sidebar.

Imports preserve branch relationships and supported attachments. The importer assigns new internal IDs to avoid collisions. Unknown message fields remain in source metadata for later export. It rejects invalid graphs and malformed archives without importing partial conversations.

Supported native audio/video attachments retain their original bytes and must pass inspection again on import. Unsupported legacy attachment forms remain archived with warnings. Imported tool transcripts and permissions are archived, not accepted as executable local tool history or permission grants. Branches with unsupported archived context cannot continue silently. Importing a legacy PDF attachment does not automatically create or index a workspace document. See [media import rules](docs/MEDIA.md), [tool provenance](docs/TOOLS.md), and [workspaces](docs/WORKSPACE.md).

Repeated imports create separate conversations. Imports do not merge or deduplicate previous imports.

## Backup and recovery

Conversation JSON exports contain messages, branches, and supported attachments. They exclude login credentials, model connections, API keys, workspace files, and browser drafts. Full offline backups include the server database, attachments, workspace revisions, and `master.key`. Browser drafts require separate care on the device. No cloud backup connector is included.

CAUTION

Stop the server before a full backup. Keep `master.key` with its database. A missing or incorrect key prevents saved API keys from decrypting.

```sh
npm run backup -- ./data ./backups/snapshot-001
npm run restore -- ./backups/snapshot-001 ./restored-data
```

The destination must be a new directory. The restore script checks file hashes and SQLite integrity. The operations guide includes password reset and Docker volume procedures.

## Test or preview

```sh
npm test
npm run check
npm run demo
```

The demo uses a simulated model and a temporary data directory. Its password is `local-demo-password`. It removes demo data after a normal shutdown. It does not load or run a language model.

The existing backend baseline has 46 tests. Its passing baseline runs do not establish acceptance of the combined preview features. New integration, browser, runner, and deployment checks remain separate work. No new live-model acceptance is claimed.

The [original verification report](docs/VERIFICATION.md) records the earlier 0.1 test counts, seven offline UI checks, and the managed-browser, Docker, and live-model limits from that release. Those are historical results, not fresh preview acceptance. See [release status](docs/RELEASES.md) for the current stage.

## Scope and limits

This is a single-owner application, not a multi-tenant service. Anyone with the owner password can read all stored conversations and edit model connections. It has no SSO, invitation flow, or per-user isolation.

Sent messages, attached files, and workspace revisions are server state. Unsent drafts use device-local browser storage. They can survive closing a tab but do not transfer between devices. Browser data removal or storage failure can lose them. See [draft limitations](docs/DRAFTS.md).

A browser disconnect does not cancel generation. A server crash does interrupt generation. After restart, committed partial text remains and the response is marked interrupted. The latest uncommitted tokens can be lost. Generation does not automatically resume after a server crash.

The assistant answer and reasoning support headings, nested lists, read-only task checkboxes, tables, HTTP/HTTPS links, quotes, emphasis, strikeout, and code fences. Known code languages have syntax highlighting and source-copy controls. KaTeX renders inline `$...$` and `\\(...\\)` math and block `$$...$$` and `\\[...\\]` math as native MathML. Mermaid fences support flowcharts, sequence diagrams, class diagrams, state diagrams, entity-relationship diagrams, and pie charts. Source remains available for every diagram. User messages remain plain text.

Raw HTML is escaped and Markdown images do not load in the chat body. Completed Mermaid fences, full HTML/SVG documents, and browser fences marked `preview`, `run`, or `artifact` show results by default. Compact Copy, Source/Result, and Actions controls leave the result in view. Actions contains the editable sandbox, Stop, Restart, Console, and sandbox information. Errors reveal the console. Mermaid uses a borderless canvas matched to the chat's light/dark appearance while retaining input styles. Source includes grouped CSS/JavaScript with separate copy controls. Explanatory fences marked `example` or `source` remain code-first. Adjacent CSS/JavaScript can join an HTML artifact. Unchanged results keep running during server updates. The editable sandbox supports combined snippets, console output, browser code, and optional external resources. Mermaid styles, HTML labels, configuration, and callbacks remain inside the opaque-origin sandbox.

Preview code cannot access chat DOM, cookies, storage, or host files. Automatic frames permit scripts only. Manual frames also permit forms, dialogs, downloads, and sandboxed popups. Frames can navigate to websites even with external resources off. This is not an offline, CPU, or operating-system isolation guarantee. Do not enter secrets. Footnotes, Mermaid mind maps, architecture diagrams, ELK layouts, and Mermaid-internal math are not supported. This browser-preview feature does not expose Python, shell, or other native runtimes. Those require an explicit operation through the separate runner. Incomplete or oversized content stays code-first. Invalid artifacts report errors with source available. See `docs/OPERATIONS.md` for controls, isolation, limits, and browser requirements.

On mobile layouts up to 760 CSS pixels wide, a right swipe from the left 24-pixel edge opens the sidebar. A left swipe from a noninteractive area inside the open sidebar closes it. Swipes need at least 64 pixels of horizontal movement within 800 ms and must be mostly horizontal. Buttons, links, text entry, selected text, and rich message content retain their normal touch actions. Vertical scrolling and horizontal code/table/diagram scrolling do not invoke the gesture. The menu button and backdrop tap remain available. Physical-phone behavior requires device verification.

Optional model tools are limited to the documented workspace and runner operations. There is no MCP integration, unrestricted host execution, model management, or offline synchronization. PDF/DOCX extraction is not optical character recognition. Audio transcription and visual interpretation depend on a compatible selected model, not a built-in transcription service. There is no microphone/camera capture or audio/video generation. The application uses chat completions, not a universal provider protocol or the Responses API.

The server allows one active generation per conversation and eight overall. It limits each upload to 10 MiB and each message to ten attachments. The selected context has a 30 MiB attachment limit. Conversation exports must fit the 24 MiB import limit. Larger history requires a full offline backup.

The sidebar returns up to 1,000 matching conversations. Conversation search can locate older conversations outside the initial list. Workspace document search is separate. Workspace bytes, paths, revisions, and extraction have [fixed limits](docs/WORKSPACE.md#limits). The rest of the application has no installation-wide disk quota or automatic cleanup policy. Monitor storage and keep offline backups.

## Source layout

```text
server/                 HTTP API, SQLite, generation, workspaces, tools, media
public/                 Browser application, local drafts, workspaces, rendering
runner/                 Separate optional execution and inspection broker
scripts/                Demo, health check, backup, restore, password reset
tests/                 Unit, API, crash-recovery, and browser tests
examples/               Small import examples with synthetic content
docs/                   Operations, architecture, API, and verification
licenses/               Original upstream license notice
```

The original source uses the MIT license. The adapted theme retains the upstream notice. Provenance and reference URLs are in `UPSTREAM.md`.
