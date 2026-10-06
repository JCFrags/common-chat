<script lang="ts">
	import { ICON_CLASS_DEFAULT } from '$lib/constants';
	import type { SettingsSection, SettingsSectionTitle } from '$lib/types';

	interface Props {
		sections: SettingsSection[];
		isActive: (section: SettingsSection) => boolean;
		onSectionChange?: (section: SettingsSectionTitle) => void;
	}

	let { isActive, onSectionChange, sections }: Props = $props();
</script>

<div class="hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-border/30 bg-muted/20 p-3 md:flex">
	<nav class="space-y-1" aria-label="Settings sections">
		{#each sections as section (section.title)}
			<button
				class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent {isActive(
					section
				)
					? 'bg-accent text-accent-foreground'
					: 'text-muted-foreground'}"
				aria-current={isActive(section) ? 'page' : undefined}
				onclick={() => onSectionChange?.(section.title)}
			>
				<section.icon class={ICON_CLASS_DEFAULT} />

				<span>{section.title}</span>
			</button>
		{/each}
	</nav>
</div>
