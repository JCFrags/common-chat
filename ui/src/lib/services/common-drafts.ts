import type { CommonGeneration } from '$lib/types/common-api';

export const DRAFT_PREFIX = 'common-chat:draft:v1:';
export const DRAFT_LOGOUT_KEY = 'common-chat:drafts:logout';
export interface DraftAttachment { id: string; name: string; existing: boolean; mime?: string; size?: number }
export interface CommonDraft {
	text: string;
	attachments: DraftAttachment[];
	editing: { id: string; parentId: string | null; baseVersion?: number } | null;
	retry: { cid: string; body: CommonGeneration } | null;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

function draftValue(value: unknown, key: string): CommonDraft {
	if (!record(value) || typeof value.text !== 'string' || !Array.isArray(value.attachments)) throw new Error('Invalid draft');
	const attachments = value.attachments.map((a: unknown) => {
		if (!record(a) || !identifier(a.id) || typeof a.name !== 'string') throw new Error('Invalid attachment reference');
		return { id: a.id, name: a.name, existing: a.existing === true,
			...(typeof a.mime === 'string' ? { mime: a.mime } : {}), ...(typeof a.size === 'number' ? { size: a.size } : {}) };
	});
	const editing = value.editing ?? null, retry = value.retry ?? null;
	if (editing && (!record(editing) || !identifier(editing.id) || !(editing.parentId === null || identifier(editing.parentId)))) throw new Error('Invalid edit target');
	if (retry && (!record(retry) || retry.cid !== key || !record(retry.body) || !identifier(retry.body.requestId))) throw new Error('Invalid pending request');
	if (editing?.baseVersion !== undefined && (!Number.isSafeInteger(editing.baseVersion) || editing.baseVersion < 0)) throw new Error('Invalid edit version');
	return { text: value.text, attachments, editing: editing ? { id: editing.id, parentId: editing.parentId,
		...(editing.baseVersion !== undefined ? { baseVersion: editing.baseVersion } : {}) } : null,
		// Property order is part of Common request idempotency. Keep the original object.
		retry: retry ? copy(retry) : null };
}
function encode(value: CommonDraft, key: string): string | null {
	const draft = draftValue(value, key);
	return draft.text || draft.attachments.length || draft.editing || draft.retry ? JSON.stringify({ version: 1, draft }) : null;
}
function decode(raw: string | null, key: string): CommonDraft | null {
	if (raw === null) return null;
	const saved = JSON.parse(raw);
	if (saved.version !== 1) throw new Error('Unknown draft version');
	return draftValue(saved.draft, key);
}

/** Same storage and conflict rules as public/drafts.js. No credential or file-byte copies. */
export function createCommonDraftStore(onWarning: (message: string) => void) {
	const memory = new Map<string, string | null>(), unsaved = new Set<string>(), problems = new Map<string, string>();
	const name = (key: string) => DRAFT_PREFIX + encodeURIComponent(key);
	const update = (key: string, message = '') => {
		if (message) problems.set(key, message); else problems.delete(key);
		onWarning([...problems.values()].at(-1) ?? '');
	};
	const failed = (key: string, error: unknown, action: string) => {
		const reason = error instanceof DOMException && error.name === 'QuotaExceededError' ? 'Browser draft storage is full.' : 'Browser draft storage is unavailable.';
		update(key, `${reason} Could not ${action}. Keep this page open and copy important text before leaving.`);
	};
	return {
		get hasUnsaved() { return unsaved.size > 0; },
		get(key: string): CommonDraft | null {
			if (unsaved.has(key)) return decode(memory.get(key) ?? null, key);
			try {
				const raw = localStorage.getItem(name(key)), value = decode(raw, key);
				memory.set(key, raw); update(key); return value;
			} catch (error) {
				if (error instanceof SyntaxError || (error instanceof Error && (error.message.startsWith('Invalid') || error.message === 'Unknown draft version'))) {
					update(key, 'A saved draft could not be read. Its stored copy was not deleted. Copy important text before replacing it.');
				} else failed(key, error, 'read saved drafts');
				return decode(memory.get(key) ?? null, key);
			}
		},
		set(key: string, value: CommonDraft): boolean {
			const raw = encode(value, key);
			if (raw === (memory.get(key) ?? null) && !unsaved.has(key)) return true;
			memory.set(key, raw); unsaved.add(key);
			try {
				if (raw === null) localStorage.removeItem(name(key)); else localStorage.setItem(name(key), raw);
				unsaved.delete(key); update(key); return true;
			} catch (error) { failed(key, error, 'save the latest draft'); return false; }
		},
		delete(key: string, expected?: CommonDraft): boolean {
			const expectedRaw = expected === undefined ? undefined : encode(expected, key);
			memory.set(key, null);
			try {
				const saved = localStorage.getItem(name(key));
				const beforeSend = expected?.retry && !expected.retry.body.regenerate && !expected.retry.body.continue
					? encode({ ...expected, retry: null }, key) : undefined;
				if (expectedRaw !== undefined && saved !== expectedRaw && saved !== beforeSend) {
					unsaved.delete(key); update(key); return true;
				}
				localStorage.removeItem(name(key)); unsaved.delete(key); update(key); return true;
			} catch (error) { unsaved.add(key); failed(key, error, 'remove a saved draft'); return false; }
		},
		clear(): boolean {
			let cleared = true;
			try {
				const keys: string[] = [];
				for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(DRAFT_PREFIX)) keys.push(key); }
				for (const key of keys) localStorage.removeItem(key);
				localStorage.setItem(DRAFT_LOGOUT_KEY, `${Date.now()}:${Math.random()}`);
			} catch { cleared = false; }
			memory.clear(); unsaved.clear(); problems.clear();
			update('logout', cleared ? '' : 'Signed out, but saved drafts could not be fully removed. Clear this site\'s browser data before sharing this device.');
			return cleared;
		},
		forget() { memory.clear(); unsaved.clear(); problems.clear(); }
	};
}
