# Workspace interface

`public/workspace.js` and `public/workspace.css` provide the Files and Run code dialog. The component uses the existing theme and sanitized Markdown renderer. It does not change model connections, generation settings, or model tool permissions.

## Integrate the component

1. Serve `/workspace.js` and `/workspace.css` as local static assets.
2. Add the stylesheet after `/style.css` in `public/index.html`.
3. Import and install the component once, after the topbar DOM exists.
4. Call `refresh()` after a conversation change or a workspace/execution event. The call reads the current conversation through the supplied callback. It only requests files while the dialog is open.
5. Call `close()` when showing the login screen or signing out. Closing stops browser polling, not server execution. It does not discard in-page editor drafts.

```js
import { installWorkspace } from './workspace.js';

const workspace = installWorkspace({
  api,
  getConversation: () => state.conversation,
  ensureConversation: async () => {
    // Use the app's normal conversation-creation path. Refresh the thread/list
    // and preserve its composer draft when that path creates a conversation.
    return state.conversation ?? await createConversation();
  },
  onChanged: async ({ conversationId, type, path }) => {
    // Refresh conversation state/list as needed. Do not change editor inputs.
    // type is "workspace" or "execution". path is optional.
  },
  toast
});

// After the app has applied a new conversation snapshot:
await workspace.refresh();

// Before the app shows its login screen:
workspace.close();
```

`api(path, method = 'GET', value)` must return parsed JSON and throw an error with a user-readable `message`. HTTP failures should provide numeric `status`. A transport failure uses `status: 0`. The component does not bypass the app's authentication or request-header handling. Downloads use same-origin, revision-specific attachment URLs.

`getConversation()` returns the current snapshot or `null`. `ensureConversation()` returns the current or newly created snapshot asynchronously. The latter must update the value that `getConversation()` returns. `onChanged({conversationId, type, path?})` runs after confirmed mutations. It is not an authorization request. Execution start, completion, and package changes use type `execution`.

The installer adds `#workspace-button` to `#topbar .toolbar`. Its return value is `{refresh, close, openFile, openExecution, openCode}`. `openFile(path, revision)` shows a saved revision. `openExecution(id)` shows its console and results. `openCode(source)` opens Python source for review and asks before replacing another code draft. It never starts execution or changes package consent. The installer rejects duplicate installation. It does not install global artifact previews or start a model.

## File behavior

- Upload uses each selected file's name as its workspace path. Create accepts a portable relative path such as `notes/summary.md`. The server validates path syntax, type, quota, and size.
- Existing and deleted paths require the current revision token. New paths use `expectedRevision: null`. Upload replacement asks for confirmation. No operation blindly overwrites a file.
- Files, deleted heads, revision history, source search, downloads, text editing, and restore are available in one dialog. Restore creates a new revision. Deleted files remain listed so that their history can be restored.
- Each conversation and file has its own in-memory editor buffer. Refresh, polling, dialog close, and conversation changes do not overwrite these buffers. Text entered while a save is pending remains an unsaved change after that save succeeds.
- Reload, discard, deletion, replacement upload, and revision restore ask before discarding unsaved text. Failed writes keep the draft. A revision conflict blocks another save until the file is reloaded or a new-file path is changed. Copy useful edits before discarding or reloading them.
- Drafts are not persisted across reloads, tab closure, or devices. The browser receives a leave-page warning when file, code, or package input could be lost. Browsers control whether that warning appears.
- Search uses indexed source text, not rendered HTML. Results show the source path, revision, and supplied page/paragraph/part location. Source citations are copyable. Opening a result reads its saved revision rather than attributing unsaved editor text to that citation.

### Previews

Markdown passes through the existing `markdown()` renderer. Raw HTML stays escaped. HTML, SVG, JavaScript, and other source formats are text, not executable documents. Workspace previews do not start artifact frames, scripts, or Mermaid rendering. Code-copy controls remain available.

PNG, JPEG, WebP, and GIF previews use only bounded base64 bytes returned for the selected revision. WAV, MP3, FLAC, MP4, and WebM use native media controls from bounded local blob bytes. Browser codec support can vary. Closing the dialog stops media playback and releases blob URLs. The component does not load a file-supplied image or media URL. Other binary types require download.

PDF and DOCX previews show extracted passages and their source locations. The interface states that layout, images, and some content can be missing. It does not claim full document fidelity or OCR support. Extraction failures remain visible, and the original revision can still be downloaded.

Text previews show at most 128 Ki characters. This does not truncate the editor or saved source. Document previews display 25 passages at a time. Search opens the passage group that contains the supplied citation. Image previews are limited to 10 MiB of encoded file content. Server limits remain authoritative.

## Execution and packages

The Run code section provides Python and shell input, explicit Run and Stop controls, runner availability, reported limits, a bounded console, and links to saved output files. It starts nothing on panel open. The runner must report both `enabled: true` and `ready: true` before Run is enabled. Missing or failed capability responses do not fall back to host execution.

Package access is explicit. The run checkbox permits approved registry downloads for the saved package specifications. A separate package editor requires its own consent before validation and save. Package access is not general internet access. Execution has no network access under the runner contract. The UI does not grant model tool permissions.

Package validation can take up to 300 seconds. Its pending state does not lock the file or code editor. The submitted package text is captured before the request. Later package edits remain unsaved. Loading a saved package list does not overwrite text changed while that read was pending.

The component polls the selected active job once per second while the dialog is open. Closing the dialog or switching conversations stops that polling. It does not cancel the server job. Reopening the conversation resumes status reads. Recent runs can recover a job after a page reload or an uncertain start response. Code is never retried automatically. After an uncertain start, a new submission requires selection of the existing job or explicit confirmation after checking recent runs.

The console uses text nodes, not HTML, and shows 64 Ki characters per page. Previous and Next controls reach all saved output. Download full console saves that output as text. The runner still applies output limits. The dialog lists at most 32 created or changed files and separately reports the number of current available files. Execution and runner operation IDs remain visible. A failed package validation keeps the prior saved list and shows its sanitized console. A polling error keeps the last known status and offers recovery through Recent runs. Stop requests cancellation and then reads the job state. An unconfirmed cancellation is not reported as stopped.

## API shapes

All conversation IDs and file query parameters are URL-encoded. The file prefix is `/api/conversations/:cid/workspace`.

| Request | Result |
| --- | --- |
| `GET /files` | `{files, usage, limits}`. Files include deleted heads. |
| `GET /files?path=&revision=` | `{file, text}` or `{file, data}`, with optional `passages`. Omitting revision reads the current file. |
| `PUT /files` | File metadata. Body: `{path, mime?, text OR data, expectedRevision}`. |
| `DELETE /files` | Deleted-head metadata. Body: `{path, expectedRevision}`. |
| `GET /history?path=` | `{path, currentRevision, revisions}`. Newest first. |
| `POST /restore` | New file metadata. Body: `{path, revision, expectedRevision}`. |
| `GET /search?q=&limit=25` | `{query, results, indexing}`. Results carry text and source citations. |
| `GET /download?path=&revision=` | Original file bytes with attachment disposition. |

File metadata has `path`, opaque UUID `revision`, numeric `version`, `mime`, `size`, `text` boolean, `deleted`, `createdAt`, and `index`. Read content's `text` is a string, not the metadata boolean. Passages have `text`, optional `page`, `paragraph`, `part`, and `citation`. Search citations have `id`, `path`, `revision`, `page`, `paragraph`, and `part`. The UI displays citations as text and constructs its own download URLs.

Execution routes:

- `GET /api/runtime` returns `{enabled, ready, packages, limits, inventory, blockedReasons}`. Verified image inventory can be `null`.
- `POST /api/conversations/:cid/executions` accepts `{kind, code, allowPackages}` and returns `{id, status}`.
- `GET /api/conversations/:cid/executions` returns `{executions}` with at most 20 recent entries.
- `GET /api/conversations/:cid/executions/:id` returns `{id, operationId, status, stdout, stderr, exitCode, files, availableFiles, fileNote, error}`.
- `POST /api/conversations/:cid/executions/:id/cancel` requests cancellation.
- `GET /api/conversations/:cid/packages` returns `{pip, npm}`.
- `POST /api/conversations/:cid/packages` accepts `{pip, npm, allowPackages: true}` and returns the saved specifications, execution result, both IDs, and `saved`. Terminal failures return `saved: false` without replacing the prior list.

Terminal job statuses are `complete`, `error`, `cancelled`, `timed_out`, and `interrupted`. An unknown status does not enable another run.

## Accessibility and verification

The native modal dialog provides focus containment and Escape-to-close behavior. Section and file-view tabs support arrow keys, Home, and End. Controls have text labels. Errors use alert regions, and progress uses status regions. The layout uses the app's light/dark theme and switches to a stacked file list and editor on narrow screens. Source and console areas scroll rather than expanding the page width.

Existing verification commands are `npm run check` and `npm test`. No new automated test files or frameworks are needed for this component. Live UI verification requires the parent app hook, static routes, workspace routes, and runner integration. Syntax and existing-suite checks do not establish browser acceptance.

After integration, exercise file creation and revision conflict, retained edits across refresh/chat changes, cited document search, unavailable-runner feedback, a safe run and cancellation, recent-run recovery, and mobile keyboard/touch access. Use a configured runner. Do not start a model as part of this UI verification.
