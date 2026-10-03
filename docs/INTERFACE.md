# Interface and capability controls

The interface uses transparent rounded ghost buttons with a subtle hover background. Icon actions retain accessible names, keyboard focus, and hover hints. Text remains for filenames, titles, tabs, fields, and important errors or safety notices.

## Navigation and settings

On desktop, the sidebar can collapse to a narrow icon rail. New chat, Files/code, and Settings remain available. Expand the sidebar to browse or search chats. This device-local layout preference does not change server history. The mobile menu, backdrop, and sidebar gestures remain separate.

Each chat row has a three-dot action button. Rename, export, and delete apply to that row's conversation, not an unrelated open chat. Deletion retains its explicit confirmation and idle checks.

Settings groups connections, active models and refresh, generation, tools, appearance, data, and Info. The composer model button opens model selection without a top endpoint selector. Help and storage information live in Settings or related tooltips. Actual draft-storage failures, missing context, unknown-send state, and edit warnings remain visible.

File results use a single compact list. Rows show a type icon, filename, and friendly type. Download and preview bind to the exact conversation, path, and revision. Inline validated workspace links remain in the answer. Tool activity uses compact disclosures, with all recorded calls, errors, historical permissions, budgets, and full console access retained.

## Thinking

Thinking controls appear only for a connection with an explicitly configured protocol. Capabilities apply to all selected models on that connection. Use separate connections for models with different support.

- `none`: no thinking control or request override.
- `llama_cpp`: On/Off maps to `chat_template_kwargs.enable_thinking`.
- `reasoning_effort`: only the configured supported levels are offered and sent as top-level `reasoning_effort`.

Provider default omits the override. The current selection applies to the conversation and is retained with each response. Switching to an unsupported connection does not silently send an incompatible saved value. Use provider defaults or edit the conversation settings first.

The mappings follow the [llama.cpp chat completion parameters](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api) and [OpenAI chat completion API](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create). Actual support and permitted effort levels depend on the endpoint and model. A configured declaration is not a live-model verification result.

## Native tools and future connections

Available native tools are automatic on a configured function-tool connection. The paperclip offers Upload and Tools. Tools provides Files/code and current availability. See [tool policy and catalog](TOOLS.md). No host shell, host filesystem, arbitrary network, or external service becomes available through this menu.

The native catalog derives from the server's function registry. Future tools can reuse its categories and availability metadata without another per-chat enable control. New authority categories still need their own server validation and isolation policy.

The MCP entry point is inactive. Model Context Protocol (MCP) can connect an application to an external tool server. No connection, credential, subprocess, or remote tool is created now. A future implementation must keep external configuration separate from native tools, scope credentials server-side, expose actual availability, and preserve call validation, cancellation, receipt provenance, and user-approved trust boundaries. Do not treat a placeholder or a tool description as permission to connect.

## Dictation

The microphone opens dictation settings and reports that transcription is not implemented. It does not ask for microphone access, record audio, call a model, or send a chat.

A future implementation can send an explicitly recorded clip to a configured speech-capable endpoint and put its transcript into the unsent composer. It must preserve text typed while transcription is pending, support cancellation, release recording resources, and leave chat submission to the user. Audio attachment capability alone does not establish a dictation endpoint. Keys must remain server-side.
