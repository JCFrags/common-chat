<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { workspaceLink } from './api';

	interface Props {
		metadata?: unknown;
		conversationId: string;
		status?: string;
		error?: string | null;
		onOpenFile?: (path: string, revision: string) => void;
		onOpenExecution?: (id: string) => void;
	}
	let { metadata, conversationId, status, error, onOpenFile, onOpenExecution }: Props = $props();
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	const number = (value: unknown) =>
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
			? value
			: null;
	const count = (value: unknown) =>
		number(value) !== null && Number.isSafeInteger(value) ? String(value) : 'unavailable';
	const limit = (value: unknown) => (value === null ? 'off' : count(value));
	const meta = $derived(record(metadata));
	const responseError = $derived(error || text(meta.error));
	const activity = $derived(Array.isArray(meta.toolActivity) ? meta.toolActivity.map(record) : []);
	const budget = $derived(record(meta.toolBudget));
	const permissions = $derived(record(meta.toolPermissions));
	const usage = $derived(record(meta.usage));
	const timings = $derived(record(meta.timings));
	const observed = $derived(record(meta.observed));
	const progress = $derived(record(meta.promptProgress));
	const metrics = $derived.by(() => {
		const items: { label: string; value: string }[] = [];
		for (const [key, label] of [
			['prompt_tokens', 'Input tokens'],
			['completion_tokens', 'Output tokens'],
			['total_tokens', 'Total tokens']
		]) {
			if (number(usage[key]) !== null && Number.isSafeInteger(usage[key]))
				items.push({ label, value: String(usage[key]) });
		}
		for (const [key, label] of [
			['prompt_per_second', 'Prompt tokens/s'],
			['predicted_per_second', 'Generated tokens/s']
		]) {
			if (number(timings[key]) !== null) items.push({ label, value: String(timings[key]) });
		}
		if (number(observed.durationMs) !== null)
			items.push({ label: 'Server elapsed', value: `${observed.durationMs} ms` });
		if (number(progress.processed) !== null && number(progress.total) !== null)
			items.push({
				label: 'Reported prompt progress',
				value: `${progress.processed} / ${progress.total}`
			});
		if (number(progress.cache) !== null)
			items.push({ label: 'Reported cached tokens', value: String(progress.cache) });
		return items;
	});
	const files = $derived.by(() => {
		const items = new Map<
			string,
			{ path: string; revision: string; url: string; sources: Set<string> }
		>();
		for (const item of activity) {
			for (const [field, label] of [
				['availableFiles', 'Available saved file'],
				[
					'files',
					item.name === 'write_workspace'
						? 'Saved revision'
						: ['run_python', 'run_shell'].includes(text(item.name))
							? 'Created or changed output'
							: 'Recorded file result'
				]
			]) {
				for (const value of Array.isArray(item[field]) ? (item[field] as unknown[]) : []) {
					const file = record(value),
						link = workspaceLink(file.url, conversationId);
					if (!link || file.path !== link.path || file.revision !== link.revision) continue;
					const key = `${link.path}@${link.revision}`,
						sources = items.get(key)?.sources ?? new Set<string>();
					sources.add(label);
					items.set(key, { ...link, sources });
				}
			}
		}
		return [...items.values()];
	});
	const names: Record<string, string> = {
		list_workspace: 'List files',
		read_workspace: 'Read file',
		write_workspace: 'Write file',
		search_workspace: 'Search files',
		run_python: 'Run Python',
		run_shell: 'Run shell',
		install_packages: 'Install packages'
	};
</script>

{#if responseError}
	<p class="my-2 text-sm text-destructive" role="alert">{responseError}</p>
{/if}
{#if files.length}
	<section aria-label="Recorded workspace files" class="my-3 space-y-1">
		{#each files as file (file.url)}
			<div
				class="flex min-w-0 items-center gap-2 rounded-lg border border-border/40 px-3 py-2 text-sm"
			>
				<a
					class="min-w-0 flex-1 truncate underline underline-offset-4"
					href={file.url}
					download
					title={`${file.path}\nRevision ${file.revision}\n${[...file.sources].join(', ')}. This is not proof that the file was tested.`}
					>{file.path}</a
				>
				{#if onOpenFile}<Button
						variant="ghost"
						size="sm"
						onclick={() => onOpenFile?.(file.path, file.revision)}>Preview revision</Button
					>{/if}
			</div>
		{/each}
	</section>
{/if}
{#if activity.length || Object.keys(budget).length || Object.keys(permissions).length || metrics.length}
	<details class="my-2 rounded-lg border border-border/40 p-3 text-sm">
		<summary class="cursor-pointer font-medium"
			>Response details{activity.length ? ` · ${activity.length} tool calls` : ''}{status
				? ` · ${status}`
				: ''}</summary
		>
		<div class="mt-3 space-y-3">
			{#if metrics.length}
				<dl class="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{#each metrics as metric}<div>
							<dt class="text-xs text-muted-foreground">{metric.label}</dt>
							<dd>{metric.value}</dd>
						</div>{/each}
				</dl>
				<p class="text-xs text-muted-foreground">
					Only supplied counts and rates are shown. Missing values are not estimated.
				</p>
			{/if}
			{#if Object.keys(permissions).length}
				<p>
					Recorded turn permissions: {['workspace', 'execute', 'packages']
						.map(
							(key) =>
								`${key}: ${permissions[key] === true ? 'granted' : permissions[key] === false ? 'not granted' : 'unavailable'}`
						)
						.join(', ')}.
				</p>
			{:else if activity.length}<p>
					Permission provenance is unavailable for this saved history.
				</p>{/if}
			{#if Object.keys(budget).length}
				<p>
					{count(budget.executedCalls)} executed calls. {count(budget.executedRounds)} executed tool rounds.
					Call limit: {limit(budget.callLimit)}. Round limit: {limit(budget.roundLimit)}.{text(
						budget.stopReason
					)
						? ` Stop reason: ${text(budget.stopReason)}.`
						: ''}
				</p>
			{/if}
			{#if activity.length}
				<p class="text-xs text-muted-foreground">
					Saved receipts are display history, not current grants or an execution queue. Imported
					activity does not prove local execution. Available files can be unchanged.
				</p>
				{#each activity as item}
					<details class="rounded-md border border-border/30 p-2" open={item.status === 'running'}>
						<summary class="cursor-pointer"
							>{names[text(item.name)] || text(item.name) || 'Tool'} · {text(item.status) ||
								'archived'}{item.error ? ' · error recorded' : ''}</summary
						>
						<div class="mt-2 space-y-2">
							<pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{text(
									item.summary
								)}</pre>
							{#if text(item.error)}<p class="text-destructive">{text(item.error)}</p>{/if}
							{#if text(item.stdout) || text(item.stderr)}<pre
									class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs"
									aria-label="Saved console excerpt">{[
										text(item.stdout) ? `stdout\n${text(item.stdout)}` : '',
										text(item.stderr) ? `stderr\n${text(item.stderr)}` : ''
									]
										.filter(Boolean)
										.join('\n\n')}</pre>{/if}
							{#if item.changed === false}<p>No new revision. File bytes were unchanged.</p>{/if}
							{#if item.exitCode !== undefined && item.exitCode !== null}<p>
									Exit code: {typeof item.exitCode === 'number' &&
									Number.isSafeInteger(item.exitCode)
										? item.exitCode
										: 'unavailable'}.
								</p>{/if}
							<p class="break-all text-xs text-muted-foreground">
								Call: {text(item.id) || 'unavailable'}{text(item.executionId)
									? ` · Execution: ${text(item.executionId)}`
									: ''}{text(item.operationId)
									? ` · Runner operation: ${text(item.operationId)}`
									: ''}
							</p>
							{#if text(item.executionId) && onOpenExecution}<Button
									variant="ghost"
									size="sm"
									onclick={() => onOpenExecution?.(text(item.executionId))}
									>Full console and results</Button
								>{/if}
						</div>
					</details>
				{/each}
			{/if}
		</div>
	</details>
{/if}
