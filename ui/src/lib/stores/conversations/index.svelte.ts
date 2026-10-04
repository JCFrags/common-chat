/** Upstream conversation interface backed by authoritative Common snapshots. */
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { ROUTES } from '$lib/constants';
import { ConversationTransferService } from '$lib/services/conversation-transfer.service';
import { DatabaseService } from '$lib/services/database.service';
import { CommonApiError } from '$lib/services/common-api';
import { activePath, conversationRow, snapshotMessages } from '$lib/services/common-mapping';
import { RouterService } from '$lib/services/router.service';
import { commonStore } from '$lib/stores/common.svelte';
import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
import { ConversationPreferences, type ConversationsPreferencesHost } from './preferences.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import type { CommonSnapshot } from '$lib/types/common-api';
import type { DatabaseConversation, DatabaseMessage, ExportedConversation, ExportedConversations } from '$lib/types/database';
import { findLeafNode, generateConversationTitle } from '$lib/utils';
import { toast } from 'svelte-sonner';

class ConversationsStore implements ConversationsPreferencesHost {
	activeConversation = $state<DatabaseConversation | null>(null);
	activeMessages = $state<DatabaseMessage[]>([]);
	conversations = $state<DatabaseConversation[]>([]);
	isInitialized = $state(false);
	missingConversationId = $state<string | null>(null);
	private _preferences = new ConversationPreferences(this);
	private listeners = new Set<(ids: string[]) => void>();
	private lastLoadedMessages: { convId: string; messages: DatabaseMessage[] } | null = null;
	private loadingTarget: string | null = null;

	constructor() {
		commonStore.subscribe((change) => {
			if (change.type === 'snapshot') {
				this.conversations = commonStore.conversations.map(conversationRow);
				if (commonStore.activeId === change.snapshot.id) this.applySnapshot(change.snapshot);
			} else if (change.type === 'list') this.conversations = commonStore.conversations.map(conversationRow);
			else if (change.type === 'deleted') {
				this.conversations = this.conversations.filter((c) => c.id !== change.id);
				if (commonStore.activeId === change.id) this.markMissing(change.id);
				for (const listener of this.listeners) listener([change.id]);
			} else if (change.type === 'signed-out') {
				this.activeConversation = null; this.activeMessages = []; this.conversations = []; this.isInitialized = false;
			}
		});
	}

	get preferences() { return this._preferences; }
	private applySnapshot(snapshot: CommonSnapshot): void {
		const row = conversationRow(snapshot), all = snapshotMessages(snapshot);
		let path: DatabaseMessage[];
		try { path = activePath(snapshot, all); }
		catch (error) { commonStore.connectionError = error instanceof Error ? error.message : String(error); return; }
		this.lastLoadedMessages = { convId: snapshot.id, messages: all };
		if (this.activeConversation?.id === snapshot.id) Object.assign(this.activeConversation, row);
		else this.activeConversation = row;
		this.activeMessages = path;
		this.missingConversationId = null;
		draftMessagesStore.setTargetWarning(snapshot.id, '');
	}

	private markMissing(id: string): void {
		this.activeConversation = null; this.activeMessages = []; this.missingConversationId = id;
		draftMessagesStore.getDraftMessage(id);
		draftMessagesStore.setTargetWarning(id, 'This conversation is unavailable. Its device draft stays at the old address. Copy needed text to a new chat.');
	}

	applyConversationUpdate(id: string, updates: Partial<DatabaseConversation>): void {
		const row = this.conversations.find((c) => c.id === id);
		if (row) Object.assign(row, updates);
		if (this.activeConversation?.id === id) Object.assign(this.activeConversation, updates);
	}
	async applyTitleFromContent(id: string, content: string): Promise<void> {
		await this.updateConversationName(id, generateConversationTitle(content, Boolean(settingsStore.config.titleGenerationUseFirstLine)));
	}
	async initialize(): Promise<void> {
		if (!browser) return;
		await commonStore.initialize();
		if (!commonStore.session?.authenticated) return;
		await this.loadConversations(); this.isInitialized = true;
	}
	async loadConversations(): Promise<void> { this.conversations = await DatabaseService.getAllConversations(); }
	async loadConversation(id: string): Promise<boolean> {
		this.loadingTarget = id;
		commonStore.setActive(id);
		draftMessagesStore.getDraftMessage(id);
		try {
			const snapshot = await commonStore.refreshConversation(id);
			if (this.loadingTarget !== id || commonStore.activeId !== id) return false;
			this.preferences.pendingCwd = null;
			this.applySnapshot(snapshot);
			const all = await DatabaseService.getConversationMessages(id);
			if (commonStore.activeId !== id) return false;
			this.lastLoadedMessages = { convId: id, messages: all };
			this.activeMessages = activePath(commonStore.snapshots.get(id) ?? snapshot, all);
			void draftMessagesStore.verifyAttachments(id);
			return true;
		} catch (error) {
			if (this.loadingTarget !== id) return false;
			if (error instanceof CommonApiError && error.status === 404) this.markMissing(id);
			else commonStore.connectionError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}
	async createConversation(name = 'New chat'): Promise<string> {
		const row = await DatabaseService.createConversation(name, {
			reasoningEffort: this.preferences.pendingReasoningEffort,
			...this.preferences.getToolPolicySnapshot()
		});
		draftMessagesStore.migrateNew(row.id);
		commonStore.setActive(row.id);
		this.applySnapshot(commonStore.snapshots.get(row.id)!);
		await goto(RouterService.chat(row.id));
		return row.id;
	}
	clearActiveConversation(): void {
		this.loadingTarget = null; commonStore.setActive(null);
		this.activeConversation = null; this.activeMessages = []; this.missingConversationId = null;
		this.preferences.resetPending();
	}
	async openNewChat(): Promise<void> { this.clearActiveConversation(); await goto(ROUTES.START); }
	consumeLastLoadedMessages(id: string): DatabaseMessage[] | null {
		if (this.lastLoadedMessages?.convId !== id) return null;
		const all = this.lastLoadedMessages.messages; this.lastLoadedMessages = null; return all;
	}
	getConversationMessages(id: string): Promise<DatabaseMessage[]> { return DatabaseService.getConversationMessages(id); }
	async refreshActiveMessages(): Promise<void> {
		const id = this.activeConversation?.id;
		if (!id) return;
		const snapshot = await commonStore.refreshConversation(id);
		if (commonStore.activeId === id) this.applySnapshot(snapshot);
	}
	async updateCurrentNode(nodeId: string): Promise<void> {
		const id = this.activeConversation?.id; if (!id) return;
		await DatabaseService.updateCurrentNode(id, nodeId);
	}
	async navigateToSibling(siblingId: string): Promise<void> {
		const id = this.activeConversation?.id; if (!id) return;
		const all = await this.getConversationMessages(id);
		if (!all.some((m) => m.id === siblingId)) throw new Error('The selected branch is unavailable. Reload the conversation.');
		await DatabaseService.updateCurrentNode(id, findLeafNode(all, siblingId));
	}
	async updateConversationName(id: string, name: string): Promise<void> {
		try { await DatabaseService.updateConversation(id, { name }); }
		catch (error) { toast.error(error instanceof Error ? error.message : 'Could not rename conversation.'); }
	}
	async toggleConversationPin(id: string): Promise<boolean> {
		try { return await DatabaseService.toggleConversationPin(id); }
		catch (error) { toast.error(error instanceof Error ? error.message : 'Could not pin conversation.'); return false; }
	}
	async bulkToggleConversationPin(ids: string[]): Promise<void> {
		for (const id of ids) await this.toggleConversationPin(id);
	}
	async deleteConversation(id: string, options?: { deleteWithForks?: boolean }): Promise<void> {
		try {
			const before = this.conversations.map((c) => c.id);
			await DatabaseService.deleteConversation(id, options);
			await this.loadConversations();
			const removed = before.filter((key) => !this.conversations.some((c) => c.id === key));
			for (const listener of this.listeners) listener(removed);
			tabsStore.removeTabs(removed);
			if (commonStore.activeId && removed.includes(commonStore.activeId)) { this.clearActiveConversation(); await goto(ROUTES.START); }
		} catch (error) { toast.error(error instanceof Error ? error.message : 'Could not delete conversation.'); }
	}
	async bulkDeleteConversations(ids: string[]): Promise<void> { for (const id of ids) await this.deleteConversation(id); }
	async deleteAll(): Promise<void> { await this.bulkDeleteConversations(this.conversations.map((c) => c.id)); }
	async forkConversation(messageId: string, options: { name: string; includeAttachments: boolean }): Promise<string | null> {
		const id = this.activeConversation?.id; if (!id) return null;
		try {
			const row = await DatabaseService.forkConversation(id, messageId, options);
			await this.loadConversation(row.id); await goto(RouterService.chat(row.id)); return row.id;
		} catch (error) { toast.error(error instanceof Error ? error.message : 'Could not fork conversation.'); return null; }
	}
	onConversationsDeleted(listener: (ids: string[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	async getConversationsForExport(ids: string[]): Promise<ExportedConversation[]> {
		const result = await DatabaseService.getConversationsWithMessages(ids);
		return ids.map((id) => result.get(id)).filter((entry): entry is ExportedConversation => !!entry);
	}
	async downloadConversation(id: string): Promise<void> {
		const [data] = await this.getConversationsForExport([id]);
		if (data) ConversationTransferService.downloadConversationFile(data);
	}
	async bulkExportConversations(ids: string[]): Promise<void> {
		ConversationTransferService.downloadConversationsArchive(await this.getConversationsForExport(ids));
	}
	async importConversationsData(data: ExportedConversations) {
		const result = await DatabaseService.importConversations(Array.isArray(data) ? data : [data]);
		await this.loadConversations(); return result;
	}
	findMessageIndex(id: string): number { return this.activeMessages.findIndex((m) => m.id === id); }
	// Display-only compatibility. No caller may use these to grant server authority.
	addMessageToActive(message: DatabaseMessage): void { this.activeMessages.push(message); }
	updateMessageAtIndex(index: number, updates: Partial<DatabaseMessage>): void {
		if (this.activeMessages[index]) Object.assign(this.activeMessages[index], updates);
	}
	removeMessageAtIndex(index: number): DatabaseMessage | undefined { return index < 0 ? undefined : this.activeMessages.splice(index, 1)[0]; }
	sliceActiveMessages(index: number): void { this.activeMessages = this.activeMessages.slice(0, index); }
	updateConversationTimestamp(_id?: string): void { void this.loadConversations(); }
}

export const conversationsStore = new ConversationsStore();
