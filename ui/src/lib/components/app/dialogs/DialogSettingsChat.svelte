<script lang="ts">
	import { Settings } from '@lucide/svelte';
	import { SettingsChat } from '$lib/components/app/settings';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		initialSection?: string;
	}

	let { initialSection, onOpenChange, open = $bindable(false) }: Props = $props();

	function handleOpenChange(value: boolean) {
		open = value;
		onOpenChange?.(value);
	}
</script>

<Dialog.Root onOpenChange={handleOpenChange} {open}>
	<Dialog.Content
		showCloseButton
		class="flex h-[calc(100dvh-2rem)]! max-h-240! w-[calc(100vw-2rem)]! max-w-6xl! flex-col gap-0 overflow-hidden rounded-2xl bg-background/95 p-0 shadow-xl backdrop-blur-xl md:h-[calc(100dvh-4rem)]! md:w-[calc(100vw-4rem)]!"
	>
		<Dialog.Header showCloseButton={false} class="shrink-0 border-b border-border/30 p-4 pr-12 md:px-6 md:py-5">
			<Dialog.Title class="flex items-center gap-2">
				<Settings class="h-5 w-5" />

				<span>Settings</span>
			</Dialog.Title>
			<Dialog.Description class="sr-only">Device preferences, connections, dictation, tools, and app information.</Dialog.Description>
		</Dialog.Header>

		<SettingsChat {initialSection} onClose={() => (open = false)} onSectionChange={() => {}} />
	</Dialog.Content>
</Dialog.Root>
