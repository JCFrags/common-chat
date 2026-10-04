import { browser } from '$app/environment';
import { commonStore } from '$lib/stores/common.svelte';

/** Upstream route compatibility. The root layout handles Common cookie authentication. */
export async function validateApiKey(_fetch: typeof globalThis.fetch): Promise<void> {
	if (browser) await commonStore.initialize();
}
