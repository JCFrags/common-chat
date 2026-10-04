import { filterFilesByModalities, isFileTypeSupported } from '$lib/utils';
import { uploadCommonFile, removeUnattachedUpload } from '$lib/services/common-upload';
import { commonStore } from '$lib/stores/common.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { toast } from 'svelte-sonner';
import type { ChatUploadedFile } from '$lib/types/chat';

interface UseChatScreenFileUploadOptions {
	capabilities: () => { hasVision: boolean; hasAudio: boolean; hasVideo: boolean };
	activeModelId: () => string | null | undefined;
}
export interface FileErrorData {
	generallyUnsupported: File[];
	modalityUnsupported: File[];
	modalityReasons: Record<string, string>;
	supportedTypes: string[];
}

export function useChatScreenFileUpload(options: UseChatScreenFileUploadOptions) {
	let uploadedFiles = $state<ChatUploadedFile[]>([]);
	let showFileErrorDialog = $state(false);
	let fileErrorData = $state<FileErrorData>({ generallyUnsupported: [], modalityReasons: {}, modalityUnsupported: [], supportedTypes: [] });

	async function handleFileUpload(files: File[]) {
		const generallyUnsupported = files.filter((file) => !isFileTypeSupported(file.name, file.type));
		const supported = files.filter((file) => isFileTypeSupported(file.name, file.type));
		const caps = options.capabilities(), model = options.activeModelId() ?? undefined;
		const { modalityReasons, supportedFiles, unsupportedFiles } = filterFilesByModalities(supported, caps);
		if (generallyUnsupported.length || unsupportedFiles.length) {
			fileErrorData = { generallyUnsupported, modalityReasons, modalityUnsupported: unsupportedFiles,
				supportedTypes: ['UTF-8 text', 'PDF text', ...(caps.hasVision ? ['images', 'PDF pages'] : []),
					...(caps.hasAudio ? ['WAV/MP3/FLAC audio'] : []), ...(caps.hasVideo ? ['MP4/WebM video'] : [])] };
			showFileErrorDialog = true;
		}
		if (!supportedFiles.length) return;
		if (conversationsStore.missingConversationId) { toast.error('Open an available conversation before uploading. The old draft stays saved.'); return; }
		const original = commonStore.activeId;
		const placeholders = supportedFiles.map((file): ChatUploadedFile => ({ id: crypto.randomUUID(), file,
			name: file.name, size: file.size, type: file.type, isLoading: true }));
		uploadedFiles = [...uploadedFiles, ...placeholders];
		draftMessagesStore.saveDraftMessage(original ?? undefined, draftMessagesStore.getRecord(original).text, uploadedFiles);
		let cid: string;
		try { cid = original ?? await conversationsStore.createConversation('New chat'); }
		catch (error) {
			toast.error(error instanceof Error ? error.message : 'Could not create an upload target.');
			uploadedFiles = uploadedFiles.map((file) => placeholders.some((p) => p.id === file.id) ? { ...file, isLoading: false, loadError: 'Upload did not complete. Remove the file and upload again.' } : file);
			return;
		}
		for (const placeholder of placeholders) {
			try {
				const uploaded = await uploadCommonFile(placeholder.file, cid, model);
				const current = draftMessagesStore.getDraftMessage(cid).files;
				if (!current.some((file) => file.id === placeholder.id)) {
					await Promise.all((uploaded.commonAttachments ?? []).map((ref) => removeUnattachedUpload(ref.id)));
					continue;
				}
				const next = current.map((file) => file.id === placeholder.id ? uploaded : file);
				draftMessagesStore.updateFiles(cid, next);
				if (commonStore.activeId === cid) uploadedFiles = next;
			} catch (error) {
				const problem = error instanceof Error ? error.message : String(error);
				const next = draftMessagesStore.getDraftMessage(cid).files.map((file) => file.id === placeholder.id ? { ...file, isLoading: false, loadError: problem } : file);
				draftMessagesStore.updateFiles(cid, next);
				if (commonStore.activeId === cid) uploadedFiles = next;
				toast.error(`Could not upload "${placeholder.name}": ${problem}`);
			}
		}
	}

	function handleFileRemove(fileId: string) {
		const file = uploadedFiles.find((item) => item.id === fileId);
		uploadedFiles = uploadedFiles.filter((item) => item.id !== fileId);
		if (file && file.commonExisting !== true) {
			void Promise.all((file.commonAttachments ?? []).map((ref) => removeUnattachedUpload(ref.id))).catch((error) => toast.warning(error.message));
		}
	}
	return {
		get fileErrorData() { return fileErrorData; }, handleFileRemove, handleFileUpload,
		get showFileErrorDialog() { return showFileErrorDialog; }, set showFileErrorDialog(value) { showFileErrorDialog = value; },
		get uploadedFiles() { return uploadedFiles; }, set uploadedFiles(value) { uploadedFiles = value; }
	};
}
