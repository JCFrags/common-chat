import { ModelModality } from '$lib/enums';
import { commonStore } from '$lib/stores/common.svelte';
import type { ModelOption, ModelModalities } from '$lib/types/models';

export interface ModelPropsHost {
	readonly models: ModelOption[];
	readonly selectedModelName: string | null;
	readonly loadedModelIds: string[];
	isModelLoaded(modelId: string): boolean;
}

/** Declared Common capabilities only. No template/name heuristic or /props probe. */
export class ModelPropsManager {
	constructor(private host: ModelPropsHost) {}
	get cacheVersion(): number { return commonStore.catalogs.get(commonStore.selectedProviderId)?.checkedAt ?? 0; }
	get supportsThinking(): boolean { return commonStore.selectedThinking.protocol !== 'none'; }
	checkModelSupportsThinking(id: string): boolean {
		return commonStore.catalogs.get(commonStore.selectedProviderId)?.details.find((d) => d.id === id)?.thinking.protocol !== 'none'
			&& !!commonStore.catalogs.get(commonStore.selectedProviderId)?.details.find((d) => d.id === id);
	}
	getModelContextSize(_id: string): null { return null; }
	getModelModalities(id: string): ModelModalities | null {
		return this.host.models.find((m) => m.model === id || m.id === id)?.modalities ?? null;
	}
	getModelModalitiesArray(id: string): ModelModality[] {
		const m = this.getModelModalities(id); if (!m) return [];
		return [...(m.vision ? [ModelModality.VISION] : []), ...(m.audio ? [ModelModality.AUDIO] : []), ...(m.video ? [ModelModality.VIDEO] : [])];
	}
	getModelProps(id: string): ApiLlamaCppServerProps | null {
		const modalities = this.getModelModalities(id);
		if (!modalities) return null;
		// A compatibility view, not a llama.cpp server response. Unknown metadata stays absent.
		return { modalities, default_generation_settings: { params: {} }, ui: true } as unknown as ApiLlamaCppServerProps;
	}
	async fetchModelProps(id: string): Promise<ApiLlamaCppServerProps | null> { return this.getModelProps(id); }
	async fetchModalitiesForLoadedModels(): Promise<void> {}
	async updateModelModalities(_id: string): Promise<void> {}
	isModelPropsFetching(_id: string): boolean { return false; }
	modelSupportsAudio(id: string): boolean { return this.getModelModalities(id)?.audio ?? false; }
	modelSupportsVideo(id: string): boolean { return this.getModelModalities(id)?.video ?? false; }
	modelSupportsVision(id: string): boolean { return this.getModelModalities(id)?.vision ?? false; }
	buildArchitectureModalities(architecture: ApiModelDataEntry['architecture']): ModelModalities | undefined {
		if (!architecture) return undefined;
		return { vision: architecture.input_modalities.includes('image'), audio: architecture.input_modalities.includes('audio'), video: architecture.input_modalities.includes('video') };
	}
}
