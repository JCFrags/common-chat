<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { onMount, tick, untrack } from 'svelte';
	import { FolderOpen, Terminal } from '@lucide/svelte';
	import CommonFiles from './CommonFiles.svelte';
	import CommonRun from './CommonRun.svelte';
	import { createWorkspaceSession, dirtyFile, type WorkspaceSession } from './workspace-state';
	import { errorText } from './api';

	type Section = 'files' | 'run';
	interface Props {
		conversationId: string | null;
		ensureConversation: () => Promise<string>;
		onChanged?: () => Promise<void> | void;
		open?: boolean;
		showTrigger?: boolean;
		initialSection?: Section;
	}
	let {
		conversationId,
		ensureConversation,
		onChanged = () => {},
		open = $bindable(false),
		showTrigger = true,
		initialSection = 'files'
	}: Props = $props();
	let section = $state<Section>(untrack(() => initialSection)),
		pendingId = $state<string | null>(null),
		creating = $state(false),
		error = $state('');
	let sessions = $state<Record<string, WorkspaceSession>>({});
	let filesRef = $state<CommonFiles>(),
		runRef = $state<CommonRun>();
	const cid = $derived(conversationId ?? pendingId);
	const session = $derived(cid ? sessions[cid] : null);
	let previousId = untrack(() => conversationId);
	$effect(() => {
		if (conversationId !== previousId) {
			previousId = conversationId;
			pendingId = null;
		}
	});
	$effect(() => {
		if (cid && !sessions[cid]) sessions[cid] = createWorkspaceSession();
	});
	export function openSection(value: Section) {
		section = value;
		open = true;
	}
	async function ensure() {
		if (cid) return cid;
		if (creating) return null;
		creating = true;
		error = '';
		try {
			const value = await ensureConversation();
			if (!value) throw new Error('No conversation was created.');
			pendingId = value;
			await tick();
			return value;
		} catch (e) {
			error = errorText(e);
			return null;
		} finally {
			creating = false;
		}
	}
	export async function openFile(path: string, revision?: string) {
		if (!(await ensure())) return;
		openSection('files');
		await tick();
		await filesRef?.refresh();
		await filesRef?.openFile(path, revision);
	}
	export async function openExecution(id: string) {
		if (!(await ensure())) return;
		openSection('run');
		await tick();
		await runRef?.openExecution(id);
	}
	export async function openCode(source: string, kind: 'python' | 'shell' = 'python') {
		if (!(await ensure())) return false;
		openSection('run');
		await tick();
		return runRef?.openCode(source, kind) ?? false;
	}
	export async function refresh() {
		if (!open || !cid) return;
		if (section === 'files') await filesRef?.refresh();
		if (section === 'run') await runRef?.checkRuntime();
	}
	onMount(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			const dirty = Object.values(sessions).some(
				(s) =>
					Object.values(s.drafts).some(dirtyFile) ||
					!!s.run.code ||
					s.packages.pip !== s.packages.basePip ||
					s.packages.npm !== s.packages.baseNpm
			);
			if (dirty) {
				event.preventDefault();
				event.returnValue = '';
			}
		};
		window.addEventListener('beforeunload', beforeUnload);
		return () => window.removeEventListener('beforeunload', beforeUnload);
	});
</script>

<Dialog.Root bind:open>
	{#if showTrigger}<Button
			variant="ghost"
			size="sm"
			aria-haspopup="dialog"
			onclick={() => (open = true)}>Files and code</Button
		>{/if}
	<Dialog.Content
		showCloseButton
		class="flex w-[min(72rem,calc(100vw-2rem))]! max-w-[calc(100vw-2rem)]! max-h-[calc(100dvh-2rem)]! flex-col overflow-hidden rounded-2xl bg-background/95 p-4 shadow-xl backdrop-blur-xl sm:p-6"
	>
		<Dialog.Header showCloseButton={false} class="shrink-0 pr-8">
			<Dialog.Title>Files and code</Dialog.Title>
			<Dialog.Description class="sr-only">Conversation files, code review, isolated runs, and packages. Closing this panel stops polling, not server work.</Dialog.Description>
		</Dialog.Header>
		<nav class="flex w-fit shrink-0 gap-1 rounded-full bg-muted/30 p-1" aria-label="Workspace sections">
			<Button class="rounded-full" variant={section === 'files' ? 'secondary' : 'ghost'} size="sm" aria-current={section === 'files' ? 'page' : undefined} onclick={() => (section = 'files')}>
				<FolderOpen class="size-3.5" /> Files
			</Button>
			<Button class="rounded-full" variant={section === 'run' ? 'secondary' : 'ghost'} size="sm" aria-current={section === 'run' ? 'page' : undefined} onclick={() => (section = 'run')}>
				<Terminal class="size-3.5" /> Run
			</Button>
		</nav>
		<div class="min-h-0 min-w-0 overflow-y-auto overscroll-contain">
			{#if cid && session}
				{#if section === 'files'}<CommonFiles
						bind:this={filesRef}
						conversationId={cid}
						{session}
						active={open}
						{onChanged}
					/>
				{:else}<CommonRun
						bind:this={runRef}
						conversationId={cid}
						{session}
						active={open}
						{onChanged}
						onOpenFile={(path, revision) => {
							void openFile(path, revision);
						}}
					/>{/if}
			{:else}<div class="space-y-3">
					<p class="text-sm">
						Files and runs need a conversation workspace. Creating a conversation does not send a
						model request.
					</p>
					<Button disabled={creating} onclick={ensure}
						>{creating ? 'Creating...' : 'Create conversation workspace'}</Button
					>
				</div>{/if}
			{#if error}<p class="mt-3 text-sm text-destructive" role="alert">{error}</p>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
