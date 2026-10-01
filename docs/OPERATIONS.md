# Operations

STE-style, not verified for ASD-STE100 compliance.

This guide describes Common Chat 0.1.0. The native Node deployment was tested on Linux. The Docker configuration is supplied but was not built in this environment.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address for native deployment. |
| `PORT` | `3000` | Listen port for native deployment. Published host port for Compose. |
| `PUBLIC_URL` | Local loopback origin | Exact browser-facing origin. Required for a non-loopback listen address. |
| `DATA_DIR` | `./data` | Native data directory. Compose uses `/app/data` in its named volume. |
| `CHAT_PASSWORD` | Random initial password | Initial owner password. It does not replace an existing password. |
| `BIND_ADDRESS` | `127.0.0.1` | Published host address for Compose only. |

The start command reads `.env` when that file exists. Ordinary environment variables take precedence. The server validates the HTTP Host and Origin headers against `PUBLIC_URL`.

The data directory must belong to one server process. This release uses a process lock and SQLite. It does not support multiple replicas or shared network storage.

## Trusted-local deployment

The home-server deployment adds an opt-in `CHAT_TRUSTED_LOCAL=true` mode. The default mode still requires a password.

WARNING

Trusted-local mode has no application login. Every allowed client can read all conversations, change connections, and use saved API keys. HTTP also exposes conversation content on the local network. Do not publish this deployment to the internet.

1. Set `CHAT_TRUSTED_LOCAL=true` and an exact `PUBLIC_URL`.
2. Keep `HOST=127.0.0.1`. The application rejects non-loopback listeners and requests in this mode.
3. Use a reverse proxy that preserves Host and restricts source addresses to the trusted LAN and personal VPN.
4. Do not trust a client-supplied `X-Forwarded-For` header for access control.

The interface opens directly and hides "Sign out". Host validation, Origin validation, and same-origin JSON mutation headers remain required. The database retains an inaccessible random password hash for account compatibility. No initial password is printed in this mode.

## Docker Compose

WARNING

Use HTTPS or an encrypted tunnel before remote access. The default Compose port is restricted to the host loopback address.

1. Copy `.env.example` to `.env`.
2. Set `PUBLIC_URL` to the address that browsers will use.
3. Set `CHAT_PASSWORD` or leave it unset for an initial random password.
4. Build and start the service.

```sh
docker compose up -d --build
```

5. Read the startup log.

```sh
docker compose logs chat
```

6. Open the configured address.
7. Sign in with the configured or generated password.

The container runs as the `node` user. The data volume remains writable. The root filesystem is read-only. Compose drops Linux capabilities and enables a health check.

A non-loopback `BIND_ADDRESS` publishes the port beyond the host. This does not enable TLS. A separate HTTPS reverse proxy or encrypted tunnel is still required for protected remote access.

Inside the container, `127.0.0.1` means the container itself. It does not identify a model server on the Docker host. The Compose file supplies a `host.docker.internal` host mapping. A possible base URL is `http://host.docker.internal:8080/v1`. The model server must accept connections on that reachable host interface. A model server bound only to host loopback may not accept that connection.

## HTTPS reverse proxy

The application serves HTTP internally. The proxy must provide TLS for the browser-facing address.

1. Set `PUBLIC_URL` to the exact HTTPS origin.
2. Forward that origin to the internal Common Chat HTTP port.
3. Preserve the browser-facing Host header on forwarded requests.
4. Disable response buffering for `/api/events`.
5. Set the proxy idle timeout above the 15-second event heartbeat interval.
6. Permit request bodies of at least 34 MiB for maximum-size imports.
7. Keep the internal port inaccessible from untrusted networks.

The server marks session cookies Secure when `PUBLIC_URL` uses HTTPS. It also supplies an HSTS header. Forwarded headers do not override its configured origin or login rate-limit address. Behind a proxy, all users can share one login rate-limit bucket.

## Native backup

CAUTION

Stop the server before backup. Keep the database, attachments, and `master.key` together. A partial copy can lose history or prevent key decryption.

1. Stop the server with Ctrl+C or SIGTERM.
2. Create a backup in a new directory.

```sh
npm run backup -- ./data ./backups/snapshot-001
```

3. Copy the complete backup to protected storage.
4. Restart the server.

The script refuses a directory with `server.lock`. It checks SQLite integrity and creates a SHA-256 file manifest. Backup files contain private conversations, session records, and the API key decryption key. File hashes detect changes but do not authenticate an untrusted backup source.

## Native restore

1. Stop the server.
2. Restore a trusted backup into a new directory.

```sh
npm run restore -- ./backups/snapshot-001 ./restored-data
```

3. Set `DATA_DIR=./restored-data` in `.env`.
4. Start the server.
5. Sign in and inspect conversations and attachments.

Restore verifies file sizes, hashes, paths, and SQLite integrity. It does not overwrite an existing destination. A restored backup also restores its saved password and sessions. A password reset revokes those sessions.

## Docker volume backup

These commands create a direct offline copy, not the manifest format used by the native backup script.

CAUTION

Do not run `docker compose down -v` on the active deployment. That command removes the named volume and its stored conversations.

1. Stop the service.

```sh
docker compose stop chat
```

2. Copy the complete data directory from the stopped container.

```sh
docker compose cp chat:/app/data ./backup-data
```

3. Start the service again.

```sh
docker compose start chat
```

For restoration, the target volume must be empty. The copied directory must contain `chat.sqlite`, `master.key`, and `files`. Do not replace selected files in an existing database directory.

1. Stop the target service.
2. Copy the complete backup into its empty data volume.

```sh
docker compose cp ./backup-data/. chat:/app/data
```

3. Restore file ownership for the container user.

```sh
docker compose run --rm --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh chat -c 'chown -R node:node /app/data && chmod 700 /app/data'
```

4. Start the target service.

These Docker procedures require verification on the deployment host. The Docker CLI was not available during this release test.

## Reset the owner password

CAUTION

Stop the server before password reset. A successful reset invalidates all existing sessions.

1. Set a new `CHAT_PASSWORD` in `.env`.
2. Reset the native account.

```sh
node --env-file=.env scripts/reset-password.mjs
```

3. Start the server.
4. Sign in again on each device.

For a stopped Compose deployment, the reset command is different.

```sh
docker compose run --rm chat node scripts/reset-password.mjs
```

The reset uses the `CHAT_PASSWORD` supplied by Compose. The value must contain at least 12 characters.

## Response statistics

Assistant messages retain numeric upstream `usage` and `timings` in metadata. The server keeps recognized token counts, usage detail counts, and llama.cpp fields `prompt_n`, `prompt_ms`, `prompt_per_second`, `predicted_n`, `predicted_ms`, `predicted_per_second`, `draft_n`, and `draft_n_accepted`. Counts must be nonnegative safe integers. Times and rates must be finite, nonnegative numbers within the safe numeric range. Unknown fields and invalid values are not stored.

PP and TG display upstream `prompt_per_second` and `predicted_per_second` in tokens/s. The application does not calculate replacement rates from response duration. Input/output counts prefer `prompt_tokens`/`completion_tokens`, then `prompt_n`/`predicted_n`. A fallback input count is labeled "timed" because caching can reduce it. llama.cpp output counts include reasoning and answer tokens. Other providers define their own counts. A separate reasoning token count is shown only when `completion_tokens_details.reasoning_tokens` is available. MTP accepted / drafted uses `draft_n_accepted`/`draft_n`.

The saved `observed.durationMs` uses a monotonic clock from model request start to response end or failure. `observed.firstTextMs` stops at the first nonempty answer or reasoning delta in an actual stream. These observations include queue, transport, and response processing time. They are not model execution timings. Buffered JSON responses retain duration but cannot expose first-text latency, even if streaming was requested. Displayed rates and seconds are rounded to two decimals. Raw validated values remain in metadata.

Streaming requests use the standard `stream_options: { include_usage: true }`. llama.cpp can return usage and timings in a final event with no choices. Providers without these fields remain usable but show unavailable statistics. If an endpoint rejects the standard usage option, disable streaming for that connection to use its JSON response. The application does not retry a rejected generation automatically.

Metadata uses the existing JSON column and native export/import format. Old messages need no migration and receive no invented values. Cancelled, interrupted, and failed responses retain observed timings when the server can finish the job, but upstream statistics may be absent. Hard crashes can leave no timing observations. Reloading the conversation reads the saved values rather than measuring browser rendering time.

## Rich rendering and mobile input

Assistant answers and reasoning use the same renderer. User messages stay plain text. Rendering does not change saved message source, provider data, settings, attachments, or import/export content.

Supported Markdown includes headings, nested ordered/unordered lists, read-only `[ ]` and `[x]` tasks, tables with column alignment, HTTP/HTTPS links without URL credentials, quotes, emphasis, strikeout, and fenced code. Raw HTML is escaped in the chat body. Markdown image syntax remains text and makes no image request. Footnotes are not enabled. Executable HTML/JavaScript previews require an explicit sandbox Run action, described below. Fences have language labels and source-copy controls. Unsupported languages stay readable without automatic language detection.

The bundled highlighter supports JavaScript, TypeScript, Python, JSON, Bash, CSS, HTML/XML, SQL, C, C++, Java, Rust, Go, YAML, Markdown, and their registered aliases. A code block must have a closing fence and fit the highlighting limit. Streaming responses show plain code until the response ends.

KaTeX supports `$...$` and `\\(...\\)` inline math. Put `$$...$$` or `\\[...\\]` block math on separate lines. The opening and closing delimiters can share one block line. Incomplete delimiters remain visible text. Math uses MathML-only output, not inline HTML styles or downloaded fonts. Use a current browser with native MathML, such as Firefox, Chromium 109 or later, or current Safari. Mermaid 12 targets modern browsers, including Safari 17.4 or later. Browser acceptance remains a separate deployment check.

Mermaid supports `graph`/`flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram`/`stateDiagram-v2`, `erDiagram`, and `pie` fences. Other types remain visible source. The Tiny build excludes mind maps, architecture, ELK layouts, and Mermaid math. The automatic renderer ignores simple `style`, `classDef`, `linkStyle`, and applicable class assignments. It uses fixed application styles and preserves the original source for copying. Statement-aware parsing permits ordinary reserved words in labels. Input frontmatter, configuration directives, complex styling, callbacks, click links, HTML labels, URL text, and image/icon shapes still use visible-source fallback. These features can be tried with an explicit sandbox preview instead.

| Work | Limit per answer or reasoning body |
| --- | --- |
| Rich parsing | 128 Ki characters, with nesting depth 32. Larger bodies display escaped source. |
| Code highlighting | 16 Ki characters per fenced block. Larger blocks display plain source. |
| Math | 4,096 characters per expression, 100 expressions, and 32 Ki characters in all expressions. |
| Math expansion | 500 macro expansions and maximum user-specified size 10 em. Each expression gets fresh macros. `trust` is false. |
| Mermaid input | 8,192 characters, 100 newline/semicolon segments, and 600 word tokens per diagram. |
| Mermaid graph | Maximum 100 edges. |
| Mermaid count | Four diagrams per body and eight diagrams per visible thread update. |
| Mermaid output | 512 Ki characters and 2,500 SVG descendant elements per diagram. |

Diagrams render one at a time, only after generation ends and a closing fence is present. Rerenders, navigation, and sign-out invalidate queued work. Stale asynchronous results cannot replace the current thread. Input size limits bound work but are not a hard execution-time deadline for Mermaid's main-thread layout. Invalid or unsupported diagrams show an error and their source. Diagram callbacks are never bound.

DOMPurify sanitizes generated browser HTML/MathML and diagram SVG. SVG allows only static drawing/text elements and bounded output. It removes scripts, links, images, `foreignObject`, animation, styles, and network references. Marker and accessibility references are rewritten to unique local IDs. The chat document retains `script-src 'self'` and `style-src 'self'`. Its explicit `frame-src 'self'` permits the separate preview document. Only that sandbox document allows inline execution and styling. Fixed external CSS replaces Mermaid-generated inline styles. Mermaid can still attempt to insert internal styles into its temporary offscreen render stage. The CSP blocks those styles. No remote renderer assets, CDN, fonts, or model content requests are needed.

On an HTTP site, browser clipboard access can be absent. The code-copy control then reveals and selects the source and shows manual copy instructions. Use the browser Copy command, Ctrl+C, or a touchscreen long-press. Whole-message Copy still copies the original message source when clipboard access is available.

Mobile touch gestures apply only up to the existing 760 CSS-pixel breakpoint:

1. Swipe right from the left 24-pixel edge of a noninteractive application area to open the sidebar.
2. Swipe left from a noninteractive area inside the open sidebar to close it.

Each gesture needs 64 pixels of horizontal movement within 800 ms, at most 40 pixels of vertical movement, and at least 1.7 times as much horizontal as vertical movement. Multiple touches, existing text selection, vertical movement, interactive controls, and rich message content are excluded. Mouse drags do not trigger gestures. The existing menu button and backdrop tap still work. The automated check covers direction/distance classification, not physical-phone gesture behavior.

### Run code and preview diagrams

1. Select "Preview / Run" on a completed HTML, XML/SVG, CSS, JavaScript, or Mermaid fence.
2. Review or edit the source fields. Use "Load code blocks from this answer" to combine HTML, CSS, and JavaScript snippets. If the answer has several Mermaid blocks, this action loads the first. Open another block to preview another diagram.
3. If the JavaScript uses module syntax, select "JavaScript is an ES module". Browser JavaScript does not provide Node.js `require`, process access, or a host filesystem.
4. If the example needs remote libraries, styles, images, fonts, media, frames, or requests, select the external-resource option.
5. Select "Run / Restart". "Stop" or "Close" removes the execution frame. Switching chats, branches, or signing out also stops the preview. Source edits are temporary and do not change the saved answer.

WARNING

Preview code is untrusted. Do not enter secrets or select private files in a preview. External resources can contact websites and devices reachable by your browser. The option blocks resource loading by default, but it is not an offline guarantee: code can navigate its own frame, create sandboxed popups, and initiate downloads. Popups keep sandbox restrictions. Browsers can offer external protocol handlers after a user action. Preview code can display misleading content, open dialogs, consume CPU/memory, and forge console messages. A busy loop can require closing the browser tab. This is origin isolation, not an operating-system container or a hard CPU/network limit.

The preview uses `/sandbox` with both an iframe sandbox attribute and an HTTP CSP `sandbox` directive. Neither permits `allow-same-origin`, top navigation, storage access, or popup sandbox escape. Its opaque origin cannot access the chat DOM, cookies, or storage. The response policy also applies when the sandbox URL is opened directly. API Origin and same-origin JSON mutation checks remain active. The main document never evaluates preview source.

A dedicated MessageChannel transfers only the chosen source, once after the initial trusted frame loads. Responses can append bounded console text only, never invoke chat actions. The parent inserts console text with text nodes. The console retains at most 100 entries and about 20 Ki characters. Each editor uses the existing 128 Ki-character message bound. These limits do not bound all browser work.

The sandbox loads the same pinned Mermaid Tiny bundle through the public `/sandbox-mermaid.js` endpoint. CORS permission applies only to that static bundle, never to chat APIs. Manual Mermaid rendering permits input styles, HTML labels, configuration and callback binding inside the sandbox. Define callback functions in the JavaScript field when needed. Remote resources still need the explicit option and remain subject to browser CORS, mixed-content, and network rules. The Tiny build's missing diagram types remain unavailable. Invalid source reports its renderer error in the console. Automatic diagrams never bind callbacks.

### Rebuild browser assets

Committed assets under `public/vendor` let the server run without npm install. Only contributors who change the renderer dependencies need this procedure:

```sh
npm ci --ignore-scripts
npm run build:renderer
npm run check
npm test
```

Exact build-only versions and package integrity are in `package.json` and `package-lock.json`. The build uses esbuild to bundle the parser, math renderer, selected highlighter languages, and DOMPurify. It copies the self-contained Mermaid Tiny bundle and changes only its final export to an ES module. No install hooks are needed. The build records asset sizes and SHA-256 hashes in `public/vendor/manifest.json`. Licenses and provenance are in `licenses/rendering/README.md`. Do not commit `node_modules`.

## Recovery and troubleshooting

A normal stop flushes active responses and marks them interrupted. A hard crash can leave a stale process lock. On the same host, the next startup removes a lock whose process no longer exists.

A copied crash-state directory can contain a PID that belongs to another host. Confirm that no Common Chat process uses that directory before removing a stale lock. Never remove a lock to bypass an active server.

A missing `master.key` prevents startup when a database already exists. Restore the matching key from backup. Creating a replacement key does not recover saved API keys.

A Host rejection usually means `PUBLIC_URL` differs from the browser address. A model connection failure usually needs a base URL, network, or credential check. The base URL must include `/v1` when the provider expects that prefix.

An interrupted response is retained but not resumed automatically. Regenerate the response or send another message to continue. A conflicting edit requires a fresh conversation snapshot before retry.

This release has no independent security audit. Use one trusted owner and a restricted network. Avoid deployment as a public multi-user service.
