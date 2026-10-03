# Model tools and isolated executions

Tools are opt-in. A connection must enable `capabilities.tools`, which defaults to false. Each generation must also receive explicit user permissions:

```json
{
  "tools": {
    "workspace": true,
    "execute": false,
    "packages": false
  }
}
```

Omitted permissions are false. Permissions apply only to that submission and its follow-up rounds. Regeneration needs a new grant. Saved permissions, imported records, model arguments, and document text cannot grant permission.

- `workspace` permits file listing, bounded reading, text replacement, and search in the current conversation workspace.
- `execute` permits Python and POSIX shell in the separately configured isolated runner. An execution receives a copied snapshot of the current conversation workspace and can produce file revisions. It therefore permits workspace access through code even if direct workspace tools are off.
- `packages` permits registry package installation and restoration of saved conversation dependencies. A code execution with saved package specifications requires this permission because the runner can fetch dependencies again.

No model argument can choose a conversation ID, host path, image, engine flag, host environment, network policy, or permission. The app supplies the conversation ID. The runner supplies the execution policy. Code fences remain display content. They never trigger these tools.

## Model protocol

The app exposes OpenAI-compatible function tools:

| Name | Arguments | Permission |
| --- | --- | --- |
| `list_workspace` | Optional `offset`, `limit` up to 50. | workspace |
| `read_workspace` | `path`, optional `offset`, `limit` up to 8192. | workspace |
| `write_workspace` | `path`, complete `text`, `expectedRevision`, optional `expectedSha256`. | workspace |
| `search_workspace` | `query`, optional `limit` up to 10. | workspace |
| `run_python` | `code`. | execute |
| `run_shell` | `code`. Node can be invoked from shell. | execute |
| `install_packages` | Complete desired `pip` and `npm` arrays. | packages |

All argument objects reject unknown fields. Text writes require the current revision, including the head of a deleted file. Use `null` only for a path that has no revision. Reading a binary file returns extracted passages when available, not binary bytes decoded as UTF-8. For text, read offsets and limits count JavaScript string positions. For extracted documents, offsets count passages and each response returns at most eight passages.

The app assembles streamed call fragments by index. A round executes only after an explicit `finish_reason: "tool_calls"`, complete function names and JSON arguments, and unique call IDs. The app validates every call in the round before executing the first call. A `[DONE]` marker alone does not authorize a tool. Legacy `function_call` responses, incomplete calls, duplicate IDs, unsupported tools, and undeclared arguments fail explicitly.

Optional local work budgets belong in generation `settings`:

```json
{
  "settings": {
    "toolCalls": 20,
    "toolRounds": 10
  }
}
```

Each budget defaults to off. Omit the field, use `null`, or use an empty string to disable it. Enabled values must be integers from 1 through 1,000,000. These settings are not sent as provider sampling controls. There is no fixed eight-request or sixteen-call cap.

The call budget counts dispatched calls, including calls that fail. The round budget counts batches with at least one dispatched call, not provider requests or the final answer. A partial batch executes only its admitted prefix. The app saves all call records, pending placeholders, and blocked results before the first side effect. Blocked calls do not run. Invalid arguments or permission attempts still fail whole-batch validation before any side effect.

When either budget is reached, the app preserves completed results and files, removes tool definitions, and requests one final answer from the provider. It does not replay calls. If the provider requests tools again or the deadline expires, the generation ends with the saved work and a clear error.

The required safety bounds per generation remain:

- Unique call IDs across that generation and 1 MiB of tool-fragment JSON per response.
- 128 KiB argument JSON per call and 256 KiB across all calls, including blocked calls.
- 64 KiB result JSON per call and 1 MiB of saved transcript JSON. A round reserves space for its results before execution. A large batch can reach this bound even with work budgets off.
- 64 KiB of code or direct text-file content per call.
- One total generation deadline, including validation, provider calls, tools, and dependency work. The default is 15 minutes.

Tools run sequentially. A tool failure becomes a bounded error result, so the model can correct an ordinary file conflict or unsupported operation within the same limits. Invalid protocol or permission attempts terminate the generation instead. Cancellation aborts the active provider request and runner operation. Previously completed tool actions remain saved. A failed or cancelled individual execution does not import its outputs.

## Visible activity and saved history

Assistant metadata adds:

- `toolActivity`: call ID, tool name, state, a short summary, revision-specific download links, and bounded stdout/stderr summaries for code execution. Execution activity also includes `executionId`, optional runner `operationId`, exit code, and safe error text.
- `toolTranscript`: bounded assistant/tool protocol messages for later model context. These are historical messages, not an execution queue. Normal message responses hide this field.
- `toolPermissions`: the permissions granted to this submission, for display and provenance only. Normal message responses expose only the three permission booleans for an assistant owned by a local job. Imported grants remain archived and hidden. This field never grants future permission.
- `toolBudget`: `callLimit` and `roundLimit`, each `null` when off, `executedCalls`, `executedRounds`, and `stopReason`, which is `null` until a work budget stops tools. Limits and counters use distinct fields.

Activity does not include host paths or engine errors. File links point to authenticated workspace downloads. The execution API retains bounded full stdout/stderr. Tool context receives at most 8000 bytes per stream and eight links each in `files` and `availableFiles`, with `totalFiles` and `totalAvailableFiles`. Long paths can reduce those link counts to keep the 64 KiB result bound. Display activity can include all changed file links in `files` and the same bounded current links in `availableFiles`. Render all text as untrusted content.

For execution receipts, `files` means revisions created or changed by that operation. `availableFiles` means stored current files, not proof that the operation created or tested them. An empty `files` list does not mean the workspace is empty. A same-bytes `write_workspace` returns `changed: false`, no new `files`, and its existing target revision in `availableFiles`. The app does not create another revision for that write. Both the result and display activity preserve this distinction.

Before a side effect, the app saves protocol-valid pending result placeholders. If the server stops before a result is saved, the placeholder tells the next model to inspect current state before retrying. The app never replays a tool automatically.

Only a local `jobs` row that owns the assistant message can establish a live transcript's provenance. Imports create new message IDs and no job rows. Import handling must move `toolTranscript` and `toolPermissions` into `metadata.archivedToolContext`. Generation rejects branches containing that archived context, imported tool roles, or unsupported archived attachments. Retained `toolActivity` is historical display data only. Do not silently omit an archived tool transcript from model context.

## Execution and package API

These routes use the app's existing authentication, Host/Origin checks, and same-origin JSON mutation headers. The execution module does not provide an unauthenticated listener.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/runtime` | `{enabled, ready, packages, limits, inventory, blockedReasons}`. Verified bundled inventory can be `null`. |
| POST | `/api/conversations/:cid/executions` | Submit `{kind: "python" or "shell", code, allowPackages: boolean}`. Return `{id, status}` with HTTP 202. |
| GET | `/api/conversations/:cid/executions` | `{executions: [...]}` with the 20 most recent compact records. |
| GET | `/api/conversations/:cid/executions/:id` | `{id, operationId, kind, status, stdout, stderr, exitCode, files, availableFiles, fileNote, error, createdAt, updatedAt}`. |
| POST | `/api/conversations/:cid/executions/:id/cancel` | `{id, status}`. Cancellation is idempotent for terminal jobs. |
| GET | `/api/conversations/:cid/packages` | `{pip: [], npm: []}`. |
| POST | `/api/conversations/:cid/packages` | Verify specifications from `{pip: [], npm: [], allowPackages: true}`. Return the saved `pip`/`npm` list, execution result, both IDs, and `saved`. A terminal failure keeps the prior saved list. |

A lost execution POST response is not permission to replay code. Read recent executions and the current workspace before submitting again. Execution POST intentionally has no automatic retry. Package changes appear in the execution list as `kind: "packages"`, so a client can inspect or cancel an uncertain package request.

Package arrays contain strings. Use a PyPI name, optionally with `==version`, or an npm name, including `@scope/name`, optionally with an exact `@major.minor.patch` version. Prerelease/build versions are allowed. Use at most 32 distinct names in total, with at most 200 characters per specification. URLs, paths, flags, alternate indexes, Git sources, extras, and version ranges are not supported. `install_packages` and the package POST replace the entire saved specification list. They do not append to it. Only successful verification saves resolved specifications. Dependency directories never become workspace revisions. A package tool receipt includes its execution ID, status, and `saved` flag. A failed verification must not claim that packages were saved.

Execution states are `running`, `complete`, `error`, `cancelled`, `timed_out`, and `interrupted`. There is one active execution or package operation per conversation. A user execution cannot overlap a generation. A model-owned tool can bypass only its own generation's busy check, never another execution or generation.

The app accepts a live workspace snapshot of at most 128 files and 20 MiB. Each file is at most 10 MiB. It accepts at most 128 returned files and 32 MiB of transfer, removes unchanged files by their captured hash, then imports at most 32 changed files and 20 MiB. Every changed output carries its captured revision and hash, including a deleted head when applicable. Import rechecks all affected heads together after document extraction. A conflict rejects every output from that execution. Outputs absent from the returned manifest do not delete workspace files.

Only a successful runner result with exit code zero can import outputs. Cancellation, timeout, invalid output, failure, or revision conflict preserves prior workspace files. Stdout and stderr together are bounded to 2 MiB. App deadlines are 60 seconds without saved dependencies, 300 seconds for package verification, and at most 380 seconds for execution with dependency restoration. The generation deadline can stop any of these earlier. The runner imposes its own code, package, memory, process, and network limits. Validated numeric runner limits appear under `runtime.limits.runner`; app limits remain at the top level. Runner cancellation must stop the actual worker, not only its client connection.

## Document creation

Use runner libraries through `run_python` or an explicit user execution. For example, when the configured worker image includes `python-docx` and ReportLab:

```python
from docx import Document
from reportlab.pdfgen import canvas

document = Document()
document.add_heading("Report", level=1)
document.add_paragraph("Created in the conversation workspace.")
document.save("report.docx")

pdf = canvas.Canvas("report.pdf")
pdf.drawString(72, 750, "Created in the conversation workspace.")
pdf.save()
```

These are relative workspace outputs. No document code runs in the chat process. The app imports successful bounded outputs as revisions, with authenticated download links. Package availability and document extraction depend on the configured runner. See [workspace storage](WORKSPACE.md) and [runner installation](RUNNER.md).

## Integration hooks

```js
const executions = new Executions(store, workspace, runner, emit, { enabled: true });
const tools = new Tools(workspace, executions);
const generations = new Generations(store, emit, { tools, media });
```

Inject a configured `RunnerClient`; there is no direct host-process fallback. Without a configured runner, execution readiness is false. Workspace tools can still operate without runner execution.

The parent router maps the routes above to `executions.runtime()`, `submit(cid, body)`, `list(cid)`, `get(cid, id)`, `cancel(cid, id)`, `getPackages(cid)`, and `setPackages(cid, body)`. `execute(cid, body, {jobId, signal})` and the optional context argument to `setPackages` are internal model-tool hooks. Never accept that context from an HTTP body or tool argument.

Always await `generations.submit(cid, body)`. It returns immediately on the no-hook path for older embedded callers, but media and tool preflight are asynchronous. After those awaits, submission rechecks request ID/fingerprint, conversation version, idle state, generation capacity, unchanged provider configuration, and attachment ownership before saving messages. An identical concurrent retry returns the original job.

For conversation mutation and deletion, combine `store.assertIdle(cid)` with `executions.assertIdle(cid)`. Do not put that combined check inside Workspace: model tools must access their own workspace during generation. Shut down generations and executions before closing Store. Both services propagate aborts and wait for active jobs to settle.

`Executions` creates additive `executions` and `workspace_packages` tables using the existing Store connection. Foreign keys scope them to the conversation. It marks unfinished executions interrupted at startup, without replay. Generation startup also marks pending tool activity interrupted for orphaned local jobs. Include these tables and workspace blobs in normal backups. A crash can leave a successfully committed workspace revision with an interrupted execution receipt if the server stopped between those commits. Inspect the workspace rather than rerunning an uncertain operation.

The optional media hook is:

```js
options.media = {
  async validateBranch(provider, attachments, { signal }) { /* validate all branch media */ },
  contentPart(attachment, bytes, provider) { /* return one native provider content part */ }
};
```

`contentPart` is synchronous after validation. Generation handles text and image attachments directly, handles only recognized audio/video kinds through this adapter, and rejects other binary kinds. It never uses a binary-to-UTF-8 fallback. Imported attachment metadata does not establish trusted media facts.
