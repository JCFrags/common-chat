<script lang="ts">
	import { LogOut, RefreshCw } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { commonStore } from '$lib/stores/common.svelte';
	import { draftMessagesStore } from '$lib/stores/chat/drafts.svelte';

	let busy = $state(false), error = $state('');
	async function refresh() {
		if (busy) return;
		busy = true;
		error = '';
		try { await Promise.all([commonStore.refreshSession(), commonStore.refreshRuntime()]); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}
	async function signOut() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await commonStore.logout();
			draftMessagesStore.clearAll();
		} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}
</script>

<section class="space-y-4" aria-label="Common Chat information">
	<div class="space-y-3 rounded-xl border border-border/30 bg-muted/20 p-4">
		<div class="flex items-center justify-between gap-3">
			<h3 class="text-sm font-medium">Common Chat</h3>
			<Button variant="ghost" size="sm" disabled={busy} onclick={refresh} title="Refresh server status">
				<RefreshCw class="size-3.5" /> Refresh
			</Button>
		</div>
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
			<dt class="text-muted-foreground">Live updates</dt><dd class="capitalize">{commonStore.eventStatus}</dd>
			<dt class="text-muted-foreground">Runner</dt><dd>{!commonStore.runtime ? 'Not checked' : commonStore.runtime.enabled && commonStore.runtime.ready ? 'Ready' : 'Unavailable'}</dd>
			<dt class="text-muted-foreground">Access</dt><dd>{commonStore.session?.authenticationRequired === false ? 'Trusted local access' : 'Signed in'}</dd>
		</dl>
		{#each commonStore.runtime?.blockedReasons ?? [] as reason}
			<p class="text-xs text-muted-foreground">{reason}</p>
		{/each}
	</div>
	<details class="rounded-xl border border-border/30 bg-muted/20 p-4">
		<summary class="cursor-pointer text-sm font-medium">Storage and access</summary>
		<div class="mt-3 space-y-3 text-sm text-muted-foreground">
			<p>History, connections, and encrypted connection keys stay on the Common server. Display and typed generation preferences are device-local. This interface never reads or exports saved keys.</p>
			<p>Unsent composer drafts stay in this browser. Sign out clears device drafts for this origin. File, code, and package editor drafts remain in-page only. Save or copy them before a reload.</p>
			<p>Use HTTPS or a private encrypted tunnel for remote access. HTTP does not encrypt passwords, session cookies, or conversations. Trusted local access has no sign-in boundary.</p>
		</div>
	</details>
	<details class="rounded-xl border border-border/30 bg-muted/20 p-4">
		<summary class="cursor-pointer text-sm font-medium">Models and generation</summary>
		<div class="mt-3 space-y-3 text-sm text-muted-foreground">
			<p>Unsupported sampling fields are rejected. Blank values defer to the connection. Capability declarations must match the endpoint. Model names do not establish support. A model catalog does not prove inference or transcription readiness.</p>
			<p>Native tools are automatic on compatible connections. Code execution requires the separate enabled and ready runner. MCP connections require explicit Connect, reviewed page-only choices, and confirmation for each new submission. Saved receipts are not new permission.</p>
			<p>A browser disconnect does not stop server generation or code execution. Use Stop to request cancellation. Closing Files and code stops polling, not server work.</p>
		</div>
	</details>
	{#if commonStore.session?.authenticationRequired !== false}
		<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/30 p-4">
			<p class="text-xs text-muted-foreground">Sign out also clears this browser's composer drafts.</p>
			<Button variant="ghost" size="sm" disabled={busy} onclick={signOut} title="Sign out and clear device drafts">
				<LogOut class="size-3.5" /> Sign out
			</Button>
		</div>
	{/if}
	{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
</section>
