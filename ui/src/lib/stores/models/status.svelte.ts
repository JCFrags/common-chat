import type { ModelDownloadProgress, ModelLoadProgress } from '$lib/types/models';
import { toast } from 'svelte-sonner';

export const MODEL_RUNTIME_NOTICE = 'Common connects to an independently managed model service. Weight loading, unloading, downloads and cache operations are not available here. A model catalog does not verify inference readiness.';
export interface ModelStatusHost { error: string | null }

/** Keep the upstream control interface, but never forward endpoint runtime operations. */
export class ModelStatusManager {
	constructor(private host: ModelStatusHost) {}
	private unavailable(): never { this.host.error = MODEL_RUNTIME_NOTICE; toast.info(MODEL_RUNTIME_NOTICE); throw new Error(MODEL_RUNTIME_NOTICE); }
	async load(_id: string): Promise<void> { this.unavailable(); }
	async unload(_id: string): Promise<void> { this.unavailable(); }
	async cancelLoad(_id: string): Promise<void> { this.unavailable(); }
	async ensureLoaded(_id: string): Promise<void> { this.unavailable(); }
	async downloadModel(_id: string): Promise<void> { this.unavailable(); }
	async cancelDownload(_id: string): Promise<boolean> { this.unavailable(); }
	async pauseDownload(_id: string): Promise<void> { this.unavailable(); }
	getDownloadEntries(): { isPaused: boolean; progress: ModelDownloadProgress | null; repoWithTag: string }[] { return []; }
	getDownloadProgress(_id: string): ModelDownloadProgress | null { return null; }
	getLoadProgress(_id: string): ModelLoadProgress | null { return null; }
	getPausedDownloadProgress(_id: string): ModelDownloadProgress | null { return null; }
	hasFailedDownload(_id: string): boolean { return false; }
	isDownloadInProgress(_id: string): boolean { return false; }
	isDownloadPaused(_id: string): boolean { return false; }
	isModelDownloaded(_id: string): boolean { return false; }
	isOperationInProgress(_id: string): boolean { return false; }
	isSidecarDownloaded(_repo: string, _path: string): boolean { return false; }
	subscribe(): void {}
	unsubscribe(): void {}
}
