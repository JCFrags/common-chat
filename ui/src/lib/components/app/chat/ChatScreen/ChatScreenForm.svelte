<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { ChatForm } from '$lib/components/app';
	import { useDraftMessages } from '$lib/hooks/use-draft-messages.svelte';
	import { chatStore, deviceStore } from '$lib/stores';
	import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
	import { onMount } from 'svelte';

	interface Props {
		class?: string;
		disabled?: boolean;
		externalBusy?: boolean;
		initialMessage?: string;
		isLoading?: boolean;
		onFileRemove?: (fileId: string) => void;
		onFileUpload?: (files: File[]) => void;
		onSend?: (message: string, files?: ChatUploadedFile[]) => Promise<boolean>;
		onStop?: () => void;
		onSystemPromptAdd?: (draft: { message: string; files: ChatUploadedFile[] }) => void;
		uploadedFiles?: ChatUploadedFile[];
	}

	let {
		class: className,
		disabled = false,
		externalBusy = false,
		initialMessage = '',
		isLoading = false,
		onFileRemove,
		onFileUpload,
		onSend,
		onStop,
		onSystemPromptAdd,
		uploadedFiles = $bindable([])
	}: Props = $props();

	let chatFormRef: ChatForm | undefined = $state(undefined);
	let formWrapperEl: HTMLDivElement | undefined = $state();
	let chatId = $derived(page.params.id as string | undefined);

	$effect(() => {
		if (!formWrapperEl) return;

		const formEl = formWrapperEl.querySelector('form') as HTMLElement | null;

		if (!formEl) return;

		const updateHeight = () => {
			const height = Math.round(formEl.getBoundingClientRect().height);

			document.documentElement.style.setProperty('--chat-form-height', `${height}px`);
		};

		updateHeight();

		const resizeObserver = new ResizeObserver(updateHeight);

		resizeObserver.observe(formEl);

		return () => {
			resizeObserver.disconnect();
			document.documentElement.style.removeProperty('--chat-form-height');
		};
	});
	let hasLoadingAttachments = $derived(uploadedFiles.some((f) => f.isLoading));
	let message = $state('');
	let submitting = $state(false);
	let previousIsLoading = false;
	let previousInitialMessage = '';
	let pendingRequest = $derived(draftMessagesStore.getPending(chatId));
	let targetWarning = $derived(draftMessagesStore.getWarning(chatId));

	export function getDraft(): string { return message; }
	export function setDraft(text: string): void { message = text; }
	export function getTargetId(): string { return chatId ?? 'new'; }

	useDraftMessages({
		getChatId: () => chatId,
		getFiles: () => uploadedFiles,
		getInitialMessage: () => initialMessage,
		getMessage: () => message,
		setFiles: (f) => (uploadedFiles = f),
		setMessage: (m) => (message = m)
	});

	function handleFilesAdd(files: File[]) {
		onFileUpload?.(files);
	}

	async function handleSubmit() {
		if ((!message.trim() && uploadedFiles.length === 0) || disabled || externalBusy || submitting
			|| hasLoadingAttachments || uploadedFiles.some((file) => file.loadError) || pendingRequest) return;
		if (!chatFormRef?.checkModelSelected()) return;

		const messageToSend = message;
		const filesToSend = [...uploadedFiles];
		const target = getTargetId();
		submitting = true;
		try {
			const success = await onSend?.(messageToSend, filesToSend);
			// Only an acknowledged turn can clear an unchanged editor at the same target.
			if (success && getTargetId() === target && message === messageToSend
				&& uploadedFiles.length === filesToSend.length && uploadedFiles.every((file, index) => file.id === filesToSend[index].id)) {
				message = ''; uploadedFiles = []; chatFormRef?.resetTextareaHeight();
			}
		} finally { submitting = false; }
	}

	async function retrySavedRequest() {
		if (!chatId || externalBusy || submitting || disabled) return;
		submitting = true;
		try { await chatStore.retryPending(chatId); }
		catch (error) { draftMessagesStore.warning = error instanceof Error ? error.message : String(error); }
		finally { submitting = false; }
	}

	function handleSystemPromptClick() {
		if (disabled || externalBusy || submitting || pendingRequest) return;
		onSystemPromptAdd?.({ files: uploadedFiles, message });
	}

	function handleUploadedFileRemove(fileId: string) {
		onFileRemove?.(fileId);
	}

	// Auto-focus must not steal focus already claimed elsewhere (e.g. the system
	// message editor opened just before a navigation)
	function focusFormUnlessCaptured() {
		const active = document.activeElement;

		if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;

		chatFormRef?.focus();
	}

	onMount(() => {
		if (!deviceStore.isMobile) {
			setTimeout(focusFormUnlessCaptured, 100);
		}
	});

	afterNavigate((navigation) => {
		if (navigation?.from != null && !deviceStore.isMobile) {
			setTimeout(focusFormUnlessCaptured, 100);
		}
	});

	$effect(() => {
		if (initialMessage !== previousInitialMessage) {
			message = initialMessage;
			previousInitialMessage = initialMessage;
		}
	});

	$effect(() => {
		if (previousIsLoading && !isLoading) {
			setTimeout(focusFormUnlessCaptured, 10);
		}

		previousIsLoading = isLoading;
	});
</script>

<div bind:this={formWrapperEl} class="chat-screen-form-wrapper">
	{#if draftMessagesStore.warning || draftMessagesStore.fileWarning || targetWarning}
		<p class="mx-auto max-w-3xl px-4 text-sm text-destructive" role="status">
			{targetWarning || draftMessagesStore.warning || draftMessagesStore.fileWarning}
		</p>
	{/if}
	{#if pendingRequest}
		<div class="mx-auto max-w-3xl px-4 text-sm" role="status">
			Submission is uncertain. Retry sends the saved exact request. New text stays in this draft.
			<button type="button" class="underline" disabled={disabled || externalBusy || submitting} onclick={retrySavedRequest}>Retry saved request</button>
		</div>
	{/if}
	<ChatForm
		bind:this={chatFormRef}
		bind:uploadedFiles
		bind:value={message}
		class="mx-auto max-w-3xl {className}"
		disabled={disabled || externalBusy || submitting}
		{isLoading}
		onFilesAdd={handleFilesAdd}
		{onStop}
		onSubmit={handleSubmit}
		onSystemPromptClick={handleSystemPromptClick}
		onUploadedFileRemove={handleUploadedFileRemove}
	/>
</div>
