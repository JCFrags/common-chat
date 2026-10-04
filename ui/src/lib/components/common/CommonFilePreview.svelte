<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import SyntaxHighlightedCode from '$lib/components/app/content/SyntaxHighlightedCode.svelte';
	import type { FileRead } from './workspace-state';
	let { content, active = true }: { content: FileRead | null; active?: boolean } = $props();
	let url = $state(''),
		previewError = $state(''),
		offset = $state(0);
	let audioElement = $state<HTMLAudioElement>(),
		videoElement = $state<HTMLVideoElement>();
	const mime = $derived(content?.file.mime ?? '');
	const raster = $derived(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime));
	const audio = $derived(['audio/wav', 'audio/mpeg', 'audio/flac'].includes(mime));
	const video = $derived(['video/mp4', 'video/webm'].includes(mime));
	const language = $derived(
		(
			{
				py: 'python',
				js: 'javascript',
				mjs: 'javascript',
				cjs: 'javascript',
				sh: 'bash',
				md: 'markdown',
				txt: 'text'
			} as Record<string, string>
		)[content?.file.path.split('.').at(-1) ?? ''] ??
			content?.file.path.split('.').at(-1) ??
			'text'
	);
	$effect(() => {
		offset = 0;
		url = '';
		previewError = '';
		if (!active || !content?.data || (!raster && !audio && !video)) return;
		try {
			if (content.data.length > Math.ceil((10 * 1024 * 1024) / 3) * 4)
				throw new Error('Preview exceeds the 10 MiB limit. Download the revision instead.');
			const data = atob(content.data),
				bytes = Uint8Array.from(data, (char) => char.charCodeAt(0));
			const local = URL.createObjectURL(new Blob([bytes], { type: mime }));
			url = local;
			return () => {
				for (const media of [audioElement, videoElement]) {
					media?.pause();
					if (media) {
						media.removeAttribute('src');
						media.load();
					}
				}
				URL.revokeObjectURL(local);
			};
		} catch (e) {
			previewError = e instanceof Error ? e.message : 'Preview bytes could not be read.';
		}
	});
</script>

{#if content}
	<div class="min-w-0 space-y-3">
		<p class="break-all text-xs text-muted-foreground">
			Saved revision {content.file.revision}. Source formats do not run here. Editor drafts are not
			part of this preview.
		</p>
		{#if previewError}<p role="alert" class="text-sm text-destructive">{previewError}</p>{/if}
		{#if content.text !== undefined}
			<SyntaxHighlightedCode code={content.text.slice(0, 128 * 1024)} {language} maxHeight="50vh" />
			{#if content.text.length > 128 * 1024}<p class="text-xs">
					Preview shows the first 128 Ki characters. The editor and download retain the full text.
				</p>{/if}
		{:else if raster && url}<img
				src={url}
				alt={`Saved workspace file ${content.file.path}`}
				class="max-h-96 max-w-full rounded-md"
			/>
		{:else if audio && url}<audio
				bind:this={audioElement}
				src={url}
				controls
				preload="metadata"
				class="w-full"
				aria-label={content.file.path}
			></audio>
		{:else if video && url}<video
				bind:this={videoElement}
				src={url}
				controls
				preload="metadata"
				class="max-h-96 max-w-full"
				aria-label={content.file.path}><track kind="captions" /></video
			>
		{:else if content.passages?.length}
			<p class="text-sm">
				Extracted document text. Layout, images, and some content can be missing. This is not a
				full-fidelity document preview.
			</p>
			{#each content.passages.slice(offset, offset + 25) as passage}<article
					class="rounded-md border p-3 text-sm"
				>
					<p class="text-xs text-muted-foreground">
						{['page', 'paragraph', 'part']
							.flatMap((key) => {
								const value = passage[key as 'page' | 'paragraph' | 'part'];
								return value ? [`${key} ${value}`] : [];
							})
							.join(', ')}
					</p>
					<p class="whitespace-pre-wrap">{passage.text}</p>
					{#if passage.citation?.id}<code class="mt-2 block break-all text-xs"
							>{passage.citation.id}</code
						>{/if}
				</article>{/each}
			<div class="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={offset === 0}
					onclick={() => (offset = Math.max(0, offset - 25))}>Previous passages</Button
				><Button
					variant="ghost"
					size="sm"
					disabled={offset + 25 >= content.passages.length}
					onclick={() => (offset += 25)}>Next passages</Button
				><span class="text-xs"
					>{offset + 1}–{Math.min(offset + 25, content.passages.length)} of {content.passages
						.length}</span
				>
			</div>
		{:else}<p class="text-sm">
				{content.file.index?.error ||
					`Preview is unavailable (${content.file.index?.status ?? 'binary file'}). Download the saved revision.`}
			</p>{/if}
	</div>
{/if}
