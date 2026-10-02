# Preview-first releases

Common Chat is a community-installable application. The primary maintainer installation receives each accepted preview before that exact source commit can be promoted to stable. Other installations can choose preview releases. Public source can also be built independently, so this policy does not prevent someone from installing a source commit earlier.

Updates do not run automatically inside the chat process. No updater has the authority to interrupt chats, discard drafts, replace the model server, or expose a private installation. An administrator applies a release during an idle window. The configured channel identifies the installation's release policy, not a background update service.

## Build an archive

Use a clean checkout of an accepted commit on `main` with Node.js 24, Git, and GNU tar. The existing checks require no npm installation. Browser assets are already included.

```sh
npm run check
npm test
npm run release:pack -- 0.2.0-preview.1 preview dist
```

The command packages tracked source only and normalizes archive ownership to numeric UID/GID 0 without local account names. Directories and executable files use mode `0755`; other files use `0644`, independent of the builder's umask. Private data is never part of this archive. It adds `release.json` with version, channel, full commit, and build time. It writes a `.tar.gz`, a SHA-256 file, and a JSON manifest. It refuses to overwrite the archive or package a dirty checkout. Do not put data, environment files, credentials, or logs in Git. Screen the actual outgoing archive and release text before publication.

The authenticated `GET /api/session` response and Settings show the loaded release version, channel, and commit. A source checkout without the generated manifest reports `development`. `CHAT_UPDATE_CHANNEL=preview` or `stable` can override the policy label, but cannot change the manifest's source commit or install another release.

## Apply a primary preview

CAUTION

A code rollback does not restore deleted or overwritten data. Back up the whole data directory while the application is stopped. Keep `master.key`, the database, attachment files, and workspace revisions together. Do not restore an older data snapshot over newer conversations.

1. Verify the archive hash against the release checksum and inspect its manifest.
2. Extract it into a new immutable release directory, separate from `DATA_DIR`.
3. Build the optional runner image from that release's pinned `runner/Dockerfile`. Use the runner instructions for its own account and socket. Never grant the chat application an engine socket.
4. Check active generations, executions, and package operations. Wait for them to finish or obtain permission to cancel them. Existing browser drafts remain device-local.
5. Stop only Common Chat, then make and verify a complete offline backup with the supported scripts.
6. Change only the application's source directory and its matching runner image selection. Preserve keys, model connections, model services, access policy, and unrelated service settings.
7. Start the runner and chat application using their supported service procedure.
8. Check the loaded release identity and actually use the changed features. Confirm that prior conversations, attachment bytes, and saved keys remain intact.
9. Keep the previous release, image identity, service configuration, and fresh backup until the new release is accepted.

See [operations](OPERATIONS.md) for base installation and backup commands, and [runner setup](RUNNER.md) for the optional execution service. A changed path or a successful build is not proof that the running application uses it.

## Publish and promote

The repository's `Existing checks` workflow runs syntax checks and the existing Node suite for pull requests and `main`. No new automated feature test suite is implied by a green result. Record practical verification and remaining limits separately.

The `Preview-first release` workflow is manual and runs only from `main`:

- For preview, choose a prerelease version such as `0.2.0-preview.1`. GitHub marks it as a prerelease, not the latest stable release.
- For stable, choose a normal version such as `0.2.0`, supply the published preview tag, and confirm primary preview verification. The workflow requires the preview tag and the checked-out `main` to identify exactly the same commit.

The confirmation is a maintainer attestation, not an automatic probe of a private server. Record the accepted commit, completed practical checks, preservation/rollback result, and known limits before confirming it. Do not publish private hostnames, local paths, credentials, or personal data as evidence. If `main` changed after a preview, deploy and verify a new preview of the new commit before promotion. Do not reuse evidence for different source.

No GitHub workflow connects to a private installation. CI credentials cannot start local models or restart local services. Releases include source and the worker build recipe, not a public copy of the primary installation's data or configuration.
