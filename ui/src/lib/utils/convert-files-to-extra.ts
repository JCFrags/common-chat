import { attachmentExtra } from '$lib/services/common-mapping';
import { uploadCommonFile } from '$lib/services/common-upload';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { commonStore } from '$lib/stores/common.svelte';
import type { ChatUploadedFile, DatabaseMessageExtra, FileProcessingResult } from '$lib/types';

/** Resolve typed server references. File bytes never enter authoritative browser history. */
export async function parseFilesToMessageExtras(files: ChatUploadedFile[], activeModelId?: string): Promise<FileProcessingResult> {
	const extras: DatabaseMessageExtra[] = [];
	if (!files.length) return { extras, emptyFiles: [] };
	if (conversationsStore.missingConversationId) throw new Error('The upload target is unavailable. Keep the retained draft at its original address.');
	const cid = commonStore.activeId ?? await conversationsStore.createConversation();
	for (const file of files) {
		if (file.isLoading || file.loadError) throw new Error(`"${file.name}" is not ready. ${file.loadError ?? 'Wait for the upload to finish.'}`);
		if (!file.commonAttachments?.length) {
			if (!file.file.size && !file.textContent) throw new Error(`"${file.name}" has no restored bytes. Upload it again.`);
			const bytes = file.textContent !== undefined ? new File([file.textContent], file.name, { type: 'text/plain' }) : file.file;
			const uploaded = await uploadCommonFile(bytes, cid, activeModelId);
			Object.assign(file, uploaded);
		}
		if (commonStore.activeId !== cid) throw new Error('The conversation changed during file upload. Return to the original draft before sending.');
		extras.push(...file.commonAttachments!.map((ref) => attachmentExtra(ref, file.commonExisting === true)));
	}
	return { extras, emptyFiles: [] };
}
