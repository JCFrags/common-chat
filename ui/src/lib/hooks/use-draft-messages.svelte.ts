import { afterNavigate, beforeNavigate } from '$app/navigation';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { DRAFT_LOGOUT_KEY } from '$lib/services/common-drafts';
import { commonStore } from '$lib/stores/common.svelte';
import { onMount, untrack } from 'svelte';

interface UseDraftMessagesOptions {
	getChatId: () => string | undefined;
	getMessage: () => string;
	getFiles: () => ChatUploadedFile[];
	setMessage: (message: string) => void;
	setFiles: (files: ChatUploadedFile[]) => void;
	getInitialMessage: () => string;
}

export function useDraftMessages(options: UseDraftMessagesOptions) {
	let ready = $state(false);
	let currentId: string | undefined;
	function restore(id?: string) {
		currentId = id;
		const draft = draftMessagesStore.getDraftMessage(id);
		options.setMessage(draft.message || options.getInitialMessage());
		options.setFiles(draft.files);
		void draftMessagesStore.verifyAttachments(id);
	}
	onMount(() => {
		restore(options.getChatId()); ready = true;
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (draftMessagesStore.hasUnsaved || draftMessagesStore.fileWarning) { event.preventDefault(); event.returnValue = ''; }
		};
		const storage = (event: StorageEvent) => {
			if (event.key !== DRAFT_LOGOUT_KEY) return;
			draftMessagesStore.forget(); options.setMessage(''); options.setFiles([]); commonStore.signedOut();
		};
		window.addEventListener('beforeunload', beforeUnload);
		window.addEventListener('storage', storage);
		return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('storage', storage); };
	});
	// Save changed input, not events or refreshed snapshots. The storage adapter skips unchanged writes.
	$effect(() => {
		if (!ready) return;
		const id = options.getChatId(), message = options.getMessage(), files = options.getFiles();
		untrack(() => {
			if (id === currentId) draftMessagesStore.saveDraftMessage(id, message, files);
		});
	});
	$effect(() => {
		const update = draftMessagesStore.draftUpdate;
		if (!ready || !update) return;
		untrack(() => {
			if ((options.getChatId() ?? 'new') === update.key) options.setMessage(draftMessagesStore.getRecord(options.getChatId()).text);
		});
	});
	$effect(() => {
		const update = draftMessagesStore.uploadUpdate;
		if (!ready || !update) return;
		untrack(() => {
			if ((options.getChatId() ?? 'new') === update.key) options.setFiles(draftMessagesStore.getDraftMessage(options.getChatId()).files);
		});
	});
	$effect(() => {
		const acknowledged = draftMessagesStore.acknowledgement;
		if (!acknowledged) return;
		untrack(() => {
			if ((options.getChatId() ?? 'new') !== acknowledged.key || options.getMessage() !== acknowledged.draft.text) return;
			const ids = options.getFiles().flatMap((f) => f.commonAttachments ?? []).map((a) => a.id);
			if (ids.join('|') !== acknowledged.draft.attachments.map((a) => a.id).join('|')) return;
			options.setMessage(''); options.setFiles([]);
		});
	});
	beforeNavigate((navigation) => {
		// Creation already moved this exact draft. Do not recreate the old new-chat key.
		if (currentId === undefined && navigation.to?.params?.id === draftMessagesStore.migratedNewTarget) return;
		if (ready) draftMessagesStore.saveDraftMessage(currentId, options.getMessage(), options.getFiles());
	});
	afterNavigate((navigation) => {
		if (navigation?.from != null && options.getChatId() !== currentId) restore(options.getChatId());
		if (options.getChatId() === draftMessagesStore.migratedNewTarget) draftMessagesStore.migratedNewTarget = null;
	});
	return { clearDraft() { draftMessagesStore.clearDraftMessage(options.getChatId()); } };
}
