# Common feature components

These components extend the imported llama Svelte interface. They use the existing Common APIs and upstream UI primitives. They do not own chat stores, authoritative history, credentials, or generation permissions.

See [API.md](../../../../../docs/API.md), [WORKSPACE.md](../../../../../docs/WORKSPACE.md), and [TOOLS.md](../../../../../docs/TOOLS.md) for the server contracts.

## Mount chat connection selection

`CommonConnectionSelector.svelte` selects a saved chat connection through `CommonStore.selectProvider`. Mount it beside the composer model picker on desktop and mobile, outside the model-catalog availability branches. It must remain available when the old connection has no models or discovery fails. Bind its `switching` state to the parent's Send and model-selection guards. A confirmed connection switch clears the selected model, not the conversation or draft. Choose a model explicitly afterward. Saving or editing a connection in Settings does not activate it for chat. The selector uses upstream Select and Tooltip primitives with the same saved raw IDs and confirmed-selection guards.

## Mount Settings

The sidebar owns the single `DialogSettingsChat`. Extend the Settings registry and `SettingsChat` custom branches, not a second modal or opener store. Connections mounts `CommonConnections`, Dictation mounts `CommonDictationSettings`, Tools mounts `CommonTools` and `CommonMcp`, and Info mounts `CommonInfo` for status, help, and Sign out.

After confirmed Common form saves, refresh `commonStore.refreshSession()`, `commonStore.refreshProviders()`, and `serverStore.fetch()`. Keep upstream `apiKey` and `mcpServers` fields filtered out of preference fields and saved device configuration. API and Info sections do not show the global preference Save/Reset footer. Device preference fields retain their saved keys and existing slugs.

The Settings dialog has a fixed header, an independently scrolling body, and a separate preference footer. Do not return the footer to sticky positioning inside the field list. Use one close control. If `Dialog.Content` enables `showCloseButton`, set `Dialog.Header` to `showCloseButton={false}` because the header adds a close control by default.

## Mount the panel

Import `CommonPanel.svelte` directly. Keep one instance alive while the authenticated chat screen is mounted. This retains per-conversation file, code, and package drafts when the dialog closes or the conversation changes.

Required props:

- `conversationId: string | null`
- `ensureConversation: () => Promise<string>`. Create a conversation through the normal Common path without sending a model request. Update the active conversation and retain its composer draft.

Callbacks:

- `onChanged: () => Promise<void> | void`. Refresh authoritative conversation state after confirmed file or execution changes.

Optional props are `bind:open`, `showTrigger` (default `true`), and `initialSection` (default `files`). `bind:this` exposes:

```ts
openSection(section: 'files' | 'run'): void
openFile(path: string, revision?: string): Promise<void>
openExecution(id: string): Promise<void>
openCode(source: string, kind?: 'python' | 'shell'): Promise<boolean>
refresh(): Promise<void>
```

The panel is titled Files and code and has only Files and Run tabs. Connection, dictation, native-tool, and MCP settings belong to Settings. Composer workspace actions pass through the existing `ChatScreenForm`, `ChatForm`, and `ChatFormActions` with a `composerActions` snippet, not an event bus.

`openCode` only prepares an editor for review. It does not execute code or change package consent. Call `refresh()` after relevant snapshot or workspace events. Closing the dialog stops execution polling, not server work. Destroy the panel on sign-out.

To expose review actions through unchanged Markdown subcomponents, set this context in `ChatScreen`:

```ts
setContext('common-run-code', (code: string, kind: 'python' | 'shell') => {
	void commonPanel?.openCode(code, kind);
});
```

`MarkdownContent.svelte` also accepts an explicit `onRunCode` prop. The prop takes precedence over this context. Completed Python and shell fences open the review editor only. Run remains an explicit panel action.

## Mount tools and MCP

`CommonTools.svelte` shows the native catalog and effective availability for the selected connection. Native tools remain automatic on compatible saved connections. It does not introduce per-turn native checkboxes.

`CommonMcp.svelte` manages server-owned HTTP connections and page-only tool choices. Mount it only in Settings, Tools. Do not mount the upstream browser-owned MCP Servers dialog or its composer menu entries. Saving a connection does not connect it. Connect explicitly discovers a catalog. Edit, disconnect, catalog replacement, and sign-out clear its selections.

The chat adapter calls `confirmSelections` from `$lib/services/common-mcp.svelte` before each new submission. The helper checks local catalog freshness without contacting an MCP server. The adapter confirms the fixed tool names and destinations, rechecks the provider/model/conversation target, and freezes `tools.mcp` into the exact request. Retry uses the stored whole request without reselection. Call `commonMcpState.reset()` on sign-out. Do not persist live choices separately or convert saved receipts into new grants. See [MCP.md](../../../../../docs/MCP.md) for transport and access limits.

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

The optional prop is `bind:open`. The component uses an upstream Popover for floating clip review. Disable its focus trap and suppress outside dismissal while a clip or operation exists so typed composer text remains editable. Close and Escape still cancel. Missing configuration directs the user to Settings, Dictation, without another settings shortcut. The component exports `cancel()` and `stopRecording()`. Destroy it or call `cancel()` on sign-out. Close and target changes abort transport, release capture and playback resources, and prevent insertion.

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

Execution and package submission have no automatic retry. An uncertain response requires inspection of Recent runs, saved packages, and files before another explicit submission. Runtime readiness must report both enabled and ready. Native code has no host, browser, or MCP execution fallback. HTTP MCP tools are separate reviewed destinations, not a substitute runner.

Run `npm run check` and `npm run build` in `ui`. These checks do not establish mounted browser behavior. After integration, exercise the actual mounted components against synthetic fixtures, including revision conflict, delayed transcription cancellation/target change, unavailable runner, package failure, console paging, and opaque preview cleanup. Microphone permission, browser codecs, responsive layout, and server sandbox/CSP behavior need browser acceptance.
