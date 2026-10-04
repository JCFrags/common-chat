import { api } from '$lib/services/common-api';
import { attachmentUrl, rememberAttachmentText } from '$lib/services/common-mapping';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import type { CommonAttachment } from '$lib/types/common-api';
import type { ChatUploadedFile } from '$lib/types/chat';
import { convertPDFToImage, convertPDFToText } from '$lib/utils/pdf-processing';
import { processFilesToChatUploaded } from '$lib/utils/process-uploaded-files';
import { getFileTypeCategory } from '$lib/utils/file-type';
import { FileTypeCategory } from '$lib/enums';

const mimeByExtension: Record<string, string> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
	svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
	wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm'
};
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/wav',
	'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac', 'video/mp4', 'video/webm']);

function dataUrl(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error('Could not read attachment bytes.'));
		reader.readAsDataURL(file);
	});
}

async function upload(cid: string, name: string, mime: string, data: string, text?: string): Promise<CommonAttachment> {
	const ref = await api<CommonAttachment>(`/api/conversations/${encodeURIComponent(cid)}/attachments`, 'POST', { name, mime, data });
	attachmentUrl(ref.id);
	if (text !== undefined) rememberAttachmentText(ref.id, text);
	return ref;
}

/** Upload media without transcoding. Common validates signatures and probes media on the server. */
export async function uploadCommonFile(file: File, cid: string, modelId?: string): Promise<ChatUploadedFile> {
	const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
	const mime = file.type || mimeByExtension[extension] || 'text/plain';
	const normalized = file.type ? file : new File([file], file.name, { type: mime });
	const refs: CommonAttachment[] = [];
	let textContent: string | undefined;
	try {
		if (mime === 'application/pdf') {
			const asImages = settingsStore.config.pdfAsImage === true && !!modelId && modelsStore.props.modelSupportsVision(modelId);
			if (asImages) {
				const pages = await convertPDFToImage(normalized);
				if (!pages.length) throw new Error('The PDF has no pages.');
				for (const [index, page] of pages.entries()) refs.push(await upload(cid, `${file.name} page ${index + 1}.png`, 'image/png', page.split(',')[1]));
			} else {
				textContent = await convertPDFToText(normalized);
				if (!textContent.trim()) throw new Error('The PDF has no extracted text. Use PDF as images with a vision connection.');
				refs.push(await upload(cid, `${file.name}.txt`, 'text/plain', (await dataUrl(new Blob([textContent]))).split(',')[1], textContent));
			}
		} else if (['image/svg+xml', 'image/heic', 'image/heif'].includes(mime)) {
			const processed = (await processFilesToChatUploaded([normalized], modelId))[0];
			if (!processed?.preview || !/^data:image\/(png|jpeg);base64,/.test(processed.preview)) throw new Error('The image could not be converted to a supported format.');
			refs.push(await upload(cid, file.name, processed.preview.slice(5, processed.preview.indexOf(';')), processed.preview.split(',')[1]));
		} else if (mediaTypes.has(mime)) {
			refs.push(await upload(cid, file.name, mime, (await dataUrl(normalized)).split(',')[1]));
		} else {
			if (!(mime.startsWith('text/') || getFileTypeCategory(mime) === FileTypeCategory.TEXT || ['application/json', 'application/xml', 'application/javascript'].includes(mime))) {
				throw new Error(`Unsupported attachment format: ${mime}.`);
			}
			textContent = new TextDecoder('utf-8', { fatal: true }).decode(await normalized.arrayBuffer());
			if (textContent.includes('\0')) throw new Error('Text attachments cannot contain NUL bytes.');
			const textMime = mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime) ? mime : 'text/plain';
			refs.push(await upload(cid, file.name, textMime, (await dataUrl(normalized)).split(',')[1], textContent));
		}
		const first = refs[0];
		return { id: first.id, file: normalized, name: file.name, type: first.mime, size: file.size,
			preview: first.kind !== 'text' ? attachmentUrl(first.id) : undefined, textContent,
			commonAttachments: refs, commonExisting: false, isLoading: false };
	} catch (error) {
		// Only these newly uploaded, unattached references are eligible for removal.
		await Promise.all(refs.map((ref) => removeUnattachedUpload(ref.id)));
		throw error;
	}
}

export async function removeUnattachedUpload(id: string): Promise<void> {
	try { await api(attachmentUrl(id), 'DELETE', {}); }
	catch (error) {
		if (!(error && typeof error === 'object' && 'status' in error && [404, 409].includes(Number(error.status)))) throw error;
	}
}
