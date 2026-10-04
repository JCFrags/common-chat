<script lang="ts">
	import { ModelsSelectorDropdown, ModelsSelectorSheet } from '$lib/components/app';
	import { conversationsStore, deviceStore, modelsStore, serverStore } from '$lib/stores';
	import { getConversationModel } from '$lib/utils';

	interface Props {
		disabled?: boolean;
		forceForegroundText?: boolean;
		hasAudioModality?: boolean;
		hasVideoModality?: boolean;
		hasVisionModality?: boolean;
		hasModelSelected?: boolean;
		isSelectedModelInCache?: boolean;
		submitTooltip?: string;
		useGlobalSelection?: boolean;
	}

	let {
		disabled = false,
		forceForegroundText = false,
		hasAudioModality = $bindable(false),
		hasModelSelected = $bindable(false),
		hasVideoModality = $bindable(false),
		hasVisionModality = $bindable(false),
		isSelectedModelInCache = $bindable(true),
		submitTooltip = $bindable(''),
		useGlobalSelection = false
	}: Props = $props();

	let isRouter = $derived(serverStore.isRouterMode);
	let isOffline = $derived(!!serverStore.error);

	let conversationModel = $derived(
		getConversationModel(conversationsStore.activeMessages as DatabaseMessage[])
	);

	// Replies can have the same model ID on another connection. Never retarget selection from history.
	let selectorModel = $derived(modelsStore.selectedModelName);

	let activeModelId = $derived(modelsStore.activeModelId);

	let modelPropsVersion = $state(0); // Used to trigger reactivity after fetch

	$effect(() => {
		if (activeModelId) {
			const cached = modelsStore.props.getModelProps(activeModelId);

			if (!cached) {
				modelsStore.props.fetchModelProps(activeModelId).then(() => {
					modelPropsVersion++;
				});
			}
		}
	});

	$effect(() => {
		void modelPropsVersion;

		hasAudioModality = activeModelId ? modelsStore.props.modelSupportsAudio(activeModelId) : false;
	});

	$effect(() => {
		void modelPropsVersion;

		hasVideoModality = activeModelId ? modelsStore.props.modelSupportsVideo(activeModelId) : false;
	});

	$effect(() => {
		void modelPropsVersion;

		hasVisionModality = activeModelId
			? modelsStore.props.modelSupportsVision(activeModelId)
			: false;
	});

	$effect(() => {
		hasModelSelected = !!modelsStore.selectedModelId;
	});

	$effect(() => {
		const currentModelId = modelsStore.selectedModelId;
		isSelectedModelInCache = !!currentModelId && modelsStore.models.some((option) => option.id === currentModelId);
	});

	$effect(() => {
		if (!hasModelSelected) {
			submitTooltip = 'Please select a model first';
		} else if (!isSelectedModelInCache) {
			submitTooltip = 'Selected model is not available, please select another';
		} else {
			submitTooltip = '';
		}
	});

	let selectorModelRef: ModelsSelectorDropdown | ModelsSelectorSheet | undefined =
		$state(undefined);

	export function open() {
		selectorModelRef?.open();
	}
</script>

{#if deviceStore.isMobile}
	<ModelsSelectorSheet
		bind:this={selectorModelRef}
		currentModel={selectorModel}
		disabled={disabled || isOffline}
		{forceForegroundText}
		{useGlobalSelection}
	/>
{:else}
	<ModelsSelectorDropdown
		bind:this={selectorModelRef}
		currentModel={selectorModel}
		disabled={disabled || isOffline}
		{forceForegroundText}
		{useGlobalSelection}
	/>
{/if}
