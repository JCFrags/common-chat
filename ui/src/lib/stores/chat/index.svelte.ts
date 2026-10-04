/** Native Common jobs behind the upstream chat interface. Navigation never cancels a job. */
import { SYSTEM_MESSAGE_PLACEHOLDER } from '$lib/constants';
import { ErrorDialogType, MessageRole, MessageType, StreamConnectionState } from '$lib/enums';
import { api, CommonApiError } from '$lib/services/common-api';
import { DatabaseService } from '$lib/services/database.service';
import type { CommonDraft } from '$lib/services/common-drafts';
import { commonStore } from '$lib/stores/common.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { settingsStore } from '$lib/stores/settings/index.svelte';
import { chatActivityStore } from './activity.svelte';
import { draftMessagesStore } from './drafts.svelte';
import { chatProcessingStore } from './processing.svelte';
import type { CommonGeneration, CommonReceipt, CommonSnapshot } from '$lib/types/common-api';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { ChatUploadedFile, ErrorDialogState } from '$lib/types/chat';
import { generationSettings } from '$lib/utils/common-settings';
import { confirmSelections } from '$lib/services/common-mcp.svelte';
import { findDescendantMessages, generateConversationTitle } from '$lib/utils';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';

class ChatStore {
	chatReasoningStates = new SvelteMap<string, boolean>();
	chatStreamingStates = new SvelteMap<string, { response: string; messageId: string; model?: string | null }>();
	errorDialogState = $state<ErrorDialogState | null>(null);
	pendingEditMessageId = $state<string | null>(null);
	streamConnectionState = $state<StreamConnectionState>(StreamConnectionState.STREAMING);
	isLoading = $derived(this.isChatLoading(conversationsStore.activeConversation?.id ?? ''));
	isReasoning = $derived(this.chatReasoningStates.get(conversationsStore.activeConversation?.id ?? '') ?? false);
	private submitting = new SvelteSet<string>();
	private reconciling = new Set<string>();
	private jobs = new SvelteMap<string, { id: string; messageId: string }>();
	private addFilesHandler: ((files: File[]) => void) | null = $state(null);
	private editing = $state(false);
	private pendingDraft: { message: string; files: ChatUploadedFile[] } | null = null;

	constructor() {
		commonStore.subscribe((change) => {
			if (change.type === 'snapshot') this.applySnapshot(change.snapshot);
			else if (change.type === 'list') this.activity.applyRemoteSnapshot(commonStore.conversations.filter((c) => c.running).map((c) => c.id));
			else if (change.type === 'reconnect') {
				for (const snapshot of commonStore.snapshots.values()) this.applySnapshot(snapshot);
				const id = commonStore.activeId;
				if (id) void this.reconcilePending(id);
			} else if (change.type === 'deleted') {
				this.jobs.delete(change.id); this.cleanupStreaming(change.id);
			} else if (change.type === 'signed-out') {
				this.jobs.clear(); this.chatStreamingStates.clear(); this.chatReasoningStates.clear();
				this.activity.applyRemoteSnapshot([]);
			}
		});
	}
	get activity() { return chatActivityStore; }
	get processing() { return chatProcessingStore; }

	private applySnapshot(snapshot: CommonSnapshot): void {
		const job = snapshot.activeJob;
		if (job) {
			this.jobs.set(snapshot.id, { id: job.id, messageId: job.messageId });
			this.activity.markLocal(snapshot.id);
			const message = snapshot.messages.find((m) => m.id === job.messageId);
			this.setChatStreaming(snapshot.id, message?.content ?? '', job.messageId, message?.model);
			this.setChatReasoning(snapshot.id, !!message?.reasoning && !message.content);
			const timings = message?.metadata.timings;
			if (timings && typeof timings === 'object') this.processing.applyStreamTimings(timings, message?.metadata.promptProgress as ChatMessagePromptProgress | undefined, snapshot.id);
		} else if (!this.submitting.has(snapshot.id)) {
			this.jobs.delete(snapshot.id); this.cleanupStreaming(snapshot.id);
		}
		this.streamConnectionState = commonStore.eventStatus === 'connected'
			? StreamConnectionState.STREAMING : StreamConnectionState.RESUMING;
	}

	getApiOptions(): Record<string, unknown> {
		const provider = commonStore.selectedProvider;
		if (!provider) throw new Error('Choose a Common connection before sending.');
		return generationSettings(settingsStore.config, commonStore.activeSnapshot?.settings ?? {}, provider,
			commonStore.selectedThinking, conversationsStore.preferences.getReasoningEffort());
	}

	private attachmentIds(extras: DatabaseMessageExtra[] = []): string[] {
		return extras.map((extra) => {
			if (!extra.commonId) throw new Error(`"${extra.name}" is not uploaded to Common. Upload it before sending.`);
			return extra.commonId;
		});
	}

	private async submit(
		id: string, turn: { parentId: string | null; content?: string; attachments?: string[]; regenerate?: boolean; continue?: boolean },
		composer?: Partial<CommonDraft>
	): Promise<boolean> {
		if (draftMessagesStore.getPending(id)) return this.retryPending(id);
		if (this.submitting.has(id)) return false;
		const providerId = commonStore.selectedProviderId, model = commonStore.selectedModel;
		const provider = commonStore.selectedProvider;
		if (!provider || !model) throw new Error('Choose a saved Common connection and model before sending.');
		const snapshot = await DatabaseService.snapshot(id);
		if (snapshot.activeJob) throw new Error('This conversation is generating. Stop the current job or wait before submitting another turn.');
		const settings = generationSettings(settingsStore.config, snapshot.settings, provider,
			commonStore.selectedThinking, conversationsStore.preferences.getReasoningEffort());
		this.submitting.add(id);
		try {
			const tools = await commonStore.readToolPermissions(providerId);
			if (commonStore.selectedModel !== model || commonStore.activeId !== id) {
				throw new Error('The model or conversation changed while checking native tools. Review the target before sending.');
			}
			const mcp = await confirmSelections(commonStore.selectedProvider ?? {}, id);
			if (mcp.selections.length && !window.confirm(
				`Allow these MCP tools for this submission to ${commonStore.selectedProvider?.name} in "${snapshot.title}"?\n\n${mcp.labels.join('\n')}\n\nThe model can call only these selected MCP tools. They can have side effects. Saved activity does not grant future permission.`
			)) return false;
			if (commonStore.selectedProviderId !== providerId || commonStore.selectedModel !== model ||
				commonStore.activeId !== id || !commonStore.session?.authenticated) {
				throw new Error('The connection, model or conversation changed. Review the target before sending.');
			}
			const body: CommonGeneration = { requestId: crypto.randomUUID(), expectedVersion: snapshot.version,
				providerId, model, ...turn, settings, tools: { ...tools, ...(mcp.selections.length ? { mcp: mcp.selections } : {}) } };
			const saved = draftMessagesStore.persistRequest(id, body, composer);
			return await this.postExact(id, saved);
		} finally {
			this.submitting.delete(id);
			const latest = commonStore.snapshots.get(id);
			if (latest) this.applySnapshot(latest);
		}
	}

	private async postExact(id: string, saved: CommonDraft): Promise<boolean> {
		if (!saved.retry || saved.retry.cid !== id) throw new Error('This pending request has a different conversation target.');
		try {
			const receipt = await api<CommonReceipt>(`/api/conversations/${encodeURIComponent(id)}/generate`, 'POST', saved.retry.body);
			this.acknowledged(id, saved, receipt);
			return true;
		} catch (error) {
			if (error instanceof CommonApiError && [401, 403].includes(error.status)) {
				this.fail(new Error('Sign in again to reconcile this saved exact request. The device draft and request were not removed.'));
			} else if (error instanceof CommonApiError && error.status >= 400 && error.status < 500) {
				draftMessagesStore.releaseRequest(id, saved.retry.body.requestId);
				if (error.status === 409) {
					await commonStore.refreshConversation(id).catch(() => {});
					this.fail(new Error('The conversation changed or is busy. The exact draft stays saved. Review the branch and settings before sending again.'));
				} else this.fail(error);
			} else this.fail(new Error(`${error instanceof Error ? error.message : 'The submission response was lost.'} Submission is uncertain. Retry uses the saved exact request, not a new turn.`));
			return false;
		}
	}

	private acknowledged(id: string, saved: CommonDraft, receipt: CommonReceipt): void {
		if (receipt.conversationId !== id) throw new Error('The receipt does not match the frozen conversation target.');
		this.jobs.set(id, { id: receipt.jobId, messageId: receipt.messageId });
		this.activity.markLocal(id);
		draftMessagesStore.acknowledge(id, saved);
		this.errorDialogState = null;
		void commonStore.refreshConversation(id).catch((error) => { commonStore.connectionError = error.message; });
		void commonStore.refreshList().catch(() => {});
	}

	/** Reconcile only. Never restart a job or automatically send a stored draft. */
	async reconcilePending(id: string): Promise<boolean> {
		const saved = draftMessagesStore.getRecord(id);
		if (!saved.retry || this.reconciling.has(id)) return false;
		this.reconciling.add(id);
		try {
			const receipt = await api<CommonReceipt>(`/api/requests/${encodeURIComponent(saved.retry.body.requestId)}`);
			this.acknowledged(id, saved, receipt); return true;
		} catch (error) {
			if (!(error instanceof CommonApiError && error.status === 404)) commonStore.connectionError = error instanceof Error ? error.message : String(error);
			return false;
		} finally { this.reconciling.delete(id); }
	}

	async retryPending(id: string): Promise<boolean> {
		if (this.submitting.has(id)) return false;
		if (commonStore.activeId !== id) throw new Error('Open the original conversation before retrying this request.');
		if (await this.reconcilePending(id)) return true;
		const saved = draftMessagesStore.getRecord(id);
		if (!saved.retry) return false;
		this.submitting.add(id);
		try { return await this.postExact(id, saved); }
		finally { this.submitting.delete(id); }
	}

	async sendMessage(content: string, extras?: DatabaseMessageExtra[]): Promise<boolean> {
		if (!content.trim() && !extras?.length) return false;
		try {
			if (conversationsStore.missingConversationId) throw new Error('This conversation is unavailable. Copy its retained draft to a new chat.');
			const id = conversationsStore.activeConversation?.id ?? await conversationsStore.createConversation(generateConversationTitle(content, true));
			const snapshot = await DatabaseService.snapshot(id);
			const attachments = this.attachmentIds(extras);
			const current = draftMessagesStore.getRecord(id);
			if (current.editing && !snapshot.messages.some((m) => m.id === current.editing!.id && m.parentId === current.editing!.parentId)) {
				throw new Error('The saved edit target changed or is missing. Review it before sending.');
			}
			return await this.submit(id, { parentId: current.editing ? current.editing.parentId : snapshot.activeLeaf,
				content, attachments }, { text: content, attachments: (extras ?? []).map((extra) => ({
					id: extra.commonId!, name: extra.name, existing: extra.commonExisting === true, mime: extra.commonMime, size: extra.size
				})) });
		} catch (error) { this.fail(error); return false; }
	}

	private activeMessage(id: string): DatabaseMessage {
		const message = conversationsStore.activeMessages.find((m) => m.id === id);
		if (!message || commonStore.activeId !== message.convId) throw new Error('The message target is unavailable. Open its original conversation.');
		return message;
	}

	async editMessageWithBranching(messageId: string, content: string, extras?: DatabaseMessageExtra[]): Promise<void> {
		const message = this.activeMessage(messageId);
		if (message.role !== MessageRole.USER) throw new Error('Only user edits create generation branches.');
		const attachments = this.attachmentIds(extras ?? message.extra);
		const composer = { text: content, attachments: (extras ?? message.extra ?? []).map((extra) => ({ id: extra.commonId!, name: extra.name, existing: extra.commonExisting === true, mime: extra.commonMime, size: extra.size })),
			editing: { id: message.id, parentId: message.parent } };
		draftMessagesStore.saveRecord(message.convId, { ...draftMessagesStore.getRecord(message.convId), ...composer });
		if (!await this.submit(message.convId, { parentId: message.parent, content, attachments }, composer)) throw new Error('The edit was not acknowledged. Its exact draft remains saved.');
	}
	async regenerateMessageWithBranching(messageId: string, modelOverride?: string): Promise<void> {
		const message = this.activeMessage(messageId);
		if (modelOverride && modelOverride !== commonStore.selectedModel) await commonStore.selectModel(modelOverride);
		const snapshot = await DatabaseService.snapshot(message.convId);
		let parent = snapshot.messages.find((m) => m.id === message.id);
		while (parent && parent.role !== 'user') parent = snapshot.messages.find((m) => m.id === parent!.parentId);
		if (!parent) throw new Error('Regeneration requires an existing user message.');
		if (!await this.submit(message.convId, { parentId: parent.id, regenerate: true })) throw new Error('Regeneration is not acknowledged. Use Retry for the saved request.');
	}
	regenerateMessage(id: string): Promise<void> { return this.regenerateMessageWithBranching(id); }
	async continueAssistantMessage(id: string): Promise<void> {
		const message = this.activeMessage(id);
		if (message.role !== MessageRole.ASSISTANT || message.status !== 'complete') throw new Error('Continue requires a complete assistant message.');
		if (!await this.submit(message.convId, { parentId: message.id, continue: true })) throw new Error('Continue is not acknowledged. Use Retry for the saved request.');
	}
	async editAssistantMessage(id: string, content: string, branch = false): Promise<void> {
		const message = this.activeMessage(id);
		if (branch) {
			await this.addMessage(message.role as MessageRole, content, MessageType.TEXT, message.parent ?? '', message.extra);
		} else await DatabaseService.updateMessage(id, { content });
	}
	async editUserMessagePreserveResponses(id: string, content: string, extras?: DatabaseMessageExtra[]): Promise<void> {
		this.activeMessage(id);
		await DatabaseService.updateMessage(id, { content, extra: extras });
	}
	async updateMessage(id: string, content: string): Promise<void> { await DatabaseService.updateMessage(id, { content }); }
	async deleteMessage(id: string): Promise<void> { this.activeMessage(id); await DatabaseService.deleteMessage(id); }
	async getDeletionInfo(id: string) {
		const message = this.activeMessage(id), all = await conversationsStore.getConversationMessages(message.convId);
		const ids = new Set([id, ...findDescendantMessages(all, id)]);
		const descendants = all.filter((item) => ids.has(item.id));
		return { totalCount: descendants.length, userMessages: descendants.filter((m) => m.role === 'user').length,
			assistantMessages: descendants.filter((m) => m.role === 'assistant').length, messageTypes: [...new Set(descendants.map((m) => m.type))] };
	}
	async addMessage(role: MessageRole, content: string, type: MessageType = MessageType.TEXT, parent = '-1', extras?: DatabaseMessageExtra[], _synthetic?: boolean): Promise<DatabaseMessage> {
		const id = conversationsStore.activeConversation?.id ?? await conversationsStore.createConversation();
		const snapshot = await DatabaseService.snapshot(id);
		return DatabaseService.createMessageBranch({ convId: id, role, content, type, timestamp: Date.now(), children: [], parent: null, extra: extras }, parent === '-1' ? snapshot.activeLeaf : parent || null);
	}
	async addSystemPrompt(): Promise<void> {
		const id = conversationsStore.activeConversation?.id ?? await conversationsStore.createConversation();
		const snapshot = await DatabaseService.snapshot(id);
		const system = snapshot.messages.find((m) => m.role === 'system' && m.parentId === null);
		if (system) { this.pendingEditMessageId = system.id; return; }
		if (snapshot.messages.length) { toast.info('Set the system prompt in generation settings for an existing branch. Common does not reparent saved history.'); return; }
		const message = await DatabaseService.createSystemMessage(id, SYSTEM_MESSAGE_PLACEHOLDER, null);
		this.pendingEditMessageId = message.id;
	}
	async removeSystemPromptPlaceholder(id: string): Promise<boolean> {
		const message = this.activeMessage(id);
		if (message.children.length) { toast.info('This system message has a saved continuation. Edit it or use explicit subtree deletion.'); return false; }
		await DatabaseService.deleteMessage(id); return false;
	}

	async discoverActiveStream(id: string): Promise<void> {
		if (!commonStore.session?.authenticated) return;
		try { this.applySnapshot(await commonStore.refreshConversation(id)); await this.reconcilePending(id); }
		catch (error) { commonStore.connectionError = error instanceof Error ? error.message : String(error); }
	}
	async syncRemoteRunningStreams(): Promise<void> {
		if (!commonStore.session?.authenticated) return;
		await commonStore.refreshList();
		if (commonStore.activeId) await this.discoverActiveStream(commonStore.activeId);
	}
	syncLoadingStateForChat(id: string): void { const snapshot = commonStore.snapshots.get(id); if (snapshot) this.applySnapshot(snapshot); }
	async stopGeneration(): Promise<void> { const id = conversationsStore.activeConversation?.id; if (id) await this.stopGenerationForChat(id); }
	async stopGenerationForChat(id: string): Promise<void> {
		try {
			const job = this.jobs.get(id) ?? (await commonStore.refreshConversation(id)).activeJob;
			if (!job) return;
			const jobId = job.id;
			await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, 'POST', {});
			await commonStore.refreshConversation(id);
		} catch (error) { this.fail(error); }
	}
	abortCurrentFlow(id: string): Promise<void> { return this.stopGenerationForChat(id); }
	isChatLoading(id: string): boolean { return this.submitting.has(id) || this.jobs.has(id) || this.activity.isRemote(id); }
	isChatLoadingInternal(id: string): boolean { return this.isChatLoading(id); }
	isStreaming(): boolean { return this.jobs.has(conversationsStore.activeConversation?.id ?? ''); }
	getAllLoadingChats(): string[] { return [...new Set([...this.activity.loadingConvs, ...this.submitting, ...this.jobs.keys()])]; }
	getChatStreaming(id: string) { return this.chatStreamingStates.get(id); }
	getResumeModel(id: string): string | null { const snapshot = commonStore.snapshots.get(id); return snapshot?.messages.find((m) => m.id === snapshot.activeJob?.messageId)?.model ?? null; }
	setChatLoading(id: string, loading: boolean): void { if (loading) this.activity.markLocal(id); else this.activity.localEnded(id); }
	setChatReasoning(id: string, value: boolean): void { if (value) this.chatReasoningStates.set(id, true); else this.chatReasoningStates.delete(id); }
	setChatStreaming(id: string, response: string, messageId: string, model?: string | null): void { this.chatStreamingStates.set(id, { response, messageId, model }); }
	clearChatStreaming(id: string, messageId?: string): void { if (!messageId || this.chatStreamingStates.get(id)?.messageId === messageId) this.chatStreamingStates.delete(id); }
	cleanupStreaming(id: string): void { this.activity.localEnded(id); this.chatStreamingStates.delete(id); this.chatReasoningStates.delete(id); this.processing.setState(id, null); }
	clearPendingEditMessageId(): void { this.pendingEditMessageId = null; }
	setEditModeActive(handler: (files: File[]) => void): void { this.editing = true; this.addFilesHandler = handler; }
	clearEditMode(): void { this.editing = false; this.addFilesHandler = null; }
	isEditing(): boolean { return this.editing; }
	getAddFilesHandler() { return this.addFilesHandler; }
	savePendingDraft(message: string, files: ChatUploadedFile[]): void { this.pendingDraft = { message, files }; draftMessagesStore.saveDraftMessage(conversationsStore.activeConversation?.id, message, files); }
	consumePendingDraft() { const draft = this.pendingDraft; this.pendingDraft = null; return draft; }
	hasPendingDraft(): boolean { return !!this.pendingDraft; }
	getPendingMessageContent(_id: string): string | null { return null; }
	getPendingMessageExtras(_id: string): DatabaseMessageExtra[] | undefined { return undefined; }
	clearPendingMessage(_id: string): void {}
	injectPendingMessage(_id: string, _content: string, _extras?: DatabaseMessageExtra[]): void { toast.info('Browser steering is disabled. Stop the native job, then send a new turn.'); }
	async recordCwdChange(_cwd: string | null): Promise<void> { throw new Error('Host working directories are disabled. Common Files and isolated Run use this conversation workspace.'); }
	cancelPreEncode(): void {}
	dismissErrorDialog(): void { this.errorDialogState = null; }
	showErrorDialog(state: ErrorDialogState | null): void { this.errorDialogState = state; }
	private fail(error: unknown): void {
		this.errorDialogState = { type: ErrorDialogType.SERVER, message: error instanceof Error ? error.message : String(error) };
	}
}

export const chatStore = new ChatStore();
