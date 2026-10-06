<script lang="ts">
	import { Mic, X } from '@lucide/svelte';
	import { ActionIcon } from '$lib/components/app';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { onMount } from 'svelte';
	import {
		api,
		errorText,
		readBase64,
		type DictationSelection,
		type Provider,
		type Session
	} from './api';

	interface Props {
		targetId: string;
		getDraft: () => string;
		setDraft: (text: string) => void;
		getTargetId: () => string;
		open?: boolean;
		disabled?: boolean;
		onBusyChange?: (busy: boolean) => void;
	}
	let {
		targetId,
		getDraft,
		setDraft,
		getTargetId,
		open = $bindable(false),
		disabled = false,
		onBusyChange = () => {}
	}: Props = $props();
	type Phase =
		| 'idle'
		| 'choosing'
		| 'requesting'
		| 'recording'
		| 'finalizing'
		| 'review'
		| 'reading'
		| 'transcribing';
	interface Operation {
		token: number;
		target: string;
		selection: DictationSelection;
		controller: AbortController;
		stream?: MediaStream;
		recorder?: MediaRecorder;
		chunks: Blob[];
		bytes: number;
		clip?: { blob: Blob; name: string; mime: string };
		url?: string;
		timer?: ReturnType<typeof setTimeout>;
		clock?: ReturnType<typeof setInterval>;
		tracks: { track: MediaStreamTrack; ended: () => void }[];
	}
	const MAX_BYTES = 10 * 1024 * 1024;
	let operation = $state.raw<Operation | null>(null),
		phase = $state<Phase>('idle');
	let selection = $state<DictationSelection | null>(null),
		service = $state('');
	let loading = $state(false),
		status = $state('Record or choose a clip, review it, then select Transcribe.'),
		error = $state('');
	let recordReason = $state(''),
		seconds = $state(0),
		audio = $state<HTMLAudioElement>(),
		input = $state<HTMLInputElement>();
	let sequence = 0,
		settingsTicket = 0;
	const busy = $derived(operation !== null);
	const transient = $derived(!['idle', 'review'].includes(phase));
	const baseMime = (value: string) => value.toLowerCase().split(';')[0].trim();
	function recorderMime() {
		if (typeof MediaRecorder !== 'function') return '';
		return (
			['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'].find(
				(value) => MediaRecorder.isTypeSupported(value)
			) ?? ''
		);
	}
	function recordingReason() {
		if (!globalThis.isSecureContext)
			return 'Recording requires HTTPS or localhost. Audio files still work.';
		if (!navigator.mediaDevices?.getUserMedia)
			return 'Microphone capture is unavailable. Choose an audio file.';
		if (!recorderMime())
			return 'This browser cannot record supported WebM or MP4 audio. Choose an audio file.';
		return '';
	}
	function current(op: Operation) {
		return (
			operation === op &&
			op.token === sequence &&
			!op.controller.signal.aborted &&
			open &&
			!disabled &&
			targetId === op.target &&
			getTargetId() === op.target
		);
	}
	function releaseCapture(op: Operation) {
		clearTimeout(op.timer);
		clearInterval(op.clock);
		for (const { track, ended } of op.tracks) track.removeEventListener('ended', ended);
		op.tracks = [];
		if (op.recorder) {
			op.recorder.ondataavailable = op.recorder.onstop = op.recorder.onerror = null;
			if (op.recorder.state !== 'inactive') {
				try {
					op.recorder.stop();
				} catch {
					/* Already stopped. */
				}
			}
			op.recorder = undefined;
		}
		op.stream?.getTracks().forEach((track) => track.stop());
		op.stream = undefined;
	}
	function releasePlayback(op: Operation) {
		if (op.url) {
			audio?.pause();
			if (audio) {
				audio.removeAttribute('src');
				audio.load();
			}
			URL.revokeObjectURL(op.url);
			op.url = undefined;
		}
	}
	function dispose(op: Operation) {
		op.controller.abort();
		releaseCapture(op);
		releasePlayback(op);
		op.chunks = [];
		op.clip = undefined;
		if (input) input.value = '';
	}
	export function cancel(
		message = 'Dictation cancelled. No transcript was added. Provider processing or billing may continue.'
	) {
		const op = operation;
		operation = null;
		sequence++;
		if (op) dispose(op);
		onBusyChange(false);
		phase = 'idle';
		seconds = 0;
		status = message;
		error = '';
	}
	function fail(op: Operation, message: string) {
		if (operation !== op) return;
		cancel('Your typed draft was kept. No chat was sent.');
		error = message;
	}
	function capture(next: Phase): Operation | null {
		if (!selection || disabled || loading || !targetId || getTargetId() !== targetId) return null;
		cancel('No audio has been uploaded.');
		const op: Operation = {
			token: ++sequence,
			target: targetId,
			selection: { ...selection },
			controller: new AbortController(),
			chunks: [],
			bytes: 0,
			tracks: []
		};
		operation = op;
		onBusyChange(true);
		phase = next;
		error = '';
		return op;
	}
	async function loadSelection() {
		const ticket = ++settingsTicket;
		loading = true;
		error = '';
		try {
			const [session, providers] = await Promise.all([
				api<Session>('/api/session'),
				api<Provider[]>('/api/providers')
			]);
			if (ticket !== settingsTicket) return;
			selection = session.settings.dictation ?? null;
			service = selection
				? `${providers.find((p) => p.id === selection?.providerId)?.name ?? 'Saved connection'} · ${selection.model}`
				: 'Dictation is not configured. Configure it in Settings, Dictation.';
		} catch (e) {
			if (ticket === settingsTicket) {
				selection = null;
				error = errorText(e);
			}
		} finally {
			if (ticket === settingsTicket) loading = false;
		}
	}
	function prepare(op: Operation, blob: Blob, name: string, mime: string) {
		if (!current(op)) {
			if (operation === op) cancel('The target draft changed. No transcript was added.');
			return;
		}
		if (!blob.size || blob.size > MAX_BYTES)
			throw new Error('The clip is empty or exceeds 10 MiB. Choose or record a smaller clip.');
		op.clip = { blob, name, mime };
		op.url = URL.createObjectURL(blob);
		phase = 'review';
		status = 'Review the local clip. Select Transcribe to upload it to the saved speech service.';
	}
	function fileMime(file: File) {
		const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
		let mime = baseMime(file.type);
		if (!mime || mime === 'application/octet-stream')
			mime =
				(
					{
						wav: 'audio/wav',
						mp3: 'audio/mpeg',
						webm: 'audio/webm',
						mp4: 'video/mp4',
						m4a: 'audio/mp4'
					} as Record<string, string>
				)[extension] ?? '';
		mime =
			(
				{
					'audio/x-wav': 'audio/wav',
					'audio/wave': 'audio/wav',
					'audio/vnd.wave': 'audio/wav',
					'audio/mp3': 'audio/mpeg',
					'audio/x-m4a': 'audio/mp4',
					'audio/m4a': 'audio/mp4'
				} as Record<string, string>
			)[mime] ?? mime;
		if (
			!['audio/wav', 'audio/mpeg', 'audio/webm', 'audio/mp4', 'video/webm', 'video/mp4'].includes(
				mime
			)
		)
			throw new Error('Choose WAV, MP3, WebM, or MP4/M4A audio. Files are not converted.');
		return mime;
	}
	function choose(event: MouseEvent) {
		if (transient || !capture('choosing')) event.preventDefault();
	}
	function acceptFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0],
			op = operation;
		if (!op || phase !== 'choosing') return;
		if (!file) {
			cancel('No audio file was selected.');
			return;
		}
		try {
			prepare(op, file, file.name, fileMime(file));
		} catch (e) {
			fail(op, errorText(e));
		}
	}
	export function stopRecording() {
		const op = operation;
		if (!op || phase !== 'recording') return;
		if (!current(op)) {
			cancel('The target draft changed. Recording was cancelled.');
			return;
		}
		clearTimeout(op.timer);
		clearInterval(op.clock);
		for (const { track, ended } of op.tracks) track.removeEventListener('ended', ended);
		op.tracks = [];
		phase = 'finalizing';
		status = 'Preparing the local clip. No audio has been uploaded.';
		try {
			op.recorder?.stop();
			op.stream?.getTracks().forEach((track) => track.stop());
		} catch {
			fail(op, 'Recording could not finish. Choose or record another clip.');
		}
	}
	async function record() {
		const reason = recordingReason();
		if (reason) {
			error = reason;
			return;
		}
		const op = capture('requesting');
		if (!op) return;
		status = 'Waiting for microphone permission. Cancel remains available.';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
			if (!current(op)) {
				stream.getTracks().forEach((track) => track.stop());
				if (operation === op) cancel('The target draft changed. Recording was cancelled.');
				return;
			}
			op.stream = stream;
			op.recorder = new MediaRecorder(stream, {
				mimeType: recorderMime(),
				audioBitsPerSecond: 128000
			});
			const mime = op.recorder.mimeType;
			if (!['audio/webm', 'audio/mp4'].includes(baseMime(mime)))
				throw new Error('Unsupported recording format.');
			for (const track of stream.getTracks()) {
				const ended = () => fail(op, 'Microphone capture ended unexpectedly. Record another clip.');
				track.addEventListener('ended', ended);
				op.tracks.push({ track, ended });
			}
			op.recorder.ondataavailable = (event) => {
				if (!current(op) || !event.data.size) return;
				if (op.bytes + event.data.size > MAX_BYTES) {
					fail(op, 'Recording exceeds 10 MiB. Record a shorter clip.');
					return;
				}
				op.bytes += event.data.size;
				op.chunks.push(event.data);
			};
			op.recorder.onerror = () => fail(op, 'Recording failed. Choose or record another clip.');
			op.recorder.onstop = () => {
				if (!current(op)) {
					if (operation === op) cancel('The target draft changed. Recording was cancelled.');
					return;
				}
				if (phase !== 'finalizing') {
					fail(op, 'Recording stopped unexpectedly.');
					return;
				}
				try {
					const blob = new Blob(op.chunks, { type: mime });
					releaseCapture(op);
					op.chunks = [];
					prepare(op, blob, `dictation.${baseMime(mime) === 'audio/webm' ? 'webm' : 'mp4'}`, mime);
				} catch (e) {
					fail(op, errorText(e));
				}
			};
			op.recorder.start(1000);
			phase = 'recording';
			seconds = 0;
			const started = performance.now();
			op.timer = setTimeout(stopRecording, 60000);
			op.clock = setInterval(() => {
				if (!current(op)) cancel('The target draft changed. Recording was cancelled.');
				else seconds = Math.min(60, Math.floor((performance.now() - started) / 1000));
			}, 1000);
		} catch (e) {
			const name = e instanceof Error ? e.name : '';
			fail(
				op,
				name === 'NotAllowedError'
					? 'Microphone permission was denied. Choose a file or check the site permission.'
					: name === 'NotFoundError'
						? 'No microphone was found.'
						: 'Recording could not start. Choose a file or check browser microphone support.'
			);
		}
	}
	async function transcribe() {
		const op = operation;
		if (!op?.clip || phase !== 'review' || !current(op)) return;
		releasePlayback(op);
		phase = 'reading';
		status = 'Preparing audio for upload. Cancel remains available.';
		error = '';
		try {
			const data = await readBase64(op.clip.blob, op.controller.signal);
			if (!current(op)) {
				if (operation === op) cancel('The target draft changed. No transcript was added.');
				return;
			}
			phase = 'transcribing';
			status =
				'Transcribing with the saved speech service. Cancel prevents insertion but may not stop provider processing.';
			const result = await api<{ text: string }>(
				'/api/transcriptions',
				'POST',
				{ ...op.selection, name: op.clip.name, mime: op.clip.mime, data },
				op.controller.signal
			);
			if (!current(op)) {
				if (operation === op) cancel('The target draft changed. No transcript was added.');
				return;
			}
			if (typeof result.text !== 'string' || result.text.length > 64 * 1024)
				throw new Error('The service returned invalid transcription text.');
			const transcript = result.text.trim();
			if (!transcript) {
				cancel('No speech was transcribed. Your draft is unchanged.');
				return;
			}
			// Read the current unsent text, not the text that existed when capture started.
			const draft = getDraft();
			if (!current(op)) return;
			setDraft(`${draft}${draft && !/\s$/.test(draft) ? '\n' : ''}${transcript}`);
			cancel('Transcript added to the unsent draft. Review it and select Send separately.');
		} catch (e) {
			if (operation === op) {
				if (op.controller.signal.aborted) cancel();
				else fail(op, errorText(e));
			}
		}
	}
	$effect(() => {
		if (open) {
			recordReason = recordingReason();
			void loadSelection();
		} else {
			settingsTicket++;
			cancel('Record or choose a clip, review it, then select Transcribe.');
		}
	});
	$effect(() => {
		if (operation && (targetId !== operation.target || disabled))
			cancel('The target draft changed or became unavailable. Dictation was cancelled.');
	});
	onMount(() => {
		const hidden = () => {
			if (document.hidden) {
				if (phase === 'recording') stopRecording();
				else if (phase === 'requesting')
					cancel('Microphone permission was cancelled when the page was hidden.');
			}
		};
		const unload = (event: BeforeUnloadEvent) => {
			if (operation) {
				event.preventDefault();
				event.returnValue = '';
			}
		};
		const pagehide = () => cancel();
		document.addEventListener('visibilitychange', hidden);
		window.addEventListener('pagehide', pagehide);
		window.addEventListener('beforeunload', unload);
		return () => {
			document.removeEventListener('visibilitychange', hidden);
			window.removeEventListener('pagehide', pagehide);
			window.removeEventListener('beforeunload', unload);
			settingsTicket++;
			cancel();
			onBusyChange(false);
		};
	});
</script>

<Popover.Root bind:open>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Popover.Trigger {...props} class={buttonVariants({ variant: 'ghost', size: 'icon' }) + ' h-8 w-8 rounded-full'} {disabled} aria-label="Speech-to-text dictation">
					<Mic class="size-4" />
				</Popover.Trigger>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>Dictation</Tooltip.Content>
	</Tooltip.Root>
	<Popover.Content
		align="start"
		side="top"
		sideOffset={12}
		trapFocus={false}
		preventScroll={false}
		onOpenAutoFocus={(event) => event.preventDefault()}
		onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
		class="w-[min(28rem,calc(100vw-2rem))] max-h-[75dvh] space-y-3 overflow-y-auto rounded-2xl border-border/30 bg-background/95 p-4 shadow-xl backdrop-blur-xl"
		aria-label="Dictation review"
	>
		<div class="flex items-center justify-between">
			<h3 class="text-sm font-medium">Dictation</h3>
			<ActionIcon icon={X} ariaLabel="Close dictation" tooltip="Close dictation" onclick={() => (open = false)} />
		</div>
		<p class="text-sm">{loading ? 'Loading saved speech selection...' : service}</p>
		{#if recordReason}<p class="text-xs text-muted-foreground">{recordReason}</p>{/if}
		<div class="flex flex-wrap items-center gap-2">
			{#if phase === 'recording'}<Button size="sm" onclick={stopRecording}>Stop recording</Button
				>{:else}<Button
					variant="ghost"
					size="sm"
					disabled={disabled || loading || !selection || transient || !!recordReason}
					onclick={record}>Record</Button
				>{/if}
			<label class="grid gap-1 text-sm"
				>Choose audio file<input
					bind:this={input}
					type="file"
					accept="audio/wav,audio/mpeg,audio/webm,audio/mp4,video/webm,video/mp4,.wav,.mp3,.webm,.mp4,.m4a"
					disabled={disabled || loading || !selection || (transient && phase !== 'choosing')}
					onclick={choose}
					onchange={acceptFile}
					oncancel={() => {
						if (phase === 'choosing') cancel('No audio file was selected.');
					}}
					class="max-w-64 text-xs"
				/></label
			>
		</div>
		{#if phase === 'review' && operation?.clip}<p class="text-xs">
				{operation.clip.name} · {Math.ceil(operation.clip.blob.size / 1024)} KiB. Local review, not uploaded.
			</p>
			<audio
				bind:this={audio}
				controls
				preload="metadata"
				src={operation.url}
				aria-label="Review dictation audio"
				class="w-full"
				onerror={(event) => {
					const op = operation;
					if (phase === 'review' && op && event.currentTarget instanceof HTMLAudioElement
						&& op.url === event.currentTarget.src)
						fail(op, 'This browser cannot play the clip. Choose or record another clip.');
				}}
			></audio>{/if}
		<p class="text-sm" role="status" aria-live="polite">
			{phase === 'recording'
				? `Recording ${seconds} / 60 seconds. No audio has been uploaded.`
				: status}
		</p>
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		<div class="flex flex-wrap gap-2">
			<Button
				size="sm"
				disabled={disabled || phase !== 'review' || !operation?.clip}
				onclick={transcribe}>Transcribe</Button
			><Button variant="ghost" size="sm" disabled={!busy} onclick={() => cancel()}>Cancel</Button
			>
		</div>
		<p class="text-xs text-muted-foreground">
			Record up to 60 seconds or choose a clip up to 10 MiB. Transcribe uploads audio using
			server-owned credentials. Audio is not saved in Common conversations. Provider retention and
			billing rules apply. Cancel aborts transport and prevents late insertion. Dictation never
			sends a chat turn.
		</p>
	</Popover.Content>
</Popover.Root>
