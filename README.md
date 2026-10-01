# Common Chat 0.1.0

A standalone chat server with shared history and configurable model connections.

This release is a new application with theme tokens adapted from llama.cpp. It is not an extraction of the full upstream Svelte interface. Repository cloning and the upstream build toolchain were unavailable during implementation. The application uses Node.js and browser JavaScript instead. The source archive contains a working server, interface, tests, and deployment files.

STE-style, not verified for ASD-STE100 compliance.

## What this version does

| Area | Implementation |
| --- | --- |
| Shared history | SQLite stores conversations, branches, messages, settings, and generation status. Devices access the same server. |
| Model connections | The server calls configurable OpenAI-compatible chat completion endpoints. Keys stay server-side. |
| Independent generation | A response continues after the browser disconnects. A new browser connection loads the saved state. |
| Editing | Message edits create branches. Regeneration keeps earlier responses. Branch selection is shared across devices. |
| Attachments | The server stores UTF-8 text and PNG, JPEG, WebP, or GIF images. Image requests require an enabled vision capability. |
| Migration | The importer accepts llama.cpp legacy JSON, current JSONL, and ZIP archives of conversation exports. |
| Authentication | One owner account can have separate sessions on multiple devices. API keys use authenticated encryption at rest. |
| Recovery | The server retains committed partial output. Backup and restore scripts include the database, files, and encryption key. |

## Start locally

The tested runtime is Node.js 22.16.0 on Linux. The package requires Node.js 22.16.0 or later. The server has no npm runtime dependencies and uses the built-in `node:sqlite` module. Pinned browser assets ship in `public/vendor`. Starting the server does not require npm install or a build. Rebuilding these assets requires the build-only dependencies. See `docs/OPERATIONS.md`.

1. Extract the archive.
2. Open a terminal in the extracted `common-chat` directory.
3. Start the server.

```sh
npm start
```

4. Open `http://localhost:3000` in a browser.
5. Sign in with the initial owner password from the server terminal.

The server creates `./data` on first startup. Without `CHAT_PASSWORD`, it generates a random password. It prints that password only when it creates the account.

Node.js 22.16.0 prints an experimental warning for `node:sqlite`. The test suite completed with that warning.

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

Both named projects document OpenAI-compatible endpoints. This release was tested with a simulated compatible endpoint, not those live servers. Compatibility varies by model and feature. Source references are in `UPSTREAM.md`.

Capabilities are configured per connection. Separate connections can use the same endpoint with different model lists and capabilities. Unsupported settings cause explicit errors rather than silent omission. The settings dialog hides unsupported controls.

## Response statistics

Each assistant message has a collapsed, keyboard-accessible statistics section. Its summary shows only PP and TG rates. Select the summary to show token counts, latency, MTP counts when reported, and the explanation. Open sections remain open during thread updates. Statistics are unavailable until reported, normally after the response ends:

- **PP** is prompt-processing speed in tokens/s. **TG** is token-generation speed in tokens/s. These are the model server's reported rates, not estimates from chat duration.
- Input and output token counts use upstream usage. If usage is absent, llama.cpp timing counts are used. "Input tokens (timed)" can exclude cached input. llama.cpp output counts include reasoning tokens and the answer. Other providers define their own counts. A separate reasoning count appears only if the provider reports it.
- Duration is the chat server's time from model request start to response end or failure. First text is the time from request start to the first nonempty answer or reasoning delta. Both include queue and transport time. First text is unavailable for non-streaming JSON responses.
- MTP accepted / drafted shows accepted and proposed multi-token prediction tokens when the model server reports them.

Streaming requests ask for usage with `stream_options.include_usage`. The final usage-only chunk can also contain llama.cpp timings. Validated numeric usage, timings, and chat-server observations are saved with each response and retained in native exports. No database migration is required. Missing or invalid values show "unavailable". Historical messages show only recorded data. Stopped or failed streams often have no final upstream statistics. A hard crash can also leave no chat-server observations.

## Use another device

Both devices must use the same chat server address and owner password. The default address listens only on the server itself.

WARNING

Use HTTPS or a private encrypted tunnel before remote access. HTTP sends passwords, session cookies, and conversations without transport encryption.

For direct access on a trusted local network, the environment file can specify the server address. This example still uses HTTP.

```dotenv
HOST=0.0.0.0
PORT=3000
PUBLIC_URL=http://192.168.1.50:3000
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

Unsupported audio, video, PDF, and tool records remain archived when supplied by the export. The importer reports unsupported attachments. It blocks model requests for branches that contain unsupported context. This prevents an apparently complete request from silently omitting that context.

Repeated imports create separate conversations. Imports do not merge or deduplicate previous imports.

## Backup and recovery

Conversation exports contain messages, branches, and attachments. They exclude login credentials, model connections, and API keys.

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

The release passed 38 Node tests and seven offline UI checks. Full HTTP browser acceptance tests were blocked by managed Chromium policy. Docker and live model connections were not tested. See `docs/VERIFICATION.md` for commands, logs, screenshots, and limitations.

## Scope and limits

This is a single-owner application, not a multi-tenant service. Anyone with the owner password can read all stored conversations and edit model connections. It has no SSO, invitation flow, or per-user isolation.

Sent messages and attached files are durable. Unsent drafts remain in browser memory. Drafts do not transfer between devices or survive a tab closure.

A browser disconnect does not cancel generation. A server crash does interrupt generation. After restart, committed partial text remains and the response is marked interrupted. The latest uncommitted tokens can be lost. Generation does not automatically resume after a server crash.

The assistant answer and reasoning support headings, nested lists, read-only task checkboxes, tables, HTTP/HTTPS links, quotes, emphasis, strikeout, and code fences. Known code languages have syntax highlighting and source-copy controls. KaTeX renders inline `$...$` and `\\(...\\)` math and block `$$...$$` and `\\[...\\]` math as native MathML. Mermaid fences support flowcharts, sequence diagrams, class diagrams, state diagrams, entity-relationship diagrams, and pie charts. Source remains available for every diagram. User messages remain plain text.

Raw HTML is escaped and Markdown images do not load in the chat body. Completed Mermaid fences, full HTML/SVG documents, and browser fences marked `preview`, `run`, or `artifact` show results by default. Source is under "Show code". Explanatory fences marked `example` or `source` remain code-first. Adjacent CSS/JavaScript can join an HTML artifact. Unchanged results keep running during server updates. The editable sandbox supports combined snippets, console output, browser code, and optional external resources. Mermaid styles, HTML labels, configuration, and callbacks remain inside the opaque-origin sandbox.

Preview code cannot access chat DOM, cookies, storage, or host files. Automatic frames permit scripts only. Manual frames also permit forms, dialogs, downloads, and sandboxed popups. Frames can navigate to websites even with external resources off. This is not an offline, CPU, or operating-system isolation guarantee. Do not enter secrets. Footnotes, Mermaid mind maps, architecture diagrams, ELK layouts, and Mermaid-internal math are not supported. Python, shell, and other native runtimes are not installed or exposed by this feature. Incomplete or oversized content stays code-first. Invalid artifacts report errors with source available. See `docs/OPERATIONS.md` for controls, isolation, limits, and browser requirements.

On mobile layouts up to 760 CSS pixels wide, a right swipe from the left 24-pixel edge opens the sidebar. A left swipe from a noninteractive area inside the open sidebar closes it. Swipes need at least 64 pixels of horizontal movement within 800 ms and must be mostly horizontal. Buttons, links, text entry, selected text, and rich message content retain their normal touch actions. Vertical scrolling and horizontal code/table/diagram scrolling do not invoke the gesture. The menu button and backdrop tap remain available. Physical-phone behavior requires device verification.

This version does not execute tools or MCP calls. It does not parse PDFs, transcribe audio, process video, manage models, or provide offline synchronization. It implements chat completions, not a universal provider protocol or the Responses API.

The server allows one active generation per conversation and eight overall. It limits each upload to 10 MiB and each message to ten attachments. The selected context has a 30 MiB attachment limit. Conversation exports must fit the 24 MiB import limit. Larger history requires a full offline backup.

The sidebar returns up to 1,000 matching conversations. Search can locate older conversations outside the initial list. This release has no automatic disk quota or storage cleanup policy.

## Source layout

```text
server/                 HTTP API, authentication, SQLite, generation, imports
public/                 Browser application, adapted theme, Markdown renderer
scripts/                Demo, health check, backup, restore, password reset
tests/                 Unit, API, crash-recovery, and browser tests
examples/               Small import examples with synthetic content
docs/                   Operations, architecture, API, and verification
licenses/               Original upstream license notice
```

The original source uses the MIT license. The adapted theme retains the upstream notice. Provenance and reference URLs are in `UPSTREAM.md`.
