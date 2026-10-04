<script lang="ts">
	import '$lib/styles/katex-custom.scss';
	import { getMarkdownProcessor, type MarkdownProcessor } from './markdown-processor';
	import {
		getCodeInfoFromTarget,
		getHastNodeId,
		getMdastNodeHash,
		isAppendMode
	} from './markdown-utils';
	import { ActionIconCopyToClipboard, CodeBlockActions } from '$lib/components/app';
	import CommonArtifactPreview from '$lib/components/common/CommonArtifactPreview.svelte';
	import { createSandboxSession, payloadForSource } from '$lib/components/common/sandbox';
	import {
		CODE_BLOCK_CLASS,
		DIAGRAM_VIEW_MODE_ATTR,
		DIAGRAM_VIEW_RENDERED,
		DIAGRAM_VIEW_SOURCE,
		IMAGE_NOT_ERROR_BOUND_SELECTOR,
		MARKDOWN_DATA_ATTRS,
		MERMAID_BLOCK_CLASS,
		MERMAID_LANGUAGE,
		MERMAID_SYNTAX_ATTR,
		MERMAID_WRAPPER_CLASS,
		SETTINGS_KEYS,
		SVG,
		TOGGLE_SOURCE_BTN_CLASS,
		UI_DATA_ATTRS
	} from '$lib/constants';
	import { BooleanString, ColorMode, UrlProtocol } from '$lib/enums';
	import { createAutoScrollController } from '$lib/hooks/use-auto-scroll.svelte';
	import { settingsStore } from '$lib/stores';
	import type { DatabaseMessageExtra } from '$lib/types/database';
	import {
		copyCodeToClipboard,
		copyToClipboard,
		getImageErrorFallbackHtml,
		preprocessLaTeX,
		splitGluedClosingCodeFences
	} from '$lib/utils';
	import { detectIncompleteCodeBlock, highlightCode, type IncompleteCodeBlock } from '$lib/utils';
	import { sanitizeSvg } from '$lib/utils/sanitize-svg';
	import type { Root as HastRoot, RootContent as HastRootContent } from 'hast';
	import githubLightCss from 'highlight.js/styles/github.css?inline';
	import githubDarkCss from 'highlight.js/styles/github-dark.css?inline';
	import type { Root as MdastRoot } from 'mdast';
	import { mode } from 'mode-watcher';
	import { getContext, onDestroy, tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	interface Props {
		attachments?: DatabaseMessageExtra[];
		content: string;
		class?: string;
		disableMath?: boolean;
		onRunCode?: (code: string, kind: 'python' | 'shell') => void;
	}

	interface MarkdownBlock {
		id: string;
		html: string;
		contentHash?: string;
	}

	const contextRunCode = getContext<Props['onRunCode']>('common-run-code');
	let {
		attachments,
		class: className = '',
		content,
		disableMath = false,
		onRunCode = contextRunCode
	}: Props = $props();

	let containerRef = $state<HTMLDivElement>();
	let renderedBlocks = $state<MarkdownBlock[]>([]);
	let unstableBlockHtml = $state('');
	let incompleteCodeBlock = $state<IncompleteCodeBlock | null>(null);

	// Derived rather than called inline in the template so it only recomputes when
	// the block actually changes. Auto-detection is disabled while streaming: it
	// costs ~38ms a call and re-guesses the language on every chunk.
	const streamingCodeHtml = $derived(
		incompleteCodeBlock
			? highlightCode(incompleteCodeBlock.code, incompleteCodeBlock.language || 'text', false)
			: ''
	);
	let previewDialogOpen = $state(false);
	let previewCode = $state('');
	let previewLanguage = $state('text');
	let previewBlocks = $state<{ code: string; language: string }[]>([]);
	const diagramSessions = new Map<HTMLElement, ReturnType<typeof createSandboxSession>>();

	let streamingCodeScrollContainer = $state<HTMLDivElement>();

	// Auto-scroll controller for streaming code block content
	const streamingAutoScroll = createAutoScrollController();

	let pendingMarkdown: string | null = null;
	let isProcessing = false;

	// Per-instance transform cache, avoids re-transforming stable blocks during streaming
	// Garbage collected when component is destroyed (on conversation change)
	const transformCache = new SvelteMap<string, string>();
	let previousContent = '';

	/**
	 * Removes click event listeners from copy and preview buttons.
	 * Called on component destroy.
	 */
	function cleanupEventListeners() {
		if (!containerRef) return;

		const copyButtons = containerRef.querySelectorAll<HTMLButtonElement>('.copy-code-btn');
		const previewButtons = containerRef.querySelectorAll<HTMLButtonElement>('.preview-code-btn');

		for (const button of copyButtons) {
			button.removeEventListener('click', handleCopyClick);
		}

		for (const button of previewButtons) {
			button.removeEventListener('click', handlePreviewClick);
		}
	}

	/**
	 * Loads the appropriate highlight.js theme based on dark/light mode.
	 * One shared style element for every markdown block, mirroring
	 * SyntaxHighlightedCode.svelte. The old per-instance copies duplicated the
	 * full theme CSS once per rendered message, which grows without bound in
	 * long conversations.
	 * @param isDark - Whether to load the dark theme (true) or light theme (false)
	 */
	function loadHighlightTheme(isDark: boolean) {
		document
			.querySelectorAll(`style[${UI_DATA_ATTRS.HIGHLIGHT_THEME_PREVIEW}]`)
			.forEach((style) => style.remove());

		const style = document.createElement('style');

		style.nonce =
			document.querySelector<HTMLMetaElement>('meta[name="common-chat-csp-nonce"]')?.content ?? '';
		style.setAttribute(UI_DATA_ATTRS.HIGHLIGHT_THEME_PREVIEW, BooleanString.TRUE);
		style.textContent = isDark ? githubDarkCss : githubLightCss;

		document.head.appendChild(style);
	}

	/**
	 * Transforms a single MDAST node to HTML string with caching.

	/**
	 * Transforms a single MDAST node to HTML string with caching.
	 * Runs the full remark/rehype plugin pipeline (GFM, math, syntax highlighting, etc.)
	 * on an isolated single-node tree, then stringifies the resulting HAST to HTML.
	 * Results are cached by node position hash for streaming performance.
	 * @param processorInstance - The remark/rehype processor instance
	 * @param node - The MDAST node to transform
	 * @param index - Node index for hash fallback
	 * @returns Object containing the HTML string and cache hash
	 */
	async function transformMdastNode(
		processorInstance: MarkdownProcessor,
		node: unknown,
		index: number
	): Promise<{ html: string; hash: string }> {
		const hash = getMdastNodeHash(node, index);
		const cached = transformCache.get(hash);

		if (cached) {
			return { hash, html: cached };
		}

		const singleNodeRoot = { children: [node], type: 'root' };
		const transformedRoot = (await processorInstance.run(singleNodeRoot as MdastRoot)) as HastRoot;
		const html = processorInstance.stringify(transformedRoot);

		transformCache.set(hash, html);

		return { hash, html };
	}

	/**
	 * Handles click events on copy buttons within code blocks.
	 * Copies the raw code content to the clipboard.
	 * @param event - The click event from the copy button
	 */
	async function handleCopyClick(event: Event) {
		event.preventDefault();
		event.stopPropagation();

		const target = event.currentTarget as HTMLButtonElement | null;

		if (!target) {
			return;
		}

		const info = getCodeInfoFromTarget(target);

		if (!info) {
			return;
		}

		try {
			await copyCodeToClipboard(info.rawCode);
		} catch (error) {
			console.error('Failed to copy code:', error);
		}
	}

	/**
	 * Handles preview dialog open state changes.
	 * Clears preview content when dialog is closed.
	 * @param open - Whether the dialog is being opened or closed
	 */
	function handlePreviewDialogOpenChange(open: boolean) {
		previewDialogOpen = open;

		if (!open) {
			previewCode = '';
			previewLanguage = 'text';
		}
	}

	/**
	 * Handles click events on preview buttons within HTML code blocks.
	 * Opens a preview dialog with the rendered HTML content.
	 * @param event - The click event from the preview button
	 */
	function handlePreviewClick(event: Event) {
		event.preventDefault();
		event.stopPropagation();

		const target = event.currentTarget as HTMLButtonElement | null;

		if (!target) {
			return;
		}

		const info = getCodeInfoFromTarget(target);

		if (!info) {
			return;
		}

		openIsolatedPreview(info.rawCode, info.language);
	}

	function openIsolatedPreview(code: string, language: string) {
		previewCode = code;
		previewLanguage = language;
		previewBlocks = Array.from(
			containerRef?.querySelectorAll<HTMLElement>(
				'.code-block-wrapper:not(.streaming-code-block), .mermaid-block-wrapper:not(.streaming-mermaid-block), .svg-block-wrapper:not(.streaming-svg-block)'
			) ?? []
		).flatMap((wrapper) => {
			const node = wrapper.querySelector<HTMLElement>(
				`[${MERMAID_SYNTAX_ATTR}], [${SVG.SOURCE_ATTR}], code[${MARKDOWN_DATA_ATTRS.CODE_ID}]`
			);
			const source =
				node?.getAttribute(MERMAID_SYNTAX_ATTR) ??
				node?.getAttribute(SVG.SOURCE_ATTR) ??
				node?.textContent;
			return typeof source === 'string'
				? [
						{
							code: source,
							language: wrapper.querySelector('.code-language')?.textContent?.trim() || 'text'
						}
					]
				: [];
		});
		previewDialogOpen = true;
	}

	/**
	 * Processes markdown content into stable and unstable HTML blocks.
	 * Uses incremental rendering: stable blocks are cached, unstable block is re-rendered.
	 * Incomplete code blocks are rendered using SyntaxHighlightedCode to maintain interactivity.
	 * @param markdown - The raw markdown string to process
	 */
	async function processMarkdown(rawMarkdown: string) {
		// Text glued to a closing code fence is not a fence to the parser -
		// the block would swallow it. Split it onto its own line first.
		const markdown = splitGluedClosingCodeFences(rawMarkdown);

		// Early exit if content unchanged (can happen with rapid coalescing)
		if (markdown === previousContent) {
			return;
		}

		if (!markdown) {
			renderedBlocks = [];
			unstableBlockHtml = '';
			incompleteCodeBlock = null;
			previousContent = '';

			return;
		}

		// Check for incomplete code block at the end of content
		const incompleteBlock = detectIncompleteCodeBlock(markdown);

		if (incompleteBlock) {
			// Process only the prefix (content before the incomplete code block)
			const prefixMarkdown = markdown.slice(0, incompleteBlock.openingIndex);

			if (prefixMarkdown.trim()) {
				const normalizedPrefix = preprocessLaTeX(prefixMarkdown);
				const processorInstance = getMarkdownProcessor({ attachments, disableMath });
				const ast = processorInstance.parse(normalizedPrefix) as MdastRoot;
				const mdastChildren = (ast as { children?: unknown[] }).children ?? [];
				const nextBlocks: MarkdownBlock[] = [];
				// Check if we're in append mode for cache reuse
				const appendMode = isAppendMode(prefixMarkdown, previousContent);
				const previousBlockCount = appendMode ? renderedBlocks.length : 0;

				// All prefix blocks are now stable since code block is separate
				for (let index = 0; index < mdastChildren.length; index++) {
					const child = mdastChildren[index];

					// In append mode, reuse previous blocks if unchanged
					if (appendMode && index < previousBlockCount) {
						const prevBlock = renderedBlocks[index];
						const currentHash = getMdastNodeHash(child, index);

						if (prevBlock?.contentHash === currentHash) {
							nextBlocks.push(prevBlock);

							continue;
						}
					}

					// Transform this block (with caching)
					const { hash, html } = await transformMdastNode(processorInstance, child, index);
					const id = getHastNodeId(
						{ position: (child as { position?: unknown }).position } as HastRootContent,
						index
					);

					nextBlocks.push({ contentHash: hash, html, id });
				}

				renderedBlocks = nextBlocks;
			} else {
				renderedBlocks = [];
			}

			previousContent = prefixMarkdown;
			unstableBlockHtml = '';
			incompleteCodeBlock = incompleteBlock;

			return;
		}

		// No incomplete code block - use standard processing
		incompleteCodeBlock = null;

		const normalized = preprocessLaTeX(markdown);
		const processorInstance = getMarkdownProcessor({ attachments, disableMath });
		const ast = processorInstance.parse(normalized) as MdastRoot;
		const mdastChildren = (ast as { children?: unknown[] }).children ?? [];
		const stableCount = Math.max(mdastChildren.length - 1, 0);
		const nextBlocks: MarkdownBlock[] = [];
		// Check if we're in append mode for cache reuse
		const appendMode = isAppendMode(markdown, previousContent);
		const previousBlockCount = appendMode ? renderedBlocks.length : 0;

		for (let index = 0; index < stableCount; index++) {
			const child = mdastChildren[index];

			// In append mode, reuse previous blocks if unchanged
			if (appendMode && index < previousBlockCount) {
				const prevBlock = renderedBlocks[index];
				const currentHash = getMdastNodeHash(child, index);

				if (prevBlock?.contentHash === currentHash) {
					nextBlocks.push(prevBlock);

					continue;
				}
			}

			// Transform this block (with caching)
			const { hash, html } = await transformMdastNode(processorInstance, child, index);
			const id = getHastNodeId(
				{ position: (child as { position?: unknown }).position } as HastRootContent,
				index
			);

			nextBlocks.push({ contentHash: hash, html, id });
		}

		let unstableHtml = '';

		if (mdastChildren.length > stableCount) {
			const unstableChild = mdastChildren[stableCount];
			const singleNodeRoot = { children: [unstableChild], type: 'root' };
			const transformedRoot = (await processorInstance.run(
				singleNodeRoot as MdastRoot
			)) as HastRoot;

			unstableHtml = processorInstance.stringify(transformedRoot);
		}

		renderedBlocks = nextBlocks;
		previousContent = markdown;
		await tick(); // Force DOM sync before updating unstable HTML block
		unstableBlockHtml = unstableHtml;
	}

	/**
	 * Attaches click event listeners to copy and preview buttons in code blocks.
	 * Uses data-listener-bound attribute to prevent duplicate bindings.
	 */
	function setupCodeBlockActions() {
		if (!containerRef) return;

		const wrappers = containerRef.querySelectorAll<HTMLElement>('.code-block-wrapper');

		for (const wrapper of wrappers) {
			const copyButton = wrapper.querySelector<HTMLButtonElement>('.copy-code-btn');
			const previewButton = wrapper.querySelector<HTMLButtonElement>('.preview-code-btn');

			if (
				copyButton &&
				copyButton.getAttribute(MARKDOWN_DATA_ATTRS.LISTENER_BOUND) !== BooleanString.TRUE
			) {
				copyButton.setAttribute(MARKDOWN_DATA_ATTRS.LISTENER_BOUND, BooleanString.TRUE);
				copyButton.addEventListener('click', handleCopyClick);
			}

			if (
				previewButton &&
				previewButton.getAttribute(MARKDOWN_DATA_ATTRS.LISTENER_BOUND) !== BooleanString.TRUE
			) {
				previewButton.setAttribute(MARKDOWN_DATA_ATTRS.LISTENER_BOUND, BooleanString.TRUE);
				previewButton.addEventListener('click', handlePreviewClick);
			}

			const language =
				wrapper.querySelector('.code-language')?.textContent?.trim().toLowerCase() ?? '';
			const actions = wrapper.querySelector<HTMLElement>(`.${CODE_BLOCK_CLASS.ACTIONS}`);
			if (
				actions &&
				!previewButton &&
				['css', 'js', 'javascript', 'mjs', 'cjs', 'htm', 'xml'].includes(language)
			) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'preview-code-btn text-xs';
				button.textContent = 'Preview / Run';
				button.title = 'Review source in an isolated browser frame. External resources start off.';
				button.setAttribute(MARKDOWN_DATA_ATTRS.LISTENER_BOUND, BooleanString.TRUE);
				button.addEventListener('click', handlePreviewClick);
				actions.append(button);
			}
			if (
				onRunCode &&
				actions &&
				['python', 'py', 'bash', 'sh', 'shell'].includes(language) &&
				!actions.querySelector('.common-run-code-btn')
			) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'common-run-code-btn text-xs px-2 py-1 rounded-md hover:bg-muted';
				button.textContent =
					language === 'python' || language === 'py'
						? 'Review in isolated Python'
						: 'Review in isolated shell';
				button.title =
					'Open the code editor for review. This does not run code or grant package access.';
				button.addEventListener('click', () => {
					const info = getCodeInfoFromTarget(button);
					if (info)
						onRunCode?.(info.rawCode, ['python', 'py'].includes(language) ? 'python' : 'shell');
				});
				actions.append(button);
			}
		}
	}

	/**
	 * Attaches error handlers to images to show fallback UI when loading fails (e.g., CORS).
	 * Uses data-error-bound attribute to prevent duplicate bindings.
	 */
	function setupImageErrorHandlers() {
		if (!containerRef) return;

		const images = containerRef.querySelectorAll<HTMLImageElement>(IMAGE_NOT_ERROR_BOUND_SELECTOR);

		for (const img of images) {
			img.setAttribute(MARKDOWN_DATA_ATTRS.ERROR_BOUND, BooleanString.TRUE);
			img.addEventListener('error', handleImageError);
		}
	}

	// Diagram source stays escaped in the upstream source view. Rendering occurs
	// only inside /sandbox, including automatic completed Mermaid and SVG blocks.
	async function handleMermaidClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		const wrapper = target.closest<HTMLElement>(`.${MERMAID_WRAPPER_CLASS}, .${SVG.WRAPPER_CLASS}`);
		if (!wrapper) return;
		const node = wrapper.querySelector<HTMLElement>(
			`pre.${MERMAID_BLOCK_CLASS}, pre.${SVG.BLOCK_CLASS}`
		);
		if (!node) return;
		const toggle = target.closest(`.${TOGGLE_SOURCE_BTN_CLASS}`);
		if (toggle) {
			event.preventDefault();
			event.stopPropagation();
			const source = wrapper.getAttribute(DIAGRAM_VIEW_MODE_ATTR) !== DIAGRAM_VIEW_SOURCE;
			wrapper.setAttribute(
				DIAGRAM_VIEW_MODE_ATTR,
				source ? DIAGRAM_VIEW_SOURCE : DIAGRAM_VIEW_RENDERED
			);
			toggle.setAttribute('aria-pressed', String(source));
			if (source) {
				diagramSessions.get(node)?.close();
				diagramSessions.delete(node);
			} else renderIsolatedDiagrams();
			return;
		}
		const source =
			node.getAttribute(MERMAID_SYNTAX_ATTR) ?? node.getAttribute(SVG.SOURCE_ATTR) ?? '';
		if (target.closest('.copy-code-btn')) {
			event.preventDefault();
			event.stopPropagation();
			try {
				await copyToClipboard(source);
			} catch (error) {
				console.error('Failed to copy diagram source:', error);
			}
		} else if (target.closest('.preview-code-btn')) {
			event.preventDefault();
			event.stopPropagation();
			openIsolatedPreview(source, node.hasAttribute(MERMAID_SYNTAX_ATTR) ? 'mermaid' : 'svg');
		}
	}

	function renderIsolatedDiagrams() {
		for (const [node, session] of diagramSessions)
			if (!node.isConnected) {
				session.close();
				diagramSessions.delete(node);
			}
		if (!containerRef) return;
		const nodes = containerRef.querySelectorAll<HTMLElement>(
			`pre.${MERMAID_BLOCK_CLASS}, pre.${SVG.BLOCK_CLASS}`
		);
		for (const node of nodes) {
			const wrapper = node.closest<HTMLElement>(`.${MERMAID_WRAPPER_CLASS}, .${SVG.WRAPPER_CLASS}`);
			if (
				!wrapper ||
				wrapper.getAttribute(DIAGRAM_VIEW_MODE_ATTR) === DIAGRAM_VIEW_SOURCE ||
				diagramSessions.has(node)
			)
				continue;
			const mermaid = node.hasAttribute(MERMAID_SYNTAX_ATTR);
			node.setAttribute('data-common-isolated', 'true');
			if (!mermaid) node.setAttribute(SVG.RENDERED_ATTR, BooleanString.TRUE);
			const raw = node.getAttribute(mermaid ? MERMAID_SYNTAX_ATTR : SVG.SOURCE_ATTR) ?? '';
			// SVG is sanitized even for the opaque automatic frame. Raw source can
			// be reviewed and run manually in a separate network-off sandbox.
			const source = mermaid ? raw : sanitizeSvg(raw);
			if (!source) continue;
			let consoleNode = wrapper.querySelector<HTMLPreElement>('.common-diagram-console');
			if (!consoleNode) {
				const details = document.createElement('details'),
					summary = document.createElement('summary');
				summary.textContent = 'Isolated diagram console';
				details.append(summary);
				consoleNode = document.createElement('pre');
				consoleNode.className =
					'common-diagram-console text-xs whitespace-pre-wrap max-h-48 overflow-auto';
				details.append(consoleNode);
				wrapper.append(details);
			}
			consoleNode.textContent = '';
			try {
				node.textContent = '';
				node.style.whiteSpace = 'normal';
				const logs = consoleNode;
				diagramSessions.set(
					node,
					createSandboxSession(node, payloadForSource(source, mermaid ? 'mermaid' : 'svg'), {
						automatic: true,
						onLog: (line, level) => {
							logs.append(document.createTextNode(line));
							if (level === 'error') logs.closest('details')?.setAttribute('open', '');
						}
					})
				);
			} catch (error) {
				consoleNode.textContent =
					error instanceof Error ? error.message : 'The isolated diagram could not start.';
			}
		}
	}

	/**
	 * Handles image load errors by replacing the image with a fallback UI.
	 * Shows a placeholder with a link to open the image in a new tab.
	 */
	function handleImageError(event: Event) {
		const img = event.target as HTMLImageElement;

		if (!img || !img.src) return;

		// Don't handle data URLs or already-handled images
		if (
			img.src.startsWith(UrlProtocol.DATA) ||
			img.getAttribute(MARKDOWN_DATA_ATTRS.ERROR_HANDLED) === BooleanString.TRUE
		)
			return;

		img.setAttribute(MARKDOWN_DATA_ATTRS.ERROR_HANDLED, BooleanString.TRUE);

		const src = img.src;
		// Create fallback element
		const fallback = document.createElement('div');

		fallback.className = 'image-load-error';
		fallback.innerHTML = getImageErrorFallbackHtml(src);

		// Replace image with fallback
		img.parentNode?.replaceChild(fallback, img);
	}

	/**
	 * Queues markdown for processing with coalescing support.
	 * Only processes the latest markdown when multiple updates arrive quickly.
	 * Uses requestAnimationFrame to yield to browser paint between batches.
	 * @param markdown - The markdown content to render
	 */
	async function updateRenderedBlocks(markdown: string) {
		pendingMarkdown = markdown;

		if (isProcessing) {
			return;
		}

		isProcessing = true;

		try {
			while (pendingMarkdown !== null) {
				const nextMarkdown = pendingMarkdown;

				pendingMarkdown = null;

				await processMarkdown(nextMarkdown);

				// Yield to browser for paint. During this, new chunks coalesce
				// into pendingMarkdown, so we always render the latest state.
				if (pendingMarkdown !== null) {
					await new Promise((resolve) => requestAnimationFrame(resolve));
				}
			}
		} catch (error) {
			console.error('Failed to process markdown:', error);
			renderedBlocks = [];
			unstableBlockHtml = markdown
				.replace(
					/[&<>"']/g,
					(character) =>
						({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
						character
				)
				.replace(/\n/g, '<br>');
		} finally {
			isProcessing = false;
		}
	}

	$effect(() => {
		const currentMode = mode.current;
		const isDark = currentMode === ColorMode.DARK;

		loadHighlightTheme(isDark);
	});

	$effect(() => {
		updateRenderedBlocks(content);
	});

	$effect(() => {
		const hasRenderedBlocks = renderedBlocks.length > 0;
		const hasUnstableBlock = Boolean(unstableBlockHtml);

		if ((hasRenderedBlocks || hasUnstableBlock) && containerRef) {
			setupCodeBlockActions();
			setupImageErrorHandlers();
		}
		renderIsolatedDiagrams();
	});

	// Auto-scroll for streaming code block
	$effect(() => {
		streamingAutoScroll.setContainer(streamingCodeScrollContainer);
	});

	$effect(() => {
		streamingAutoScroll.updateInterval(incompleteCodeBlock !== null);
	});

	onDestroy(() => {
		cleanupEventListeners();
		for (const session of diagramSessions.values()) session.close();
		diagramSessions.clear();
		streamingAutoScroll.destroy();
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={containerRef}
	class="markdown-content {className}{settingsStore.config[SETTINGS_KEYS.FULL_HEIGHT_CODE_BLOCKS]
		? ' full-height-code-blocks'
		: ''}"
	onclick={handleMermaidClick}
>
	{#each renderedBlocks as block (block.id)}
		<div class="markdown-block" {...{ [MARKDOWN_DATA_ATTRS.BLOCK_ID]: block.id }}>
			{@html block.html}
		</div>
	{/each}

	{#if unstableBlockHtml}
		<div
			class="markdown-block markdown-block--unstable"
			{...{ [MARKDOWN_DATA_ATTRS.BLOCK_ID]: 'unstable' }}
		>
			<!-- eslint-disable-next-line no-at-html-tags -->
			{@html unstableBlockHtml}
		</div>
	{/if}

	{#if incompleteCodeBlock}
		{#if incompleteCodeBlock.language === MERMAID_LANGUAGE}
			<div class="mermaid-block-wrapper streaming-mermaid-block">
				<div class="code-block-header">
					<span class="code-language">mermaid</span>

					<div class="code-block-actions">
						<ActionIconCopyToClipboard
							ariaLabel="Diagram incomplete"
							canCopy={false}
							text={incompleteCodeBlock.code}
						/>
					</div>
				</div>

				<div class="mermaid-loading-placeholder">
					<span class="mermaid-loading-text">Generating diagram...</span>
				</div>
			</div>
		{:else}
			<div class="code-block-wrapper streaming-code-block relative">
				<div class="code-block-header">
					<span class="code-language">{incompleteCodeBlock.language || 'text'}</span>

					<CodeBlockActions
						code={incompleteCodeBlock.code}
						disabled
						language={incompleteCodeBlock.language || 'text'}
						onPreview={(code, lang) => {
							previewCode = code;
							previewLanguage = lang;
							previewDialogOpen = true;
						}}
					/>
				</div>

				<div
					bind:this={streamingCodeScrollContainer}
					class="streaming-code-scroll-container"
					onscroll={() => streamingAutoScroll.handleScroll()}
				>
					<pre class="streaming-code-pre"><code
							class="hljs language-{incompleteCodeBlock.language || 'text'}"
							>{@html streamingCodeHtml}</code
						></pre>
				</div>
			</div>
		{/if}
	{/if}
</div>

<CommonArtifactPreview
	blocks={previewBlocks}
	code={previewCode}
	language={previewLanguage}
	onOpenChange={handlePreviewDialogOpenChange}
	bind:open={previewDialogOpen}
/>

<style>
	@import './markdown-content.css';

	/* Upstream diagram CSS expects an inline SVG. The Common renderer uses a frame. */
	.markdown-content :global(pre.mermaid[data-common-isolated]) {
		display: block;
		width: 100%;
	}
</style>
