/** Common provider/model selection. Catalog availability is not inference readiness. */
import { FAVORITE_MODELS_LOCALSTORAGE_KEY } from '$lib/constants';
import { commonStore } from '$lib/stores/common.svelte';
import { ModelPropsManager } from './props.svelte';
import { ModelStatusManager } from './status.svelte';
import type { ModelOption } from '$lib/types/models';
import { SvelteSet } from 'svelte/reactivity';

export const modelSelectionId = (providerId: string, model: string) => `${encodeURIComponent(providerId)}::${encodeURIComponent(model)}`;
class ModelsStore {
	error = $state<string | null>(null);
	loading = $state(false);
	updating = $state(false);
	favoriteModelIds = $state<Set<string>>(this.loadFavorites());
	models = $derived.by((): ModelOption[] => {
		const provider = commonStore.selectedProvider;
		if (!provider) return [];
		const catalog = commonStore.catalogs.get(provider.id);
		return (catalog?.models ?? provider.models).map((model) => {
			const detail = catalog?.details.find((d) => d.id === model);
			const name = detail?.nickname || detail?.name || model;
			return { id: modelSelectionId(provider.id, model), model,
				name, aliases: name === model ? undefined : [name], capabilities: [],
				modalities: { vision: provider.capabilities.vision === true,
					audio: provider.capabilities.audioInput === 'llama_cpp', video: provider.capabilities.videoInput === 'llama_cpp' } };
		});
	});
	// Common does not report weight load status, cache paths or runtime arguments.
	routerModels = $state<ApiModelDataEntry[]>([]);
	selectedModelName = $derived(commonStore.selectedModel || null);
	selectedModelId = $derived(commonStore.selectedModel ? modelSelectionId(commonStore.selectedProviderId, commonStore.selectedModel) : null);
	private _props = new ModelPropsManager(this);
	private _status = new ModelStatusManager(this);
	private inflight: Promise<void> | null = null;
	constructor() {
		commonStore.subscribe((change) => {
			if ((change.type === 'providers' || change.type === 'session') && commonStore.session?.authenticated) {
				void this.fetch().catch(() => {});
			}
		});
	}
	get props() { return this._props; }
	get status() { return this._status; }
	get activeModelId(): string | null { return this.selectedModelName; }
	get selectedModel(): ModelOption | null { return this.models.find((m) => m.id === this.selectedModelId) ?? null; }
	get selectedModelContextSize(): number | null { return null; }
	get singleModelName(): string | null { return null; }
	get loadedModelIds(): string[] { return []; }
	get catalog() { return commonStore.catalogs.get(commonStore.selectedProviderId) ?? null; }
	get catalogNotice(): string {
		const catalog = this.catalog;
		if (!catalog) return 'Model catalog has not been checked. Inference readiness is unknown.';
		return `Catalog: ${catalog.catalogState} (${catalog.source}). ${catalog.error ?? 'Model listing does not verify inference readiness.'}`;
	}
	fetch(force = false): Promise<void> {
		if (this.inflight) return this.inflight;
		this.inflight = (async () => {
			this.loading = true; this.error = null;
			try {
				if (!commonStore.session?.authenticated) await commonStore.initialize();
				if (!commonStore.session?.authenticated) return;
				if (!commonStore.providers.length) await commonStore.refreshProviders();
				let id = commonStore.selectedProviderId;
				while (id && commonStore.selectedProvider) {
					if (force || !commonStore.catalogs.has(id)) await commonStore.refreshCatalog(id, force);
					if (id === commonStore.selectedProviderId && commonStore.catalogs.has(id)) break;
					id = commonStore.selectedProviderId;
				}
			} catch (error) { this.error = error instanceof Error ? error.message : String(error); throw error; }
			finally { this.loading = false; }
		})().finally(() => { this.inflight = null; });
		return this.inflight;
	}
	async fetchRouterModels(): Promise<void> { await this.fetch(); }
	async ensureFirstModelSelected(): Promise<void> {
		// Selection is an account preference. Do not silently switch to another model.
		await this.fetch();
	}
	async selectModelById(id: string): Promise<void> {
		const model = this.models.find((m) => m.id === id || m.model === id);
		if (!model) throw new Error('This model is not in the selected connection catalog.');
		this.updating = true;
		try { await commonStore.selectModel(model.model); }
		finally { this.updating = false; }
	}
	selectModelByName(name: string): void { void this.selectModelById(name).catch((error) => { this.error = error.message; }); }
	async selectModelFromLastAssistantResponse(): Promise<boolean> { return false; }
	getModelFromLastAssistantResponse(): string | null {
		const snapshot = commonStore.activeSnapshot;
		const message = snapshot?.messages.find((m) => m.id === snapshot.activeLeaf);
		return message?.providerId === commonStore.selectedProviderId ? message.model : null;
	}
	findModelById(id: string): ModelOption | null { return this.models.find((m) => m.id === id) ?? null; }
	findModelByName(name: string): ModelOption | null { return this.models.find((m) => m.model === name) ?? null; }
	hasModel(name: string): boolean { return this.models.some((m) => m.model === name); }
	isModelLoaded(_id: string): boolean { return false; }
	getModelStatus(_id: string): null { return null; }
	toDisplayName(id: string): string { return this.findModelByName(id)?.name ?? id; }
	clearSelection(): void { void commonStore.savePreferences({ model: '' }); commonStore.selectedModel = ''; }
	isFavorite(id: string): boolean { return this.favoriteModelIds.has(id); }
	toggleFavorite(id: string): void {
		const next = new SvelteSet(this.favoriteModelIds); if (next.has(id)) next.delete(id); else next.add(id);
		this.favoriteModelIds = next;
		try { localStorage.setItem(FAVORITE_MODELS_LOCALSTORAGE_KEY, JSON.stringify([...next])); } catch { this.error = 'Could not save device-local favorites.'; }
	}
	private loadFavorites(): Set<string> {
		try { return new Set(JSON.parse(localStorage.getItem(FAVORITE_MODELS_LOCALSTORAGE_KEY) ?? '[]')); } catch { return new Set(); }
	}
}

export const modelsStore = new ModelsStore();
