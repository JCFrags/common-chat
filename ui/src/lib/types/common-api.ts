export interface CommonThinking {
	protocol: 'unknown' | 'none' | 'llama_cpp' | 'reasoning_effort' | 'openrouter_reasoning';
	levels: string[];
	source?: string;
}

export interface CommonProvider {
	id: string;
	name: string;
	baseUrl: string;
	hasKey: boolean;
	models: string[];
	modelConfig?: { discovery?: string; metadata?: string; profiles?: unknown[] };
	capabilities: {
		tools?: boolean;
		vision?: boolean;
		audioInput?: string;
		videoInput?: string;
		llamaCppSampling?: boolean;
		thinking?: Exclude<CommonThinking['protocol'], 'unknown'>;
		thinkingLevels?: string[];
		[key: string]: unknown;
	};
}

export interface CommonCatalog {
	models: string[];
	details: { id: string; name?: string; nickname?: string; thinking: CommonThinking }[];
	reachable: boolean | null;
	source: string;
	checkedAt: number | null;
	catalogState: string;
	error?: string;
}

export interface CommonSession {
	authenticated: boolean;
	authenticationRequired: boolean;
	account?: string;
	settings: { theme?: string; providerId?: string; model?: string; dictation?: unknown };
	version?: string;
	release?: Record<string, unknown>;
	frontend?: { sourceCommit?: string; manifestSha256?: string };
}

export interface CommonAttachment {
	id: string;
	name: string;
	mime: string;
	kind: 'text' | 'image' | 'audio' | 'video';
	size: number;
	sha256?: string;
}

export type CommonSettings = Record<string, string | number | boolean | string[]>;

export interface CommonMessage {
	id: string;
	conversationId: string;
	parentId: string | null;
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	reasoning: string;
	status: string;
	providerId: string | null;
	providerName?: string;
	model: string | null;
	settings: CommonSettings;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	attachments: CommonAttachment[];
}

export interface CommonUI {
	pinned?: boolean;
	thinkingEnabled?: boolean;
	reasoningEffort?: string;
	disabledTools?: string[];
	disabledToolCategories?: string[];
	forkedFromConversationId?: string;
}

export interface CommonConversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	version: number;
	running?: boolean;
	ui?: CommonUI;
}

export interface CommonSnapshot extends CommonConversation {
	activeLeaf: string | null;
	settings: CommonSettings;
	messages: CommonMessage[];
	activeJob: { id: string; messageId: string; status: string } | null;
}

export interface CommonRuntime {
	ready: boolean;
	packages: boolean;
	blockedReasons?: string[];
	nativeTools?: { name: string; title?: string; category: string; available: boolean }[];
	[key: string]: unknown;
}

export interface CommonReceipt {
	jobId: string;
	messageId: string;
	conversationId: string;
}

export interface CommonGeneration {
	requestId: string;
	expectedVersion: number;
	providerId: string;
	model: string;
	parentId: string | null;
	content?: string;
	attachments?: string[];
	regenerate?: boolean;
	continue?: boolean;
	settings: CommonSettings;
	tools: { workspace: boolean; execute: boolean; packages: boolean };
}
