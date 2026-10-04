/** Store-compatible Common adapter. SQLite is the only authoritative chat history. */
import { api, CommonApiError } from './common-api';
import { conversationRow, hydrateTextAttachments, snapshotMessages } from './common-mapping';
import { commonStore } from '$lib/stores/common.svelte';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import type { CommonSnapshot, CommonUI } from '$lib/types/common-api';
import type { DatabaseConversation, DatabaseMessage, ExportedConversation } from '$lib/types/database';
import { toast } from 'svelte-sonner';

const route = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
const uiKeys = ['pinned', 'thinkingEnabled', 'reasoningEffort', 'disabledTools', 'disabledToolCategories', 'forkedFromConversationId'] as const;
function uiFields(value: Partial<DatabaseConversation>): CommonUI {
	return Object.fromEntries(uiKeys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export class DatabaseService {
	static async snapshot(id: string): Promise<CommonSnapshot> {
		return commonStore.snapshots.get(id) ?? await commonStore.refreshConversation(id);
	}
	static async bulkDeleteConversations(ids: string[]): Promise<void> {
		for (const id of new Set(ids)) await this.deleteConversation(id);
	}
	static async bulkToggleConversationPins(ids: string[]): Promise<Map<string, boolean>> {
		const result = new Map<string, boolean>();
		for (const id of new Set(ids)) result.set(id, await this.toggleConversationPin(id));
		return result;
	}
	static async createConversation(name: string, fields?: Partial<DatabaseConversation>): Promise<DatabaseConversation> {
		const snapshot = await api<CommonSnapshot>('/api/conversations', 'POST', { title: name, ui: uiFields(fields ?? {}) });
		commonStore.acceptSnapshot(snapshot);
		return conversationRow(snapshot);
	}
	static async createMessageBranch(message: Omit<DatabaseMessage, 'id' | 'parent' | 'model'> & { parent?: string | null; model?: string | null }, parentId: string | null): Promise<DatabaseMessage> {
		if (!['system', 'user', 'assistant'].includes(message.role)) throw new Error('Common tools are server-owned. Browser tool result messages are disabled.');
		const snapshot = await this.snapshot(message.convId);
		const attachments = (message.extra ?? []).map((extra) => {
			if (!extra.commonId) throw new Error('Upload this attachment to Common before saving it.');
			return extra.commonId;
		});
		const result = await this.mutate(message.convId, '/messages', 'POST', {
			expectedVersion: snapshot.version, parentId, role: message.role,
			content: message.content, reasoning: message.reasoningContent, attachments
		});
		const id = result.activeLeaf;
		const created = snapshotMessages(result).find((m) => m.id === id);
		if (!created) throw new Error('The saved message is missing from the server snapshot. Reload the conversation.');
		return created;
	}
	static async createRootMessage(_id: string): Promise<string> {
		throw new Error('Common does not create synthetic browser history roots.');
	}
	static async createSystemMessage(id: string, content: string, parentId: string | null): Promise<DatabaseMessage> {
		return this.createMessageBranch({ convId: id, content, parent: parentId, children: [], timestamp: Date.now(), role: 'system', type: 'system' }, parentId);
	}
	static async deleteConversation(id: string, options?: { deleteWithForks?: boolean }): Promise<void> {
		if (options?.deleteWithForks) {
			await commonStore.refreshList();
			for (const row of commonStore.conversations.filter((c) => c.ui?.forkedFromConversationId === id)) {
				await this.deleteConversation(row.id, options);
			}
		}
		const snapshot = await this.snapshot(id);
		await api(route(id), 'DELETE', { expectedVersion: snapshot.version });
		commonStore.snapshots.delete(id);
		commonStore.conversations = commonStore.conversations.filter((c) => c.id !== id);
		draftMessagesStore.clearDraftMessage(id);
	}
	static async deleteMessage(id: string): Promise<void> {
		const found = this.findMessage(id);
		if (!found) throw new Error('Message is unavailable. Reload its conversation.');
		await this.deleteMessageCascading(found.snapshot.id, id);
	}
	static async deleteMessageCascading(id: string, messageId: string): Promise<string[]> {
		const before = await this.snapshot(id);
		const after = await this.mutate(id, `/messages/${encodeURIComponent(messageId)}`, 'DELETE', { expectedVersion: before.version });
		return before.messages.filter((m) => !after.messages.some((n) => n.id === m.id)).map((m) => m.id);
	}
	static async forkConversation(id: string, messageId: string, options: { name: string; includeAttachments: boolean }): Promise<DatabaseConversation> {
		const source = await this.snapshot(id);
		const snapshot = await this.mutate(id, '/fork', 'POST', { expectedVersion: source.version, messageId, title: options.name });
		const warnings = (snapshot as CommonSnapshot & { warnings?: string[] }).warnings;
		if (warnings?.length) toast.warning(warnings.join(' '));
		if (!options.includeAttachments) toast.info('Common forks copy saved branch files. Workspace state and tool execution authority are not copied.');
		return conversationRow(snapshot);
	}
	static async getAllConversations(): Promise<DatabaseConversation[]> {
		await commonStore.refreshList();
		return commonStore.conversations.map(conversationRow);
	}
	static async getConversation(id: string): Promise<DatabaseConversation | undefined> {
		try { return conversationRow(await commonStore.refreshConversation(id)); }
		catch (error) { if (error instanceof CommonApiError && error.status === 404) return undefined; throw error; }
	}
	static async getConversationMessages(id: string): Promise<DatabaseMessage[]> {
		const snapshot = await this.snapshot(id);
		await hydrateTextAttachments(snapshot).catch((error) => { toast.warning(error.message); });
		return snapshotMessages(snapshot);
	}
	static async getConversationsWithMessages(ids: string[]): Promise<Map<string, ExportedConversation>> {
		const result = new Map<string, ExportedConversation>();
		for (const id of ids) {
			const snapshot = await this.snapshot(id);
			const native = await api(`${route(id)}/export`);
			result.set(id, { conv: conversationRow(snapshot), messages: [], commonExport: native });
		}
		return result;
	}
	static async importConversations(data: ExportedConversation[]): Promise<{ imported: DatabaseConversation[]; skipped: DatabaseConversation[] }> {
		const nativeEntries = data.filter((entry) => entry.commonExport);
		if (nativeEntries.length && nativeEntries.length !== data.length) throw new Error('Import Common and upstream archives separately so neither format loses metadata.');
		const native = nativeEntries.length ? { format: 'common-chat', version: 1,
			conversations: nativeEntries.flatMap((entry) => (entry.commonExport as { conversations: unknown[] }).conversations) } : data;
		const result = await api<{ conversationIds: string[]; warnings?: string[] }>('/api/import', 'POST', { text: JSON.stringify(native) });
		if (result.warnings?.length) toast.warning(result.warnings.join(' '));
		await commonStore.refreshList();
		return { imported: commonStore.conversations.filter((c) => result.conversationIds.includes(c.id)).map(conversationRow), skipped: [] };
	}
	static async toggleConversationPin(id: string): Promise<boolean> {
		const snapshot = await this.snapshot(id);
		const pinned = !snapshot.ui?.pinned;
		await this.updateConversation(id, { pinned });
		return pinned;
	}
	static async updateConversation(id: string, updates: Partial<Omit<DatabaseConversation, 'id'>>): Promise<void> {
		if (updates.cwd !== undefined || updates.mcpServerOverrides !== undefined) {
			throw new Error('Browser MCP and host working directories cannot run in Common. Use Files and the isolated Run panel.');
		}
		const snapshot = await this.snapshot(id);
		const ui = { ...snapshot.ui, ...uiFields(updates) };
		await this.mutate(id, '', 'PATCH', { expectedVersion: snapshot.version,
			...(updates.name !== undefined ? { title: updates.name } : {}),
			...(updates.currNode !== undefined ? { activeLeaf: updates.currNode } : {}),
			...(updates.settings !== undefined ? { settings: updates.settings } : {}), ui });
	}
	static async updateCurrentNode(id: string, nodeId: string): Promise<void> {
		await this.updateConversation(id, { currNode: nodeId });
	}
	static async updateMessage(id: string, updates: Partial<Omit<DatabaseMessage, 'id'>>): Promise<void> {
		const found = this.findMessage(id);
		if (!found) throw new Error('Message is unavailable. Reload its conversation.');
		if (updates.parent !== undefined || updates.children !== undefined || updates.toolCalls !== undefined || updates.toolCallId !== undefined) {
			throw new Error('Common owns branch structure and tool authority. Browser graph updates are disabled.');
		}
		const attachments = updates.extra?.map((extra) => {
			if (!extra.commonId) throw new Error('Upload this attachment to Common before saving it.');
			return extra.commonId;
		});
		await this.mutate(found.snapshot.id, `/messages/${encodeURIComponent(id)}`, 'PATCH', {
			expectedVersion: found.snapshot.version, content: updates.content ?? found.message.content,
			reasoning: updates.reasoningContent ?? found.message.reasoning,
			...(attachments !== undefined ? { attachments } : {})
		});
	}
	private static findMessage(id: string) {
		for (const snapshot of commonStore.snapshots.values()) {
			const message = snapshot.messages.find((m) => m.id === id);
			if (message) return { snapshot, message };
		}
		return null;
	}
	private static async mutate(id: string, action: string, method: string, body: unknown): Promise<CommonSnapshot> {
		try {
			const result = await api<CommonSnapshot>(route(id) + action, method, body);
			return commonStore.acceptSnapshot(result);
		} catch (error) {
			if (error instanceof CommonApiError && error.status === 409) {
				await commonStore.refreshConversation(id);
				throw new Error('The conversation changed or is busy. Saved state was refreshed. Review the target before trying again.');
			}
			throw error;
		}
	}
}
