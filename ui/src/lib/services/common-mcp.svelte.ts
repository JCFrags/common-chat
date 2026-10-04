import { api } from './common-api';

export interface McpSelection {
	connectionId: string;
	catalogRevision: string;
	tools: string[];
}
export interface McpTool {
	name: string;
	modelName: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	available: boolean;
	error?: string;
}
export interface McpConnection {
	id: string;
	name: string;
	url: string;
	protocolVersion: '2025-11-25';
	hasKey: boolean;
	connected: boolean;
	catalogRevision: string | null;
	checkedAt: number | null;
	tools: McpTool[];
	error: string | null;
}
export interface McpConfig {
	name: string;
	url: string;
	apiKey?: string;
	clearKey?: boolean;
}
const prefix = '/api/mcp/connections';

/** Page-only choices are not a grant until the parent confirms the frozen submission. */
class CommonMcpState {
	connections = $state<McpConnection[]>([]);
	private chosen = $state<McpSelection[]>([]);
	private epoch = 0;
	private ticket = 0;

	get selections(): McpSelection[] {
		return structuredClone($state.snapshot(this.chosen));
	}

	reset(): void {
		this.epoch++;
		this.ticket++;
		this.connections = [];
		this.chosen = [];
	}

	clear(connectionId?: string): void {
		this.epoch++;
		this.chosen = connectionId
			? this.chosen.filter((item) => item.connectionId !== connectionId)
			: [];
	}

	async load(signal?: AbortSignal): Promise<void> {
		const ticket = ++this.ticket;
		const connections = await api<McpConnection[]>(prefix, 'GET', undefined, signal);
		if (ticket !== this.ticket) throw new Error('MCP settings changed during refresh.');
		const retained = this.chosen.filter((selection) => {
			const connection = connections.find((item) => item.id === selection.connectionId);
			return connection?.connected && connection.catalogRevision === selection.catalogRevision &&
				selection.tools.every((name) => connection.tools.some((tool) => tool.name === name && tool.available));
		});
		if (retained.length !== this.chosen.length) this.epoch++;
		this.chosen = retained;
		this.connections = connections;
	}

	choose(connectionId: string, toolName: string, selected: boolean): void {
		const connection = this.connections.find((item) => item.id === connectionId);
		if (!connection?.connected || !connection.catalogRevision ||
			!connection.tools.some((tool) => tool.name === toolName && tool.available)) {
			throw new Error('Connect and review this MCP tool before selecting it.');
		}
		const existing = this.chosen.find((item) => item.connectionId === connectionId);
		const names = new Set(existing?.catalogRevision === connection.catalogRevision ? existing.tools : []);
		if (selected) names.add(toolName); else names.delete(toolName);
		const otherCount = this.chosen.filter((item) => item.connectionId !== connectionId)
			.reduce((total, item) => total + item.tools.length, 0);
		if (otherCount + names.size > 32) throw new Error('At most 32 MCP tools may be selected for a turn.');
		this.chosen = this.chosen.filter((item) => item.connectionId !== connectionId);
		if (names.size) this.chosen = [...this.chosen, {
			connectionId, catalogRevision: connection.catalogRevision, tools: [...names].sort()
		}].sort((a, b) => a.connectionId.localeCompare(b.connectionId));
		this.epoch++;
	}

	snapshotSelections(): McpSelection[] {
		const selections = this.selections;
		for (const selection of selections) {
			const connection = this.connections.find((item) => item.id === selection.connectionId);
			if (!connection?.connected || connection.catalogRevision !== selection.catalogRevision ||
				selection.tools.some((name) => !connection.tools.some((tool) => tool.name === name && tool.available))) {
				throw new Error('The MCP catalog changed. Review and select tools again.');
			}
			Object.freeze(selection.tools);
			Object.freeze(selection);
		}
		return Object.freeze(selections) as McpSelection[];
	}

	/** Check the registered catalog only. The parent owns the per-send confirmation. */
	async confirmSelections(
		provider: { capabilities?: { tools?: boolean } },
		cid: string,
		_requestId?: string
	): Promise<{ selections: McpSelection[]; labels: string[] }> {
		const selections = this.snapshotSelections();
		if (!selections.length) return { selections, labels: [] };
		if (!cid || provider.capabilities?.tools !== true) {
			throw new Error('Selected MCP tools require a conversation and a function-tools-enabled connection.');
		}
		const epoch = this.epoch;
		await this.load();
		if (epoch !== this.epoch || JSON.stringify(selections) !== JSON.stringify(this.snapshotSelections())) {
			throw new Error('The MCP selection changed during preflight. Review and select tools again.');
		}
		const labels = selections.flatMap((selection) => {
			const connection = this.connections.find((item) => item.id === selection.connectionId)!;
			return selection.tools.map((name) => `${connection.name}: ${name} (${connection.url})`);
		});
		return { selections, labels };
	}

	async save(config: McpConfig, connectionId?: string): Promise<McpConnection> {
		this.clear(connectionId);
		const saved = await api<McpConnection>(connectionId ? `${prefix}/${encodeURIComponent(connectionId)}` : prefix,
			connectionId ? 'PUT' : 'POST', config);
		await this.load();
		return saved;
	}

	async connect(connectionId: string): Promise<void> {
		this.clear(connectionId);
		await api(`${prefix}/${encodeURIComponent(connectionId)}/connect`, 'POST', {});
		await this.load();
	}

	async disconnect(connectionId: string): Promise<void> {
		this.clear(connectionId);
		await api(`${prefix}/${encodeURIComponent(connectionId)}/disconnect`, 'POST', {});
		await this.load();
	}

	async remove(connectionId: string): Promise<void> {
		this.clear(connectionId);
		await api(`${prefix}/${encodeURIComponent(connectionId)}`, 'DELETE');
		await this.load();
	}
}

export const commonMcpState = new CommonMcpState();
export const confirmSelections = (
	provider: { capabilities?: { tools?: boolean } }, cid: string, requestId?: string
) => commonMcpState.confirmSelections(provider, cid, requestId);
