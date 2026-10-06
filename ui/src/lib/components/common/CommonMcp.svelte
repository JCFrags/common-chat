<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { commonMcpState, type McpConnection } from '$lib/services/common-mcp.svelte';
	import { errorText } from './api';

	let { onChanged = () => {} }: { onChanged?: () => Promise<void> | void } = $props();
	let selectedId = $state('');
	let name = $state('');
	let url = $state('');
	let key = $state('');
	let clearKey = $state(false);
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	const connection = $derived(commonMcpState.connections.find((item) => item.id === selectedId));
	const selectClass = 'h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

	function fill(id: string) {
		if (id) commonMcpState.clear(id);
		selectedId = id;
		const item = commonMcpState.connections.find((item) => item.id === id);
		name = item?.name ?? '';
		url = item?.url ?? '';
		key = '';
		clearKey = false;
		error = '';
		status = '';
	}
	async function refresh() {
		if (busy) return;
		busy = true;
		error = '';
		try { await commonMcpState.load(); }
		catch (e) { error = errorText(e); }
		finally { busy = false; }
	}
	async function save() {
		if (busy) return;
		busy = true;
		error = '';
		status = '';
		try {
			const saved = await commonMcpState.save({ name, url, apiKey: key, clearKey }, selectedId || undefined);
			fill(saved.id);
			status = 'Connection saved and inactive. No MCP server was contacted.';
			await onChanged();
		} catch (e) { error = errorText(e); }
		finally { key = ''; busy = false; }
	}
	async function connect(item: McpConnection) {
		if (busy || !confirm(`Connect to ${item.name} at ${item.url} and discover its tools? The Common server will send its saved credential. This does not authorize tool calls.`)) return;
		busy = true;
		error = '';
		status = '';
		try {
			await commonMcpState.connect(item.id);
			status = 'Connected. Review and select individual tools for per-turn confirmation.';
			await onChanged();
		} catch (e) { error = errorText(e); }
		finally { busy = false; }
	}
	async function disconnect(item: McpConnection) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await commonMcpState.disconnect(item.id);
			status = 'Disconnected. Pending local choices were cleared. Prior remote side effects are not undone.';
			await onChanged();
		} catch (e) { error = errorText(e); }
		finally { busy = false; }
	}
	async function remove() {
		const item = connection;
		if (!item || busy || !confirm(`Delete saved MCP connection ${item.name}? Its credential and page selections will be removed. Saved tool receipts remain.`)) return;
		busy = true;
		error = '';
		try {
			await commonMcpState.remove(item.id);
			fill('');
			status = 'MCP connection deleted.';
			await onChanged();
		} catch (e) { error = errorText(e); }
		finally { busy = false; }
	}
	function choose(connectionId: string, toolName: string, selected: boolean) {
		try { commonMcpState.choose(connectionId, toolName, selected); error = ''; }
		catch (e) { error = errorText(e); }
	}
	onMount(() => { void refresh(); return () => { key = ''; }; });
</script>

<section class="space-y-4" aria-label="Common MCP connections">
	<h3 class="text-sm font-medium">MCP connections</h3>
	<details class="rounded-xl border border-border/30 bg-muted/20 p-3">
		<summary class="cursor-pointer text-sm font-medium">MCP help and access limits</summary>
		<div class="mt-3 space-y-3 text-sm text-muted-foreground">
			<p>Model Context Protocol (MCP) connects remote tools to Common. Connections and encrypted bearer keys stay on the server. Saving or loading this list does not contact an MCP server. Connect and discovery are explicit. Connections are inactive after a server restart.</p>
			<p>Remote tools use their server's permissions, not Common's isolated runner. Review the endpoint and each tool before use. Selected tools need a separate confirmation for every new turn or regeneration. Native tools remain automatic on compatible connections.</p>
			<p>Protocol 2025-11-25 only. Use HTTPS or HTTP loopback. URL credentials, query strings, redirects, OAuth, stdio, browser execution, prompts, and resources are not supported.</p>
		</div>
	</details>
	<div class="flex items-end gap-2">
		<label class="grid flex-1 gap-1 text-sm">Saved connection
			<select class={selectClass} value={selectedId} disabled={busy} onchange={(e) => fill(e.currentTarget.value)}>
				<option value="">New connection</option>
				{#each commonMcpState.connections as item}<option value={item.id}>{item.name}</option>{/each}
			</select>
		</label>
		<Button variant="ghost" disabled={busy} onclick={refresh}>Reload</Button>
	</div>
	<form class="space-y-3 rounded-xl border border-border/30 bg-muted/20 p-4" onsubmit={(e) => { e.preventDefault(); void save(); }}>
		<fieldset disabled={busy} class="space-y-3">
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="grid gap-1 text-sm">Name<Input bind:value={name} required maxlength={100} autocomplete="off" /></label>
				<label class="grid gap-1 text-sm">Streamable HTTP endpoint<Input bind:value={url} type="url" required maxlength={500} placeholder="https://example.org/mcp" autocomplete="off" /></label>
			</div>
			<label class="grid gap-1 text-sm">Bearer key<Input bind:value={key} type="password" maxlength={8000} autocomplete="new-password" placeholder={connection?.hasKey ? 'A key is saved. Leave blank to retain it.' : 'Optional bearer key'} /></label>
			<label class="flex items-center gap-2 text-sm"><Checkbox bind:checked={clearKey} aria-label="Clear saved MCP key" /> Clear saved key</label>
			<div class="flex flex-wrap gap-2">
				<Button type="submit">Save inactive connection</Button>
				{#if connection}<Button variant="ghost" onclick={remove}>Delete connection</Button>{/if}
			</div>
		</fieldset>
	</form>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if status}<p role="status" class="text-sm">{status}</p>{/if}
	{#each commonMcpState.connections as item (item.id)}
		<section class="space-y-3 rounded-xl border border-border/30 bg-muted/20 p-4" aria-label={`MCP connection ${item.name}`}>
			<div class="flex flex-wrap items-center gap-2">
				<h3 class="flex-1 text-sm font-medium">{item.name}</h3>
				<span class="text-xs">{item.connected ? 'Connected' : 'Inactive'}</span>
				<Button size="sm" variant="outline" disabled={busy} onclick={() => connect(item)}>{item.connected ? 'Connect and rediscover' : 'Connect and discover'}</Button>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => disconnect(item)}>Disconnect</Button>
			</div>
			<p class="break-all text-xs text-muted-foreground">{item.url}</p>
			{#if item.error}<p role="alert" class="text-sm text-destructive">{item.error}</p>{/if}
			{#if item.connected}
				<p class="text-xs text-muted-foreground">Catalog checked {item.checkedAt ? new Date(item.checkedAt).toLocaleString() : 'at an unknown time'}. These choices are page-only, not standing permission.</p>
				{#if !item.tools.length}<p class="text-sm">The server returned no tools.</p>{/if}
				{#each item.tools as tool (tool.name)}
					<div class="space-y-2 rounded-xl border border-border/30 bg-background/50 p-3">
						<label class="flex items-start gap-2 text-sm">
							<Checkbox class="mt-1" aria-label={`Select MCP tool ${tool.title || tool.name}`} disabled={busy || !tool.available} checked={commonMcpState.selections.some((selection) => selection.connectionId === item.id && selection.catalogRevision === item.catalogRevision && selection.tools.includes(tool.name))} onCheckedChange={(checked) => choose(item.id, tool.name, checked)} />
							<span><span class="font-medium">{tool.title}</span> <code>{tool.name}</code></span>
						</label>
						<p class="whitespace-pre-wrap break-words text-sm">{tool.description || 'No description was supplied.'}</p>
						{#if tool.error}<p class="text-sm text-destructive">Unavailable: {tool.error}</p>{/if}
						<details><summary class="cursor-pointer text-xs">Review schema</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre>{#if tool.outputSchema}<pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(tool.outputSchema, null, 2)}</pre>{/if}</details>
					</div>
				{/each}
			{/if}
		</section>
	{/each}
</section>
