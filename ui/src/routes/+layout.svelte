<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SidebarNavigation } from '$lib/components/app';
	import { PwaMetaTags, PwaRefreshAlert } from '$lib/components/pwa';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import {
		FAVICON_PATHS,
		FAVICON_SELECTORS,
		NEW_CHAT_TAB_ID,
		ROUTES,
		SETTINGS_KEYS,
		TOOLTIP_DELAY_DURATION
	} from '$lib/constants';
	import { useKeyboardShortcuts } from '$lib/hooks/use-keyboard-shortcuts.svelte';
	import { usePwa } from '$lib/hooks/use-pwa.svelte';
	import { RouterService } from '$lib/services/router.service';
	import {
		chatStore,
		conversationsStore,
		deviceStore,
		settingsStore,
		tabsStore,
		versionStore
	} from '$lib/stores';
	import { initStores } from '$lib/stores/init';
	import { commonStore } from '$lib/stores/common.svelte';
	import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import { Toaster } from 'svelte-sonner';
	import { pwaAssetsHead } from 'virtual:pwa-assets/head';

	let { children } = $props();

	let password = $state('');
	let loginError = $state('');
	let signingIn = $state(false);
	let initialized = $state(false);
	let cspNonce = $state<string | undefined>();

	async function signIn() {
		if (signingIn) return;
		signingIn = true; loginError = '';
		try {
			await commonStore.login(password); password = '';
			await conversationsStore.initialize();
		} catch (error) { loginError = error instanceof Error ? error.message : String(error); }
		finally { signingIn = false; }
	}
	async function signOut() {
		try {
			await commonStore.logout();
			draftMessagesStore.clearAll();
		} catch (error) { loginError = error instanceof Error ? error.message : String(error); }
	}

	let innerHeight = $state<number | undefined>();
	let innerWidth = $state(browser ? window.innerWidth : 0);

	let chatSidebar:
		| {
				activateSearchMode?: () => void;
				editActiveConversation?: () => void;
		  }
		| undefined = $state();

	let showBuildVersion = $derived(
		settingsStore.config[SETTINGS_KEYS.SHOW_BUILD_VERSION] as boolean
	);

	// Keep the hook object intact: destructuring needRefreshByStorage reads the getter once and freezes it
	const pwa = usePwa();
	const { needRefresh, updateServiceWorker } = pwa;

	function updateFavicon() {
		const dark = deviceStore.systemTheme.isDark;

		let icoLink = document.querySelector(FAVICON_SELECTORS.ICO_48X48) as HTMLLinkElement | null;

		if (icoLink) {
			icoLink.href = dark ? FAVICON_PATHS.ICO_DARK : FAVICON_PATHS.ICO_LIGHT;
		}

		let svgLink = document.querySelector(FAVICON_SELECTORS.SVG_ANY) as HTMLLinkElement | null;

		if (svgLink) {
			svgLink.href = dark ? FAVICON_PATHS.SVG_DARK : FAVICON_PATHS.SVG_LIGHT;
		}
	}

	function navigateToTab(direction: -1 | 1) {
		// only makes sense with conversation tabs enabled
		if (!settingsStore.config.conversationTabs) return;

		const openTabs = tabsStore.openTabs;

		if (openTabs.length === 0) return;

		const activeId = page.params.id ?? NEW_CHAT_TAB_ID;
		const idx = openTabs.indexOf(activeId);
		// active tab not in list (e.g. a non-chat route): start from an edge
		const targetIdx =
			idx === -1
				? direction === 1
					? 0
					: openTabs.length - 1
				: (idx + direction + openTabs.length) % openTabs.length;

		void tabsStore.activate(openTabs[targetIdx]);
	}

	function navigateToConversation(direction: -1 | 1) {
		const allConvs = conversationsStore.conversations;

		if (allConvs.length === 0) return;

		const currentId = page.params.id;

		if (!currentId) {
			goto(RouterService.chat(allConvs[direction === 1 ? 0 : allConvs.length - 1].id));

			return;
		}

		const idx = allConvs.findIndex((c) => c.id === currentId);

		if (idx === -1) return;

		const targetIdx = idx + direction;

		if (targetIdx >= 0 && targetIdx < allConvs.length) {
			goto(RouterService.chat(allConvs[targetIdx].id));
		} else {
			conversationsStore.openNewChat();
		}
	}

	// navigating away from the new-chat screen drops its tab, so it does not
	// linger once the user moves to a real conversation or another route
	let previousChatId = $state<string | undefined>(undefined);

	$effect(() => {
		const id = page.params.id ?? (page.route.id === '/(chat)' ? NEW_CHAT_TAB_ID : undefined);
		const prev = untrack(() => previousChatId);

		previousChatId = id;

		if (id !== prev && prev && settingsStore.config.conversationTabs && prev === NEW_CHAT_TAB_ID) {
			untrack(() => tabsStore.removeTabs([NEW_CHAT_TAB_ID]));
		}
	});
	// Global keyboard shortcuts
	const { handleKeydown } = useKeyboardShortcuts({
		editActiveConversation: () => chatSidebar?.editActiveConversation?.(),
		navigateToNextConversation: () => navigateToConversation(1),
		navigateToNextTab: () => navigateToTab(1),
		navigateToPrevConversation: () => navigateToConversation(-1),
		navigateToPrevTab: () => navigateToTab(-1)
	});

	onMount(() => {
		cspNonce = document.querySelector<HTMLMetaElement>('meta[name="common-chat-csp-nonce"]')?.content;
		updateFavicon();
		void initStores().finally(() => { initialized = true; });
	});

	// refresh that snapshot when the tab returns to the foreground, a stream may have advanced
	// or ended while it was hidden. snapshot only, no polling
	function handleVisibilityChange() {
		if (document.visibilityState !== 'visible') return;

		void chatStore.syncRemoteRunningStreams();
	}

	$effect(() => {
		void deviceStore.systemTheme.isDark;

		updateFavicon();
	});

	// Inject custom CSS at runtime through an action on the head style node
	// textContent keeps the value as text, never parsed as HTML
	function customCss(node: HTMLStyleElement) {
		$effect(() => {
			node.textContent = (settingsStore.config.customCss as string | undefined) ?? '';
		});
	}


</script>

<svelte:head>
	{#if pwaAssetsHead.themeColor}
		<meta content={pwaAssetsHead.themeColor.content} name="theme-color" />
	{/if}

	{#if settingsStore.config.customCss}
		<style nonce={cspNonce} use:customCss></style>
	{/if}

	{#each pwaAssetsHead.links as link (link.href)}
		<link {...link} />
	{/each}

	<PwaMetaTags />
</svelte:head>

<svelte:window bind:innerHeight bind:innerWidth onkeydown={handleKeydown} />
<svelte:document onvisibilitychange={handleVisibilityChange} />

<Tooltip.Provider delayDuration={TOOLTIP_DELAY_DURATION}>
	{#if !initialized}
		<p class="p-6" role="status">Connecting to Common...</p>
	{:else if !commonStore.session?.authenticated}
		<form class="mx-auto flex max-w-sm flex-col gap-3 p-6" onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
			<h1 class="text-xl">Sign in to Common</h1>
			<p>Conversation history and encrypted connection keys stay on the Common server. Device drafts stay on this browser until explicit sign-out.</p>
			<label for="common-password">Password</label>
			<input id="common-password" class="rounded border p-2" type="password" autocomplete="current-password" bind:value={password} required disabled={signingIn} />
			<button class="rounded border p-2" type="submit" disabled={signingIn}>{signingIn ? 'Signing in...' : 'Sign in'}</button>
			{#if loginError || commonStore.connectionError}<p role="alert">{loginError || commonStore.connectionError}</p>{/if}
			{#if draftMessagesStore.warning}<p role="status">{draftMessagesStore.warning}</p>{/if}
		</form>
	{:else}
		<div class="flex items-center justify-between gap-2 px-4 py-2 text-sm">
			<span>Common{commonStore.session.authenticationRequired === false ? ' · Trusted local access' : ''}</span>
			{#if commonStore.session.authenticationRequired !== false}<button type="button" class="underline" onclick={signOut}>Sign out and clear device drafts</button>{/if}
		</div>
		{#if commonStore.connectionError}<p class="px-4 text-sm" role="status">{commonStore.connectionError}</p>{/if}
	<div class="flex flex-col md:flex-row">
		<SidebarNavigation
			onSearchClick={() => {
				if (deviceStore.isMobile) {
					goto(ROUTES.SEARCH);
				} else if (chatSidebar?.activateSearchMode) {
					chatSidebar.activateSearchMode();
				}
			}}
		/>

		<!-- min-w-0 lets the chat column shrink below its content width, so wide
		     code blocks and tables scroll inside their own containers instead of
		     stretching the page into a horizontal scrollbar -->
		<div class="min-w-0 flex-1">
			{@render children?.()}
		</div>
	</div>
	{/if}

	<ModeWatcher />

	<Toaster closeButton richColors />
</Tooltip.Provider>

<!-- PWA update prompt + version -->
<div class="fixed right-4 bottom-4 z-9999 flex flex-col items-end gap-1">
	{#if showBuildVersion && versionStore.build}
		<span class="text-[10px] tabular-nums text-muted-foreground">{versionStore.build}</span>
	{/if}

	<PwaRefreshAlert
		forceReload={pwa.needRefreshByStorage}
		needRefresh={$needRefresh || pwa.needRefreshByStorage}
		{updateServiceWorker}
	/>
</div>
