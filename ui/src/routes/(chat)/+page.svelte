<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { DialogModelNotAvailable } from '$lib/components/app';
	import { APP_NAME, URL_PARAMS } from '$lib/constants';
	import { conversationsStore, modelsStore } from '$lib/stores';
	import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
	import { onMount } from 'svelte';

	let qParam = $derived(page.url.searchParams.get(URL_PARAMS.QUERY));
	let modelParam = $derived(page.url.searchParams.get(URL_PARAMS.MODEL));

	let showModelNotAvailable = $state(false);
	let requestedModelName = $state('');
	let availableModelNames = $derived(modelsStore.models.map((m) => m.model));

	// Clear params after handling the deep link so a refresh does not replay them
	function clearUrlParams() {
		const url = new URL(page.url);

		url.searchParams.delete(URL_PARAMS.QUERY);
		url.searchParams.delete(URL_PARAMS.MODEL);
		url.searchParams.delete(URL_PARAMS.LOAD);

		replaceState(url.toString(), {});
	}

	async function handleUrlParams() {
		await modelsStore.fetch();

		if (modelParam) {
			const model = modelsStore.findModelByName(modelParam);

			if (model) {
				try {
					await modelsStore.selectModelById(model.id);

				} catch (error) {
					console.error('Failed to select model:', error);
					requestedModelName = modelParam;
					showModelNotAvailable = true;

					return;
				}
			} else {
				requestedModelName = modelParam;
				showModelNotAvailable = true;

				return;
			}
		}

		// Links populate an unsent draft. They never start inference or load model weights.
		if (qParam !== null) {
			if (draftMessagesStore.setLinkDraft('new', qParam)) clearUrlParams();
		} else if (modelParam) {
			clearUrlParams();
		}
	}

	onMount(async () => {
		if (!conversationsStore.isInitialized) {
			await conversationsStore.initialize();
		}

		conversationsStore.clearActiveConversation();

		await modelsStore.fetch();

		if (qParam !== null || modelParam !== null) {
			await handleUrlParams();
		}

		await modelsStore.ensureFirstModelSelected();
	});
</script>

<svelte:head>
	<title>{APP_NAME}</title>
</svelte:head>

<DialogModelNotAvailable
	bind:open={showModelNotAvailable}
	availableModels={availableModelNames}
	modelName={requestedModelName}
/>
