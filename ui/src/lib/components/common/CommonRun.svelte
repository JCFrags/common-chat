<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import {
		api,
		conversationPrefix,
		downloadUrl,
		errorStatus,
		errorText,
		workspaceLink
	} from './api';
	import {
		activeStatuses,
		terminalStatuses,
		type Execution,
		type Runtime,
		type WorkspaceSession
	} from './workspace-state';
	let {
		conversationId,
		session,
		active = true,
		onChanged = () => {},
		onOpenFile = () => {}
	}: {
		conversationId: string;
		session: WorkspaceSession;
		active?: boolean;
		onChanged?: () => Promise<void> | void;
		onOpenFile?: (path: string, revision?: string) => void;
	} = $props();
	let runtime = $state<Runtime | null>(null),
		runtimeError = $state(''),
		runtimeLoading = $state(false);
	let alive = true,
		timer: ReturnType<typeof setTimeout> | undefined,
		polling = '';
	const run = $derived(session.run),
		packages = $derived(session.packages);
	const ready = $derived(runtime?.enabled === true && runtime?.ready === true);
	const packageDirty = $derived(
		packages.pip !== packages.basePip || packages.npm !== packages.baseNpm
	);
	const consoleText = $derived(
		[
			run.job?.stdout ? `stdout\n${run.job.stdout}` : '',
			run.job?.stderr ? `stderr\n${run.job.stderr}` : '',
			run.job?.error ? `error\n${run.job.error}` : ''
		]
			.filter(Boolean)
			.join('\n\n')
	);
	const offset = $derived(Math.min(run.consoleOffset, Math.max(0, consoleText.length - 1)));
	const canRun = $derived(
		ready &&
			!run.starting &&
			!run.unknown &&
			!packages.saving &&
			(!run.job || terminalStatuses.has(run.job.status)) &&
			!!run.code.trim() &&
			(!run.allowPackages || runtime?.packages === true)
	);
	const prefix = (cid: string) => conversationPrefix(cid);
	const fileLink = (path: string, revision: string) =>
		workspaceLink(downloadUrl(conversationId, path, revision), conversationId);
	async function changed(ctx: WorkspaceSession) {
		try {
			await onChanged();
		} catch {
			ctx.run.error = 'The operation was saved, but the conversation refresh failed.';
		}
	}
	export async function checkRuntime() {
		if (runtimeLoading) return;
		runtimeLoading = true;
		runtimeError = '';
		try {
			runtime = await api<Runtime>('/api/runtime');
		} catch (e) {
			runtime = null;
			runtimeError = errorText(e);
		} finally {
			runtimeLoading = false;
		}
	}
	function validateJob(result: Execution, expectedId?: string) {
		if (
			!result ||
			typeof result.id !== 'string' ||
			!result.id ||
			typeof result.status !== 'string' ||
			(expectedId && result.id !== expectedId)
		)
			throw Object.assign(
				new Error('The server did not return a usable execution status. Check Recent runs.'),
				{ status: 0 }
			);
		return result;
	}
	async function poll(ctx: WorkspaceSession, cid: string) {
		const id = ctx.run.job?.id,
			key = `${cid}:${id}`;
		if (!id || !active || !alive || session !== ctx || conversationId !== cid || polling === key)
			return;
		clearTimeout(timer);
		polling = key;
		try {
			const job = validateJob(
				await api<Execution>(`${prefix(cid)}/executions/${encodeURIComponent(id)}`),
				id
			);
			if (ctx.run.job?.id !== id) return;
			const previous = ctx.run.job.status;
			ctx.run.job = job;
			ctx.run.error = '';
			if (!activeStatuses.has(job.status) && !terminalStatuses.has(job.status))
				ctx.run.error = 'Unknown execution state. Inspect Recent runs before submitting again.';
			if (activeStatuses.has(previous) && terminalStatuses.has(job.status)) await changed(ctx);
		} catch (e) {
			if (ctx.run.job?.id === id)
				ctx.run.error = `${errorText(e)} Last known status is kept. Use Recent runs to reconnect.`;
		} finally {
			if (polling === key) polling = '';
			if (
				alive &&
				active &&
				session === ctx &&
				conversationId === cid &&
				ctx.run.job?.id === id &&
				activeStatuses.has(ctx.run.job.status) &&
				!ctx.run.error
			)
				timer = setTimeout(() => {
					void poll(ctx, cid);
				}, 1000);
		}
	}
	export async function openExecution(id: string) {
		const ctx = session,
			cid = conversationId;
		ctx.run.error = '';
		try {
			const job = validateJob(
				await api<Execution>(`${prefix(cid)}/executions/${encodeURIComponent(id)}`),
				id
			);
			ctx.run.job = job;
			ctx.run.consoleOffset = 0;
			ctx.run.unknown = false;
			if (activeStatuses.has(job.status)) void poll(ctx, cid);
		} catch (e) {
			ctx.run.error = errorText(e);
		}
	}
	export function openCode(source: string, kind: 'python' | 'shell' = 'python') {
		if (
			run.code &&
			run.code !== source &&
			!confirm('Replace the code draft with this source? Nothing will run until you select Run.')
		)
			return false;
		run.code = source;
		run.kind = kind;
		run.error = '';
		return true;
	}
	async function recentRuns() {
		const ctx = session,
			cid = conversationId;
		if (ctx.run.recovering) return;
		ctx.run.recovering = true;
		ctx.run.error = '';
		try {
			const value = await api<{ executions: Execution[] }>(`${prefix(cid)}/executions`);
			if (!Array.isArray(value.executions)) throw new Error('Invalid recent-run list.');
			ctx.run.recent = value.executions.slice(0, 20);
		} catch (e) {
			ctx.run.error = errorText(e);
		} finally {
			ctx.run.recovering = false;
		}
	}
	async function start() {
		const ctx = session,
			cid = conversationId;
		if (!canRun) return;
		const code = ctx.run.code,
			kind = ctx.run.kind,
			allowPackages = ctx.run.allowPackages;
		const codeLimit =
			typeof runtime?.limits?.codeBytes === 'number' ? runtime.limits.codeBytes : 64 * 1024;
		if (new TextEncoder().encode(code).length > codeLimit) {
			ctx.run.error = `Code must fit ${codeLimit} bytes.`;
			return;
		}
		ctx.run.starting = true;
		ctx.run.error = '';
		ctx.run.recent = null;
		try {
			ctx.run.job = validateJob(
				await api<Execution>(`${prefix(cid)}/executions`, 'POST', { kind, code, allowPackages })
			);
			ctx.run.consoleOffset = 0;
			ctx.run.unknown = false;
			await changed(ctx);
			await poll(ctx, cid);
		} catch (e) {
			ctx.run.error = errorText(e);
			if (errorStatus(e) === 0 || errorStatus(e) >= 500) {
				ctx.run.unknown = true;
				ctx.run.error +=
					' Start status is unknown. Check Recent runs and files before submitting again. Code is never retried automatically.';
			}
		} finally {
			ctx.run.starting = false;
		}
	}
	async function stop() {
		const ctx = session,
			cid = conversationId,
			id = ctx.run.job?.id;
		if (!id || ctx.run.canceling) return;
		ctx.run.canceling = true;
		ctx.run.error = '';
		try {
			await api(`${prefix(cid)}/executions/${encodeURIComponent(id)}/cancel`, 'POST');
			await poll(ctx, cid);
		} catch (e) {
			ctx.run.error = `${errorText(e)} Cancellation is not confirmed. Check Recent runs.`;
		} finally {
			ctx.run.canceling = false;
		}
	}
	async function loadPackages() {
		const ctx = session,
			cid = conversationId,
			p = ctx.packages;
		if (
			p.loading ||
			p.saving ||
			(packageDirty && !confirm('Replace the unsaved package list with the saved server list?'))
		)
			return;
		const original = [p.pip, p.npm];
		p.loading = true;
		p.error = '';
		try {
			const result = await api<{ pip: string[]; npm: string[] }>(`${prefix(cid)}/packages`);
			if (!Array.isArray(result.pip) || !Array.isArray(result.npm))
				throw new Error('Invalid saved package list.');
			p.basePip = result.pip.join('\n');
			p.baseNpm = result.npm.join('\n');
			p.loaded = true;
			if (p.pip === original[0] && p.npm === original[1]) {
				p.pip = p.basePip;
				p.npm = p.baseNpm;
				p.status = 'Saved package list loaded.';
			} else
				p.status =
					'Edits made during loading were kept. The server list was not placed over your draft.';
		} catch (e) {
			p.error = errorText(e);
		} finally {
			p.loading = false;
		}
	}
	async function savePackages() {
		const ctx = session,
			cid = conversationId,
			p = ctx.packages;
		if (
			!ready ||
			runtime?.packages !== true ||
			!p.consent ||
			p.saving ||
			p.loading ||
			run.starting ||
			run.unknown ||
			(run.job && !terminalStatuses.has(run.job.status))
		)
			return;
		if (
			!p.loaded &&
			!confirm('The existing package list has not been loaded. Replace it with the displayed list?')
		)
			return;
		const original = [p.pip, p.npm],
			pip = p.pip
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean),
			npm = p.npm
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean);
		p.saving = true;
		p.error = '';
		p.status = 'Validating registry packages. You can keep editing. This can take five minutes.';
		try {
			const result = await api<Execution & { saved: boolean; pip: string[]; npm: string[] }>(
				`${prefix(cid)}/packages`,
				'POST',
				{ pip, npm, allowPackages: true }
			);
			ctx.run.job = validateJob(result);
			ctx.run.consoleOffset = 0;
			if (result.saved !== true) {
				p.error = `${result.error || 'Package validation failed.'} Previous saved specifications are unchanged. See the saved console.`;
				p.status = '';
				return;
			}
			p.basePip = result.pip.join('\n');
			p.baseNpm = result.npm.join('\n');
			p.loaded = true;
			if (p.pip === original[0] && p.npm === original[1]) {
				p.pip = p.basePip;
				p.npm = p.baseNpm;
				p.status = 'Packages verified and saved.';
			} else p.status = 'Submitted packages were saved. Later editor changes remain unsaved.';
			p.consent = false;
			await changed(ctx);
		} catch (e) {
			p.error = errorText(e);
			p.status = '';
			if (errorStatus(e) === 0 || errorStatus(e) >= 500) {
				ctx.run.unknown = true;
				p.error +=
					' Status is unknown. Check Recent runs and reload saved packages before another submission.';
			}
		} finally {
			p.saving = false;
		}
	}
	function downloadConsole() {
		const blob = new Blob([consoleText], { type: 'text/plain;charset=utf-8' }),
			url = URL.createObjectURL(blob),
			a = document.createElement('a');
		a.href = url;
		a.download = 'execution-console.txt';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	$effect(() => {
		if (active && conversationId && session)
			untrack(() => {
				void checkRuntime();
				if (session.run.job && activeStatuses.has(session.run.job.status))
					void poll(session, conversationId);
			});
		return () => clearTimeout(timer);
	});
	onDestroy(() => {
		alive = false;
		clearTimeout(timer);
	});
</script>

<section class="space-y-4" aria-label="Isolated code and package operations">
	<p class="text-sm">
		Review the source before Run. Code runs only through the configured isolated runner and can
		change this conversation's files. Closing this panel stops status polling, not server work.
		Model tools and manual consent are separate.
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<p class="flex-1 text-sm" role="status">
			{runtimeLoading
				? 'Checking runner...'
				: runtimeError ||
					(ready
						? 'Runner available.'
						: `Execution unavailable. ${runtime?.blockedReasons?.join(' ') || 'No ready runner was reported.'}`)}
		</p>
		<Button variant="ghost" size="sm" disabled={runtimeLoading} onclick={checkRuntime}
			>Check runner</Button
		>
	</div>
	<details class="rounded-md border p-3 text-sm">
		<summary class="cursor-pointer">Reported limits, inventory, and native tools</summary>
		<p class="mt-2 text-xs text-muted-foreground">
			Execution is offline. Package access is restricted to approved registries, not general
			internet access. There is no host shell, host filesystem, browser, or MCP fallback. A model
			also needs a configured function-tool connection.
		</p>
		<pre
			class="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(
				{ limits: runtime?.limits ?? null, verifiedInventory: runtime?.inventory ?? null },
				null,
				2
			)}</pre>
		{#each runtime?.nativeTools ?? [] as tool}<p class="my-2 text-xs">
				{tool.title || tool.name} · {tool.available === true ? 'runtime available' : 'unavailable'} ·
				{tool.category}<br />{tool.description}
			</p>{/each}
	</details>
	<div class="flex flex-wrap items-center gap-4">
		<label class="grid gap-1 text-sm"
			>Language<select
				class="h-9 rounded-md border border-input bg-background px-3"
				bind:value={run.kind}
				><option value="python">Python</option><option value="shell">POSIX shell</option></select
			></label
		><label class="flex items-center gap-2 text-sm"
			><input
				type="checkbox"
				bind:checked={run.allowPackages}
				disabled={runtime?.packages !== true && !run.allowPackages}
			/> Allow approved registry downloads for saved dependencies in this run</label
		>
	</div>
	<label class="grid gap-1 text-sm"
		>Code for manual review<Textarea
			bind:value={run.code}
			spellcheck={false}
			rows={12}
			class="min-h-60 max-h-[60vh] field-sizing-fixed! font-mono"
			placeholder="Review or enter code. Source never runs on panel open."
		/></label
	>
	<p class="text-xs text-muted-foreground">
		Each run receives a copied workspace. Only successful changed outputs create revisions. Python
		uses headless plotting. Save plots to files instead of plt.show().
	</p>
	<div class="flex flex-wrap items-center gap-2">
		<Button disabled={!canRun} onclick={start}
			>{run.starting ? 'Starting...' : 'Run reviewed code'}</Button
		><Button
			variant="ghost"
			disabled={!run.job || !activeStatuses.has(run.job.status) || run.canceling}
			onclick={stop}>{run.canceling ? 'Requesting cancellation...' : 'Stop'}</Button
		><Button variant="ghost" disabled={run.recovering} onclick={recentRuns}>Recent runs</Button
		><span role="status" class="text-sm"
			>{run.unknown
				? 'Start status unknown. Inspect recent runs before another submission.'
				: (run.job?.status ?? '')}</span
		>
	</div>
	{#if run.error}<p role="alert" class="text-sm text-destructive">{run.error}</p>{/if}
	{#if run.recent}<div class="space-y-1">
			<p class="text-xs">
				Select a saved operation to inspect it. Requests are never replayed automatically.
			</p>
			{#each run.recent as job}<Button
					variant="ghost"
					size="sm"
					class="max-w-full whitespace-normal break-all"
					onclick={() => openExecution(job.id)}
					>{job.kind || 'run'} · {job.id} · {job.status}</Button
				>{/each}{#if !run.recent.length}<p class="text-sm">
					No recent runs returned.
				</p>{/if}{#if run.unknown}<Button
					size="sm"
					variant="outline"
					onclick={() => {
						if (
							confirm(
								'Have you checked recent executions, saved packages, and current files and confirmed that another submission is safe? An earlier request may still be active.'
							)
						) {
							run.unknown = false;
							run.error = '';
						}
					}}>Allow a new submission after inspection</Button
				>{/if}
		</div>{/if}
	{#if run.job}
		<div class="space-y-2 rounded-lg border p-3">
			<h3 class="text-sm font-medium">Saved console and results</h3>
			<p class="break-all text-xs">
				Execution {run.job.id}{run.job.operationId
					? ` · runner operation ${run.job.operationId}`
					: ''}{run.job.exitCode !== null && run.job.exitCode !== undefined
					? ` · exit ${run.job.exitCode}`
					: ''}
			</p>
			<!-- The bounded console needs focus for keyboard scrolling. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<pre
				class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs"
				tabindex="0"
				role="log"
				aria-label="Saved execution console">{consoleText.slice(offset, offset + 64 * 1024) ||
					'No saved output yet.'}</pre>
			<p class="text-xs">
				{consoleText.length > 64 * 1024
					? `Characters ${offset + 1}–${Math.min(offset + 64 * 1024, consoleText.length)} of ${consoleText.length}.`
					: 'All saved output is shown.'} Runner output limits still apply.
			</p>
			<div class="flex flex-wrap gap-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={offset === 0}
					onclick={() => (run.consoleOffset = Math.max(0, offset - 64 * 1024))}
					>Previous console page</Button
				><Button
					variant="ghost"
					size="sm"
					disabled={offset + 64 * 1024 >= consoleText.length}
					onclick={() => (run.consoleOffset = offset + 64 * 1024)}>Next console page</Button
				><Button variant="ghost" size="sm" onclick={downloadConsole}
					>Download full saved console</Button
				>
			</div>
			{#if run.job.files?.length}<h4 class="text-sm">Created or changed files</h4>
				{#each run.job.files as file}{#if fileLink(file.path, file.revision)}<div
							class="flex flex-wrap gap-2 text-sm"
						>
							<a
								class="break-all underline"
								href={downloadUrl(conversationId, file.path, file.revision)}
								download>{file.path}</a
							><Button
								variant="ghost"
								size="sm"
								onclick={() => onOpenFile(file.path, file.revision)}>Preview revision</Button
							>
						</div>{/if}{/each}{/if}
			<p class="text-xs">
				{run.job.availableFiles?.length ?? 0} current available files. Available files are not necessarily
				outputs of this operation. {run.job.fileNote ?? ''}
			</p>
		</div>
	{/if}
	<details class="space-y-3 rounded-lg border p-3">
		<summary class="cursor-pointer text-sm font-medium">Conversation packages</summary>
		<p class="mt-3 text-xs text-muted-foreground">
			Validation replaces the saved package specifications. One specification per line. Python: name
			or name==version. npm: name or name@exact.version. No URLs, paths, flags, ranges, or Git
			sources. Validation can take five minutes.
		</p>
		<div class="my-3 grid gap-3 sm:grid-cols-2">
			<label class="grid gap-1 text-sm"
				>Python packages<Textarea bind:value={packages.pip} rows={4} spellcheck={false} /></label
			><label class="grid gap-1 text-sm"
				>npm packages<Textarea bind:value={packages.npm} rows={4} spellcheck={false} /></label
			>
		</div>
		<label class="flex items-center gap-2 text-sm"
			><input type="checkbox" bind:checked={packages.consent} /> Allow the displayed packages to be downloaded
			from approved registries</label
		>
		<div class="my-3 flex flex-wrap gap-2">
			<Button
				variant="ghost"
				size="sm"
				disabled={packages.loading || packages.saving}
				onclick={loadPackages}>Load saved list</Button
			><Button
				size="sm"
				disabled={!ready ||
					runtime?.packages !== true ||
					!packages.consent ||
					packages.loading ||
					packages.saving ||
					run.starting ||
					run.unknown ||
					(!!run.job && !terminalStatuses.has(run.job.status))}
				onclick={savePackages}
				>{packages.saving ? 'Validating...' : 'Validate and save packages'}</Button
			>
		</div>
		<p role="status" class="text-sm">
			{packageDirty ? 'Unsaved package edits. ' : ''}{packages.loading
				? 'Loading saved list...'
				: packages.status}
		</p>
		{#if packages.error}<p role="alert" class="text-sm text-destructive">{packages.error}</p>{/if}
	</details>
</section>
