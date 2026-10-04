<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		ChatMessageAssistant,
		ChatMessageMcpPrompt,
		ChatMessageSynthetic,
		ChatMessageSystem,
		ChatMessageUser
	} from '$lib/components/app/chat';
	import {
		AGENTIC_TEXT_COPY_SEPARATOR,
		REASONING_TAGS,
		ROUTES,
		SYSTEM_MESSAGE_PLACEHOLDER
	} from '$lib/constants';
	import { setChatMessageActionsContext, setChatMessageEditContext } from '$lib/contexts';
	import { AgenticSectionType, AttachmentType, MessageRole } from '$lib/enums';
	import { DatabaseService } from '$lib/services/database.service';
	import { chatStore, conversationsStore, deviceStore } from '$lib/stores';
	import type {
		ChatMessageActions,
		ChatMessageDeletionInfo,
		DatabaseMessageExtraMcpPrompt
	} from '$lib/types';
	import { deriveAgenticSections } from '$lib/utils';
	import { parseFilesToMessageExtras } from '$lib/utils/browser-only';
	import { useCommonEditDraft } from '$lib/hooks/use-common-edit-draft.svelte';
	import { toast } from 'svelte-sonner';

	interface Props {
		class?: string;
		chatActions: ChatMessageActions;
		message: DatabaseMessage;
		toolMessages?: DatabaseMessage[];
		isLastAssistantMessage?: boolean;
		isLastUserMessage?: boolean;
		nextAssistantMessage?: DatabaseMessage | null;
		siblingInfo?: ChatMessageSiblingInfo | null;
	}

	let {
		chatActions,
		class: className = '',
		isLastAssistantMessage = false,
		isLastUserMessage = false,
		message,
		nextAssistantMessage = null,
		siblingInfo = null,
		toolMessages = []
	}: Props = $props();

	let deletionInfo = $state<ChatMessageDeletionInfo | null>(null);
	// Keep reviewed edit text separate from refreshed server message props.
	let editedContent = $state('');

	// Synthetic cwd-change messages render with the folder-row UI instead
	// of a user bubble. The persisted flag is the single source of truth.
	let isSynthetic = $derived(Boolean(message.isSynthetic));

	let rawEditContent = $derived.by(() => {
		if (message.role !== MessageRole.ASSISTANT) return undefined;

		const sections = deriveAgenticSections(message, toolMessages, [], false);
		const parts: string[] = [];

		for (const section of sections) {
			switch (section.type) {
				case AgenticSectionType.REASONING:
				case AgenticSectionType.REASONING_PENDING:
					parts.push(`${REASONING_TAGS.START}\n${section.content}\n${REASONING_TAGS.END}`);

					break;

				case AgenticSectionType.TEXT:
					parts.push(section.content);

					break;

				case AgenticSectionType.TOOL_CALL:
				case AgenticSectionType.TOOL_CALL_PENDING:
				case AgenticSectionType.TOOL_CALL_STREAMING: {
					const callObj: Record<string, unknown> = { name: section.toolName };

					if (section.toolArgs) {
						try {
							callObj.arguments = JSON.parse(section.toolArgs);
						} catch {
							callObj.arguments = section.toolArgs;
						}
					}

					parts.push(JSON.stringify(callObj, null, 2));

					if (section.toolResult) {
						parts.push(`[Tool Result]\n${section.toolResult}`);
					}

					break;
				}
			}
		}

		return parts.join('\n\n\n');
	});
	let editedExtras = $state<DatabaseMessageExtra[]>([]);
	let editedUploadedFiles = $state<ChatUploadedFile[]>([]);
	let isEditing = $state(false);
	let showDeleteDialog = $state(false);
	let shouldBranchAfterEdit = $state(false);
	let textareaElement: HTMLTextAreaElement | undefined = $state();

	let showSaveOnlyOption = $derived(message.role === MessageRole.USER);
	let showBranchAfterEditOption = $derived(message.role === MessageRole.ASSISTANT);
	const editDraft = useCommonEditDraft({
		message: () => message, isEditing: () => isEditing, content: () => editedContent,
		extras: () => editedExtras, files: () => editedUploadedFiles,
		setDraft: (text, extras) => { editedContent = text; editedExtras = extras; editedUploadedFiles = []; }
	});

	setChatMessageEditContext({
		cancel: handleCancelEdit,
		get editedContent() {
			return editedContent;
		},
		get editedExtras() {
			return editedExtras;
		},
		get editedUploadedFiles() {
			return editedUploadedFiles;
		},
		get isEditing() {
			return isEditing;
		},
		get messageRole() {
			return message.role;
		},
		get originalContent() {
			return message.role === MessageRole.ASSISTANT
				? (rawEditContent ?? message.content)
				: message.content;
		},
		get originalExtras() {
			return message.extra || [];
		},
		get rawEditContent() {
			return rawEditContent;
		},
		save: handleSaveEdit,
		saveOnly: handleSaveEditOnly,
		setContent: (content: string) => {
			editedContent = content;
		},
		setExtras: (extras: DatabaseMessageExtra[]) => {
			editedExtras = extras;
		},
		setShouldBranchAfterEdit: (value: boolean) => {
			shouldBranchAfterEdit = value;
		},
		setUploadedFiles: (files: ChatUploadedFile[]) => {
			editedUploadedFiles = files;
		},
		get shouldBranchAfterEdit() {
			return shouldBranchAfterEdit;
		},
		get showBranchAfterEditOption() {
			return showBranchAfterEditOption;
		},
		get showSaveOnlyOption() {
			return showSaveOnlyOption;
		},
		startEdit: handleEdit
	});

	setChatMessageActionsContext({
		confirmDelete: handleConfirmDelete,
		copy: handleCopy,
		get deletionInfo() {
			return deletionInfo;
		},
		get forkConversation() {
			const isForkableUser = message.role === MessageRole.USER && !mcpPromptExtra;

			return isForkableUser || message.role === MessageRole.ASSISTANT
				? handleForkConversation
				: undefined;
		},
		navigateToSibling: handleNavigateToSibling,
		requestDelete: handleDelete,
		setShowDeleteDialog: handleShowDeleteDialogChange,
		get showDeleteDialog() {
			return showDeleteDialog;
		},
		get siblingInfo() {
			return siblingInfo;
		}
	});

	let mcpPromptExtra = $derived.by(() => {
		if (message.role !== MessageRole.USER) return null;

		if (message.content.trim()) return null;

		if (!message.extra || message.extra.length !== 1) return null;

		const extra = message.extra[0];

		if (extra.type === AttachmentType.MCP_PROMPT) {
			return extra as DatabaseMessageExtraMcpPrompt;
		}

		return null;
	});

	$effect(() => {
		const pendingId = chatStore.pendingEditMessageId;

		if (pendingId && pendingId === message.id && !isEditing) {
			handleEdit();
			chatStore.clearPendingEditMessageId();
		}
	});

	async function handleCancelEdit() {
		isEditing = false;

		// If canceling a new system message with placeholder content, remove it without deleting children
		if (message.role === MessageRole.SYSTEM && message.content === SYSTEM_MESSAGE_PLACEHOLDER) {
			const conversationDeleted = await chatStore.removeSystemPromptPlaceholder(message.id);

			if (conversationDeleted) {
				goto(ROUTES.START);
			}

			return;
		}

		editedContent =
			message.role === MessageRole.ASSISTANT
				? rawEditContent || message.content || ''
				: message.content;
		editedExtras = message.extra ? [...message.extra] : [];
		editedUploadedFiles = [];
	}

	function handleCopy() {
		// Agentic sessions render as a single entry anchored on the first assistant
		// turn, whose own content is typically just the first tool call. Copy the
		// text sections of the whole session so the clipboard matches the visible
		// response instead of the anchor turn.
		if (message.role === MessageRole.ASSISTANT) {
			const sections = deriveAgenticSections(message, toolMessages, [], false);
			const text = sections
				.filter((section) => section.type === AgenticSectionType.TEXT)
				.map((section) => section.content)
				.join(AGENTIC_TEXT_COPY_SEPARATOR);

			if (text) {
				chatActions.copy(message, text);

				return;
			}
		}

		chatActions.copy(message);
	}

	async function handleConfirmDelete() {
		if (message.role === MessageRole.SYSTEM) {
			const conversationDeleted = await chatStore.removeSystemPromptPlaceholder(message.id);

			if (conversationDeleted) {
				goto(ROUTES.START);
			}
		} else {
			chatActions.delete(message);
		}

		showDeleteDialog = false;
	}

	async function handleDelete() {
		deletionInfo = await chatStore.getDeletionInfo(message.id);
		showDeleteDialog = true;
	}

	function handleEdit() {

		// Clear temporary placeholder content for system messages
		if (message.role === MessageRole.SYSTEM && message.content === SYSTEM_MESSAGE_PLACEHOLDER) {
			editedContent = '';
		} else if (message.role === MessageRole.ASSISTANT) {
			editedContent = rawEditContent || message.content || '';
		} else {
			editedContent = message.content;
		}

		textareaElement?.focus({ preventScroll: true });
		editedExtras = message.extra ? [...message.extra] : [];
		editedUploadedFiles = [];
		try { editDraft.begin(); isEditing = true; }
		catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return; }

		setTimeout(() => {
			if (textareaElement) {
				textareaElement.focus();
				textareaElement.setSelectionRange(
					textareaElement.value.length,
					textareaElement.value.length
				);
			}
		}, 0);
	}

	function handleRegenerate(modelOverride?: string) {
		chatActions.regenerateWithBranching(message, modelOverride);
	}

	function handleContinue() {
		chatActions.continueAssistantMessage(message);
	}

	function handleForkConversation(options: { name: string; includeAttachments: boolean }) {
		chatActions.forkConversation(message, options);
	}

	function handleNavigateToSibling(siblingId: string) {
		chatActions.navigateToSibling(siblingId);
	}

	// After the system message flow ends, hand focus to the main chat form
	function focusMainChatForm() {
		if (deviceStore.isMobile) return;

		document.querySelector<HTMLTextAreaElement>('.chat-screen-form-wrapper textarea')?.focus();
	}

	async function handleSaveEdit() {
		try {
		editDraft.assertTarget();
		if (message.role === MessageRole.SYSTEM) {
			// System messages: update in place without branching
			const newContent = editedContent;

			// If content is empty, remove without deleting children
			if (!newContent.trim()) {
				const conversationDeleted = await chatStore.removeSystemPromptPlaceholder(message.id);

				editDraft.acknowledged(); isEditing = false;

				if (conversationDeleted) {
					goto(ROUTES.START);
				} else {
					focusMainChatForm();
				}

				return;
			}

			await DatabaseService.updateMessage(message.id, { content: newContent });
			const index = conversationsStore.findMessageIndex(message.id);

			if (index !== -1) {
				conversationsStore.updateMessageAtIndex(index, { content: newContent });
			}

			focusMainChatForm();
		} else if (message.role === MessageRole.USER) {
			const finalExtras = await getMergedExtras();

			await chatStore.editMessageWithBranching(message.id, editedContent, finalExtras);
		} else {
			// For assistant messages, preserve exact content including trailing whitespace
			// This is important for the Continue feature to work properly
			await chatStore.editAssistantMessage(message.id, editedContent, shouldBranchAfterEdit);
		}

		editDraft.acknowledged(); isEditing = false;
		shouldBranchAfterEdit = false;
		editedUploadedFiles = [];
		} catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
	}

	async function handleSaveEditOnly() {
		try {
		editDraft.assertTarget();
		if (message.role === MessageRole.USER) {
			// Keep the exact reviewed text. The server owns the saved message.
			const finalExtras = await getMergedExtras();

			await chatStore.editUserMessagePreserveResponses(message.id, editedContent, finalExtras);
		}

		editDraft.acknowledged(); isEditing = false;
		editedUploadedFiles = [];
		} catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
	}

	async function getMergedExtras(): Promise<DatabaseMessageExtra[]> {
		if (editedUploadedFiles.length === 0) {
			return editedExtras;
		}

		const plainFiles = $state.snapshot(editedUploadedFiles);
		const result = await parseFilesToMessageExtras(plainFiles);
		const newExtras = result?.extras || [];

		return [...editedExtras, ...newExtras];
	}

	function handleShowDeleteDialogChange(show: boolean) {
		showDeleteDialog = show;
	}
</script>

<div>
	{#if editDraft.available}
		<div class="mb-2 text-sm" role="status">
			Saved device edit draft for this message.
			{#if editDraft.warning}<p>{editDraft.warning}</p>{/if}
			{#if !isEditing}<button type="button" class="underline" onclick={handleEdit}>Restore edit draft</button>{/if}
			<button type="button" class="ml-2 underline" onclick={() => { isEditing = false; editDraft.discard(); }}>Discard saved edit</button>
		</div>
	{/if}
	{#if message.role === MessageRole.SYSTEM}
		<ChatMessageSystem bind:textareaElement class={className} {message} />
	{:else if mcpPromptExtra}
		<ChatMessageMcpPrompt class={className} mcpPrompt={mcpPromptExtra} {message} />
	{:else if isSynthetic}
		<ChatMessageSynthetic class={className} {message} />
	{:else if message.role === MessageRole.USER}
		<ChatMessageUser class={className} {isLastUserMessage} {message} {nextAssistantMessage} />
	{:else}
		<ChatMessageAssistant
			bind:textareaElement
			class={className}
			{isLastAssistantMessage}
			{message}
			onContinue={handleContinue}
			onRegenerate={handleRegenerate}
			{toolMessages}
		/>
	{/if}
</div>
