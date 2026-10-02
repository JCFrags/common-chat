// Device-local drafts. File bytes and conversation history stay on the server.
export const DRAFT_PREFIX = 'common-chat:draft:v1:';
export const DRAFT_LOGOUT_KEY = 'common-chat:drafts:logout';
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 100;

function draftValue(value, key) {
  if (!record(value) || typeof value.text !== 'string' || !Array.isArray(value.attachments)) throw new Error('Invalid draft');
  const attachments = value.attachments.map(a => {
    if (!record(a) || !identifier(a.id) || typeof a.name !== 'string') throw new Error('Invalid attachment reference');
    return { id: a.id, name: a.name, existing: a.existing === true };
  });
  const editing = value.editing ?? null, retry = value.retry ?? null;
  if (editing && (!record(editing) || !identifier(editing.id) || !(editing.parentId === null || identifier(editing.parentId)))) throw new Error('Invalid edit target');
  if (retry && (!record(retry) || retry.cid !== key || !record(retry.body) || !identifier(retry.body.requestId))) throw new Error('Invalid pending request');
  return { text: value.text, attachments, editing: editing ? { id: editing.id, parentId: editing.parentId } : null,
    // Preserve the exact request object, including property order, for server idempotency.
    retry: copy(retry) };
}
function encode(value, key) {
  const draft = draftValue(value, key);
  return draft.text || draft.attachments.length || draft.editing || draft.retry ? JSON.stringify({ version: 1, draft }) : null;
}
function decode(raw, key) {
  if (raw === null) return null;
  const saved = JSON.parse(raw);
  if (saved.version !== 1) throw new Error('Unknown draft version');
  return draftValue(saved.draft, key);
}

export function createDraftStore({ storage = () => globalThis.localStorage, onWarning = () => {} } = {}) {
  const memory = new Map(), unsaved = new Set(), problems = new Map();
  const name = key => DRAFT_PREFIX + encodeURIComponent(key ?? 'new');
  const update = (key, message = '') => {
    if (message) problems.set(key, message); else problems.delete(key);
    onWarning([...problems.values()].at(-1) ?? '');
  };
  const failed = (key, error, action) => {
    const reason = error?.name === 'QuotaExceededError' ? 'Browser draft storage is full.' : 'Browser draft storage is unavailable.';
    update(key, `${reason} Could not ${action}. Keep this page open and copy important text before leaving.`);
  };
  return {
    get hasUnsaved() { return unsaved.size > 0; },
    get(key) {
      if (unsaved.has(key)) return decode(memory.get(key) ?? null, key);
      try {
        const raw = storage().getItem(name(key)), value = decode(raw, key);
        memory.set(key, raw); update(key); return value;
      } catch (error) {
        if (error instanceof SyntaxError || error?.message?.startsWith('Invalid') || error?.message === 'Unknown draft version') {
          update(key, 'A saved draft could not be read. Its stored copy was not deleted. Copy important text before replacing it.');
        } else failed(key, error, 'read saved drafts');
        return decode(memory.get(key) ?? null, key);
      }
    },
    set(key, value) {
      const raw = encode(value, key);
      // Navigation and server refreshes must not overwrite another tab's edits.
      if (raw === (memory.get(key) ?? null) && !unsaved.has(key)) return true;
      memory.set(key, raw); unsaved.add(key);
      try {
        const target = storage();
        if (raw === null) target.removeItem(name(key)); else target.setItem(name(key), raw);
        unsaved.delete(key); update(key); return true;
      } catch (error) { failed(key, error, 'save the latest draft'); return false; }
    },
    delete(key, expected) {
      const expectedRaw = expected === undefined ? undefined : encode(expected, key);
      memory.set(key, null);
      try {
        const target = storage();
        // Do not erase a newer draft saved by another tab after this submission.
        const saved = target.getItem(name(key));
        const beforeSend = expected?.retry && !expected.retry.body.regenerate ? encode({ ...expected, retry: null }, key) : undefined;
        if (expectedRaw !== undefined && saved !== expectedRaw && saved !== beforeSend) {
          unsaved.delete(key); update(key); return true;
        }
        target.removeItem(name(key)); unsaved.delete(key); update(key); return true;
      } catch (error) { unsaved.add(key); failed(key, error, 'remove a saved draft'); return false; }
    },
    clear() {
      let cleared = true;
      try {
        const target = storage(), keys = [];
        for (let i = 0; i < target.length; i++) { const key = target.key(i); if (key?.startsWith(DRAFT_PREFIX)) keys.push(key); }
        for (const key of keys) target.removeItem(key);
        // Other tabs must forget their in-memory drafts after explicit sign-out.
        target.setItem(DRAFT_LOGOUT_KEY, `${Date.now()}:${Math.random()}`);
      } catch { cleared = false; }
      memory.clear(); unsaved.clear(); problems.clear();
      update('logout', cleared ? '' : 'Signed out, but saved drafts could not be fully removed. Clear this site\'s browser data before sharing this device.');
      return cleared;
    },
    forget() { memory.clear(); unsaved.clear(); problems.clear(); }
  };
}
