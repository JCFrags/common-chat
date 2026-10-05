# Interface and capability controls

The interface uses transparent rounded ghost buttons with a subtle hover background. Icon actions retain accessible names, keyboard focus, and hover hints. Text remains for filenames, titles, tabs, fields, and important errors or safety notices.

## Navigation and settings

On desktop, the sidebar can collapse to a narrow icon rail. New chat, Files/code, and Settings remain available. Expand the sidebar to browse or search chats. This device-local layout preference does not change server history. The mobile menu, backdrop, and sidebar gestures remain separate.

Each chat row has a three-dot action button. Rename, export, and delete apply to that row's conversation, not an unrelated open chat. Deletion retains its explicit confirmation and idle checks.

Settings groups connections, active models and refresh, generation, tools, appearance, data, and Info. The composer has a Chat connection selector beside the model button. Choose a saved connection, then choose its model. Changing the connection clears the selected model and keeps the current draft and conversation. Send is disabled while either selection is saved. The connection selector remains available when the current connection has no models or discovery fails. The model button opens model selection without a top endpoint selector. Help and storage information live in Settings or related tooltips. Actual draft-storage failures, missing context, unknown-send state, and edit warnings remain visible.

File results use a single compact list. Rows show a type icon, filename, and friendly type. Download and preview bind to the exact conversation, path, and revision. Inline validated workspace links remain in the answer. Tool activity uses compact disclosures, with all recorded calls, errors, historical permissions, budgets, and full console access retained.

## Model discovery and nicknames

New connections use automatic discovery from `/models`. Saving or editing a connection does not activate it for chat. The Connection dropdown in Settings chooses a record to edit. Use Chat connection beside the composer model button to activate a saved connection. The composer model picker lists actual API IDs from that connection. A nickname changes the display label, not the request ID, saved selection, or historical model identity. Use "Model nickname and thinking support" in the picker to save a nickname or an explicit per-model declaration.

Existing nonempty manual lists stay manual until you change "Model discovery" in Connections. Manual mode is available for endpoints without `/models`. Automatic discovery failures show a clear error and any saved IDs as an unverified fallback. Refresh requests a new API check. The picker retains a historical selection that is missing from the current list rather than silently replacing it.

## Thinking

The thinking button beside the model button uses the selected model's support. Resolution order is a per-model declaration, a legacy connection declaration, recognized fresh API metadata, then unknown. Generic OpenAI-compatible `/models` does not expose thinking levels. Model names, returned reasoning text, and llama.cpp thinking booleans do not prove supported levels. The app does not probe `/props` or a model router that could load models.

- `none`: explicitly disables thinking overrides for that model.
- `llama_cpp`: On/Off maps to `chat_template_kwargs.enable_thinking`.
- `reasoning_effort`: declared supported levels map to top-level `reasoning_effort`.
- `openrouter_reasoning`: supported levels map to `reasoning: { "effort": "..." }`.

The OpenRouter metadata adapter reads `reasoning.supported_efforts` from `/models`. A null value uses the documented gateway effort list. Mandatory reasoning excludes `none`. Select this adapter only for a compatible endpoint. Other services need documented declarations, not guesses.

Provider default omits the override. The selection applies to the conversation and is retained with each response. A saved value incompatible with a newly selected model remains visible as a warning and fails before messages are committed. Select a valid level or explicitly choose Provider default. Editing another setting must not silently erase the saved thinking value.

The mappings follow the [llama.cpp parameters](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api), [OpenAI chat API](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create), and [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). A declaration or catalog entry is not an inference check.

## Connection indicators

The two sidebar dots are separate. The first reports synchronization with Common Chat. The second reports the selected provider's API model listing. Green means connected, amber means checking or reconnecting, red means a failed connection or missing selected model, and gray means unknown or unverified. Each dot has a keyboard-accessible text label and hover description.

Manual lists and cached results do not claim fresh API reachability. Visible online pages refresh the selected catalog about every 30 seconds. A listed model is not proof that inference or transcription will succeed.

## Native tools and MCP connections

Available native tools are automatic on a configured function-tool connection. The paperclip offers Upload and Tools. Tools provides Files/code and current availability. See [tool policy and catalog](TOOLS.md). No host shell, host filesystem, arbitrary network, or external service becomes available through this menu.

The native catalog derives from the server's function registry. Future tools can reuse its categories and availability metadata without another per-chat enable control. New authority categories still need their own server validation and isolation policy.

Model Context Protocol (MCP) connects Common to a separately reviewed HTTP tool server. Settings, Tools and the Common panel provide saved connections and page-only tool choices. Keys stay encrypted on the server. Saving a connection makes no remote request. Use Connect to initialize and discover its bounded catalog, then review and select tools. Each new submission requires confirmation of those exact tools and destinations. Disconnect, edit, catalog replacement, and sign-out clear selections. Saved activity is provenance, not permission for another turn. MCP does not launch subprocesses or replace the isolated runner. See [MCP limits and consent](MCP.md).

## Dictation

Configure a saved OpenAI-compatible speech-to-text connection and model in Settings, Dictation. This choice is independent of the chat model. The service must support `/audio/transcriptions`. A catalog listing and chat audio capability do not prove transcription support.

1. Select the microphone button.
2. Select Record, then Stop recording, or choose an audio file.
3. Review the local clip.
4. Select Transcribe to send the clip to the configured service.
5. Edit the returned text, then use Send separately when ready.

No recording timer or file selection uploads audio automatically. Send is blocked while a dictation operation or prepared clip exists. The composer stays editable. A returned transcript appends to the current typed text, not an earlier snapshot. Cancel, Close, a different draft, or sign-out aborts the local operation and prevents late insertion. Microphone tracks, timers, and local playback URLs are released.

Microphone capture requires HTTPS or localhost and browser permission. Remote HTTP can use file transcription without weakening browser security. Recordings stop after 60 seconds. Each clip is limited to 10 MiB. The upstream request deadline is 60 seconds, with at most two concurrent requests per app process and a 64 KiB response limit. The server does not determine the duration of compressed uploaded files.

Audio is not stored in conversations, attachments, jobs, or server files. Saved keys stay server-side. The provider receives the clip only after Transcribe and can apply its own processing, retention, and billing rules. Cancellation aborts transport and insertion. It cannot guarantee that provider processing or billing stops. See [the transcription API](API.md#dictation).
