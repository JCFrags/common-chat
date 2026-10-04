// Common server APIs are the only authority for these components.
export async function api<T = unknown>(
	path: string,
	method = 'GET',
	value?: unknown,
	signal?: AbortSignal
): Promise<T> {
	if (!path.startsWith('/api/') || path.includes('\\') || /[\r\n]/.test(path)) {
		throw new Error('Only same-origin Common API paths are supported.');
	}
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			credentials: 'same-origin',
			redirect: 'error',
			headers:
				method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Chat-Request': '1' },
			...(value !== undefined ? { body: JSON.stringify(value) } : {}),
			signal
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw Object.assign(new Error('The Common server could not be reached.'), { status: 0 });
	}
	const result = await response.json().catch(() => null);
	if (!response.ok) {
		throw Object.assign(
			new Error(
				typeof result?.error === 'string' ? result.error : `Request failed (${response.status}).`
			),
			{ status: response.status }
		);
	}
	if (result === null)
		throw Object.assign(new Error('The server returned no JSON result.'), { status: 0 });
	return result as T;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'The operation failed.';
}

export function errorStatus(error: unknown): number {
	return typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
		? error.status
		: 0;
}

export const conversationPrefix = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
export const workspaceQuery = (path: string, revision?: string) =>
	new URLSearchParams({ path, ...(revision ? { revision } : {}) }).toString();
export const downloadUrl = (id: string, path: string, revision: string) =>
	`${conversationPrefix(id)}/workspace/download?${workspaceQuery(path, revision)}`;

// Historical links are display data, not navigation or tool authority.
export function workspaceLink(
	value: unknown,
	conversationId: string
): { path: string; revision: string; url: string } | null {
	if (typeof value !== 'string' || !conversationId || !value.startsWith('/api/')) return null;
	try {
		const url = new URL(value, 'https://common.invalid');
		if (
			url.origin !== 'https://common.invalid' ||
			url.hash ||
			url.pathname !== `${conversationPrefix(conversationId)}/workspace/download`
		)
			return null;
		if (Array.from(url.searchParams.keys()).sort().join(',') !== 'path,revision') return null;
		const path = url.searchParams.get('path') ?? '',
			revision = url.searchParams.get('revision') ?? '';
		if (
			!path ||
			path.startsWith('/') ||
			path.includes('\\') ||
			path.split('/').some((part) => !part || part === '.' || part === '..') ||
			/[\x00-\x1f\x7f]/.test(path)
		)
			return null;
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(revision))
			return null;
		return { path, revision, url: downloadUrl(conversationId, path, revision) };
	} catch {
		return null;
	}
}

export function catalogMessage(result: Catalog): string {
	const checked = result.checkedAt
		? ` Checked at ${new Date(result.checkedAt).toLocaleString()}.`
		: '';
	if (result.catalogState === 'stale')
		return `This catalog changed during discovery. Refresh before relying on it.${checked}`;
	if (result.error || result.catalogState === 'failed' || result.reachable === false)
		return `${result.error || 'Model discovery failed.'} Saved IDs are an unverified fallback.${checked}`;
	if (result.source === 'cache' || result.catalogState === 'cached')
		return `Cached model IDs, not a fresh reachability check.${checked}`;
	if (result.source === 'manual' || result.catalogState === 'manual')
		return 'Saved manual model IDs. API reachability is not verified.';
	if (result.reachable === true && result.source === 'api')
		return `${result.models.length} models listed by the API.${checked} Listing does not prove inference or transcription support.`;
	return 'Model availability is unknown. Refresh to check discovery.';
}

export interface Thinking {
	protocol: string;
	levels?: string[];
	source?: string;
}
export interface ModelProfile {
	id: string;
	nickname?: string;
	thinking?: Thinking;
}
export interface Provider {
	id: string;
	name: string;
	baseUrl: string;
	hasKey?: boolean;
	models: string[];
	modelConfig?: { discovery?: string; metadata?: string; profiles?: ModelProfile[] };
	capabilities: Record<string, boolean | string | string[]>;
}
export interface Catalog {
	models: string[];
	details?: { id: string; name?: string; nickname?: string; thinking?: Thinking }[];
	source?: string;
	catalogState?: string;
	reachable?: boolean | null;
	checkedAt?: number | string;
	error?: string;
}
export interface DictationSelection {
	providerId: string;
	model: string;
}
export interface Session {
	settings: { dictation?: DictationSelection | null };
}

export function readBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		const finish = (error?: Error, text?: string) => {
			signal?.removeEventListener('abort', abort);
			reader.onload = reader.onerror = reader.onabort = null;
			if (error) reject(error);
			else resolve(text ?? '');
		};
		const abort = () => {
			if (reader.readyState === FileReader.LOADING) reader.abort();
			finish(new DOMException('Cancelled.', 'AbortError'));
		};
		reader.onerror = () => finish(new Error('The selected file could not be read.'));
		reader.onabort = () => finish(new DOMException('Cancelled.', 'AbortError'));
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== 'string' || !result.includes(','))
				finish(new Error('The selected file could not be read.'));
			else finish(undefined, result.slice(result.indexOf(',') + 1));
		};
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		else reader.readAsDataURL(blob);
	});
}
