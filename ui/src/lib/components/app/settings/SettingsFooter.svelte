<script lang="ts">
	import { RotateCcw } from '@lucide/svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { settingsStore } from '$lib/stores';

	interface Props {
		onReset?: () => void;
		onSave?: () => void;
	}

	let { onReset, onSave }: Props = $props();

	let showResetDialog = $state(false);

	function handleResetClick() {
		showResetDialog = true;
	}

	function handleConfirmReset() {
		settingsStore.forceSyncWithServerDefaults();
		onReset?.();

		showResetDialog = false;
	}

	function handleSave() {
		onSave?.();
	}
</script>

<div class="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/30 bg-background/95 px-4 py-3 backdrop-blur-md md:px-6">
	<div class="flex gap-2">
		<Button onclick={handleResetClick} variant="ghost" size="sm">
			<RotateCcw class="h-3 w-3" />

			Reset preferences
		</Button>
	</div>

	<Button onclick={handleSave} size="sm">Save preferences</Button>
</div>

<AlertDialog.Root bind:open={showResetDialog}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Reset Settings to Default</AlertDialog.Title>

			<AlertDialog.Description>
				Reset device preferences and generation parameters to the server defaults? This removes
				your device overrides. Saved connections, credentials, dictation, and MCP choices are not reset.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>

			<AlertDialog.Action onclick={handleConfirmReset}>Reset to Default</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
