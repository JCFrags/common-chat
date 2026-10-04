import { browser } from '$app/environment';
import { api, CommonApiError, setUnauthorizedHandler } from '$lib/services/common-api';
import type {
	CommonCatalog, CommonConversation, CommonProvider, CommonRuntime, CommonSession,
	CommonSnapshot, CommonMessage, CommonThinking
} from '$lib/types/common-api';
import { SvelteMap } from 'svelte/reactivity';
import { commonMcpState } from '$lib/services/common-mcp.svelte';

const catalogConfig = (provider?: CommonProvider) => provider && JSON.stringify([
	provider.baseUrl, provider.hasKey, provider.models, provider.capabilities, provider.modelConfig
]);

export type CommonChange =
	| { type: 'snapshot'; snapshot: CommonSnapshot }
	| { type: 'deleted'; id: string }
	| { type: 'list' | 'providers' | 'session' | 'runtime' | 'reconnect' | 'signing-out' | 'signed-out' };

class CommonStore {
	session = $state<CommonSession | null>(null);
	providers = $state<CommonProvider[]>([]);
	selectedProviderId = $state('');
	selectedModel = $state('');
	activeSnapshot = $state<CommonSnapshot | null>(null);
	runtime = $state<CommonRuntime | null>(null);
	connectionError = $state<string | null>(null);
	eventStatus = $state<'offline' | 'connecting' | 'connected'>('offline');
	conversations = $state<CommonConversation[]>([]);
	catalogs = new SvelteMap<string, CommonCatalog>();
	snapshots = new SvelteMap<string, CommonSnapshot>();
	activeId = $state<string | null>(null);
	private listeners = new Set<(change: CommonChange) => void>();
	private events: EventSource | null = null;
	private initializing: Promise<void> | null = null;
	private reconnecting: Promise<void> | null = null;
	private refreshing = new Map<string, Promise<CommonSnapshot>>();
	private epoch = 0;
	private providerVersions = new Map<string, number>();

	constructor() {
		setUnauthorizedHandler(() => this.signedOut());
	}

	get selectedProvider(): CommonProvider | null {
		return this.providers.find((p) => p.id === this.selectedProviderId) ?? null;
	}

	get selectedThinking(): CommonThinking {
		const declared = this.catalogs.get(this.selectedProviderId)?.details.find(
			(d) => d.id === this.selectedModel
		)?.thinking;
		if (declared) return declared;
		const capabilities = this.selectedProvider?.capabilities;
		return { protocol: capabilities?.thinking ?? 'none', levels: capabilities?.thinkingLevels ?? [] };
	}

	subscribe(listener: (change: CommonChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(change: CommonChange): void {
		for (const listener of this.listeners) listener(change);
	}

	initialize(): Promise<void> {
		if (!browser) return Promise.resolve();
		if (this.initializing) return this.initializing;
		this.initializing = (async () => {
			try {
				await this.refreshSession();
				if (!this.session?.authenticated) return;
				await Promise.all([this.refreshProviders(), this.refreshList(), this.refreshRuntime()]);
				this.connectEvents();
			} catch (error) {
				if (!(error instanceof CommonApiError && error.status === 401)) {
					this.connectionError = error instanceof Error ? error.message : String(error);
				}
			} finally {
				this.initializing = null;
			}
		})();
		return this.initializing;
	}

	async refreshSession(): Promise<void> {
		try {
			const session = await api<CommonSession>('/api/session');
			this.session = session;
			this.selectedProviderId = session.settings.providerId ?? this.selectedProviderId;
			this.selectedModel = session.settings.model ?? this.selectedModel;
			this.connectionError = null;
			this.notify({ type: 'session' });
		} catch (error) {
			if (error instanceof CommonApiError && error.status === 401) this.signedOut();
			throw error;
		}
	}

	async login(password: string): Promise<void> {
		await api('/api/login', 'POST', { password });
		await this.initialize();
		if (!this.session?.authenticated) throw new Error(this.connectionError ?? 'Sign-in did not complete.');
	}

	async logout(): Promise<void> {
		if (this.session?.authenticationRequired === false) return;
		// Cancel transient input immediately. Keep authentication and drafts until logout succeeds.
		commonMcpState.reset();
		this.notify({ type: 'signing-out' });
		await api('/api/logout', 'POST', {});
		this.signedOut();
	}

	signedOut(): void {
		this.epoch++;
		commonMcpState.reset();
		this.events?.close();
		this.events = null;
		this.eventStatus = 'offline';
		this.session = { authenticated: false, authenticationRequired: true, settings: {} };
		this.providers = [];
		this.providerVersions.clear();
		this.catalogs.clear();
		this.snapshots.clear();
		this.conversations = [];
		this.activeSnapshot = null;
		this.runtime = null;
		this.notify({ type: 'signed-out' });
	}

	async refreshProviders(): Promise<void> {
		const epoch = this.epoch;
		const providers = await api<CommonProvider[]>('/api/providers');
		if (epoch !== this.epoch) return;
		const previous = new Map(this.providers.map((provider) => [provider.id, provider]));
		const next = new Map(providers.map((provider) => [provider.id, provider]));
		for (const id of new Set([...previous.keys(), ...next.keys()])) {
			if (catalogConfig(previous.get(id)) !== catalogConfig(next.get(id))) {
				this.catalogs.delete(id);
				this.providerVersions.set(id, (this.providerVersions.get(id) ?? 0) + 1);
			}
		}
		this.providers = providers;
		if (!this.selectedProviderId && providers.length) this.selectedProviderId = providers[0].id;
		this.notify({ type: 'providers' });
	}

	async refreshCatalog(id = this.selectedProviderId, refresh = false): Promise<CommonCatalog> {
		if (!id) throw new Error('Choose a Common connection first.');
		const epoch = this.epoch, version = this.providerVersions.get(id);
		const catalog = await api<CommonCatalog>(`/api/providers/${encodeURIComponent(id)}/models${refresh ? '?refresh=1' : ''}`);
		// A late response cannot restore metadata invalidated by a connection change.
		if (epoch === this.epoch && version === this.providerVersions.get(id) && this.providers.some((provider) => provider.id === id)) {
			this.catalogs.set(id, catalog);
		}
		return catalog;
	}

	async refreshRuntime(): Promise<void> {
		const epoch = this.epoch;
		try {
			const runtime = await api<CommonRuntime>('/api/runtime');
			if (epoch === this.epoch) this.runtime = runtime;
		} catch (error) {
			if (epoch === this.epoch) this.runtime = {
				enabled: false, ready: false, packages: false,
				blockedReasons: [error instanceof Error ? error.message : 'Runner availability could not be checked.']
			};
		}
		this.notify({ type: 'runtime' });
	}

	async savePreferences(value: Record<string, unknown>): Promise<void> {
		const settings = await api<CommonSession['settings']>('/api/preferences', 'PUT', value);
		if (this.session) this.session = { ...this.session, settings };
		this.notify({ type: 'session' });
	}

	async selectProvider(id: string): Promise<void> {
		if (!this.providers.some((p) => p.id === id)) throw new Error('This Common connection is no longer available.');
		await this.savePreferences({ providerId: id, model: '' });
		this.selectedProviderId = id;
		this.selectedModel = '';
		this.notify({ type: 'providers' });
	}

	async selectModel(id: string): Promise<void> {
		const providerId = this.selectedProviderId;
		if (!this.selectedProvider) throw new Error('Choose a Common connection first.');
		await this.savePreferences({ providerId, model: id });
		if (providerId !== this.selectedProviderId) throw new Error('The connection changed. Choose the model again.');
		this.selectedModel = id;
		this.notify({ type: 'providers' });
	}

	/** New turns use configured native availability, never historical grants or UI categories. */
	async readToolPermissions(providerId: string): Promise<{ workspace: boolean; execute: boolean; packages: boolean }> {
		if (providerId !== this.selectedProviderId) throw new Error('The connection changed. Review it before sending.');
		const epoch = this.epoch;
		await Promise.all([this.refreshProviders(), this.refreshRuntime()]);
		if (epoch !== this.epoch || providerId !== this.selectedProviderId) {
			throw new Error('The connection changed while checking native tools. Review it before sending.');
		}
		const enabled = this.selectedProvider?.capabilities.tools === true;
		const ready = this.runtime?.enabled === true && this.runtime.ready === true;
		return { workspace: enabled, execute: enabled && ready,
			packages: enabled && ready && this.runtime?.packages === true };
	}

	setActive(id: string | null): void {
		this.activeId = id;
		this.activeSnapshot = id ? this.snapshots.get(id) ?? null : null;
	}

	acceptSnapshot(snapshot: CommonSnapshot): CommonSnapshot {
		const previous = this.snapshots.get(snapshot.id);
		if (previous && previous.version > snapshot.version) return previous;
		this.snapshots.set(snapshot.id, snapshot);
		if (this.activeId === snapshot.id) this.activeSnapshot = snapshot;
		const index = this.conversations.findIndex((c) => c.id === snapshot.id);
		const row = { id: snapshot.id, title: snapshot.title, createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt, version: snapshot.version, ui: snapshot.ui, running: !!snapshot.activeJob };
		if (index === -1) this.conversations = [row, ...this.conversations];
		else this.conversations[index] = row;
		this.notify({ type: 'snapshot', snapshot });
		return snapshot;
	}

	async refreshList(query = ''): Promise<void> {
		const epoch = this.epoch;
		const rows = await api<CommonConversation[]>(`/api/conversations${query ? `?q=${encodeURIComponent(query)}` : ''}`);
		if (epoch !== this.epoch) return;
		this.conversations = rows;
		this.notify({ type: 'list' });
	}

	refreshConversation(id: string): Promise<CommonSnapshot> {
		const pending = this.refreshing.get(id);
		if (pending) return pending;
		const epoch = this.epoch;
		const request = api<CommonSnapshot>(`/api/conversations/${encodeURIComponent(id)}`).then((snapshot) => {
			return epoch === this.epoch ? this.acceptSnapshot(snapshot) : snapshot;
		}).finally(() => { if (this.refreshing.get(id) === request) this.refreshing.delete(id); });
		this.refreshing.set(id, request);
		return request;
	}

	private async reconnect(): Promise<void> {
		if (this.reconnecting) return this.reconnecting;
		this.reconnecting = (async () => {
			try {
				await this.refreshSession();
				await Promise.all([this.refreshProviders(), this.refreshList(), this.refreshRuntime()]);
				if (this.activeId) await this.refreshConversation(this.activeId).catch((error) => {
					if (error.status === 404) this.deleted(this.activeId!);
					else throw error;
				});
				this.connectionError = null;
				this.notify({ type: 'reconnect' });
			} catch (error) {
				this.connectionError = error instanceof Error ? error.message : String(error);
			} finally { this.reconnecting = null; }
		})();
		return this.reconnecting;
	}

	private deleted(id: string): void {
		this.snapshots.delete(id);
		this.conversations = this.conversations.filter((c) => c.id !== id);
		if (this.activeId === id) this.activeSnapshot = null;
		// The old-address device draft stays at its original target.
		this.notify({ type: 'deleted', id });
	}

	private connectEvents(): void {
		if (this.events || !browser || !this.session?.authenticated) return;
		const source = new EventSource('/api/events');
		this.events = source;
		this.eventStatus = 'connecting';
		source.onopen = () => { if (this.events === source) this.eventStatus = 'connected'; };
		source.onerror = () => {
			if (this.events !== source) return;
			this.eventStatus = 'connecting';
			this.connectionError = 'Live updates disconnected. Jobs continue on the server. Reconnecting reads saved snapshots.';
			void this.refreshSession().catch(() => {});
		};
		source.onmessage = (event) => {
			if (this.events !== source) return;
			try {
				const change = JSON.parse(event.data);
				if (change.type === 'hello') { void this.reconnect(); return; }
				if (change.type === 'delta') {
					const snapshot = this.snapshots.get(change.conversationId);
					const message = change.message as CommonMessage;
					if (snapshot && change.version < snapshot.version) return;
					if (!snapshot || (message.parentId && !snapshot.messages.some((m) => m.id === message.parentId))) {
						void this.refreshConversation(change.conversationId).catch((error) => { this.connectionError = error.message; });
						return;
					}
					const messages = [...snapshot.messages];
					const index = messages.findIndex((m) => m.id === message.id);
					if (index === -1) messages.push(message); else messages[index] = message;
					this.acceptSnapshot({ ...snapshot, version: change.version, messages });
				} else if (change.type === 'changed') {
					if (change.conversationId && (this.activeId === change.conversationId || this.snapshots.has(change.conversationId))) {
						void this.refreshConversation(change.conversationId).catch((error) => { this.connectionError = error.message; });
					}
					void this.refreshList().catch((error) => { this.connectionError = error.message; });
				} else if (change.type === 'deleted') this.deleted(change.conversationId);
				else if (change.type === 'providers') void this.refreshProviders().catch((error) => { this.connectionError = error.message; });
				else if (change.type === 'preferences') void this.refreshSession().catch(() => {});
			} catch { this.connectionError = 'A live update could not be read. Refresh the saved conversation.'; }
		};
	}
}

export const commonStore = new CommonStore();
