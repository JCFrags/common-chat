import { ReasoningEffort } from '$lib/enums';
import { conversationsStore } from '$lib/stores';
import { commonStore } from '$lib/stores/common.svelte';
import type { ReasoningEffortLevel } from '$lib/types';
import { toast } from 'svelte-sonner';

export interface UseReasoningMenuReturn {
	readonly modelSupportsThinking: boolean;
	readonly thinkingEnabled: boolean;
	readonly isReasoningActive: boolean;
	readonly isOff: boolean;
	readonly currentEffort: ReasoningEffort;
	readonly levels: ReasoningEffortLevel[];
	isSelected(level: ReasoningEffortLevel): boolean;
	tokenLabel(level: ReasoningEffortLevel): string | null;
	select(level: ReasoningEffortLevel): void;
}

/** Use only declared protocol values. Model names and old replies do not declare support. */
export function useReasoningMenu(): UseReasoningMenuReturn {
	const declaration = $derived(commonStore.selectedThinking);
	const currentEffort = $derived(conversationsStore.preferences.getReasoningEffort());
	const modelSupportsThinking = $derived(declaration.protocol !== 'none');
	const isOff = $derived(currentEffort === ReasoningEffort.OFF || currentEffort === ReasoningEffort.NONE);
	const labels: Record<string, string> = { on: 'On', off: 'Off', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
	const levels = $derived<ReasoningEffortLevel[]>([
		{ label: 'Default', value: ReasoningEffort.DEFAULT },
		...(declaration.protocol === 'llama_cpp' ? ['on', 'off'] : declaration.protocol === 'none' ? [] : declaration.levels)
			.map((value) => ({ label: labels[value] ?? value, value: value as ReasoningEffort }))
	]);
	return {
		get currentEffort() { return currentEffort; }, get isOff() { return isOff; },
		get modelSupportsThinking() { return modelSupportsThinking; },
		get thinkingEnabled() { return modelSupportsThinking && currentEffort !== ReasoningEffort.DEFAULT && !isOff; },
		get isReasoningActive() { return modelSupportsThinking && currentEffort !== ReasoningEffort.DEFAULT && !isOff; },
		get levels() { return levels; }, isSelected(level) { return currentEffort === level.value; },
		select(level) { void conversationsStore.preferences.setReasoningEffort(level.value as ReasoningEffort).catch((error) => toast.error(error.message)); },
		tokenLabel(level) { return level.value === ReasoningEffort.DEFAULT ? 'No override' : declaration.protocol === 'llama_cpp' ? 'llama.cpp on/off' : 'Declared remote effort'; }
	};
}
