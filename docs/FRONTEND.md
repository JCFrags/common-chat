# Svelte frontend

Common Chat vendors the actual llama.cpp `tools/ui` frontend under `ui/`. The upstream pin is `0c1e57098bba43ac29e6e3b677cdceebdd22334f`. See [provenance](../UPSTREAM.md) for its license and source history.

The frontend is Svelte 5 with SvelteKit, Tailwind, and static hash routing. It keeps the upstream component layout and uses Common adapters for persistence and generation. The independent Node.js server does not load a model or require llama-server.

## Build a source checkout

Use Node.js 24 for the build and the server.

```sh
npm --prefix ui ci --ignore-scripts --no-audit --no-fund
npm run check:ui
npm run build:ui
npm start
```

Build dependencies are not runtime dependencies. Do not commit `node_modules`, `.svelte-kit`, or `ui/dist`.

The build writes static assets under `ui/dist`. It also writes `frontend.json` with the source commit and a SHA-256 hash of `frontend-manifest.json`. The manifest records each built file's size and SHA-256 hash. A source commit identifies the build input. It does not prove that a working tree was clean or that a client loaded that build. Use a clean checkout for delivery and verify the served identity separately.

The server reads the built assets when it starts. If they are absent, the root page returns a build instruction with HTTP 503. It does not silently serve the old frontend. Restart the server after a rebuild. The server serves only its fixed static file map, not arbitrary filesystem paths.

## Package and install

`npm run release:pack -- VERSION preview OUTPUT_DIRECTORY` requires a clean committed checkout. It extracts that exact commit into a temporary directory, installs pinned frontend build dependencies, builds there, and includes `ui/dist` in the release archive. It does not copy stale ignored assets from the checkout. The archive excludes build dependencies and includes the frontend identity in `release.json`.

Release archives start without a frontend build. The Dockerfile builds the frontend in a separate stage. Follow [release procedures](RELEASES.md) and [operations](OPERATIONS.md) for backup, installation, and rollback. A successful build or package is not browser or deployment acceptance.

For local development with Vite, start the backend with `PUBLIC_URL=http://localhost:5173`, then run `npm --prefix ui run dev`. The development proxy forwards only `/api` and `/sandbox` routes to `http://localhost:3000`. Set `VITE_PUBLIC_SERVER_ORIGIN` if that backend uses another address. Keep the backend loopback-only. Production serves the static build directly and does not use this proxy.

## State and execution boundaries

- Common owns SQLite conversations, branches, settings, server generation jobs, and credentials. The browser does not keep a second authoritative conversation database.
- Submission returns a job receipt. Saved-state events and snapshots update the actual upstream message components. Browser disconnection does not cancel a job. Stop uses the server job API.
- Draft text and an unresolved exact request remain device-local. Clear a submitted draft only after acknowledgement. See [draft recovery](DRAFTS.md).
- Provider credentials stay encrypted on the server. The upstream API-key setting is not a second credential store or authentication mechanism.
- Advanced generation controls use explicit typed fields and declared provider capabilities. Custom JSON is not an unrestricted provider request override.
- Thinking support comes from an explicit model/connection declaration or supported catalog metadata. Model names do not establish a protocol. Llama token budgets are separate from remote reasoning-effort levels.
- Common files, execution, packages, dictation, MCP connections, and saved tool receipts use the authenticated [HTTP API](API.md). Native execution remains inside the separate rootless broker. [HTTP MCP tools](MCP.md) require explicit Connect, reviewed page-only choices, and confirmation for each new submission. Exact retry does not obtain a new grant.
- Upstream model load/download, host working directories, and browser MCP execution do not become trusted Common operations merely because their components were imported. Unsupported runtime actions must show their limitation rather than execute against an arbitrary endpoint.

## Browser policy

The app page retains same-origin scripts and connections. Its generated bootstrap and trusted runtime highlight styles use a per-response Content Security Policy nonce. Inline style attributes are allowed for upstream positioning and layout. Inline event handlers and authored scripts are not allowed in the app page.

Authored HTML, SVG, JavaScript, and Mermaid previews run in Common's opaque `/sandbox` frame. That policy still denies chat cookies, storage, DOM, APIs, and host files. External resources are off by default. The app's microphone permission applies only to the app page, never the sandbox. See [preview safety](OPERATIONS.md#run-code-and-preview-diagrams) and [dictation](INTERFACE.md#dictation).

The service worker caches static assets only. Authenticated API responses must not use offline cache fallback. A frontend update must not automatically reload a page with an unsent draft.

## Verification

Run the existing checks:

```sh
npm run check
npm run check:ui
npm run build:ui
npm test
```

Exercise the integrated frontend through a browser against a synthetic compatible endpoint before activation. Verify generation/reconnect/stop, acknowledged drafts, branch actions, typed sampling, connections, files, isolated artifacts, and dictation separately. Synthetic checks do not prove model quality, real microphone capture, or transcription quality. Keep these limits separate from source, GitHub, and local activation evidence.
