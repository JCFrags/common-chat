import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { commonStore } from '$lib/stores/common.svelte';
import { attachmentExtra } from '$lib/services/common-mapping';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { ChatUploadedFile } from '$lib/types/chat';
import { onMount, untrack } from 'svelte';

interface Options {
	message: () => DatabaseMessage;
	isEditing: () => boolean;
	content: () => string;
	extras: () => DatabaseMessageExtra[];
	files: () => ChatUploadedFile[];
	setDraft: (content: string, extras: DatabaseMessageExtra[]) => void;
}

/** One device edit draft per conversation. It never enters the main composer or auto-submits. */
export function useCommonEditDraft(options: Options) {
	let ready = $state(false), baseVersion = $state<number | null>(null);
	const key = () => `edit:${options.message().convId}`;
	onMount(() => { draftMessagesStore.getRecord(key()); ready = true; });
	const saved = $derived.by(() => {
		void draftMessagesStore.revision;
		return ready ? untrack(() => draftMessagesStore.getRecord(key())) : null;
	});
	const available = $derived(saved?.editing?.id === options.message().id);
	const warning = $derived(available && saved?.editing?.baseVersion !== commonStore.snapshots.get(options.message().convId)?.version
		? 'The conversation changed since this edit draft was saved. Review it. Copy needed text, discard this saved edit, then reopen the current message before submission.' : '');

	function begin(): void {
		const message = options.message();
		const existing = draftMessagesStore.getRecord(key());
		if (existing.editing && existing.editing.id !== message.id) throw new Error('Another message has a retained edit draft in this conversation. Restore or discard that draft first.');
		baseVersion = commonStore.snapshots.get(message.convId)?.version ?? null;
		if (existing.editing?.id === message.id) restore();
	}
	function restore(): void {
		const message = options.message(), draft = draftMessagesStore.getRecord(key());
		if (draft.editing?.id !== message.id || draft.editing.parentId !== message.parent) throw new Error('The saved edit has a different target. It was not moved or submitted.');
		const files = draftMessagesStore.getDraftMessage(key()).files;
		const extras = files.flatMap((file) => (file.commonAttachments ?? []).map((ref) => attachmentExtra(ref, file.commonExisting === true)));
		baseVersion = draft.editing.baseVersion ?? null;
		options.setDraft(draft.text, extras);
	}
	function assertTarget(): void {
		const message = options.message(), snapshot = commonStore.snapshots.get(message.convId);
		if (commonStore.activeId !== message.convId || !snapshot?.messages.some((item) => item.id === message.id && item.parentId === message.parent)
			|| baseVersion !== snapshot.version) throw new Error('The conversation or edit version changed. Copy needed text, discard the retained edit, then reopen the current message and review it before submission.');
	}
	function discard(): void { draftMessagesStore.clearDraftMessage(key()); baseVersion = null; }
	function acknowledged(): void { discard(); }
	$effect(() => {
		if (!ready || !options.isEditing() || baseVersion === null) return;
		const message = options.message(), text = options.content(), extras = options.extras(), files = options.files();
		const version = baseVersion;
		untrack(() => {
			const refs = extras.filter((extra) => extra.commonId).map((extra) => ({ id: extra.commonId!, name: extra.name,
				existing: true, mime: extra.commonMime, size: extra.size }));
			refs.push(...files.flatMap((file) => (file.commonAttachments ?? []).map((ref) => ({ id: ref.id, name: ref.name,
				existing: file.commonExisting === true, mime: ref.mime, size: ref.size }))));
			draftMessagesStore.saveRecord(key(), { text, attachments: refs, editing: { id: message.id, parentId: message.parent, baseVersion: version }, retry: null });
		});
	});
	return { begin, restore, assertTarget, discard, acknowledged,
		get available() { return available; }, get warning() { return warning; } };
}
