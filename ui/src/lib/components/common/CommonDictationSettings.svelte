<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { onMount } from 'svelte';
	import { api, catalogMessage, errorText, type Catalog, type Provider, type Session } from './api';
	let { onChanged = () => {} }: { onChanged?: () => Promise<void> | void } = $props();
	let providers = $state<Provider[]>([]),
		providerId = $state(''),
		model = $state('');
	let catalog = $state<Catalog | null>(null),
		catalogStatus = $state('');
	let loading = $state(false),
		saving = $state(false),
		error = $state(''),
		status = $state('');
	let ticket = 0;
	async function loadCatalog(refresh = false) {
		const id = providerId,
			sequence = ++ticket;
		catalog = null;
		catalogStatus = '';
		if (!id) return;
		loading = true;
		try {
			const value = await api<Catalog>(
				`/api/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=1' : ''}`
			);
			if (sequence === ticket && providerId === id) {
				catalog = value;
				catalogStatus = catalogMessage(value);
			}
		} catch (e) {
			if (sequence === ticket) catalogStatus = errorText(e);
		} finally {
			if (sequence === ticket) loading = false;
		}
	}
	async function load() {
		error = '';
		loading = true;
		try {
			const [items, session] = await Promise.all([
				api<Provider[]>('/api/providers'),
				api<Session>('/api/session')
			]);
			providers = items;
			providerId = session.settings.dictation?.providerId ?? '';
			model = session.settings.dictation?.model ?? '';
			await loadCatalog();
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	async function save(disable = false) {
		if (saving || (!disable && (!providerId || !model.trim()))) return;
		saving = true;
		error = '';
		status = '';
		try {
			await api('/api/preferences', 'PUT', {
				dictation: disable ? null : { providerId, model: model.trim() }
			});
			if (disable) {
				providerId = '';
				model = '';
				catalog = null;
				catalogStatus = '';
			}
			status = disable
				? 'Dictation is disabled.'
				: 'Speech connection and model saved as one pair. Chat selection is unchanged.';
			await onChanged();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
	onMount(() => {
		void load();
	});
	const selectClass = 'h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
</script>

<section class="space-y-4" aria-label="Speech-to-text selection">
	<details class="rounded-xl border border-border/30 bg-muted/20 p-3">
		<summary class="cursor-pointer text-sm font-medium">Dictation help</summary>
		<div class="mt-3 space-y-3 text-sm text-muted-foreground">
			<p>Dictation uses a saved speech connection and model, independent of the chat selection. The service must support /audio/transcriptions. Catalogs and chat audio capabilities do not prove that support.</p>
			<p>Audio is sent only after you review a clip and select Transcribe. Saved keys stay on the server. The provider can apply its own retention and billing rules.</p>
		</div>
	</details>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
		class="space-y-4 rounded-xl border border-border/30 bg-muted/20 p-4"
	>
		<label class="grid gap-1 text-sm"
			>Speech connection<select
				class={selectClass}
				value={providerId}
				disabled={saving}
				onchange={(e) => {
					providerId = e.currentTarget.value;
					model = '';
					void loadCatalog();
				}}
				><option value="">Not configured</option>{#each providers as p}<option value={p.id}
						>{p.name}</option
					>{/each}{#if providerId && !providers.some((p) => p.id === providerId)}<option
						value={providerId}>Saved connection is unavailable</option
					>{/if}</select
			></label
		>
		<label class="grid gap-1 text-sm"
			>Model from catalog<select
				class={selectClass}
				bind:value={model}
				disabled={!providerId || loading || saving}
				><option value="">Choose a speech model</option>{#each catalog?.models ?? [] as id}<option
						value={id}>{catalog?.details?.find((d) => d.id === id)?.nickname || id}</option
					>{/each}{#if model && !catalog?.models.includes(model)}<option value={model}
						>{model} (saved or manually entered, unverified)</option
					>{/if}</select
			></label
		>
		<label class="grid gap-1 text-sm"
			>Speech API model ID<Input
				bind:value={model}
				disabled={!providerId || saving}
				placeholder="Enter the documented speech model ID"
				autocomplete="off"
			/></label
		>
		{#if loading || catalogStatus}<p class="text-xs text-muted-foreground" role="status">
			{loading ? 'Loading speech selection and model catalog...' : catalogStatus}
		</p>{/if}
		<div class="flex flex-wrap gap-2">
			<Button type="submit" disabled={saving || !providerId || !model.trim()}
				>{saving ? 'Saving...' : 'Save dictation'}</Button
			><Button
				variant="ghost"
				disabled={!providerId || loading || saving}
				onclick={() => loadCatalog(true)}>Refresh</Button
			><Button variant="ghost" disabled={saving} onclick={() => save(true)}
				>Disable</Button
			><Button variant="ghost" disabled={saving || loading} onclick={load}>Reload</Button
			>
		</div>
	</form>
	{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
	{#if status}<p class="text-sm" role="status">{status}</p>{/if}
</section>
