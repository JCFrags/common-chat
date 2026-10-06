<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { commonStore } from '$lib/stores/common.svelte';

	let checking = $state(false), error = $state('');
	const enabled = $derived(commonStore.selectedProvider?.capabilities.tools === true);
	const tools = $derived(commonStore.runtime?.nativeTools ?? []);

	async function refresh() {
		if (checking) return;
		checking = true;
		error = '';
		try { await Promise.all([commonStore.refreshProviders(), commonStore.refreshRuntime()]); }
		catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { checking = false; }
	}
	onMount(() => { void refresh(); });
</script>

<section class="space-y-3 rounded-xl border border-border/30 bg-muted/20 p-4" aria-label="Native function tools">
	<div class="flex items-center justify-between gap-2">
		<h3 class="text-sm font-medium">Native tools</h3>
		<Button variant="ghost" size="sm" disabled={checking} onclick={refresh}>
			{checking ? 'Checking...' : 'Refresh'}
		</Button>
	</div>
	<p class="text-xs text-muted-foreground">
		{#if enabled}Available automatically for {commonStore.selectedProvider?.name}.
		{:else}Choose a connection with function tools enabled.{/if}
	</p>
	{#each tools as tool (tool.name)}
		<details class="rounded-xl border border-border/30 bg-background/50 p-3 text-sm">
			<summary class="cursor-pointer">
				{tool.title || tool.name} · {enabled && tool.available ? 'available' : 'unavailable'}
			</summary>
			<p class="mt-2 text-xs text-muted-foreground">{tool.name}</p>
			{#if tool.description}<p class="mt-1">{tool.description}</p>{/if}
		</details>
	{:else}
		<p class="text-sm text-muted-foreground">The native tool catalog is unavailable.</p>
	{/each}
	{#each commonStore.runtime?.blockedReasons ?? [] as reason}
		<p class="text-sm text-muted-foreground">{reason}</p>
	{/each}
	<details class="text-xs text-muted-foreground">
		<summary class="cursor-pointer">Native tool help</summary>
		<p class="mt-2">Each new turn checks the connection and runner. Available native tools are automatic, not per-turn selections. Saved receipts do not authorize new calls. Manual code Run requires source review. Manual package changes require separate consent. Native tool budgets are off unless set in generation settings. Native calls cannot use host working directories or execute code in the browser.</p>
	</details>
	{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
</section>
