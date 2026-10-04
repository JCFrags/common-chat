import { conversationsStore } from './conversations/index.svelte';
import { commonStore } from './common.svelte';
import { settingsStore } from './settings/index.svelte';
import { tabsStore } from './tabs.svelte';
import { versionStore } from './version.svelte';
import { browser } from '$app/environment';

let startup: Promise<void> | null = null;

/** Device preferences only. Common owns history, authentication and native jobs. */
export function initStores(): Promise<void> {
	if (!browser) return Promise.resolve();
	startup ??= (async () => {
		settingsStore.initialize();
		await commonStore.initialize();
		void versionStore.initialize();
		if (commonStore.session?.authenticated) {
			await conversationsStore.initialize();
			tabsStore.init(conversationsStore.conversations.map((conversation) => conversation.id));
		}
	})();
	return startup;
}
