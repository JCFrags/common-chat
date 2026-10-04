# Common feature components

These components extend the imported llama Svelte interface. They use the existing Common APIs and upstream UI primitives. They do not own chat stores, authoritative history, credentials, or generation permissions.

See [API.md](../../../../../docs/API.md), [WORKSPACE.md](../../../../../docs/WORKSPACE.md), and [TOOLS.md](../../../../../docs/TOOLS.md) for the server contracts.

## Mount the panel

Import `CommonPanel.svelte` directly. Keep one instance alive while the authenticated chat screen is mounted. This retains per-conversation file, code, and package drafts when the dialog closes or the conversation changes.

Required props:

- `conversationId: string | null`
- `ensureConversation: () => Promise<string>`. Create a conversation through the normal Common path without sending a model request. Update the active conversation and retain its composer draft.

Callbacks:

- `onChanged: () => Promise<void> | void`. Refresh authoritative conversation state after confirmed file or execution changes.
- `onConnectionsChanged: () => Promise<void> | void`. Refresh providers and preferences after connection, profile, or dictation selection changes.

Optional props are `bind:open`, `showTrigger` (default `true`), and `initialSection` (default `files`). `bind:this` exposes:

```ts
openSection(section: 'connections' | 'dictation' | 'files' | 'run'): void
openFile(path: string, revision?: string): Promise<void>
openExecution(id: string): Promise<void>
openCode(source: string, kind?: 'python' | 'shell'): Promise<boolean>
refresh(): Promise<void>
```

`openCode` only prepares an editor for review. It does not execute code or change package consent. Call `refresh()` after relevant snapshot or workspace events. Closing the dialog stops execution polling, not server work. Destroy the panel on sign-out.

To expose review actions through unchanged Markdown subcomponents, set this context in `ChatScreen`:

```ts
setContext('common-run-code', (code: string, kind: 'python' | 'shell') => {
	void commonPanel?.openCode(code, kind);
});
```

`MarkdownContent.svelte` also accepts an explicit `onRunCode` prop. The prop takes precedence over this context. Completed Python and shell fences open the review editor only. Run remains an explicit panel action.

## Mount dictation

Import `CommonDictation.svelte` beside the composer. Keep the upstream audio-attachment action separate. Dictation produces unsent text, not a chat audio attachment.

Required props:

```ts
targetId: string
getDraft: () => string
setDraft: (text: string) => void
getTargetId: () => string
```

Use a target identity that includes the route/conversation and a draft epoch. Change the epoch when the draft target changes, is sent, or is replaced. A conversation ID alone cannot distinguish a switch away and back to the same draft.

Set `onBusyChange` to update the composer's `externalBusy`. Block Send and draft-target replacement while a clip is prepared or an operation is active. Keep normal typed text editable. Do not pass that dictation busy value back as `disabled`, which would cancel the operation. `disabled` is for external authentication or chat-action unavailability.

Optional props are `bind:open` and `openSettings`. Route `openSettings` to `commonPanel.openSection('dictation')`. The component exports `cancel()` and `stopRecording()`. Destroy it or call `cancel()` on sign-out. Close and target changes abort transport, release capture and playback resources, and prevent insertion.

The component reads the saved atomic speech provider/model pair from `/api/session`. It never uses chat model selection. File selection and recording do not upload audio. Transcribe is explicit. Recording stops at 60 seconds. Clips must fit 10 MiB. Cancellation does not prove that provider processing or billing stopped.

## Mount message details

Mount `CommonMessageDetails.svelte` in the assistant renderer with raw snapshot metadata:

```ts
metadata: unknown
conversationId: string
status?: string
error?: string | null
onOpenFile?: (path: string, revision: string) => void
onOpenExecution?: (id: string) => void
```

Bind file and execution callbacks to the panel methods. The component also reads a saved `metadata.error`. Console, receipt, and error text remain text. Download links must match the exact conversation, path, and revision. Imported grants and transcripts are not accepted as authority. Missing rates and permissions are not estimated.

## Preview and content security policy

Retain the server's `/sandbox` and `/sandbox-mermaid.js` responses. Keep `frame-src 'self'`. Do not add same-origin sandbox privileges, main-document preview scripts, or relaxed main-document script policy.

Inject `<meta name="common-chat-csp-nonce" content="...">` into the served application HTML. `MarkdownContent.svelte` assigns that nonce to its trusted highlight style before attachment. Other upstream dynamic style writers need the same nonce hook in their owning components. Inline style attributes used for normal upstream layout and bounded frame height remain separate from authored preview code.

Manual previews transfer reviewed HTML/SVG, CSS, JavaScript, or Mermaid through a one-use `MessageChannel`. They default to network off. External resource access requires the visible opt-in and a new Run/Restart. Combined answer blocks can be loaded for review, with only the first Mermaid block included. Completed Mermaid and sanitized SVG diagrams render automatically in opaque, network-off frames. Incomplete SVG stays highlighted source until complete. Source view and component destruction remove automatic frames. Replies contain bounded console text or finite diagram-only height values, never parent commands.

## Limits and acceptance

Workspace previews display source as highlighted text rather than executing Markdown diagrams or active formats. Native raster/audio/video previews use bounded server bytes and local blob URLs. PDF/DOCX previews display extracted passages and citations, not full layout. Drafts are in-page only, not durable across reloads.

Execution and package submission have no automatic retry. An uncertain response requires inspection of Recent runs, saved packages, and files before another explicit submission. Runtime readiness must report both enabled and ready. There is no host, browser, or MCP execution fallback.

Run `npm run check` and `npm run build` in `ui`. These checks do not establish mounted browser behavior. After integration, exercise the actual mounted components against synthetic fixtures, including revision conflict, delayed transcription cancellation/target change, unavailable runner, package failure, console paging, and opaque preview cleanup. Microphone permission, browser codecs, responsive layout, and server sandbox/CSP behavior need browser acceptance.
