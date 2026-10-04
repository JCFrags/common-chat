import { ServerRole } from '$lib/enums';
import { commonStore } from '$lib/stores/common.svelte';

/** Compatibility view for upstream selectors. It makes no llama.cpp management requests. */
class ServerStore {
	props: ApiLlamaCppServerProps | null = null;
	loading = $state(false);
	get error(): string | null { return commonStore.session?.authenticated ? null : commonStore.connectionError; }
	get status(): number | null { return null; }
	role = $state<ServerRole>(ServerRole.ROUTER);
	get contextSize(): number | null { return null; }
	get defaultParams(): ApiLlamaCppServerProps['default_generation_settings']['params'] | null { return null; }
	get isModelMode(): boolean { return false; }
	get isRouterMode(): boolean { return true; }
	get uiSettings(): Record<string, string | number | boolean> | undefined { return undefined; }
	clear(): void {}
	async fetch(_options?: { background?: boolean }): Promise<void> { await commonStore.initialize(); }
}
export const serverStore = new ServerStore();
