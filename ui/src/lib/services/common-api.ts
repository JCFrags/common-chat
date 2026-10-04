export class CommonApiError extends Error {
	constructor(message: string, public status: number) {
		super(message);
		this.name = 'CommonApiError';
	}
}

let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler: () => void): void {
	onUnauthorized = handler;
}

/** Common owns endpoint selection, credentials, history and execution authority. */
export async function api<T = any>(
	path: string,
	method = 'GET',
	value?: unknown,
	signal?: AbortSignal
): Promise<T> {
	if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) {
		throw new Error('Only same-origin Common API routes are permitted.');
	}
	const headers: Record<string, string> = {};
	if (method !== 'GET' && method !== 'HEAD') {
		headers['Content-Type'] = 'application/json';
		headers['X-Chat-Request'] = '1';
	}
	const response = await fetch(path, {
		method,
		headers,
		credentials: 'same-origin',
		cache: 'no-store',
		body: value === undefined ? undefined : JSON.stringify(value),
		signal
	});
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		if (response.status === 401 && path !== '/api/login') onUnauthorized?.();
		throw new CommonApiError(data?.error ?? `Common request failed (${response.status}).`, response.status);
	}
	return data as T;
}
