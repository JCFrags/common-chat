<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { untrack } from 'svelte';
	import {
		api,
		conversationPrefix,
		downloadUrl,
		errorStatus,
		errorText,
		readBase64,
		workspaceQuery
	} from './api';
	import CommonFilePreview from './CommonFilePreview.svelte';
	import {
		dirtyFile,
		fileDraft,
		sizeLabel,
		type FileDraft,
		type FileMetadata,
		type FileRead,
		type SearchResult,
		type WorkspaceSession
	} from './workspace-state';
	let {
		conversationId,
		session,
		active = true,
		onChanged = () => {}
	}: {
		conversationId: string;
		session: WorkspaceSession;
		active?: boolean;
		onChanged?: () => Promise<void> | void;
	} = $props();
	let uploadInput = $state<HTMLInputElement>();
	const draft = $derived(session.selected ? session.drafts[session.selected] : null);
	const editable = $derived(
		!!draft &&
			(draft.isNew ||
				(draft.file?.text === true &&
					!draft.file.deleted &&
					typeof draft.content?.text === 'string'))
	);
	const stale = $derived(
		!!draft?.file &&
			session.files.some((f) => f.path === draft.path && f.revision !== draft.file?.revision)
	);
	const base = (cid: string) => `${conversationPrefix(cid)}/workspace`;
	function checkedFile(value: FileMetadata): FileMetadata {
		if (
			!value ||
			typeof value.path !== 'string' ||
			typeof value.revision !== 'string' ||
			!value.revision
		)
			throw new Error('Invalid file metadata. Refresh before making changes.');
		return value;
	}
	function checkedRead(value: FileRead): FileRead {
		checkedFile(value?.file);
		if (typeof value.text !== 'string' && typeof value.data !== 'string')
			throw new Error('The server did not return file content. Your draft is kept.');
		return value;
	}
	function setFile(ctx: WorkspaceSession, file: FileMetadata) {
		ctx.files = [...ctx.files.filter((f) => f.path !== file.path), file].sort((a, b) =>
			a.path.localeCompare(b.path)
		);
	}
	async function changed(ctx: WorkspaceSession) {
		try {
			await onChanged();
		} catch {
			ctx.error = 'The file change was saved, but the conversation refresh failed.';
		}
	}
	export async function refresh() {
		const ctx = session,
			cid = conversationId;
		if (ctx.loading) return;
		ctx.loading = true;
		ctx.error = '';
		try {
			const result = await api<{ files: FileMetadata[]; usage: Record<string, number> }>(base(cid));
			if (!Array.isArray(result.files)) throw new Error('Invalid workspace list.');
			ctx.files = result.files.map(checkedFile);
			ctx.usage = result.usage;
			ctx.loaded = true;
		} catch (e) {
			ctx.error = errorText(e);
		} finally {
			ctx.loading = false;
		}
	}
	export async function openFile(path: string, revision?: string) {
		const ctx = session,
			cid = conversationId,
			ticket = ++ctx.openTicket;
		let existing = Object.values(ctx.drafts).find((item) => item.path === path);
		ctx.error = '';
		try {
			if (!ctx.loaded) {
				const listing = await api<{ files: FileMetadata[]; usage: Record<string, number> }>(
					base(cid)
				);
				ctx.files = listing.files.map(checkedFile);
				ctx.usage = listing.usage;
				ctx.loaded = true;
			}
			if (!existing) {
				const head = ctx.files.find((f) => f.path === path);
				if (head?.deleted) existing = fileDraft(head, null);
				else
					existing = fileDraft(
						null,
						checkedRead(await api<FileRead>(`${base(cid)}/files?${workspaceQuery(path)}`))
					);
				if (!head?.deleted) {
					const file = existing.content!.file;
					existing = fileDraft(file, existing.content);
				}
				ctx.drafts[path] = existing;
			}
			if (revision) {
				const historical = checkedRead(
					await api<FileRead>(`${base(cid)}/files?${workspaceQuery(path, revision)}`)
				);
				if (ticket !== ctx.openTicket) return;
				existing.historical = historical;
				existing.view = 'preview';
			}
			if (ticket === ctx.openTicket) ctx.selected = existing.key;
		} catch (e) {
			ctx.error = errorText(e);
		}
	}
	function newFile() {
		const item = fileDraft(null, null);
		session.drafts[item.key] = item;
		session.selected = item.key;
	}
	function mutationError(item: FileDraft, e: unknown) {
		item.error = errorText(e);
		if (errorStatus(e) === 409) {
			item.conflict = true;
			item.error +=
				' No newer file was overwritten. Copy useful edits, then reload, or change a new-file path.';
		}
	}
	async function save() {
		const ctx = session,
			cid = conversationId,
			item = draft;
		if (!item || !editable || item.busy || item.conflict || stale || ctx.busy) return;
		const path = item.path.trim(),
			text = item.text,
			oldKey = item.key,
			expectedRevision = item.file?.revision ?? null;
		if (!path) {
			item.error = 'Enter a relative file path.';
			return;
		}
		if (new TextEncoder().encode(text).length > 1024 * 1024) {
			item.error = 'Text files must fit 1 MiB.';
			return;
		}
		item.busy = true;
		item.error = '';
		try {
			const file = checkedFile(
				await api<FileMetadata>(`${base(cid)}/files`, 'PUT', { path, text, expectedRevision })
			);
			setFile(ctx, file);
			item.file = file;
			item.path = file.path;
			item.isNew = false;
			item.key = file.path;
			item.baseText = text;
			item.content = { file, text };
			item.historical = null;
			item.history = null;
			item.conflict = false;
			item.notice = 'Revision saved. Text entered during saving remains an unsaved change.';
			if (oldKey !== item.key) {
				delete ctx.drafts[oldKey];
				ctx.drafts[item.key] = item;
				if (ctx.selected === oldKey) ctx.selected = item.key;
			}
			await changed(ctx);
		} catch (e) {
			mutationError(item, e);
		} finally {
			item.busy = false;
		}
	}
	async function reload() {
		const ctx = session,
			cid = conversationId,
			item = draft;
		if (
			!item?.file ||
			item.busy ||
			ctx.busy ||
			(dirtyFile(item) &&
				!confirm('Reload this file and discard its unsaved text? Copy useful edits first.'))
		)
			return;
		item.busy = item.locked = true;
		item.error = '';
		try {
			const listing = await api<{ files: FileMetadata[]; usage: Record<string, number> }>(
				base(cid)
			);
			ctx.files = listing.files.map(checkedFile);
			ctx.usage = listing.usage;
			ctx.loaded = true;
			const head = ctx.files.find((file) => file.path === item.path);
			if (head?.deleted) ctx.drafts[item.key] = fileDraft(head, null);
			else {
				const result = checkedRead(
					await api<FileRead>(`${base(cid)}/files?${workspaceQuery(item.path, head?.revision)}`)
				);
				ctx.drafts[item.key] = fileDraft(result.file, result);
				setFile(ctx, result.file);
			}
		} catch (e) {
			item.error = `${errorText(e)} Your draft is kept. Deleted files can be recovered through revision history.`;
		} finally {
			item.busy = item.locked = false;
		}
	}
	function discard() {
		const item = draft;
		if (!item || item.busy || !confirm('Discard this unsaved file draft?')) return;
		if (item.isNew) {
			delete session.drafts[item.key];
			session.selected = null;
		} else item.text = item.baseText;
	}
	async function remove() {
		const ctx = session,
			cid = conversationId,
			item = draft;
		if (
			!item?.file ||
			item.busy ||
			ctx.busy ||
			!confirm(
				`Delete ${item.path}? A deletion revision retains previous history.${dirtyFile(item) ? ' Unsaved editor text will be discarded only after success.' : ''}`
			)
		)
			return;
		item.busy = item.locked = true;
		item.error = '';
		try {
			const file = checkedFile(
				await api<FileMetadata>(`${base(cid)}/files`, 'DELETE', {
					path: item.path,
					expectedRevision: item.file.revision
				})
			);
			setFile(ctx, file);
			ctx.drafts[item.key] = fileDraft(file, null);
			await changed(ctx);
		} catch (e) {
			mutationError(item, e);
		} finally {
			item.busy = item.locked = false;
		}
	}
	async function history() {
		const cid = conversationId,
			item = draft;
		if (!item?.file || item.busy) return;
		item.view = 'history';
		item.busy = true;
		item.error = '';
		try {
			const result = await api<{ revisions: FileMetadata[] }>(
				`${base(cid)}/history?${workspaceQuery(item.path)}`
			);
			item.history = result.revisions.map(checkedFile);
		} catch (e) {
			item.error = errorText(e);
		} finally {
			item.busy = false;
		}
	}
	async function restore(revision: FileMetadata) {
		const ctx = session,
			cid = conversationId,
			item = draft;
		if (
			!item?.file ||
			item.busy ||
			ctx.busy ||
			revision.deleted ||
			!confirm(
				`Restore ${item.path} from revision ${revision.version ?? revision.revision}? A new head is created.${dirtyFile(item) ? ' Unsaved text is discarded only after success.' : ''}`
			)
		)
			return;
		item.busy = item.locked = true;
		item.error = '';
		let restored = false;
		try {
			const file = checkedFile(
				await api<FileMetadata>(`${base(cid)}/restore`, 'POST', {
					path: item.path,
					revision: revision.revision,
					expectedRevision: item.file.revision
				})
			);
			restored = true;
			setFile(ctx, file);
			item.notice = 'Restore succeeded. Reload to read the restored content.';
			await changed(ctx);
			const result = checkedRead(
				await api<FileRead>(`${base(cid)}/files?${workspaceQuery(file.path, file.revision)}`)
			);
			ctx.drafts[item.key] = fileDraft(file, result);
		} catch (e) {
			if (restored) {
				item.conflict = true;
				item.error =
					'Restore succeeded, but the new content could not be loaded. The old draft is kept. Reload before saving.';
			} else mutationError(item, e);
		} finally {
			item.busy = item.locked = false;
		}
	}
	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement,
			selected = Array.from(input.files ?? []),
			ctx = session,
			cid = conversationId;
		if (!selected.length || ctx.busy) return;
		ctx.busy = true;
		ctx.error = '';
		let saved = 0;
		try {
			for (const file of selected) {
				if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB.`);
				const head = ctx.files.find((f) => f.path === file.name),
					local = Object.values(ctx.drafts).find((d) => d.path === file.name);
				if (
					(head || local) &&
					!confirm(
						`Replace ${file.name}?${dirtyFile(local) ? ' Its unsaved draft will be discarded after success.' : ''}`
					)
				)
					continue;
				if (local) {
					local.busy = local.locked = true;
				}
				try {
					const result = checkedFile(
						await api<FileMetadata>(`${base(cid)}/files`, 'PUT', {
							path: file.name,
							mime: file.type || undefined,
							data: await readBase64(file),
							expectedRevision: head?.revision ?? null
						})
					);
					setFile(ctx, result);
					if (local) {
						delete ctx.drafts[local.key];
						if (ctx.selected === local.key) ctx.selected = null;
					}
					saved++;
					await changed(ctx);
				} finally {
					if (local) local.busy = local.locked = false;
				}
			}
		} catch (e) {
			ctx.error = `${saved ? `${saved} files saved before this error. ` : ''}${errorText(e)}${errorStatus(e) === 409 ? ' No conflicting file was overwritten. Refresh and review the current revision.' : ''}`;
		} finally {
			ctx.busy = false;
			input.value = '';
			if (ctx === session) void refresh();
		}
	}
	async function search() {
		const ctx = session,
			cid = conversationId,
			query = ctx.query.trim(),
			ticket = ++ctx.searchTicket;
		if (!query) {
			ctx.results = null;
			ctx.searching = false;
			return;
		}
		ctx.searching = true;
		ctx.error = '';
		try {
			const result = await api<{ results: SearchResult[]; indexing: WorkspaceSession['indexing'] }>(
				`${base(cid)}/search?${new URLSearchParams({ q: query, limit: '25' })}`
			);
			if (ticket === ctx.searchTicket) {
				ctx.results = result.results;
				ctx.indexing = result.indexing ?? [];
			}
		} catch (e) {
			if (ticket === ctx.searchTicket) ctx.error = errorText(e);
		} finally {
			if (ticket === ctx.searchTicket) ctx.searching = false;
		}
	}
	$effect(() => {
		if (active && conversationId && session)
			untrack(() => {
				void refresh();
			});
	});
</script>

<section class="space-y-3" aria-label="Conversation workspace files">
	<div class="flex flex-wrap gap-2">
		<Button size="sm" disabled={session.busy} onclick={newFile}>New file</Button><Button
			variant="ghost"
			size="sm"
			disabled={session.busy || !session.loaded}
			onclick={() => uploadInput?.click()}>Upload</Button
		><input
			bind:this={uploadInput}
			type="file"
			multiple
			hidden
			onchange={upload}
			aria-label="Upload workspace files"
		/><Button variant="ghost" size="sm" disabled={session.loading} onclick={refresh}
			>Refresh list</Button
		>
	</div>
	<form
		class="flex gap-2"
		onsubmit={(e) => {
			e.preventDefault();
			void search();
		}}
	>
		<Input
			type="search"
			bind:value={session.query}
			maxlength={500}
			aria-label="Search current file contents"
			placeholder="Search current source text"
		/><Button type="submit" variant="ghost" disabled={session.searching}>Search</Button
		>{#if session.results}<Button
				variant="ghost"
				onclick={() => {
					session.searchTicket++;
					session.results = null;
					session.searching = false;
				}}>Clear</Button
			>{/if}
	</form>
	{#if session.error}<p role="alert" class="text-sm text-destructive">{session.error}</p>{/if}
	<p role="status" class="text-xs text-muted-foreground">
		{session.loading
			? 'Loading files...'
			: session.searching
				? 'Searching...'
				: `${session.files.filter((f) => !f.deleted).length} current files.`}{session.usage
			? ` ${sizeLabel(session.usage.bytes)} retained across ${session.usage.revisions} revisions. Deletion retains history.`
			: ''}
	</p>
	<div class="grid min-w-0 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
		<aside class="max-h-96 space-y-1 overflow-auto" aria-label="Workspace file list">
			{#each Object.values(session.drafts).filter((d) => d.isNew) as local}<Button
					class="w-full justify-start truncate"
					variant="ghost"
					size="sm"
					onclick={() => (session.selected = local.key)}
					>{local.path || 'Untitled'} · unsaved</Button
				>{/each}
			{#if session.results}
				{#each session.results as result}<article class="space-y-1 rounded-md border p-2 text-xs">
						<Button
							variant="ghost"
							size="sm"
							class="w-full justify-start truncate"
							onclick={() => openFile(result.path, result.revision)}>{result.path}</Button
						>
						<p class="whitespace-pre-wrap break-words">{result.text}</p>
						<code class="block break-all"
							>{result.citation?.id ||
								`workspace:${encodeURIComponent(result.path)}@${result.revision}`}</code
						>
					</article>{/each}
				{#each session.indexing as item}<p class="text-xs">
						{item.path}: {item.error || item.status}
					</p>{/each}
				{#if !session.results.length}<p class="text-sm">
						No matching source text. Deleted files are not searched.
					</p>{/if}
			{:else}
				{#each session.files as file}<Button
						variant="ghost"
						class="h-auto w-full justify-start whitespace-normal text-left"
						aria-current={draft?.path === file.path ? 'true' : undefined}
						onclick={() => openFile(file.path)}
						><span class="min-w-0"
							><span class="block break-all">{file.path}</span><span
								class="block text-xs text-muted-foreground"
								>{file.deleted ? 'Deleted' : file.mime} · {file.version ?? '?'}{Object.values(
									session.drafts
								).some((d) => d.path === file.path && dirtyFile(d))
									? ' · unsaved'
									: ''}</span
							></span
						></Button
					>{/each}
			{/if}
		</aside>
		<div class="min-w-0 space-y-3">
			{#if draft}
				{#if draft.isNew}<label class="grid gap-1 text-sm"
						>Relative file path<Input
							bind:value={draft.path}
							disabled={draft.busy || session.busy}
							placeholder="notes/summary.md"
							autocomplete="off"
							onchange={() => {
								if (draft?.isNew) {
									draft.conflict = false;
									draft.error = '';
								}
							}}
						/></label
					>{:else}<h3 class="break-all text-sm font-medium">{draft.path}</h3>
					<p class="break-all text-xs text-muted-foreground">
						Revision {draft.file?.version ?? '?'} · {draft.file?.revision} · {sizeLabel(
							draft.file?.size ?? 0
						)}{draft.file?.deleted ? ' · deleted' : ''}
					</p>{/if}
				<div class="flex flex-wrap gap-1">
					{#if editable}<Button
							size="sm"
							disabled={draft.busy || session.busy || draft.conflict || stale || !dirtyFile(draft)}
							onclick={save}>Save</Button
						>{/if}
					{#if draft.file && !draft.file.deleted}<Button
							variant="ghost"
							size="sm"
							href={downloadUrl(conversationId, draft.path, draft.file.revision)}
							download>Download revision</Button
						><Button
							variant="ghost"
							size="sm"
							disabled={draft.busy || session.busy}
							onclick={remove}>Delete</Button
						>{/if}
					{#if draft.file}<Button
							variant="ghost"
							size="sm"
							disabled={draft.busy || session.busy}
							onclick={reload}>Reload head</Button
						>{/if}
					{#if dirtyFile(draft)}<Button
							variant="ghost"
							size="sm"
							disabled={draft.busy || session.busy}
							onclick={discard}>Discard draft</Button
						>{/if}
				</div>
				<p role="status" class="text-xs">
					{dirtyFile(draft) ? 'Unsaved changes. ' : ''}{stale
						? 'The server has a newer revision. Reload before saving. Your edits are kept. '
						: ''}{draft.notice}
				</p>
				{#if draft.error}<p role="alert" class="text-sm text-destructive">{draft.error}</p>{/if}
				<div class="flex flex-wrap gap-1" aria-label="File views">
					<Button
						variant={draft.view === 'edit' ? 'secondary' : 'ghost'}
						size="sm"
						disabled={!editable}
						onclick={() => {
							if (draft) draft.view = 'edit';
						}}>Edit</Button
					><Button
						variant={draft.view === 'preview' ? 'secondary' : 'ghost'}
						size="sm"
						disabled={draft.isNew || (draft.file?.deleted && !draft.historical)}
						onclick={() => {
							if (draft) draft.view = 'preview';
						}}>Preview saved revision</Button
					><Button
						variant={draft.view === 'history' ? 'secondary' : 'ghost'}
						size="sm"
						disabled={draft.isNew || draft.busy}
						onclick={history}>History</Button
					>
				</div>
				{#if draft.view === 'edit'}<Textarea
						bind:value={draft.text}
						readonly={draft.locked || !editable}
						class="min-h-72 max-h-[60vh] field-sizing-fixed! font-mono text-sm"
						rows={16}
						spellcheck={false}
						aria-label="Workspace file text"
						onkeydown={(e) => {
							if ((e.ctrlKey || e.metaKey) && e.key === 's') {
								e.preventDefault();
								void save();
							}
						}}
					/>
				{:else if draft.view === 'preview'}{#if draft.historical}<p class="text-sm">
							Historical revision. Editor text is unchanged.
						</p>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								if (draft) draft.historical = null;
							}}>Return to loaded head</Button
						><Button
							variant="ghost"
							size="sm"
							href={downloadUrl(conversationId, draft.path, draft.historical.file.revision)}
							download>Download this historical revision</Button
						>{/if}<CommonFilePreview content={draft.historical ?? draft.content} {active} />
				{:else}<p class="text-xs text-muted-foreground">
						Restore copies a saved revision into a new head. It does not erase history.
					</p>
					{#each draft.history ?? [] as revision}<div
							class="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
						>
							<span class="min-w-0 flex-1 break-all"
								>Revision {revision.version ?? '?'} · {revision.revision}{revision.deleted
									? ' · deletion'
									: ''}</span
							>{#if !revision.deleted}<Button
									variant="ghost"
									size="sm"
									onclick={() => openFile(revision.path, revision.revision)}>View</Button
								><Button
									variant="ghost"
									size="sm"
									disabled={draft.busy || session.busy}
									onclick={() => restore(revision)}>Restore</Button
								>{/if}
						</div>{/each}{#if !draft.history}<Button
							variant="ghost"
							size="sm"
							disabled={draft.busy}
							onclick={history}>Load revisions</Button
						>{/if}{/if}
			{:else}<p class="text-sm text-muted-foreground">
					Select a file, upload a file, or create a text file.
				</p>{/if}
		</div>
	</div>
	<p class="text-xs text-muted-foreground">
		File drafts remain in this page across panel and chat changes. Reloading or closing the tab can
		lose drafts. Conflicts never silently overwrite newer revisions. Files and source text cannot
		authorize tools.
	</p>
</section>
