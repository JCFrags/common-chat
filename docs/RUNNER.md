# Isolated runner

The optional runner executes Python and shell code, including Node commands, outside the chat process. It also extracts DOCX/PDF text and inspects media with ffprobe. It does not load or manage models.

The first implementation supports **rootless Podman on Linux with cgroup v2**. Docker Engine, macOS, Windows, rootful engines, and remote engine sockets are not supported. A Compose chat application can use this broker's Unix socket, but must not receive an engine socket. Do not describe an untested Docker adapter as available.

## Boundaries

Run the broker as a dedicated unprivileged account, not the chat account. Chat keeps its database, master key, provider credentials, and immutable workspace store. The broker has no access to those directories. Chat copies bounded snapshot bytes through a Unix socket. No `DATA_DIR`, home directory, host workspace, device, or engine socket is mounted into a worker.

Each operation creates one short-lived container with a fixed image ID, non-root UID, private PID/IPC namespaces, read-only root, no capabilities, default seccomp, and no-new-privileges. Networking stays `none`, including during package installation. The worker uses bounded tmpfs storage. Files return as bounded regular-file bytes, not an archive extracted on the host. Symlinks, hard links, special files, traversal, and oversized outputs are rejected.

The broker checks rootless Podman, cgroup v2 delegation, seccomp, and the worker protocol label before reporting ready. Each worker must then prove its effective UID, PID namespace, capability set, seccomp, no-new-privileges, CPU, memory, swap, and PID limits. A failed check stops the container before receiving code or input files. Rootless containers still share the host kernel. This is not a hostile multi-tenant VM service or an independent security audit.

| Bound | Value |
| --- | --- |
| Concurrent operations | 1, including preparation and package installation |
| CPU | 1 CPU |
| Memory / additional swap | 1.5 GiB / 0 |
| Processes | 128 |
| Code | 128 KiB UTF-8 |
| Ordinary execution | 60 seconds |
| Package phase | 240 seconds |
| Document extraction / media inspection | 30-second client deadline |
| Container lifetime | 360 seconds, including setup and package work |
| Captured stdout + stderr | 2 MiB of input bytes; UTF-8 replacement can increase encoded result size |
| File transfer | 16 MiB per file, 32 MiB total, 128 files, 12 path components |
| Workspace / dependency / scratch / temporary storage | 128 / 512 / 256 / 128 MiB tmpfs |
| Retained results | 4 operations, 5 minutes; the client normally releases them immediately |

The application can apply narrower file or workspace limits. Tmpfs uses the worker's memory budget. Dependency space permits executable mappings for native libraries. A read-only root alone would not limit tmpfs; every writable area has an explicit size. Podman engine logging is disabled for these containers. The broker validates and bounds protocol output separately from user stdout.

Successful output is a full regular-file snapshot. The application must reimport it against the captured workspace revisions. Failed/cancelled operations do not return output files. The runner does not persist a second workspace or implement workspace conflict resolution. An aggregate permanent-workspace quota belongs to the application.

## Build the worker image

Use the dedicated rootless runner account and a source tree without secrets. The build context is only `runner/`, not the project or data directory.

```sh
podman build --cpu-quota 200000 --cpu-period 100000 \
  --memory 2g --memory-swap 2g --ulimit nproc=256:256 \
  -t localhost/common-chat-worker:1 -f runner/Dockerfile runner
podman image inspect localhost/common-chat-worker:1 --format '{{.Id}}'
```

The Dockerfile pins both base image digests, Node 22.16.0, and ffmpeg/ffprobe package `7:5.1.9-0+deb12u1`. The Python base resolves to 3.12.15. `runner/requirements.txt` pins the complete installed Python dependency set, including Matplotlib 3.10.1, NumPy 2.2.4, python-docx 1.1.2, pypdf 5.4.0, and ReportLab 4.3.1. `/opt/runner/python-versions.txt` and `debian-versions.txt` record installed components in the image. Debian transitive dependencies still come from the configured Debian repository; this is not a claim of bit-for-bit reproducible builds. Save the accepted image ID/archive for rollback. Review package/security updates deliberately rather than using a floating runtime image.

The broker resolves the configured image once at startup and runs that exact local image ID with `--pull never`. It never downloads an image in response to a code request. Its readiness response explains a missing image or missing rootless prerequisite.

## Install and connect the broker

1. Provision a dedicated account with non-overlapping subordinate UID/GID ranges, rootless Podman, mapping helpers, an active user manager, cgroup v2 CPU/memory/PID delegation, and lingering when boot startup is required. Use the distribution's supported account configuration. Do not reuse an administrator's home or remove the chat service's hardening.
2. Put the accepted source in a read-only release directory accessible to the runner. Install Node 22.16 or later for the broker. Set the absolute Node/release paths in [the user-service example](../examples/deployment/common-chat-runner.service).
3. Build/load the worker into this account's rootless store. Other users' and rootful image stores are separate.
4. Set `RUNNER_STATE_DIR` to private broker state, `RUNNER_SOCKET` to the intended Unix socket, and `RUNNER_IMAGE` to the accepted local tag or image ID. The broker needs `XDG_RUNTIME_DIR` from the user manager. Do not pass provider keys or a chat environment file.
5. Install the example as a user unit for the runner account, then start it through that account's user manager. Do not set `NoNewPrivileges=yes` on the broker: rootless UID/GID mapping helpers need elevation. Workers always set it. Do not enable engine sockets or privileged containers as a workaround.
6. Configure the application with `new RunnerClient({socketPath})`. For separate chat/runner accounts, use a dedicated API group and a shared socket directory outside `/run/user/UID`, because that parent is normally private. Provision the directory as runner-owned, API-group-owned, mode `2750`. The socket is `0660`; only runner can replace it. Keep broker state `0700`. Do not widen access to an existing engine group.

On NixOS, declare the account, non-overlapping ID ranges, lingering/user manager, required source/state mounts, helper packages, and user service in a focused module. Use the Nix-store Node executable in `ExecStart`. Put the API directory in a declarative tmpfiles rule with the exact runner/API group. Preserve the native chat account's no-new-privileges, read-only system, and credential directory. Evaluate the module and compare generated units before activation. The generic example is not a prevalidated NixOS module.

The broker creates only its configured state files and socket. Restart reconciliation removes containers with its saved random owner label, not every `common-chat` container or another broker's jobs. It marks prior operation records interrupted and does not replay code. An existing live socket or unexplained socket/lock ownership is a startup error. A hard crash's owned, inactive socket can be recovered only when the saved path/type/UID and lack of a listener agree. Never broadly delete socket directories, image stores, or containers to repair startup.

Stop chat submissions and cancel current work before stopping the broker. SIGTERM cancels the actual containers. Podman's independent lifetime limit also bounds a container if the broker crashes. Retain the old image and source for rollback. Do not roll back the application's current workspace revisions or chat database merely to change runner code.

## Package installation

Package arrays contain strings. Python accepts a registry name or `name==exact-version`. npm accepts `name`, `@scope/name`, and an optional exact `@version`. The combined maximum is 32 specifications, each at most 200 characters. Ranges, command flags, URLs, Git/path sources, custom indexes and user configuration files are unsupported.

A separate clean fetch container receives no conversation code or files. Its in-container loopback HTTP bridge sends bounded registry requests through the existing stdin/stdout protocol. No host socket is mounted and SELinux labeling stays enabled. The broker's fixed **registry mirror** allows GET/HEAD routes for `pypi.org`, `files.pythonhosted.org`, and `registry.npmjs.org`. It rewrites package-download URLs, validates public IPv4/IPv6 DNS answers and each redirect, then connects to a validated IP with normal hostname/TLS certificate checks. It does not implement CONNECT, arbitrary upstream URLs, private/LAN egress, or general web access. There is no routable worker network. Registry bodies cross the pipe in 192 KiB chunks, with fixed per-response/aggregate byte and request budgets. The pipe is transport, not authority to choose a destination.

Python installs wheels only. npm lifecycle scripts are disabled. A source build, postinstall-dependent package, private registry, external tarball, dependency containing symlinks/hard links, or large dependency closure can fail. Additional dependencies have a separate strict regular-file transfer budget: 32 MiB total, 16 MiB per file, 4096 files. npm binary symlinks are not exported, so packages requiring them are unsupported. The image already contains the larger plotting/document toolchain. Errors remain visible; the broker never broadens networking. npm packages are available to CommonJS through `NODE_PATH`. Bare ESM imports from arbitrary workspace locations do not use Node's `NODE_PATH`; use an explicit package path or CommonJS. No dependency-directory caching is implemented.

After installation, the broker revokes registry requests and closes every upstream connection. It collects only bounded regular dependency files and destroys the fetch container. It then creates a fresh, fully confined offline worker with no registry handler or socket. Dependencies enter that worker before conversation files. The execution worker cannot request registry access through the pipe. An install-only request returns pinned top-level specifications and a summary, not dependency directories. The application stores those specifications and passes them on each execute. Transitive dependency resolution is not a full application lockfile and may change between operations unless independently pinned.

## Client contract

`server/runner-client.mjs` exports `RunnerClient`:

```js
const runner = new RunnerClient({ socketPath });
await runner.capabilities();
// {enabled, ready, packages, execution, installs, limits, blockedReasons}
await runner.execute({
  workspaceId, kind: 'python', code, // kind can also be 'shell'
  files: [{ path, mime, bytes: Buffer.from('input') }],
  packages: { pip: [], npm: [] }, signal
});
// {status, stdout, stderr, exitCode, error, files:[{path,mime,bytes:Buffer}]}
await runner.install({ workspaceId, packages: { pip: ['humanize'], npm: [] }, signal });
// {packages:{pip:['humanize==resolved-version'],npm:[]},summary}
await runner.extractDocument({ path, mime, bytes, signal });
// {passages:[{text,page?,paragraph?}]}
await runner.mediaProbe({ name, mime, bytes, signal });
// {durationSeconds,hasAudio,hasVideo,width?,height?,audioCodec?,videoCodec?}
```

Unconfigured/unavailable capabilities return `ready:false` with reasons. Execution terminal states are complete, error, cancelled, timed_out, and interrupted. Transport errors and AbortSignal cancellation reject. Install, extraction, and probe reject on a failed operation. Callers must not blindly retry code after a transport failure. The client sends an explicit cancellation without using the already-aborted signal, then releases terminal results.

The private protocol has prepare, bounded raw-byte input upload, start, status, bounded output download, cancel and release routes under `/v1/operations`. It sends small internal chunks to the worker rather than one base64 workspace JSON object. Operation IDs are idempotent only while their bounded records remain retained; differing content with the same ID is a conflict. No caller can select engine flags, mounts, images, entrypoints, host paths, or environment.

Document extraction is fixed code, not a caller-selected shell command. PDF extraction rejects encryption and more than 200 pages. DOCX limits expanded ZIP bytes and entry count. Both bound extracted text to 250000 characters. OCR, scanned-image text, office-layout conversion, and password-protected documents are unsupported. ffprobe returns inspected duration/stream/codec metadata, not evidence that an inference endpoint supports that codec or a guarantee of full media decoding.
