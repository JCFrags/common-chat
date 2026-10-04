export interface PreviewPayload {
	type: 'common-chat-preview';
	html: string;
	css: string;
	js: string;
	mermaid: string;
	module: boolean;
}
export function payloadForSource(code: string, language: string): PreviewPayload {
	const payload: PreviewPayload = {
		type: 'common-chat-preview',
		html: '',
		css: '',
		js: '',
		mermaid: '',
		module: false
	};
	if (['html', 'htm', 'xml', 'svg'].includes(language)) payload.html = code;
	else if (language === 'css') payload.css = code;
	else if (['js', 'javascript', 'mjs', 'cjs'].includes(language)) {
		payload.js = code;
		payload.module = language === 'mjs';
	} else if (language === 'mermaid') payload.mermaid = code;
	return payload;
}

// Authored source is transferred only to the existing opaque /sandbox response.
// No reply can invoke a parent action, navigate the app, or use a Common API.
export function createSandboxSession(
	host: HTMLElement,
	payload: PreviewPayload,
	{
		automatic = false,
		external = false,
		onLog = () => {},
		onStatus = () => {}
	}: {
		automatic?: boolean;
		external?: boolean;
		onLog?: (line: string, level: string) => void;
		onStatus?: (text: string) => void;
	} = {}
) {
	if (
		['html', 'css', 'js', 'mermaid'].some(
			(key) => payload[key as 'html' | 'css' | 'js' | 'mermaid'].length > 128 * 1024
		)
	)
		throw new Error('Each preview source field must fit 128 Ki characters.');
	const diagramOnly = !!payload.mermaid && !payload.html && !payload.css && !payload.js;
	const frame = document.createElement('iframe');
	frame.title = diagramOnly ? 'Isolated Mermaid diagram' : 'Isolated artifact preview';
	frame.className = 'w-full rounded-md border bg-background';
	frame.style.height = diagramOnly ? '240px' : '420px';
	frame.setAttribute(
		'sandbox',
		automatic
			? 'allow-scripts'
			: 'allow-scripts allow-forms allow-modals allow-downloads allow-popups'
	);
	frame.setAttribute('referrerpolicy', 'no-referrer');
	frame.setAttribute('credentialless', '');
	frame.loading = 'lazy';
	frame.setAttribute(
		'allow',
		"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
	);
	const channel = new MessageChannel();
	let active = true,
		entries = 0,
		bytes = 0,
		layouts = 0;
	channel.port1.onmessage = (event) => {
		if (!active || !frame.isConnected) return;
		const value = event.data;
		if (!value || typeof value !== 'object' || Array.isArray(value)) return;
		if (value.type === 'common-chat-mermaid-layout') {
			if (
				!diagramOnly ||
				layouts >= 16 ||
				Object.keys(value).length !== 2 ||
				typeof value.height !== 'number' ||
				!Number.isFinite(value.height) ||
				value.height <= 0
			)
				return;
			layouts++;
			frame.style.height = `${Math.round(Math.max(96, Math.min(800, value.height)))}px`;
			return;
		}
		if (
			!['log', 'info', 'warn', 'error', 'debug', 'status'].includes(value.level) ||
			typeof value.text !== 'string' ||
			entries >= 100 ||
			bytes >= 20000
		)
			return;
		const line = `[${value.level}] ${value.text.slice(0, Math.min(2000, 20000 - bytes))}\n`;
		entries++;
		bytes += line.length;
		onLog(line, value.level);
		if (value.level === 'error')
			onStatus('The isolated preview reported an error. Inspect its saved console and source.');
	};
	frame.addEventListener(
		'load',
		() => {
			if (!active || !frame.isConnected || !frame.contentWindow) return;
			// The receiver checks parent identity and origin and consumes one port.
			frame.contentWindow.postMessage(
				{ ...payload, dark: document.documentElement.classList.contains('dark') },
				'*',
				[channel.port2]
			);
			onStatus(
				automatic
					? 'Diagram runs in an isolated frame. External resources are off.'
					: `Preview runs in an isolated frame. External resources are ${external ? 'enabled by your consent' : 'off'}.`
			);
		},
		{ once: true }
	);
	frame.src = `/sandbox?automatic=${automatic ? '1' : '0'}&external=${!automatic && external ? '1' : '0'}`;
	const observer = payload.mermaid
		? new MutationObserver(() => {
				if (active)
					channel.port1.postMessage({
						type: 'common-chat-theme',
						dark: document.documentElement.classList.contains('dark')
					});
			})
		: null;
	observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
	host.append(frame);
	onStatus('Loading the isolated preview...');
	return {
		frame,
		close() {
			active = false;
			observer?.disconnect();
			channel.port1.onmessage = null;
			channel.port1.close();
			channel.port2.close();
			frame.remove();
		}
	};
}
