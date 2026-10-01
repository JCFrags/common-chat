# Operations

STE-style, not verified for ASD-STE100 compliance.

This guide describes Common Chat 0.1.0. The native Node deployment was tested on Linux. The Docker configuration is supplied but was not built in this environment.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address for native deployment. |
| `PORT` | `3000` | Listen port for native deployment. Published host port for Compose. |
| `PUBLIC_URL` | Local loopback origin | Exact browser-facing origin. Required for a non-loopback listen address. |
| `DATA_DIR` | `./data` | Native data directory. Compose uses `/app/data` in its named volume. |
| `CHAT_PASSWORD` | Random initial password | Initial owner password. It does not replace an existing password. |
| `BIND_ADDRESS` | `127.0.0.1` | Published host address for Compose only. |

The start command reads `.env` when that file exists. Ordinary environment variables take precedence. The server validates the HTTP Host and Origin headers against `PUBLIC_URL`.

The data directory must belong to one server process. This release uses a process lock and SQLite. It does not support multiple replicas or shared network storage.

## Trusted-local deployment

The home-server deployment adds an opt-in `CHAT_TRUSTED_LOCAL=true` mode. The default mode still requires a password.

WARNING

Trusted-local mode has no application login. Every allowed client can read all conversations, change connections, and use saved API keys. HTTP also exposes conversation content on the local network. Do not publish this deployment to the internet.

1. Set `CHAT_TRUSTED_LOCAL=true` and an exact `PUBLIC_URL`.
2. Keep `HOST=127.0.0.1`. The application rejects non-loopback listeners and requests in this mode.
3. Use a reverse proxy that preserves Host and restricts source addresses to the trusted LAN and personal VPN.
4. Do not trust a client-supplied `X-Forwarded-For` header for access control.

The interface opens directly and hides "Sign out". Host validation, Origin validation, and same-origin JSON mutation headers remain required. The database retains an inaccessible random password hash for account compatibility. No initial password is printed in this mode.

## Docker Compose

WARNING

Use HTTPS or an encrypted tunnel before remote access. The default Compose port is restricted to the host loopback address.

1. Copy `.env.example` to `.env`.
2. Set `PUBLIC_URL` to the address that browsers will use.
3. Set `CHAT_PASSWORD` or leave it unset for an initial random password.
4. Build and start the service.

```sh
docker compose up -d --build
```

5. Read the startup log.

```sh
docker compose logs chat
```

6. Open the configured address.
7. Sign in with the configured or generated password.

The container runs as the `node` user. The data volume remains writable. The root filesystem is read-only. Compose drops Linux capabilities and enables a health check.

A non-loopback `BIND_ADDRESS` publishes the port beyond the host. This does not enable TLS. A separate HTTPS reverse proxy or encrypted tunnel is still required for protected remote access.

Inside the container, `127.0.0.1` means the container itself. It does not identify a model server on the Docker host. The Compose file supplies a `host.docker.internal` host mapping. A possible base URL is `http://host.docker.internal:8080/v1`. The model server must accept connections on that reachable host interface. A model server bound only to host loopback may not accept that connection.

## HTTPS reverse proxy

The application serves HTTP internally. The proxy must provide TLS for the browser-facing address.

1. Set `PUBLIC_URL` to the exact HTTPS origin.
2. Forward that origin to the internal Common Chat HTTP port.
3. Preserve the browser-facing Host header on forwarded requests.
4. Disable response buffering for `/api/events`.
5. Set the proxy idle timeout above the 15-second event heartbeat interval.
6. Permit request bodies of at least 34 MiB for maximum-size imports.
7. Keep the internal port inaccessible from untrusted networks.

The server marks session cookies Secure when `PUBLIC_URL` uses HTTPS. It also supplies an HSTS header. Forwarded headers do not override its configured origin or login rate-limit address. Behind a proxy, all users can share one login rate-limit bucket.

## Native backup

CAUTION

Stop the server before backup. Keep the database, attachments, and `master.key` together. A partial copy can lose history or prevent key decryption.

1. Stop the server with Ctrl+C or SIGTERM.
2. Create a backup in a new directory.

```sh
npm run backup -- ./data ./backups/snapshot-001
```

3. Copy the complete backup to protected storage.
4. Restart the server.

The script refuses a directory with `server.lock`. It checks SQLite integrity and creates a SHA-256 file manifest. Backup files contain private conversations, session records, and the API key decryption key. File hashes detect changes but do not authenticate an untrusted backup source.

## Native restore

1. Stop the server.
2. Restore a trusted backup into a new directory.

```sh
npm run restore -- ./backups/snapshot-001 ./restored-data
```

3. Set `DATA_DIR=./restored-data` in `.env`.
4. Start the server.
5. Sign in and inspect conversations and attachments.

Restore verifies file sizes, hashes, paths, and SQLite integrity. It does not overwrite an existing destination. A restored backup also restores its saved password and sessions. A password reset revokes those sessions.

## Docker volume backup

These commands create a direct offline copy, not the manifest format used by the native backup script.

CAUTION

Do not run `docker compose down -v` on the active deployment. That command removes the named volume and its stored conversations.

1. Stop the service.

```sh
docker compose stop chat
```

2. Copy the complete data directory from the stopped container.

```sh
docker compose cp chat:/app/data ./backup-data
```

3. Start the service again.

```sh
docker compose start chat
```

For restoration, the target volume must be empty. The copied directory must contain `chat.sqlite`, `master.key`, and `files`. Do not replace selected files in an existing database directory.

1. Stop the target service.
2. Copy the complete backup into its empty data volume.

```sh
docker compose cp ./backup-data/. chat:/app/data
```

3. Restore file ownership for the container user.

```sh
docker compose run --rm --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh chat -c 'chown -R node:node /app/data && chmod 700 /app/data'
```

4. Start the target service.

These Docker procedures require verification on the deployment host. The Docker CLI was not available during this release test.

## Reset the owner password

CAUTION

Stop the server before password reset. A successful reset invalidates all existing sessions.

1. Set a new `CHAT_PASSWORD` in `.env`.
2. Reset the native account.

```sh
node --env-file=.env scripts/reset-password.mjs
```

3. Start the server.
4. Sign in again on each device.

For a stopped Compose deployment, the reset command is different.

```sh
docker compose run --rm chat node scripts/reset-password.mjs
```

The reset uses the `CHAT_PASSWORD` supplied by Compose. The value must contain at least 12 characters.

## Response statistics

Assistant messages retain numeric upstream `usage` and `timings` in metadata. The server keeps recognized token counts, usage detail counts, and llama.cpp fields `prompt_n`, `prompt_ms`, `prompt_per_second`, `predicted_n`, `predicted_ms`, `predicted_per_second`, `draft_n`, and `draft_n_accepted`. Counts must be nonnegative safe integers. Times and rates must be finite, nonnegative numbers within the safe numeric range. Unknown fields and invalid values are not stored.

PP and TG display upstream `prompt_per_second` and `predicted_per_second` in tokens/s. The application does not calculate replacement rates from response duration. Input/output counts prefer `prompt_tokens`/`completion_tokens`, then `prompt_n`/`predicted_n`. A fallback input count is labeled "timed" because caching can reduce it. llama.cpp output counts include reasoning and answer tokens. Other providers define their own counts. A separate reasoning token count is shown only when `completion_tokens_details.reasoning_tokens` is available. MTP accepted / drafted uses `draft_n_accepted`/`draft_n`.

The saved `observed.durationMs` uses a monotonic clock from model request start to response end or failure. `observed.firstTextMs` stops at the first nonempty answer or reasoning delta in an actual stream. These observations include queue, transport, and response processing time. They are not model execution timings. Buffered JSON responses retain duration but cannot expose first-text latency, even if streaming was requested. Displayed rates and seconds are rounded to two decimals. Raw validated values remain in metadata.

Streaming requests use the standard `stream_options: { include_usage: true }`. llama.cpp can return usage and timings in a final event with no choices. Providers without these fields remain usable but show unavailable statistics. If an endpoint rejects the standard usage option, disable streaming for that connection to use its JSON response. The application does not retry a rejected generation automatically.

Metadata uses the existing JSON column and native export/import format. Old messages need no migration and receive no invented values. Cancelled, interrupted, and failed responses retain observed timings when the server can finish the job, but upstream statistics may be absent. Hard crashes can leave no timing observations. Reloading the conversation reads the saved values rather than measuring browser rendering time.

## Recovery and troubleshooting

A normal stop flushes active responses and marks them interrupted. A hard crash can leave a stale process lock. On the same host, the next startup removes a lock whose process no longer exists.

A copied crash-state directory can contain a PID that belongs to another host. Confirm that no Common Chat process uses that directory before removing a stale lock. Never remove a lock to bypass an active server.

A missing `master.key` prevents startup when a database already exists. Restore the matching key from backup. Creating a replacement key does not recover saved API keys.

A Host rejection usually means `PUBLIC_URL` differs from the browser address. A model connection failure usually needs a base URL, network, or credential check. The base URL must include `/v1` when the provider expects that prefix.

An interrupted response is retained but not resumed automatically. Regenerate the response or send another message to continue. A conflicting edit requires a fresh conversation snapshot before retry.

This release has no independent security audit. Use one trusted owner and a restricted network. Avoid deployment as a public multi-user service.
