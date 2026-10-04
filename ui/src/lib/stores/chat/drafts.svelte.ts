import { browser } from '$app/environment';
import { createCommonDraftStore, type CommonDraft } from '$lib/services/common-drafts';
import { attachmentUrl } from '$lib/services/common-mapping';
import type { CommonAttachment, CommonGeneration } from '$lib/types/common-api';
import type { ChatUploadedFile } from '$lib/types/chat';
import { SvelteMap } from 'svelte/reactivity';

const empty = (): CommonDraft => ({ text: '', attachments: [], editing: null, retry: null });
const keyOf = (id?: string | null) => id ?? 'new';
const kindOf = (mime: string): CommonAttachment['kind'] => mime.startsWith('image/') ? 'image'
	: mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'text';

class DraftMessagesStore {
	warning = $state('');
	fileWarning = $state('');
	revision = $state(0);
	acknowledgement = $state<{ key: string; draft: CommonDraft; requestId: string } | null>(null);
	uploadUpdate = $state<{ key: string; revision: number } | null>(null);
	draftUpdate = $state<{ key: string; revision: number } | null>(null);
	migratedNewTarget: string | null = null;
	private storage = createCommonDraftStore((warning) => { this.warning = warning; });
	private files = new Map<string, ChatUploadedFile[]>();
	private records = new SvelteMap<string, CommonDraft>();
	private missing = new SvelteMap<string, string>();

	get hasUnsaved(): boolean { return this.storage.hasUnsaved; }

	getRecord(id?: string | null): CommonDraft {
		const key = keyOf(id);
		const record = browser ? this.storage.get(key) ?? empty() : this.records.get(key) ?? empty();
		this.records.set(key, record);
		return record;
	}

	getPending(id?: string | null): CommonDraft['retry'] {
		void this.revision;
		return this.records.get(keyOf(id))?.retry ?? null;
	}

	getWarning(id?: string | null): string {
		return this.missing.get(keyOf(id)) ?? '';
	}
	setTargetWarning(id: string, warning: string): void {
		if (warning) this.missing.set(id, warning); else this.missing.delete(id);
	}

	getDraftMessage(id?: string): { message: string; files: ChatUploadedFile[] } {
		const key = keyOf(id), record = this.getRecord(id);
		const restored = record.attachments.map((ref): ChatUploadedFile => {
			const mime = ref.mime ?? 'text/plain';
			const attachment: CommonAttachment = { id: ref.id, name: ref.name, mime, kind: kindOf(mime), size: ref.size ?? 0 };
			let url: string | undefined, loadError: string | undefined;
			try { url = attachmentUrl(ref.id); } catch { loadError = 'Invalid file reference. Remove it and upload again.'; }
			return { id: ref.id, name: ref.name, size: attachment.size, type: mime,
				file: new File([], ref.name, { type: mime }), loadError,
				preview: attachment.kind !== 'text' ? url : undefined,
				commonAttachments: [attachment], commonExisting: ref.existing };
		});
		const previous = this.files.get(key);
		const files = previous && previous.flatMap((f) => f.commonAttachments ?? []).map((a) => a.id).join('|') === record.attachments.map((a) => a.id).join('|')
			? previous : restored;
		this.files.set(key, files);
		return { message: record.text, files };
	}

	saveDraftMessage(id: string | undefined, message: string, files: ChatUploadedFile[]): void {
		const key = keyOf(id), previous = this.records.get(key) ?? this.getRecord(id);
		this.files.set(key, files);
		this.fileWarning = files.some((f) => !f.commonAttachments?.length)
			? 'Files are not uploaded yet. Keep this page open. Reload cannot restore their bytes.' : '';
		const record = { ...previous, text: message, attachments: files.flatMap((f) => (f.commonAttachments ?? []).map((a) => ({
			id: a.id, name: a.name, existing: f.commonExisting === true, mime: a.mime, size: a.size
		}))) };
		this.save(key, record);
	}

	setLinkDraft(id: string, text: string): boolean {
		const current = this.getRecord(id);
		if (current.text || current.retry || current.editing || current.attachments.length) {
			this.warning = 'The link prompt did not replace an existing device draft. Copy the link text if needed.';
			return false;
		}
		this.save(id, { ...current, text });
		this.draftUpdate = { key: id, revision: this.revision };
		return true;
	}

	updateFiles(id: string, files: ChatUploadedFile[]): void {
		this.saveDraftMessage(id, this.getRecord(id).text, files);
		this.uploadUpdate = { key: id, revision: this.revision };
	}

	saveRecord(id: string, value: CommonDraft): void { this.save(id, value); }
	private save(key: string, record: CommonDraft): void {
		this.records.set(key, record);
		if (browser) this.storage.set(key, record);
		this.revision++;
	}

	setEditing(id: string, editing: CommonDraft['editing']): void {
		this.save(id, { ...this.getRecord(id), editing });
	}

	persistRequest(id: string, body: CommonGeneration, composer?: Partial<CommonDraft>): CommonDraft {
		const record = { ...this.getRecord(id), ...composer, retry: { cid: id, body: JSON.parse(JSON.stringify(body)) } };
		this.save(id, record);
		return record;
	}

	releaseRequest(id: string, requestId: string): void {
		const record = this.getRecord(id);
		if (record.retry?.body.requestId === requestId) this.save(id, { ...record, retry: null });
	}

	acknowledge(id: string, expected: CommonDraft): void {
		const current = this.getRecord(id);
		if (!expected.retry) return;
		if (expected.retry.body.regenerate || expected.retry.body.continue) {
			this.releaseRequest(id, expected.retry.body.requestId);
			return;
		}
		this.storage.delete(id, expected);
		// A different draft typed after submission stays visible and stored.
		const requestMatches = current.retry?.body.requestId === expected.retry.body.requestId;
		const same = requestMatches && current.text === expected.text && JSON.stringify(current.attachments) === JSON.stringify(expected.attachments)
			&& JSON.stringify(current.editing) === JSON.stringify(expected.editing);
		if (same) {
			this.records.set(id, empty()); this.files.delete(id);
			this.acknowledgement = { key: id, draft: expected, requestId: expected.retry.body.requestId };
		} else if (requestMatches) {
			this.save(id, { ...current, retry: null });
		}
		this.revision++;
	}

	migrateNew(id: string): void {
		this.migratedNewTarget = id;
		const value = this.getRecord();
		this.save(id, value);
		if (this.files.has('new')) this.files.set(id, this.files.get('new')!);
		this.storage.delete('new', value); this.records.delete('new'); this.files.delete('new');
	}

	clearDraftMessage(id: string | undefined): void {
		const key = keyOf(id);
		this.storage.delete(key); this.records.delete(key); this.files.delete(key); this.revision++;
	}

	async verifyAttachments(id?: string): Promise<void> {
		const record = this.getRecord(id), key = keyOf(id);
		const files = this.getDraftMessage(id).files;
		await Promise.all(files.map(async (file) => {
			const ref = file.commonAttachments?.[0];
			if (!ref) return;
			try {
				const response = await fetch(attachmentUrl(ref.id), { credentials: 'same-origin', cache: 'no-store' });
				if (!response.ok) {
					file.loadError = response.status === 404 ? 'Missing file. Remove this reference and upload again.' : 'File availability is not verified.';
					return;
				}
				const mime = response.headers.get('Content-Type')?.split(';')[0] ?? ref.mime;
				ref.mime = mime; ref.kind = kindOf(mime); file.type = mime; file.loadError = undefined;
				if (ref.kind === 'text') file.textContent = await response.text();
				else { file.preview = attachmentUrl(ref.id); await response.body?.cancel(); }
			} catch { file.loadError = 'File availability is not verified.'; }
		}));
		// Navigation may have restored a different target while the check ran.
		if (this.records.get(key)?.retry?.body.requestId === record.retry?.body.requestId) {
			this.files.set(key, files.map((file) => ({ ...file })));
			this.revision++;
			this.uploadUpdate = { key, revision: this.revision };
		}
	}

	clearAll(): boolean {
		const result = this.storage.clear();
		this.forget();
		return result;
	}
	forget(): void {
		this.files.clear(); this.records.clear(); this.missing.clear(); this.fileWarning = '';
		this.acknowledgement = null; this.migratedNewTarget = null; this.storage.forget(); this.revision++;
	}
}

export const draftMessagesStore = new DraftMessagesStore();
