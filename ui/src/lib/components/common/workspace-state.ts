export interface FileMetadata {
	path: string;
	revision: string;
	version?: number;
	mime: string;
	size: number;
	text: boolean;
	deleted?: boolean;
	sha256?: string | null;
	createdAt?: number;
	index?: { status: string; error?: string | null };
}
export interface Passage {
	text: string;
	page?: number;
	paragraph?: number;
	part?: number;
	citation?: { id?: string };
}
export interface FileRead {
	file: FileMetadata;
	text?: string;
	data?: string;
	passages?: Passage[];
}
export interface SearchResult extends Passage {
	path: string;
	revision: string;
}
export interface FileDraft {
	key: string;
	path: string;
	isNew: boolean;
	file: FileMetadata | null;
	text: string;
	baseText: string;
	content: FileRead | null;
	historical: FileRead | null;
	history: FileMetadata[] | null;
	view: 'edit' | 'preview' | 'history';
	busy: boolean;
	locked: boolean;
	conflict: boolean;
	error: string;
	notice: string;
}
export interface Execution {
	id: string;
	status: string;
	kind?: string;
	operationId?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	exitCode?: number | null;
	files?: FileMetadata[];
	availableFiles?: FileMetadata[];
	fileNote?: string;
	createdAt?: number;
}
export interface Runtime {
	enabled: boolean;
	ready: boolean;
	packages?: boolean;
	blockedReasons?: string[];
	limits?: Record<string, unknown>;
	inventory?: unknown;
	nativeTools?: {
		name: string;
		title: string;
		category: string;
		description: string;
		available: boolean;
	}[];
}
export interface WorkspaceSession {
	files: FileMetadata[];
	usage: Record<string, number> | null;
	loaded: boolean;
	loading: boolean;
	busy: boolean;
	error: string;
	drafts: Record<string, FileDraft>;
	selected: string | null;
	openTicket: number;
	query: string;
	searching: boolean;
	searchTicket: number;
	results: SearchResult[] | null;
	indexing: { path: string; status: string; error?: string }[];
	run: {
		kind: 'python' | 'shell';
		code: string;
		allowPackages: boolean;
		job: Execution | null;
		starting: boolean;
		canceling: boolean;
		unknown: boolean;
		recent: Execution[] | null;
		recovering: boolean;
		error: string;
		consoleOffset: number;
	};
	packages: {
		pip: string;
		npm: string;
		basePip: string;
		baseNpm: string;
		consent: boolean;
		loaded: boolean;
		loading: boolean;
		saving: boolean;
		error: string;
		status: string;
	};
}
export function createWorkspaceSession(): WorkspaceSession {
	return {
		files: [],
		usage: null,
		loaded: false,
		loading: false,
		busy: false,
		error: '',
		drafts: {},
		selected: null,
		openTicket: 0,
		query: '',
		searching: false,
		searchTicket: 0,
		results: null,
		indexing: [],
		run: {
			kind: 'python',
			code: '',
			allowPackages: false,
			job: null,
			starting: false,
			canceling: false,
			unknown: false,
			recent: null,
			recovering: false,
			error: '',
			consoleOffset: 0
		},
		packages: {
			pip: '',
			npm: '',
			basePip: '',
			baseNpm: '',
			consent: false,
			loaded: false,
			loading: false,
			saving: false,
			error: '',
			status: ''
		}
	};
}
export function fileDraft(
	file: FileMetadata | null,
	content: FileRead | null,
	key?: string
): FileDraft {
	return {
		key: key ?? file?.path ?? `new:${crypto.randomUUID()}`,
		path: file?.path ?? '',
		isNew: !file,
		file,
		content,
		text: content?.text ?? '',
		baseText: content?.text ?? '',
		historical: null,
		history: null,
		view: file?.deleted ? 'history' : !file || file.text ? 'edit' : 'preview',
		busy: false,
		locked: false,
		conflict: false,
		error: '',
		notice: ''
	};
}
export const dirtyFile = (draft?: FileDraft | null) =>
	!!draft && (draft.isNew || draft.text !== draft.baseText);
export const terminalStatuses = new Set([
	'complete',
	'error',
	'cancelled',
	'timed_out',
	'interrupted'
]);
export const activeStatuses = new Set([
	'queued',
	'pending',
	'starting',
	'running',
	'cancelling',
	'canceling'
]);
export const sizeLabel = (value: number) =>
	Number.isFinite(value) ? `${(value / 1024).toFixed(1)} KiB` : 'Size unavailable';
