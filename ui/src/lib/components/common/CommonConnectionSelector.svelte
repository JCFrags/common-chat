<script lang="ts">
	import { Cable } from '@lucide/svelte';
	import * as Select from '$lib/components/ui/select';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { commonStore } from '$lib/stores/common.svelte';

	let {
		disabled = false,
		switching = $bindable(false)
	}: { disabled?: boolean; switching?: boolean } = $props();
	let error = $state('');
	let connectionId = $state('');
	$effect(() => { connectionId = commonStore.selectedProviderId; });
	const selectionHint = $derived(switching ? 'Saving chat connection...' : `Chat connection: ${commonStore.selectedProvider?.name ?? 'Choose connection'}`);

	async function selectConnection(id: string) {
		if (disabled || switching || !id || id === commonStore.selectedProviderId) {
			connectionId = commonStore.selectedProviderId;
			return;
		}
		switching = true;
		error = '';
		try {
			await commonStore.selectProvider(id);
		} catch (cause) {
			error = `Chat connection selection could not be confirmed. ${cause instanceof Error ? cause.message : String(cause)}`;
		} finally {
			connectionId = commonStore.selectedProviderId;
			switching = false;
		}
	}
</script>

<div class="inline-flex min-w-0 flex-col gap-1">
	<Select.Root type="single" bind:value={connectionId} onValueChange={(id) => { void selectConnection(id); }} disabled={disabled || switching || !commonStore.session?.authenticated || commonStore.providers.length === 0}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Select.Trigger {...props} variant="plain" size="sm" class="w-auto max-w-[min(25vw,12rem)] justify-between rounded-full bg-muted/30 px-2.5 text-xs text-foreground hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring" aria-label="Chat connection">
						<Cable class="size-3.5" />
						<span class="truncate">{switching ? 'Saving...' : commonStore.selectedProvider?.name ?? (commonStore.selectedProviderId ? 'Unavailable connection' : 'Choose connection')}</span>
					</Select.Trigger>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>{selectionHint}</Tooltip.Content>
		</Tooltip.Root>
		<Select.Content align="end" class="max-w-[calc(100vw-2rem)] rounded-xl border-border/30 bg-popover/95 backdrop-blur-xl">
			{#if commonStore.selectedProviderId && !commonStore.selectedProvider}
				<Select.Item value={commonStore.selectedProviderId} label="Unavailable connection" disabled>Unavailable connection</Select.Item>
			{/if}
			{#each commonStore.providers as provider (provider.id)}
				<Select.Item value={provider.id} label={provider.name}>{provider.name}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
	{#if error}<p role="alert" class="max-w-64 text-xs text-destructive">{error}</p>{/if}
</div>
