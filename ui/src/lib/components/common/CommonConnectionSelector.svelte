<script lang="ts">
	import { commonStore } from '$lib/stores/common.svelte';

	let {
		disabled = false,
		switching = $bindable(false)
	}: { disabled?: boolean; switching?: boolean } = $props();
	let error = $state('');

	async function selectConnection(event: Event) {
		const input = event.currentTarget as HTMLSelectElement;
		const id = input.value;
		if (disabled || switching || !id || id === commonStore.selectedProviderId) {
			input.value = commonStore.selectedProviderId;
			return;
		}
		switching = true;
		error = '';
		try {
			await commonStore.selectProvider(id);
		} catch (cause) {
			error = `Chat connection selection could not be confirmed. ${cause instanceof Error ? cause.message : String(cause)}`;
		} finally {
			input.value = commonStore.selectedProviderId;
			switching = false;
		}
	}
</script>

<div class="inline-flex min-w-0 flex-col gap-1">
	<label class="inline-flex min-w-0 items-center">
		<span class="sr-only">Chat connection</span>
		<select
			class="h-7 max-w-[min(35vw,12rem)] cursor-pointer rounded-sm border border-input bg-background px-1.5 text-xs focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
			value={commonStore.selectedProviderId}
			title={switching ? 'Saving chat connection...' : `Chat connection: ${commonStore.selectedProvider?.name ?? 'Choose connection'}`}
			disabled={disabled || switching || !commonStore.session?.authenticated || commonStore.providers.length === 0}
			onchange={selectConnection}
		>
			<option value="" disabled>Choose connection</option>
			{#if commonStore.selectedProviderId && !commonStore.selectedProvider}
				<option value={commonStore.selectedProviderId} disabled>Unavailable connection</option>
			{/if}
			{#each commonStore.providers as provider (provider.id)}
				<option value={provider.id}>{provider.name}</option>
			{/each}
		</select>
	</label>
	{#if error}<p role="alert" class="max-w-64 text-xs text-destructive">{error}</p>{/if}
</div>
