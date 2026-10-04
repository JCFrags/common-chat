<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { onMount } from 'svelte';
	import { api, catalogMessage, errorText, type Catalog, type Provider } from './api';

	let { onChanged = () => {} }: { onChanged?: () => Promise<void> | void } = $props();
	let providers = $state<Provider[]>([]),
		selectedId = $state('');
	let name = $state(''),
		baseUrl = $state(''),
		key = $state(''),
		clearKey = $state(false);
	let manualModels = $state(''),
		discovery = $state('auto'),
		metadata = $state('generic');
	let caps = $state<Record<string, boolean | string | string[]>>({});
	let error = $state(''),
		status = $state(''),
		saving = $state(false),
		loading = $state(false);
	let catalog = $state<Catalog | null>(null),
		catalogLoading = $state(false),
		catalogError = $state('');
	let profileModel = $state(''),
		nickname = $state(''),
		protocol = $state('inherit'),
		levels = $state('');
	let profileSaving = $state(false),
		profileError = $state('');
	let catalogTicket = 0;
	const provider = $derived(providers.find((item) => item.id === selectedId));
	const selectClass =
		'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-ring';
	const boolCaps = [
		['streaming', 'Streaming responses'],
		['systemPrompt', 'System prompt'],
		['vision', 'Image input'],
		['tools', 'Function-tool protocol'],
		['temperature', 'Temperature'],
		['topP', 'Top P'],
		['maxTokens', 'Token limit'],
		['presencePenalty', 'Presence penalty'],
		['frequencyPenalty', 'Frequency penalty'],
		['seed', 'Seed'],
		['llamaCppTimings', 'llama.cpp per-token timings and progress'],
		['llamaCppSampling', 'llama.cpp extended sampling'],
		['llamaCppThinkingBudget', 'llama.cpp thinking token budget']
	];
	function fill(id = selectedId) {
		selectedId = id;
		const item = providers.find((p) => p.id === id);
		name = item?.name ?? '';
		baseUrl = item?.baseUrl ?? '';
		key = '';
		clearKey = false;
		manualModels = item?.models?.join('\n') ?? '';
		discovery = item?.modelConfig?.discovery ?? (item?.models?.length ? 'manual' : 'auto');
		metadata = item?.modelConfig?.metadata ?? 'generic';
		caps = item
			? { ...item.capabilities }
			: {
					streaming: true,
					systemPrompt: true,
					temperature: true,
					topP: true,
					maxTokens: true,
					tokenParameter: 'max_tokens',
					audioInput: 'none',
					videoInput: 'none',
					thinking: 'none'
				};
		error = '';
		status = '';
		catalog = null;
		catalogError = '';
		profileModel = '';
		fillProfile();
		catalogTicket++;
		if (id) void loadCatalog();
	}
	async function loadProviders() {
		loading = true;
		error = '';
		try {
			providers = await api<Provider[]>('/api/providers');
			fill(providers.some((p) => p.id === selectedId) ? selectedId : '');
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	async function loadCatalog(refresh = false) {
		const id = selectedId,
			ticket = ++catalogTicket;
		if (!id) return;
		catalogLoading = true;
		catalogError = '';
		try {
			const result = await api<Catalog>(
				`/api/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=1' : ''}`
			);
			if (ticket === catalogTicket && selectedId === id) catalog = result;
		} catch (e) {
			if (ticket === catalogTicket) catalogError = errorText(e);
		} finally {
			if (ticket === catalogTicket) catalogLoading = false;
		}
	}
	async function save() {
		if (saving) return;
		const id = selectedId;
		saving = true;
		error = '';
		status = '';
		try {
			const updated = await api<Provider>(
				id ? `/api/providers/${encodeURIComponent(id)}` : '/api/providers',
				id ? 'PUT' : 'POST',
				{
					name,
					baseUrl,
					apiKey: key,
					clearKey,
					models: manualModels
						.split(/\r?\n/)
						.map((value) => value.trim())
						.filter(Boolean),
					capabilities: caps,
					modelConfig: { discovery, metadata, profiles: provider?.modelConfig?.profiles ?? [] }
				}
			);
			key = '';
			clearKey = false;
			providers = await api<Provider[]>('/api/providers');
			fill(updated.id);
			status = 'Connection saved. No inference or transcription test was run.';
			await onChanged();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
	async function remove() {
		const id = selectedId;
		if (
			!id ||
			saving ||
			!confirm(
				'Delete this connection? Saved messages remain. Its dictation selection may become unavailable.'
			)
		)
			return;
		saving = true;
		error = '';
		try {
			await api(`/api/providers/${encodeURIComponent(id)}`, 'DELETE');
			selectedId = '';
			await loadProviders();
			await onChanged();
			status = 'Connection deleted.';
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
	function fillProfile() {
		const profile = providers
			.find((p) => p.id === selectedId)
			?.modelConfig?.profiles?.find((p) => p.id === profileModel);
		nickname = profile?.nickname ?? '';
		protocol = profile?.thinking?.protocol ?? 'inherit';
		levels = profile?.thinking?.levels?.join(', ') ?? '';
		profileError = '';
	}
	async function saveProfile() {
		const id = selectedId,
			model = profileModel.trim();
		if (!id || !model || profileSaving) return;
		profileSaving = true;
		profileError = '';
		try {
			const updated = await api<Provider>(
				`/api/providers/${encodeURIComponent(id)}/models`,
				'PATCH',
				{
					model,
					nickname,
					thinking:
						protocol === 'inherit'
							? null
							: {
									protocol,
									...(['reasoning_effort', 'openrouter_reasoning'].includes(protocol)
										? { levels: levels.split(/[\s,]+/).filter(Boolean) }
										: {})
								}
				}
			);
			providers = providers.map((p) => (p.id === id ? updated : p));
			status = 'Nickname and thinking declaration saved. The API model ID is unchanged.';
			await loadCatalog();
			await onChanged();
		} catch (e) {
			profileError = errorText(e);
		} finally {
			profileSaving = false;
		}
	}
	onMount(() => {
		fill('');
		void loadProviders();
	});
</script>

<section class="space-y-4" aria-label="Common connections">
	<p class="text-sm text-muted-foreground">
		Connections and encrypted credentials stay on the Common server. This editor never reads or
		exports saved keys. Capability declarations must match your endpoint. They are not tested or
		inferred from model names.
	</p>
	<div class="flex items-end gap-2">
		<label class="grid flex-1 gap-1 text-sm"
			>Connection<select
				class={selectClass}
				value={selectedId}
				disabled={saving || loading}
				onchange={(e) => fill(e.currentTarget.value)}
				><option value="">New connection</option>{#each providers as p}<option value={p.id}
						>{p.name}</option
					>{/each}</select
			></label
		>
		<Button variant="ghost" disabled={saving || loading} onclick={loadProviders}>Reload</Button>
	</div>
	<form
		class="space-y-4"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<fieldset disabled={saving} class="space-y-4">
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="grid gap-1 text-sm"
					>Name<Input bind:value={name} required maxlength={200} autocomplete="off" /></label
				>
				<label class="grid gap-1 text-sm"
					>OpenAI-compatible base URL<Input
						bind:value={baseUrl}
						type="url"
						required
						placeholder="https://example.org/v1"
						autocomplete="off"
					/></label
				>
			</div>
			<label class="grid gap-1 text-sm"
				>API key<Input
					bind:value={key}
					type="password"
					autocomplete="new-password"
					placeholder={provider?.hasKey
						? 'A key is saved. Leave blank to retain it.'
						: 'Optional key'}
				/></label
			>
			<label class="flex items-center gap-2 text-sm"
				><input type="checkbox" bind:checked={clearKey} /> Explicitly clear the saved key</label
			>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="grid gap-1 text-sm"
					>Model discovery<select class={selectClass} bind:value={discovery}
						><option value="auto">Automatic /models discovery</option><option value="manual"
							>Manual model IDs</option
						></select
					></label
				>
				<label class="grid gap-1 text-sm"
					>Model metadata<select class={selectClass} bind:value={metadata}
						><option value="generic">Generic, no inferred thinking levels</option><option
							value="openrouter">OpenRouter-compatible reasoning metadata</option
						></select
					></label
				>
			</div>
			<label class="grid gap-1 text-sm"
				>{discovery === 'manual'
					? 'Manual IDs, one per line'
					: 'Saved fallback IDs, one per line'}<Textarea
					bind:value={manualModels}
					rows={3}
					spellcheck={false}
				/></label
			>
			<p class="text-xs text-muted-foreground">
				Automatic discovery calls /models even when fallback IDs exist. Manual IDs and cached
				catalogs do not prove reachability. Saving these fields does not change the chat selection.
			</p>
			<details class="rounded-md border p-3">
				<summary class="cursor-pointer text-sm font-medium"
					>Endpoint capability declarations</summary
				>
				<div class="mt-3 grid gap-2 sm:grid-cols-2">
					{#each boolCaps as [cap, title]}<label class="flex items-center gap-2 text-sm"
							><input
								type="checkbox"
								checked={caps[cap] === true}
								onchange={(e) => (caps[cap] = e.currentTarget.checked)}
							/>{title}</label
						>{/each}
				</div>
				<div class="mt-3 grid gap-3 sm:grid-cols-2">
					<label class="grid gap-1 text-sm"
						>Token parameter<select
							class={selectClass}
							value={String(caps.tokenParameter ?? 'max_tokens')}
							onchange={(e) => (caps.tokenParameter = e.currentTarget.value)}
							><option value="max_tokens">max_tokens</option><option value="max_completion_tokens"
								>max_completion_tokens</option
							></select
						></label
					>
					<label class="grid gap-1 text-sm"
						>Native audio attachment input<select
							class={selectClass}
							value={String(caps.audioInput ?? 'none')}
							onchange={(e) => (caps.audioInput = e.currentTarget.value)}
							><option value="none">None</option><option value="llama_cpp">llama_cpp</option
							></select
						></label
					>
					<label class="grid gap-1 text-sm"
						>Native video attachment input<select
							class={selectClass}
							value={String(caps.videoInput ?? 'none')}
							onchange={(e) => (caps.videoInput = e.currentTarget.value)}
							><option value="none">None</option><option value="llama_cpp">llama_cpp</option
							></select
						></label
					>
				</div>
				<p class="mt-2 text-xs text-muted-foreground">
					Native attachments are separate from speech-to-text dictation. llama.cpp thinking budgets
					apply only to a resolved llama_cpp declaration. Seed and penalties require their
					independent declaration or llamaCppSampling.
				</p>
			</details>
			<div class="flex flex-wrap gap-2">
				<Button type="submit">{saving ? 'Saving...' : 'Save connection'}</Button
				>{#if provider}<Button variant="ghost" onclick={remove}>Delete connection</Button>{/if}
			</div>
		</fieldset>
	</form>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if status}<p role="status" class="text-sm">{status}</p>{/if}
	{#if provider}
		<section class="space-y-3 rounded-lg border p-3" aria-label="Model catalog and profiles">
			<div class="flex flex-wrap items-center gap-2">
				<h3 class="flex-1 text-sm font-medium">Model catalog and declarations</h3>
				<Button
					size="sm"
					variant="ghost"
					disabled={catalogLoading || saving || profileSaving}
					onclick={() => loadCatalog(true)}>Refresh discovery</Button
				>
			</div>
			<p class="text-sm" role="status">
				{catalogLoading
					? 'Checking model catalog...'
					: catalogError || (catalog ? catalogMessage(catalog) : 'Catalog has not been checked.')}
			</p>
			<label class="grid gap-1 text-sm"
				>Model from catalog<select
					class={selectClass}
					value={profileModel}
					onchange={(e) => {
						profileModel = e.currentTarget.value;
						fillProfile();
					}}
					><option value="">Choose a model</option>{#each catalog?.models ?? [] as id}<option
							value={id}
							>{catalog?.details?.find((d) => d.id === id)?.nickname ||
								catalog?.details?.find((d) => d.id === id)?.name ||
								id} ({id})</option
						>{/each}{#if profileModel && !catalog?.models.includes(profileModel)}<option
							value={profileModel}>{profileModel} (not in current list)</option
						>{/if}</select
				></label
			>
			<form
				class="space-y-3"
				onsubmit={(e) => {
					e.preventDefault();
					void saveProfile();
				}}
			>
				<label class="grid gap-1 text-sm"
					>API model ID<Input
						bind:value={profileModel}
						onchange={fillProfile}
						autocomplete="off"
					/></label
				>
				<label class="grid gap-1 text-sm"
					>Display nickname<Input bind:value={nickname} autocomplete="off" /></label
				>
				<label class="grid gap-1 text-sm"
					>Thinking declaration<select class={selectClass} bind:value={protocol}
						><option value="inherit">Inherit connection or recognized metadata</option><option
							value="none">None, no override support</option
						><option value="llama_cpp">llama.cpp On/Off</option><option value="reasoning_effort"
							>reasoning_effort</option
						><option value="openrouter_reasoning">OpenRouter reasoning.effort</option></select
					></label
				>
				{#if ['reasoning_effort', 'openrouter_reasoning'].includes(protocol)}<label
						class="grid gap-1 text-sm"
						>Documented supported levels, separated by commas<Input
							bind:value={levels}
							placeholder="none, low, medium, high"
						/></label
					>{/if}
				<p class="text-xs text-muted-foreground">
					No support is inferred from a model ID or returned reasoning. Effort levels must be
					documented by the service. llama.cpp On/Off is not an effort-level scale. Inherit clears
					the per-model declaration.
				</p>
				{#if catalog?.details?.find((d) => d.id === profileModel)?.thinking}<p class="text-xs">
						Catalog support: {catalog?.details?.find((d) => d.id === profileModel)?.thinking
							?.protocol}. Source: {catalog?.details?.find((d) => d.id === profileModel)?.thinking
							?.source || 'unavailable'}.
					</p>{/if}
				<Button type="submit" size="sm" disabled={!profileModel.trim() || profileSaving || saving}
					>{profileSaving ? 'Saving...' : 'Save nickname and declaration'}</Button
				>
			</form>
			{#if profileError}<p role="alert" class="text-sm text-destructive">{profileError}</p>{/if}
		</section>
	{/if}
</section>
