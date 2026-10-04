# Upstream provenance

Common Chat is independently named. It is not an official llama.cpp release.

The `ui/` directory contains the actual llama.cpp Svelte frontend from commit `0c1e57098bba43ac29e6e3b677cdceebdd22334f`, including its components, stores, services, styles, build configuration, and existing tests. The upstream `tools/ui` tree is `d28bac24cdd9b83739340cb8488b6224b817e123`. `ui/LICENSE` and `licenses/llama.cpp.txt` retain its MIT notice. Common Chat adapts this frontend to its independent server and additional features.

The original Common Chat frontend was a separate browser-JavaScript implementation. Its `public/theme.css` adapts CSS custom properties from the older upstream source below. The independent Node.js server, restricted renderer, workspace, and isolated runner are Common Chat implementations.

```text
Repository: ggml-org/llama.cpp
Commit: f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7
Source path: tools/ui/src/app.css
Source blob SHA: f9b544bebc5637b3c3d40cb036d17c9715f1e45c
License: MIT
Copyright: Copyright (c) 2023-2026 The ggml authors
```

The imported frontend retains upstream resources needed to build its interface. Common Chat does not bundle a llama.cpp inference binary and is not an official upstream distribution.

The following upstream files informed the import format and architecture review.

```text
tools/ui/src/lib/services/conversation-transfer.service.ts
tools/ui/src/lib/types/database.d.ts
tools/ui/package.json
tools/ui/README.md
LICENSE
```

## Reference URLs

These references were inspected during implementation. Live documentation can change independently of this release.

```text
Pinned stylesheet:
https://github.com/ggml-org/llama.cpp/blob/f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7/tools/ui/src/app.css

Pinned export service:
https://github.com/ggml-org/llama.cpp/blob/f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7/tools/ui/src/lib/services/conversation-transfer.service.ts

Pinned database types:
https://github.com/ggml-org/llama.cpp/blob/f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7/tools/ui/src/lib/types/database.d.ts

Pinned license:
https://github.com/ggml-org/llama.cpp/blob/f7b384c1e5c5b2c5b321a4a7cefea04b15b54cb7/LICENSE

llama.cpp server documentation:
https://github.com/ggml-org/llama.cpp/tree/master/tools/server

Ollama compatibility documentation:
https://docs.ollama.com/api/openai-compatibility

Node.js SQLite documentation:
https://nodejs.org/api/sqlite.html

Docker Compose service reference:
https://docs.docker.com/reference/compose-file/services/
```
