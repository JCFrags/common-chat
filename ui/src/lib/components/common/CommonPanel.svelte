<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { onMount, tick, untrack } from 'svelte';
	import CommonConnections from './CommonConnections.svelte';
	import CommonDictationSettings from './CommonDictationSettings.svelte';
	import CommonFiles from './CommonFiles.svelte';
	import CommonRun from './CommonRun.svelte';
	import { createWorkspaceSession, dirtyFile, type WorkspaceSession } from './workspace-state';
	import { errorText } from './api';

	type Section = 'connections' | 'dictation' | 'files' | 'run';
	interface Props {
		conversationId: string | null;
		ensureConversation: () => Promise<string>;
		onChanged?: () => Promise<void> | void;
		onConnectionsChanged?: () => Promise<void> | void;
		open?: boolean;
		showTrigger?: boolean;
		initialSection?: Section;
	}
	let {
		conversationId,
		ensureConversation,
		onChanged = () => {},
		onConnectionsChanged = () => {},
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
			onclick={() => (open = true)}>Common tools and settings</Button
		>{/if}
	<Dialog.Content
		class="w-[min(72rem,calc(100vw-1rem))]! max-w-[calc(100vw-1rem)]! max-h-[calc(100dvh-1rem)]! p-4 sm:p-6"
	>
		<Dialog.Header
			><div class="flex items-center justify-between gap-2">
				<Dialog.Title>Common tools and settings</Dialog.Title><Button
					variant="ghost"
					size="sm"
					onclick={() => (open = false)}>Close</Button
				>
			</div>
			<Dialog.Description
				>Server-owned connections, speech selection, and conversation-scoped files and isolated
				operations.</Dialog.Description
			></Dialog.Header
		>
		<nav class="flex flex-wrap gap-1" aria-label="Common panel sections">
			{#each [['connections', 'Connections'], ['dictation', 'Dictation'], ['files', 'Files'], ['run', 'Run and packages']] as [value, label]}<Button
					variant={section === value ? 'secondary' : 'ghost'}
					size="sm"
					aria-current={section === value ? 'page' : undefined}
					onclick={() => (section = value as Section)}>{label}</Button
				>{/each}
		</nav>
		<div class="min-w-0">
			{#if section === 'connections'}<CommonConnections onChanged={onConnectionsChanged} />
			{:else if section === 'dictation'}<CommonDictationSettings onChanged={onConnectionsChanged} />
			{:else if cid && session}
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
