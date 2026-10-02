# Device-local drafts

Common Chat saves unsent drafts in this browser's `localStorage`. Each conversation has one draft. The New chat screen has a separate draft until sending, uploading a file, or opening generation settings creates a server conversation. New chat returns to that separate draft instead of creating an empty server conversation.

Drafts survive page reloads and browser restarts when the browser retains site data. They do not sync to another device, browser profile, or server address. A different scheme, hostname, or port has separate storage. Private browsing and browser data removal can erase drafts. This is not an account or multi-user feature.

The composer states that draft storage is local. Its Discard draft button removes the visible draft after confirmation. Cancel edit also discards the edited draft after confirmation. Deleting a conversation explicitly includes its draft on this device. Other conversations' drafts remain unchanged.

## Saved data

`public/drafts.js` stores one versioned JSON record per conversation under `common-chat:draft:v1:<id>`. The reserved `new` key holds the New chat draft. A record contains:

- The complete unsent text, including whitespace.
- Uploaded attachment IDs, display names, and whether the reference came from a saved message.
- The edited message ID and its original parent ID.
- An unresolved submission's conversation ID and exact request object, when present.

Attachment bytes stay on the server. Provider credentials and session cookies are not copied into drafts. A pending request does include its selected provider ID, model, generation settings, and any system prompt. Drafts are not encrypted. Anyone who can access this browser profile or run same-origin code can read them. Server exports and backups do not include browser drafts.

## Sending and recovery

Before a generate request, the browser saves the exact request object and request ID with the draft. Reloading an unresolved submission restores Retry send and checks `/api/requests/:id`. Retry sends the original object without changing its version, parent, settings, or request ID. A confirmed request result clears only the submitted draft. Regeneration retains the unrelated text and attachments in the composer.

A network failure or server error retains the pending request. A definite client rejection, such as a version conflict, releases retry mode and keeps the text, attachments, and edit target for correction. The browser does not automatically submit drafts or restart model jobs.

The visible draft key is independent of the conversation snapshot. Server events, reconnects, and version refreshes update saved messages without restoring or clearing the composer. Navigation saves the current draft before restoring the target draft. Creating a server conversation saves the new destination before removing the New chat copy. An interruption between those storage operations can leave an extra copy rather than lose the draft.

A deleted or unavailable conversation does not silently move its draft into New chat. The old conversation address still opens its local draft and shows a warning. Copy needed text to a new chat. Missing edit targets also remain visible with a warning instead of silently sending on a different branch.

## Attachments

Restoring a draft checks its attachment references through the existing authenticated file route. Missing files remain listed as missing. Remove those references and upload the files again before sending. A failed availability check shows "not verified" and retains the reference. The server still validates attachment ownership and availability at submission.

The remove button deletes an unattached upload, as before. A file already missing or saved to a message can still be removed from the draft without deleting the saved message. Removing an upload can make its reference stale in another open tab. That tab retains its text and can remove the stale reference.

Discarding a whole draft, replacing it with an edit, or signing out removes local references, not uploaded server files. The server retains unused uploads until conversation deletion. Its existing limit of 100 unattached files per conversation still applies. This feature adds no server cleanup job or attachment API.

## Storage failures and tabs

If browser storage is denied or full, the composer displays a persistent warning. The current input and failed saves stay in page memory. Copy important text before closing or reloading. The browser requests an unload warning for unsaved storage changes and active operations, but browsers can omit that warning. Persistence and reload-safe retry cannot be guaranteed when storage fails.

Unreadable or unsupported saved records are not silently deleted. The warning asks the user to preserve important text before replacing the record. There is no automatic expiry or draft eviction.

Different conversation keys avoid rewriting unrelated drafts. Saving unchanged input during navigation does not overwrite another tab's changes. A successful send checks the stored draft before deleting it, so a different newer draft is retained. Editing the same conversation in multiple tabs is not collaborative editing. The last changed input saved in that browser wins, and another tab's changes are not merged into the visible input.

## Sign-out privacy

Explicit Sign out asks for confirmation to discard all Common Chat drafts for this server in the current browser. After the server accepts sign-out, the browser removes this feature's storage records and clears its in-memory composer. A `common-chat:drafts:logout` storage event tells other open tabs on the same origin to clear their in-memory drafts and return to sign-in. It does not clear unrelated site storage, server conversations, or uploaded files. It does not cancel an already submitted generation.

If storage removal or the cross-tab signal fails, the sign-in screen shows a warning. Clear this site's browser data before sharing the device. Closing the page, ordinary session expiry, and temporary authentication failures do not discard drafts. Session expiry hides the app until sign-in. It is not equivalent to explicit sign-out. In trusted-local mode, the server hides Sign out, so use Discard draft or the browser's site-data controls when needed.

## Integration

`public/app.js` imports `createDraftStore` and `DRAFT_LOGOUT_KEY`. `server/app.mjs` registers `/drafts.js` as a static JavaScript asset. No server database migration, account change, build step, dependency, or model configuration change is required.

The existing verification commands remain `npm run check` and `npm test`. Practical checks should use a temporary server and the repository's synthetic model fixture, not a real model service. Browser checks must distinguish a page reload from a complete browser restart. Storage-denial, quota, and same-conversation concurrent edits require separate observation before claiming those scenarios passed.
