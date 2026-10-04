<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import { onDestroy } from 'svelte';
	import { createSandboxSession, payloadForSource } from './sandbox';
	let {
		open = $bindable(false),
		code = '',
		language = 'html',
		blocks = [],
		onOpenChange = () => {}
	}: {
		open?: boolean;
		code?: string;
		language?: string;
		blocks?: { code: string; language: string }[];
		onOpenChange?: (open: boolean) => void;
	} = $props();
	let html = $state(''),
		css = $state(''),
		js = $state(''),
		mermaid = $state('');
	let module = $state(false),
		external = $state(false),
		consoleText = $state(''),
		status = $state('Review source, then select Run preview.');
	let output = $state<HTMLDivElement>();
	let session: ReturnType<typeof createSandboxSession> | null = null;
	function stop() {
		session?.close();
		session = null;
	}
	function loadBlocks() {
		const sources = blocks.map((block) =>
			payloadForSource(block.code, block.language.toLowerCase())
		);
		html = sources
			.map((source) => source.html)
			.filter(Boolean)
			.join('\n\n');
		css = sources
			.map((source) => source.css)
			.filter(Boolean)
			.join('\n\n');
		js = sources
			.map((source) => source.js)
			.filter(Boolean)
			.join('\n\n');
		mermaid = sources.find((source) => source.mermaid)?.mermaid ?? '';
		module = sources.some((source) => source.module);
		status =
			'Combined answer source loaded. Only the first Mermaid block is included. Review it, then select Run preview.';
	}
	function run() {
		if (!output) return;
		stop();
		consoleText = '';
		try {
			session = createSandboxSession(
				output,
				{ type: 'common-chat-preview', html, css, js, mermaid, module },
				{ external, onLog: (line) => (consoleText += line), onStatus: (text) => (status = text) }
			);
		} catch (e) {
			status = e instanceof Error ? e.message : 'Preview could not start.';
		}
	}
	$effect(() => {
		if (open) {
			stop();
			const source = payloadForSource(code, language.toLowerCase());
			html = source.html;
			css = source.css;
			js = source.js;
			mermaid = source.mermaid;
			module = source.module;
			external = false;
			consoleText = '';
			status = 'Review source, then select Run preview.';
		} else stop();
	});
	onDestroy(stop);
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content
		class="w-[min(64rem,calc(100vw-1rem))]! max-w-[calc(100vw-1rem)]! max-h-[calc(100dvh-1rem)]!"
	>
		<Dialog.Header
			><div class="flex items-center justify-between">
				<Dialog.Title>Isolated artifact preview</Dialog.Title><Button
					variant="ghost"
					size="sm"
					onclick={() => {
						open = false;
						onOpenChange(false);
					}}>Close</Button
				>
			</div>
			<Dialog.Description
				>Authored HTML, SVG, JavaScript, and diagrams run only inside an opaque browser sandbox,
				never in the chat document.</Dialog.Description
			></Dialog.Header
		>
		<p class="text-sm">
			The frame cannot read your chats, credentials, or host files. Do not enter secrets. Code can
			navigate its own frame. A busy loop may require closing the browser tab.
		</p>
		{#if blocks.length > 1}<Button variant="ghost" size="sm" onclick={loadBlocks}
				>Load code blocks from this answer</Button
			>{/if}
		<details class="rounded-md border p-3" open>
			<summary class="cursor-pointer text-sm font-medium">Review or edit source</summary>
			<div class="mt-3 grid gap-3 sm:grid-cols-2">
				<label class="grid gap-1 text-sm"
					>HTML / SVG<Textarea
						bind:value={html}
						rows={6}
						class="max-h-64 field-sizing-fixed! font-mono"
						spellcheck={false}
					/></label
				><label class="grid gap-1 text-sm"
					>CSS<Textarea
						bind:value={css}
						rows={6}
						class="max-h-64 field-sizing-fixed! font-mono"
						spellcheck={false}
					/></label
				><label class="grid gap-1 text-sm"
					>JavaScript<Textarea
						bind:value={js}
						rows={6}
						class="max-h-64 field-sizing-fixed! font-mono"
						spellcheck={false}
					/></label
				><label class="grid gap-1 text-sm"
					>Mermaid<Textarea
						bind:value={mermaid}
						rows={6}
						class="max-h-64 field-sizing-fixed! font-mono"
						spellcheck={false}
					/></label
				>
			</div>
		</details>
		<label class="flex items-center gap-2 text-sm"
			><input type="checkbox" bind:checked={module} /> JavaScript is an ES module</label
		>
		<p class="text-xs text-muted-foreground">
			External resources are off by default. Enabling them lets this authored code contact websites
			and devices on your network. Consent applies only when you select Run preview or Restart.
		</p>
		<label class="flex items-center gap-2 text-sm"
			><input type="checkbox" bind:checked={external} /> Allow external scripts, styles, images, and requests
			for the next preview</label
		>
		<div class="flex flex-wrap gap-2">
			<Button onclick={run}>Run preview / Restart</Button><Button
				variant="ghost"
				onclick={() => {
					stop();
					status = 'Preview stopped. The frame was removed.';
				}}>Stop</Button
			>
		</div>
		<p role="status" class="text-sm">{status}</p>
		<div bind:this={output} class="min-w-0" aria-label="Isolated preview output"></div>
		<details class="rounded-md border p-3">
			<summary class="cursor-pointer text-sm">Untrusted frame console</summary>
			<pre
				class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{consoleText ||
					'No console messages.'}</pre>
		</details>
	</Dialog.Content>
</Dialog.Root>
