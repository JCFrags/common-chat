<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import {
		SettingsChatDesktopSidebar,
		SettingsChatFields,
		SettingsChatImportExportTab,
		SettingsChatMobileHeader,
		SettingsFooter
	} from '$lib/components/app/settings';
	import { Button } from '$lib/components/ui/button';
	import {
		NUMERIC_FIELDS,
		POSITIVE_INTEGER_FIELDS,
		SETTINGS_CHAT_SECTIONS,
		SETTINGS_SECTION_SLUGS
	} from '$lib/constants';
	import { ColorMode } from '$lib/enums/ui.enums';
	import { modelsStore, serverStore, settingsStore } from '$lib/stores';
	import { commonStore } from '$lib/stores/common.svelte';
	import { generationSettings } from '$lib/utils/common-settings';
	import { sanitizeDeviceConfig } from '$lib/services/settings.service';
	import type { SettingsSection, SettingsSectionTitle } from '$lib/types';
	import { setMode } from 'mode-watcher';
	import { fade } from 'svelte/transition';
	interface Props {
		initialSection?: string;
		onSectionChange?: (section: SettingsSectionTitle) => void;
		onClose?: () => void;
	}

	let { initialSection, onClose, onSectionChange }: Props = $props();

	let activeSlug = $derived(initialSection ?? 'general');

	function handleSectionChange(section: SettingsSectionTitle) {
		const found = SETTINGS_CHAT_SECTIONS.find((s) => s.title === section);

		if (found) {
			activeSlug = found.slug;
		}

		onSectionChange?.(section);
	}

	let currentSection = $derived(
		SETTINGS_CHAT_SECTIONS.find((section) => section.slug === activeSlug) ||
			SETTINGS_CHAT_SECTIONS[0]
	);

	let localConfig: SettingsConfigType = $state({ ...settingsStore.config });

	let mobileHeader: { updateCarousel: () => void } | undefined;

	let fetchInitiated = false;

	$effect(() => {
		if (serverStore.isRouterMode && currentSection.fields?.length && !fetchInitiated) {
			fetchInitiated = true;

			void modelsStore
				.fetch()
				.then(() => modelsStore.fetchRouterModels())
				.then(() => modelsStore.props.fetchModalitiesForLoadedModels())
				.then(() => modelsStore.ensureFirstModelSelected());
		}
	});

	function handleThemeChange(newTheme: string) {
		localConfig.theme = newTheme;
		setMode(newTheme as ColorMode);
	}

	function handleConfigChange(key: string, value: string | boolean) {
		localConfig[key] = value;
	}

	function handleReset() {
		localConfig = { ...settingsStore.config };
		setMode(localConfig.theme as ColorMode);
		mobileHeader?.updateCarousel();
	}

	function handleSave() {
		if (
			localConfig.customJson &&
			typeof localConfig.customJson === 'string' &&
			localConfig.customJson.trim()
		) {
			try {
				JSON.parse(localConfig.customJson);
			} catch (error) {
				alert('Invalid JSON in custom parameters. Please check the format and try again.');
				console.error(error);

				return;
			}
		}

		const processedConfig = { ...localConfig };

		for (const field of NUMERIC_FIELDS) {
			if (processedConfig[field] !== undefined && processedConfig[field] !== '') {
				const numValue = Number(processedConfig[field]);

				if (Number.isFinite(numValue)) {
					if ((POSITIVE_INTEGER_FIELDS as readonly string[]).includes(field) && !Number.isInteger(numValue)) {
						alert(`${field} must be an integer. The value was not changed.`); return;
					}
					processedConfig[field] = numValue;
				} else {
					alert(`Invalid numeric value for ${field}. Please enter a valid number.`);

					return;
				}
			}
		}

		try {
			if (processedConfig.customJson && !sanitizeDeviceConfig(processedConfig).customJson) {
				throw new Error('Custom JSON accepts typed sampling settings only. Model, messages, tools, credentials and URL overrides are not saved.');
			}
			if (commonStore.selectedProvider) generationSettings(processedConfig, {}, commonStore.selectedProvider, commonStore.selectedThinking);
		} catch (error) { alert(error instanceof Error ? error.message : String(error)); return; }
		settingsStore.updateMultipleConfig(processedConfig);
		onClose?.();
	}

	export function reset() {
		localConfig = { ...settingsStore.config };
	}
</script>

<div in:fade={{ duration: 150 }} class="mx-auto flex h-full w-full flex-col">
	<div class="flex flex-1 flex-col md:flex-row md:gap-4">
		<SettingsChatDesktopSidebar
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<SettingsChatMobileHeader
			bind:this={mobileHeader}
			isActive={(section: SettingsSection) => section.slug === activeSlug}
			onSectionChange={handleSectionChange}
			sections={SETTINGS_CHAT_SECTIONS}
		/>

		<div class="mx-auto max-w-2xl px-4 flex-1 md:mt-4">
			<div class="space-y-6 pt-3">
				<div class="grid">
					{#if currentSection.slug === SETTINGS_SECTION_SLUGS.TOOLS}
						<p>Configured native function tools are available automatically. Each new turn checks connection capabilities and runner availability. Saved activity does not grant future permission. Manual Run and package consent stay separate. Native tool budgets are off unless explicitly set. Browser MCP, host working directories and raw llama.cpp management are disabled.</p>
					{:else if currentSection.slug === SETTINGS_SECTION_SLUGS.IMPORT_EXPORT}
						<SettingsChatImportExportTab />
					{:else if currentSection.fields}
						<div class="space-y-6">
							<SettingsChatFields
								fields={currentSection.fields.filter((field) => field.key !== 'apiKey' && field.key !== 'mcpServers')}
								{localConfig}
								onConfigChange={handleConfigChange}
								onThemeChange={handleThemeChange}
							/>

							{#if currentSection.slug === SETTINGS_SECTION_SLUGS.GENERAL}
								<div class="flex justify-end">
									<Button onclick={() => window.location.reload()} variant="outline">
										<RefreshCw class="h-3 w-3" />
										Reload app
									</Button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="mt-8 border-t border-border/30 pt-6">
					<p class="text-xs text-muted-foreground">Display and typed generation preferences are device-local. Connection keys stay encrypted on Common. Unsupported sampling fields are rejected. Blank values defer to the connection. Catalog availability does not prove that inference is ready.</p>
				</div>
			</div>

			<SettingsFooter onReset={handleReset} onSave={handleSave} />
		</div>
	</div>
</div>
