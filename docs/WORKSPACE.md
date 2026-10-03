# Conversation workspace

`server/workspace.mjs` stores files in a conversation-scoped workspace. `server/workspace-routes.mjs` supplies its HTTP handler. Construct one Workspace instance for the Store. Call its HTTP handler after the application's normal authentication and Origin checks.

The workspace does not execute code or mount application data into a runner. A caller must copy selected bytes into a separate, disposable execution environment. Returned output files pass through the same validation and revision checks as browser writes.

## Storage and scope

Each operation calls `Store.conversation(cid)`. A revision lookup also requires its exact conversation and logical path. A revision ID alone cannot retrieve another conversation's bytes or passages.

The application chooses the conversation ID from its authenticated request or saved generation job. Do not expose a model argument that chooses a conversation ID. Pass a fixed ID from the job into every workspace tool call. Write and restore payloads reject unknown fields, including embedded conversation IDs.

A logical path is display metadata, not a host filesystem path. Names use `/` between segments. They must be normalized Unicode (NFC), with at most 512 UTF-8 bytes, eight segments, and 120 bytes per segment. Absolute paths, empty segments, traversal segments, backslashes, control characters, Windows-reserved names and characters, leading/trailing segment spaces, trailing dots, and paths beginning with `~` are rejected. Case-only collisions are rejected. A live file cannot also act as a folder prefix.

Three additive SQLite tables hold file heads, revisions, and search passages. The constructor does not change `PRAGMA user_version`, existing messages, or existing tables. File bytes are stored under `DATA_DIR/workspace/blobs/` with generated UUID filenames. Logical paths never select disk locations. Blobs are created with exclusive writes and mode `0600`, then flushed before the database commits. The workspace directories use mode `0700` when created. Reads check file type, size, and SHA-256. Symlink blobs are not followed.

Every successful content write creates a new immutable revision. Deletes create a tombstone revision. They do not erase previous revisions. Restore copies a saved revision and its index into a new head revision. Historical citations continue to identify their original bytes. Current search excludes old and deleted revisions.

A failed database transaction removes blobs created by that operation when possible. A crash can leave an orphan blob. Orphans remain for administrator recovery and count toward the global blob and byte limits. The application calls `workspace.deleteConversation(cid)` before `store.deleteConversation(cid)` to remove only the blobs recorded for that conversation and its workspace records. The parent must first apply its normal conversation version and active-job checks. Cleanup validates each blob entry and never follows symlinks or deletes another conversation's files. If file removal fails, the method retains database records so the application can retry. A partial cleanup can leave some recorded bytes missing until deletion finishes. Calling only the Store method would leave orphan blobs. There is no automatic orphan garbage collection or separate permanent-file-delete API. Do not delete unknown files to bypass a limit.

## JavaScript contract

```js
import { Workspace, WORKSPACE_LIMITS, workspacePath } from './workspace.mjs';

const workspace = new Workspace(store, { extractDocument });
const created = await workspace.write(cid, {
  path: 'notes/plan.md',
  text: '# Plan\n\nCheck the backup.',
  expectedRevision: null
});
const edited = await workspace.write(cid, {
  path: created.path,
  text: '# Plan\n\nCheck the backup and restore.',
  expectedRevision: created.revision,
  expectedSha256: created.sha256
});
const matches = workspace.search(cid, 'backup');
```

`extractDocument` is optional. No external search service, embedding model, process launcher, or package dependency is required by this module.

| Method | Result |
| --- | --- |
| `list(cid)` | `{ files, usage, limits }`. Includes current tombstones so a client can restore deleted files. |
| `read(cid, path, { revision? })` | `{ file, text }` for UTF-8 text, or `{ file, data }` with base64 for binary files. PDF/DOCX also include `passages: [{ text, page, paragraph, part, citation }]` for extracted previews, bounded by the extraction limits. Omit the options object for the current revision. A revision ID string is also accepted as the third argument. A deleted head returns 404. |
| `write(cid, { path, mime?, text?, data?, expectedRevision?, expectedSha256? }, { signal? })` | Promise of file metadata. Supply exactly one of `text` and base64 `data`. The options object is optional. |
| `remove(cid, path, expectedRevision, expectedSha256?)` | Metadata for the new tombstone. |
| `history(cid, path)` | `{ path, currentRevision, revisions }`, with newest revisions first. |
| `restore(cid, { path, revision, expectedRevision, expectedSha256? })` | Metadata for a new revision copied from a nondeleted revision of the same path and conversation. |
| `download(cid, path, { revision? })` | `{ file, bytes }`, where bytes is a Buffer. No host path is returned. |
| `search(cid, query, { limit? })` | `{ query, results, indexing }`. Default result limit is 10. |
| `snapshot(cid, { paths? })` | `{ files, revisions }` captured synchronously. Files contain `{ path, mime, data, size, revision, sha256 }`, with base64 data. The revision map has `{ [path]: { revision, sha256, deleted } }` for every known path, including tombstones. Optional paths select live files. Omit options to include all live files. Selected bytes must fit 20 MiB. |
| `importOutputs(cid, files, { signal? })` | Promise of `{ files }` containing new metadata. Each input uses the same shape and preconditions as `write`. All revisions commit together, or none do. The options object is optional. |
| `deleteConversation(cid)` | `{ deleted: true, blobs }`. Removes workspace records and only that conversation's recorded blobs. Call before the existing Store deletion method. It does not delete messages or the conversation itself. |

File metadata has this shape:

```json
{
  "path": "notes/plan.md",
  "revision": "generated-revision-uuid",
  "version": 2,
  "mime": "text/markdown",
  "size": 45,
  "sha256": "64-lowercase-hex-characters",
  "text": true,
  "deleted": false,
  "createdAt": 1790899200000,
  "restoredFrom": null,
  "index": { "status": "indexed", "error": null, "passages": 2 }
}
```

`text` in metadata is a Boolean, not file content. `version` is the per-path revision sequence, not the conversation version. A tombstone has size zero and a null hash. `usage` contains `paths`, `revisions`, and retained content/index `bytes` for this conversation.

An absent or null `expectedRevision` means create-only. Replacing or recreating a path requires its current revision ID, including a deleted head. `expectedSha256` is an optional additional equality check. Omit it when not used. A mismatch returns 409. The server checks preconditions before extraction and again in the write transaction, so concurrent edits cannot silently replace one another.

Each successful mutation increments the existing conversation version. The application should emit its normal `changed` event after HTTP or model-tool mutations. The workspace module does not emit browser events itself.

For runner outputs, preserve `snapshot.revisions` when inputs are selected. Set each output's `expectedRevision` and `expectedSha256` from that captured map, or null when the path was absent. Do not reread the current head and silently overwrite a later user edit. A conflict on any output prevents the entire batch from committing. Changes to unrelated paths do not prevent the batch.

Pass the generation's AbortSignal to `write` and `importOutputs`. Cancellation is checked before extraction, propagated to the extractor, checked between files, and checked immediately before the synchronous transaction. Cancellation throws an `AbortError` and does not commit the requested revisions. An extractor failure is different: it stores the original document with an explicit index error. Once a synchronous transaction has completed, a later cancellation cannot undo it.

The workspace never calls `Store.assertIdle`. A model tool must be able to write within its own active job. The parent coordinates job lifecycle and conversation deletion.

## Document search

Text, Markdown, CSV, JSON, XML, common configuration formats, and source-code files can be indexed locally. The module validates UTF-8 and rejects NUL bytes. MIME type or a recognized extension identifies text. It does not parse, execute, or semantically validate JSON, CSV, or source code.

Text is divided into nonempty paragraphs separated by blank lines. Each paragraph is split into bounded parts when needed. Search returns complete parts, not generated summaries. Matching uses literal lowercase keyword substrings through parameterized SQLite expressions. Results rank by the number of distinct query words matched, then logical path and source order. It is not semantic search and has no query-language operators.

Each result includes `path`, `revision`, `sha256`, `mime`, `text`, `score`, and a citation:

```json
{
  "id": "workspace:notes%2Fplan.md@revision-uuid#paragraph=2&part=1",
  "path": "notes/plan.md",
  "revision": "revision-uuid",
  "sha256": "64-lowercase-hex-characters",
  "page": null,
  "paragraph": 2,
  "part": 1,
  "url": "/api/conversations/conversation-id/workspace/files?path=notes%2Fplan.md&revision=revision-uuid#paragraph=2&part=1"
}
```

Page, paragraph, and part numbers are one-based. A null page means the source did not supply page numbers. The citation URL retrieves the exact saved revision. Its fragment identifies the extracted passage location, not an HTTP parameter. The application can use these fields to show a source link. It must treat file contents as untrusted source material, not tool instructions or authorization.

Search also returns `indexing: [{ path, status, error }]` for current files that are not indexed. Status is `indexed`, `empty`, `unsupported`, `unavailable`, or `error`. Deleted metadata uses `deleted`. An empty or failed extraction never appears as successful indexing. A file that cannot be indexed remains readable and downloadable.

### PDF and DOCX extractor

The application supplies an asynchronous callback:

```js
async function extractDocument({ path, mime, bytes, signal }) {
  // Copy bytes into an isolated runner. Never mount DATA_DIR there.
  return {
    pages: [
      { page: 1, text: 'First page text.' },
      { page: 2, text: 'Second page text.' }
    ]
  };
}
```

Alternatively, return `{ passages: [{ page?, paragraph?, text }] }`. When paragraph numbers are supplied, each entry represents one paragraph. Numbers must be unique within their page. Without paragraph numbers, blank lines define paragraphs. Pages can omit `page` to use array order. Preserve real page numbers when available. Do not invent DOCX pagination when the extractor only supplies paragraphs.

The input path is logical metadata. The input bytes are a copy, not a storage path. The callback must use an isolated, bounded runner, enforce its own resource limits, honor `signal`, and remove its own temporary files. The workspace module does not start or configure that runner. A 30-second deadline aborts the signal and marks extraction as failed. This deadline does not forcibly stop a callback that ignores cancellation.

Return `{ status: 'unsupported' }` for a document that the extractor cannot process, or throw on failure. Detailed extractor errors are not returned to clients because they can contain host paths. Empty PDF extraction reports that scanned PDFs require optical character recognition (OCR), which is not supported here. Missing extractor configuration reports `unavailable`. There is no automatic retry or reindex API. A new write can retry extraction with the current revision precondition.

## HTTP routes

```js
import { createWorkspaceHandler } from './workspace-routes.mjs';
const handleWorkspace = createWorkspaceHandler(workspace);

// Run after the existing Host, authentication, and Origin gates.
if (await handleWorkspace({ req, res, url, method, send })) return;
```

`url` is a URL object. `send` is the application's existing `send(res, data, status = 200)` JSON helper. The handler returns false for unrelated routes, true after a response, and throws normal HTTP errors for invalid requests. It does not perform authentication itself.

All paths below have prefix `/api/conversations/:cid/workspace`.

| Method | Suffix | Input and result |
| --- | --- | --- |
| GET | Empty, or `/files` | `list(cid)`. |
| GET | `/files?path=...&revision=...` | `read`. Revision is optional. |
| PUT | `/files` | `write` JSON body. Returns 201 for a new path, otherwise 200. |
| DELETE | `/files` | `{ path, expectedRevision, expectedSha256? }`. Returns tombstone metadata. |
| GET | `/history?path=...` | `history`. Includes deletion revisions. |
| POST | `/restore` | `restore` JSON body. Returns 201. |
| GET | `/search?q=...&limit=...` | `search`. Limit is optional. |
| GET | `/download?path=...&revision=...` | Exact saved bytes. Revision is optional. |

Use URLSearchParams for logical paths. Unknown or duplicate query parameters are rejected. Mutation routes require the application's same-origin JSON headers. Downloads always use attachment disposition, `application/octet-stream`, `nosniff`, and a restrictive sandbox policy. Uploaded HTML, SVG, JavaScript, and other active formats never receive an inline execution response from these routes.

## Browser file results

Tool receipts show revision-specific file cards outside collapsed activity. A card can represent a changed output or a file that remains available. It is not proof that the model tested the file. Download always retrieves the recorded revision. Preview supports bounded text/code, PNG/JPEG/WebP/GIF, extracted PDF/DOCX text, and native WAV/MP3/FLAC or MP4/WebM controls. Media codec support depends on the browser. Close the panel to stop media playback.

Markdown activates only an exact same-conversation `/api/conversations/:cid/workspace/download` link with one valid path and one revision UUID. Other relative navigation, cross-conversation links, raw HTML, and Markdown images remain inactive. Workspace previews do not execute scripts.

Completed Python fences have an explicit "Run in isolated Python" control. The control opens the Run code editor for review. It does not execute code or grant package access. Press the separate Run button to submit the reviewed source. Earlier messages and new incoming fences never run automatically.

## Limits

| Resource | Limit |
| --- | --- |
| UTF-8 text file | 1 MiB |
| Binary file | 10 MiB |
| Retained logical paths per conversation | 128, including deleted paths |
| Revisions per path | 64, with one final deletion allowed at the limit |
| Retained content and index per conversation | 128 MiB |
| Retained blob bytes and index across the installation | 1 GiB |
| Blob files across the installation | 8,192, including orphans |
| Revision records across the installation | 16,384 |
| Concurrent write/import calls per Workspace instance | 4 |
| Extracted document text | 2 MiB |
| Extracted pages | 1,000 |
| Passages per revision | 2,048 |
| Text per passage | 4,096 UTF-8 bytes |
| Output import | 32 files and 20 MiB combined |
| Runner snapshot | 20 MiB selected bytes, with up to 128 known paths |
| Search | 500 query characters, 16 distinct words of up to 64 characters, 50 returned passages |

Index storage includes both display text and its lowercase search copy. Retained bytes include old revisions. These limits bound logical content, not SQLite page overhead or unrelated application data. Deleted revisions do not reclaim content storage. Search scans only the selected conversation's current indexed revisions. Synchronous database and file work can still delay other requests.

## Backup and portability

The existing offline backup and restore scripts recursively copy and verify the entire data directory. They already include workspace blobs and additive SQLite tables. No new backup route or data-directory mount is required.

1. Stop the application before backup.
2. Back up the complete data directory with the existing backup script.
3. Restore that backup into a new directory with the existing restore script.
4. Use the restored directory as `DATA_DIR`.

Keep workspace blobs, database, and `master.key` together. A database-only copy loses file contents. Existing conversation JSON exports and imports do not include workspace files. Use a complete offline backup when moving workspace state between installations. Backups and file contents are not encrypted by this module.
