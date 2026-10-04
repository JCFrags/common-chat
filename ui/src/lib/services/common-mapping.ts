import { AttachmentType, MessageRole, ReasoningEffort, ToolSource } from '$lib/enums';
import type { CommonAttachment, CommonConversation, CommonSnapshot } from '$lib/types/common-api';
import type { DatabaseConversation, DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { ChatMessageTimings } from '$lib/types/chat';

const textCache = new Map<string, string>();
export function attachmentUrl(id: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
		throw new Error('Invalid Common attachment reference. Remove it and upload the file again.');
	}
	return `/api/attachments/${id}`;
}
export function rememberAttachmentText(id: string, text: string): void { textCache.set(id, text); }
export function forgetAttachmentText(): void { textCache.clear(); }

export function attachmentExtra(file: CommonAttachment, existing = true): DatabaseMessageExtra {
	const ref = { commonId: file.id, commonUrl: attachmentUrl(file.id), commonMime: file.mime,
		commonExisting: existing, name: file.name, size: file.size };
	if (file.kind === 'image') return { ...ref, type: AttachmentType.IMAGE, base64Url: ref.commonUrl };
	if (file.kind === 'audio') return { ...ref, type: AttachmentType.AUDIO, base64Data: '', mimeType: file.mime };
	if (file.kind === 'video') return { ...ref, type: AttachmentType.VIDEO, base64Data: '', mimeType: file.mime };
	return { ...ref, type: AttachmentType.TEXT, content: textCache.get(file.id) ?? '' };
}

export async function hydrateTextAttachments(snapshot: CommonSnapshot): Promise<void> {
	const files = snapshot.messages.flatMap((m) => m.attachments).filter((a) => a.kind === 'text' && !textCache.has(a.id));
	await Promise.all(files.map(async (a) => {
		const response = await fetch(attachmentUrl(a.id), { credentials: 'same-origin', cache: 'no-store' });
		if (!response.ok) throw new Error(`Could not read attachment "${a.name}" (${response.status}).`);
		textCache.set(a.id, await response.text());
	}));
}

export function conversationRow(row: CommonConversation | CommonSnapshot): DatabaseConversation {
	return {
		id: row.id, name: row.title, currNode: 'activeLeaf' in row ? row.activeLeaf : null,
		lastModified: row.updatedAt, version: row.version, running: row.running,
		settings: 'settings' in row ? row.settings : undefined,
		pinned: row.ui?.pinned, thinkingEnabled: row.ui?.thinkingEnabled,
		reasoningEffort: row.ui?.reasoningEffort as ReasoningEffort | undefined,
		disabledTools: row.ui?.disabledTools,
		disabledToolCategories: row.ui?.disabledToolCategories as ToolSource[] | undefined,
		forkedFromConversationId: row.ui?.forkedFromConversationId
	};
}

export function snapshotMessages(snapshot: CommonSnapshot): DatabaseMessage[] {
	const children = new Map<string, string[]>();
	for (const message of snapshot.messages) {
		if (message.parentId) children.set(message.parentId, [...(children.get(message.parentId) ?? []), message.id]);
	}
	return snapshot.messages.map((message) => ({
		id: message.id, convId: message.conversationId, parent: message.parentId,
		children: children.get(message.id) ?? [], timestamp: message.createdAt,
		role: message.role as MessageRole, type: message.role === 'system' ? 'system' : 'text',
		content: message.content, reasoningContent: message.reasoning,
		model: message.model ?? undefined, providerId: message.providerId,
		status: message.status, common: message,
		timings: message.metadata.timings as ChatMessageTimings | undefined,
		extra: message.attachments.map((file) => attachmentExtra(file))
	}));
}

/** Derive the exact active ancestry. Common has no fake IndexedDB root message. */
export function activePath(snapshot: CommonSnapshot, messages = snapshotMessages(snapshot)): DatabaseMessage[] {
	if (!snapshot.activeLeaf) return [];
	const byId = new Map(messages.map((m) => [m.id, m]));
	const path: DatabaseMessage[] = [], seen = new Set<string>();
	let id: string | null = snapshot.activeLeaf;
	while (id) {
		if (seen.has(id)) throw new Error('Saved conversation contains a cyclic branch. Reload it.');
		seen.add(id);
		const message = byId.get(id);
		if (!message) throw new Error('Saved branch is incomplete. Reload the authoritative conversation.');
		path.unshift(message);
		id = message.parent;
	}
	return path;
}
