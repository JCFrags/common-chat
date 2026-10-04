import { commonStore } from '$lib/stores/common.svelte';

/** Common reports accepted release and frontend build identity. Unknown values stay absent. */
class VersionStore {
	get build(): string { return commonStore.session?.version ?? ''; }
	get frontend(): string {
		const frontend = commonStore.session?.frontend;
		return frontend?.sourceCommit && frontend.manifestSha256 ? `${frontend.sourceCommit}:${frontend.manifestSha256}` : '';
	}
	initialize(): void {}
}
export const versionStore = new VersionStore();
