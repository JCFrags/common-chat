const MAX_BYTES = 10 * 1024 * 1024;
const RECORD_SECONDS = 60;
const aliases = new Map([
  ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'], ['audio/x-m4a', 'audio/mp4'], ['audio/m4a', 'audio/mp4']
]);
const audioMimes = new Set(['audio/wav', 'audio/mpeg', 'audio/webm', 'audio/mp4', 'video/webm', 'video/mp4']);
const extensions = new Map([['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['webm', 'audio/webm'], ['mp4', 'video/mp4'], ['m4a', 'audio/mp4']]);
const transient = new Set(['choosing', 'requesting', 'recording', 'finalizing', 'reading', 'transcribing']);
const baseMime = value => (typeof value === 'string' ? value.toLowerCase().split(';')[0].trim() : '');

function recorderMime() {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'].find(mime => MediaRecorder.isTypeSupported(mime)) ?? '';
}
function recordingReason() {
  if (!globalThis.isSecureContext) return 'Microphone recording requires HTTPS or localhost. You can still choose an audio file.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot access a microphone. You can still choose an audio file.';
  if (!recorderMime()) return 'This browser cannot record a supported WebM or MP4 audio format. Choose an audio file instead.';
  return '';
}
function fileMime(file) {
  let mime = baseMime(file.type);
  if (!mime || mime === 'application/octet-stream') mime = extensions.get(file.name.split('.').at(-1).toLowerCase()) ?? '';
  mime = aliases.get(mime) ?? mime;
  if (!audioMimes.has(mime)) throw new Error('Choose WAV, MP3, WebM, or MP4/M4A audio. Files are not converted.');
  return mime;
}
function microphoneError(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone access was denied. Check browser permission and the site microphone policy, or choose an audio file.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect a microphone or choose an audio file.';
  if (error?.name === 'NotReadableError') return 'The microphone could not be read. Check whether another application is using it, or choose an audio file.';
  return 'Microphone recording could not start. Choose an audio file or check browser microphone support.';
}

/** The parent owns composer text, draft persistence, selection, and chat submission. */
export function installDictation({ transcribe, getSelection, getTarget, canUse, appendTranscript,
  onStateChange = () => {}, openSettings = () => {}, toast = () => {} }) {
  const composer = document.querySelector('#composer');
  if (!composer) throw new Error('Dictation requires the composer.');
  const panel = document.createElement('section');
  panel.id = 'dictation-panel'; panel.className = 'dictation-panel'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-labelledby', 'dictation-title');
  panel.innerHTML = `<div class="row spread"><h3 id="dictation-title">Dictation</h3><button type="button" class="ghost" data-dictation-close>Close</button></div>
    <p class="small" data-service></p><p class="small" data-record-help></p>
    <div class="dictation-actions"><button type="button" class="ghost" data-record>Record</button><button type="button" class="ghost" data-stop hidden>Stop recording</button>
    <label class="dictation-file">Choose audio file<input type="file" accept="audio/wav,audio/mpeg,audio/webm,audio/mp4,video/webm,video/mp4,.wav,.mp3,.webm,.mp4,.m4a" data-file></label></div>
    <p class="small" data-clip hidden></p><audio controls preload="metadata" aria-label="Review dictation audio" hidden></audio>
    <p class="small" data-status role="status" aria-live="polite"></p><p class="error" data-error role="alert" hidden></p>
    <div class="dictation-actions"><button type="button" class="ghost" data-transcribe>Transcribe</button><button type="button" class="ghost" data-cancel>Cancel</button><button type="button" class="ghost" data-settings>Dictation settings</button></div>
    <p class="small">Record up to 60 seconds or choose a file up to 10 MiB. Recording and file selection do not upload audio. Transcribe uploads this clip to the selected speech service and adds text to the unsent draft. Audio is not saved by Common Chat. Provider processing and retention rules still apply.</p>`;
  composer.before(panel);
  const $ = selector => panel.querySelector(selector);
  const record = $('[data-record]'), stop = $('[data-stop]'), input = $('[data-file]'), audio = $('audio');
  let operation = null, sequence = 0, phase = 'idle', message = 'Record or choose an audio file, then select Transcribe.', errorMessage = '', notified = '';

  function selection() {
    const value = getSelection();
    return value && typeof value.providerId === 'string' && value.providerId && typeof value.model === 'string' && value.model.trim()
      ? { providerId: value.providerId, model: value.model.trim(), name: value.name } : null;
  }
  function current(op) {
    const target = getTarget();
    return operation === op && op.token === sequence && !op.controller.signal.aborted && target?.authenticated === true
      && target.draftKey === op.target.draftKey && target.epoch === op.target.epoch;
  }
  function render() {
    const selected = operation?.selection ?? selection(), unavailable = !canUse();
    $('[data-service]').textContent = selected ? `Speech service: ${selected.name || selected.providerId}. Model: ${selected.model}.` : 'Select a speech connection and model in Dictation settings.';
    const reason = recordingReason(); $('[data-record-help]').textContent = reason; $('[data-record-help]').hidden = !reason;
    record.disabled = unavailable || transient.has(phase) || !!reason;
    stop.hidden = phase !== 'recording';
    // Do not disable the input during its click event; that can prevent the file picker.
    input.disabled = unavailable || transient.has(phase) && phase !== 'choosing';
    $('[data-transcribe]').disabled = unavailable || phase !== 'recorded' || !operation?.clip;
    $('[data-cancel]').disabled = !operation;
    $('[data-clip]').hidden = !operation?.clip;
    $('[data-clip]').textContent = operation?.clip ? `${operation.clip.name} (${Math.ceil(operation.clip.blob.size / 1024)} KiB). Review before transcription.` : '';
    audio.hidden = !operation?.clip;
    $('[data-error]').hidden = !errorMessage; $('[data-error]').textContent = errorMessage;
    $('[data-status]').textContent = phase === 'recording'
      ? `Recording: ${Math.min(RECORD_SECONDS, Math.floor((performance.now() - operation.startedAt) / 1000))} / ${RECORD_SECONDS} seconds. Select Stop recording when finished.` : message;
    const next = JSON.stringify([phase, !!operation, !panel.hidden]);
    if (next !== notified) {
      notified = next;
      onStateChange({ state: phase, busy: !!operation, open: !panel.hidden });
    }
  }
  function capture(phaseName, status) {
    const selected = selection(), target = getTarget();
    if (!selected) { openSettings(); return null; }
    if (!canUse() || target?.authenticated !== true || !Number.isSafeInteger(target.epoch)) {
      toast('Finish the current chat action before using dictation.'); return null;
    }
    const previous = operation; operation = null;
    if (previous) dispose(previous);
    const op = { token: ++sequence, selection: selected, target: { draftKey: target.draftKey, epoch: target.epoch, authenticated: true },
      controller: new AbortController(), stream: null, recorder: null, tracks: [], chunks: [], bytes: 0, clip: null, url: null, reader: null };
    operation = op; phase = phaseName; message = status; errorMessage = ''; render();
    if (!current(op)) { if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return null; }
    return op;
  }
  function releaseCapture(op) {
    clearTimeout(op.timer); clearInterval(op.clock);
    if (op.recorder) {
      op.recorder.ondataavailable = null; op.recorder.onstop = null; op.recorder.onerror = null;
      if (op.recorder.state !== 'inactive') { try { op.recorder.stop(); } catch {} }
      op.recorder = null;
    }
    for (const [track, ended] of op.tracks) track.removeEventListener('ended', ended);
    op.tracks = [];
    op.stream?.getTracks().forEach(track => track.stop()); op.stream = null;
  }
  function dispose(op) {
    op.controller.abort(); releaseCapture(op); op.chunks = []; op.clip = null;
    if (op.url) {
      if (audio.getAttribute('src') === op.url) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      URL.revokeObjectURL(op.url); op.url = null;
    }
    input.value = '';
  }
  function cancel(status = 'Dictation cancelled. No transcript was added.') {
    const op = operation; operation = null; sequence++;
    if (op) dispose(op);
    phase = 'idle'; message = status; errorMessage = ''; render();
  }
  function close() { panel.hidden = true; cancel('Record or choose an audio file, then select Transcribe.'); }
  function failOperation(op, status) {
    if (operation !== op) return;
    operation = null; sequence++; dispose(op);
    phase = 'error'; message = 'Your typed draft was kept. No chat was sent.'; errorMessage = status; render();
  }
  function refresh() {
    if (operation && !current(operation)) cancel('The chat or draft changed. Dictation was cancelled.');
    else render();
  }
  function open() {
    if (!selection()) { close(); openSettings(); return; }
    if (!canUse() && !operation) { toast('Finish the current chat action before using dictation.'); return; }
    panel.hidden = false; refresh();
  }
  function prepareClip(op, blob, name, mime, status) {
    if (!current(op)) { if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return; }
    if (!blob.size || blob.size > MAX_BYTES) throw new Error('The audio clip is empty or exceeds 10 MiB. Record or choose a smaller clip.');
    op.clip = { blob, name, mime }; op.url = URL.createObjectURL(blob); audio.src = op.url;
    phase = 'recorded'; message = status; render();
  }
  function stopRecording(status = 'Recording stopped. Review the clip, then select Transcribe.') {
    const op = operation;
    if (!op || phase !== 'recording') return;
    if (!current(op)) { cancel('The chat or draft changed. Dictation was cancelled.'); return; }
    clearTimeout(op.timer); clearInterval(op.clock); op.stopStatus = status;
    phase = 'finalizing'; message = 'Preparing the recorded clip. No audio has been uploaded.'; render();
    try { op.recorder.stop(); } catch { failOperation(op, 'The recording could not be stopped safely. Record another clip or choose an audio file.'); }
    op.stream?.getTracks().forEach(track => track.stop());
  }
  async function startRecording() {
    if (transient.has(phase)) return;
    const reason = recordingReason(); if (reason) { errorMessage = reason; render(); return; }
    const op = capture('requesting', 'Waiting for microphone permission. Cancel remains available.');
    if (!op) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!current(op)) {
        stream.getTracks().forEach(track => track.stop());
        if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.');
        return;
      }
      op.stream = stream;
      op.recorder = new MediaRecorder(stream, { mimeType: recorderMime(), audioBitsPerSecond: 128000 });
      op.mime = op.recorder.mimeType;
      if (!['audio/webm', 'audio/mp4'].includes(baseMime(op.mime))) throw new Error('Unsupported recording format.');
      for (const track of stream.getTracks()) {
        const ended = () => failOperation(op, 'Microphone recording ended unexpectedly. Record another clip or choose an audio file.');
        track.addEventListener('ended', ended); op.tracks.push([track, ended]);
      }
      op.recorder.ondataavailable = event => {
        if (!current(op) || !event.data.size) return;
        if (op.bytes + event.data.size > MAX_BYTES) { failOperation(op, 'The recording exceeds 10 MiB. Record a shorter clip.'); return; }
        op.bytes += event.data.size; op.chunks.push(event.data);
      };
      op.recorder.onerror = () => failOperation(op, 'Recording failed. Record another clip or choose an audio file.');
      op.recorder.onstop = () => {
        if (!current(op)) { if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return; }
        if (phase !== 'finalizing') { failOperation(op, 'Recording stopped unexpectedly. Record another clip or choose an audio file.'); return; }
        try {
          const blob = new Blob(op.chunks, { type: op.mime }); op.chunks = []; releaseCapture(op);
          const extension = baseMime(op.mime) === 'audio/webm' ? 'webm' : 'mp4';
          prepareClip(op, blob, `dictation.${extension}`, op.mime, op.stopStatus);
        } catch (error) { failOperation(op, error.message); }
      };
      op.recorder.start(1000); op.startedAt = performance.now(); phase = 'recording'; message = '';
      op.timer = setTimeout(() => {
        if (operation === op) stopRecording('The 60-second recording limit was reached. Review the clip, then select Transcribe.');
      }, RECORD_SECONDS * 1000);
      op.clock = setInterval(() => {
        if (!current(op)) { clearInterval(op.clock); if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return; }
        render();
      }, 1000);
      render();
    } catch (error) { failOperation(op, microphoneError(error)); }
  }
  function chooseFile(event) {
    if (transient.has(phase) || !capture('choosing', 'Choose an audio file. No audio has been uploaded.')) event.preventDefault();
  }
  function acceptFile() {
    const op = operation, file = input.files?.[0];
    if (!op || phase !== 'choosing') { input.value = ''; return; }
    if (!current(op)) { cancel('The chat or draft changed. Dictation was cancelled.'); return; }
    if (!file) { cancel('No audio file was selected.'); return; }
    try { prepareClip(op, file, file.name, fileMime(file), 'Audio file selected. Review it, then select Transcribe.'); }
    catch (error) { failOperation(op, error.message); }
  }
  function readBase64(op) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); op.reader = reader;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true;
        op.controller.signal.removeEventListener('abort', abort);
        reader.onload = null; reader.onerror = null; reader.onabort = null;
        if (op.reader === reader) op.reader = null;
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { if (reader.readyState === FileReader.LOADING) reader.abort(); finish(new DOMException('Dictation cancelled.', 'AbortError')); };
      reader.onerror = () => finish(new Error('The audio file could not be read. Choose it again or record a clip.'));
      reader.onabort = () => finish(new DOMException('Dictation cancelled.', 'AbortError'));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string' || !result.includes(',')) finish(new Error('The audio file could not be read.'));
        else finish(null, result.slice(result.indexOf(',') + 1));
      };
      op.controller.signal.addEventListener('abort', abort, { once: true });
      if (op.controller.signal.aborted) abort(); else reader.readAsDataURL(op.clip.blob);
    });
  }
  async function sendClip() {
    const op = operation;
    if (!op?.clip || phase !== 'recorded') return;
    if (!current(op)) { cancel('The chat or draft changed. Dictation was cancelled.'); return; }
    if (!canUse()) { toast('Finish the current chat action before transcribing.'); return; }
    phase = 'reading'; message = 'Preparing the audio upload. Cancel remains available.'; errorMessage = ''; render();
    try {
      const data = await readBase64(op);
      if (!current(op)) { if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return; }
      if (!canUse()) throw new Error('The current chat action does not allow transcription.');
      phase = 'transcribing'; message = 'Transcribing with the selected speech service. Cancel remains available.'; render();
      const result = await transcribe({ providerId: op.selection.providerId, model: op.selection.model,
        name: op.clip.name, mime: op.clip.mime, data }, { signal: op.controller.signal });
      if (!current(op)) { if (operation === op) cancel('The chat or draft changed. Dictation was cancelled.'); return; }
      if (!result || typeof result.text !== 'string' || result.text.length > 64 * 1024) throw new Error('The speech service returned invalid transcription text.');
      if (!result.text.trim()) { cancel('No speech was transcribed. Your draft was not changed.'); return; }
      if (appendTranscript(result.text, op.target) === false) { cancel('The chat or draft changed. No transcript was inserted.'); return; }
      cancel('Transcript added to the unsent draft. Review it before selecting Send.');
      toast('Transcript added to the unsent draft.');
    } catch (error) {
      if (operation !== op) return;
      if (op.controller.signal.aborted) cancel();
      else failOperation(op, error instanceof Error ? error.message : 'Speech transcription failed. Record or choose another clip.');
    }
  }

  record.addEventListener('click', startRecording);
  stop.addEventListener('click', () => stopRecording());
  input.addEventListener('click', chooseFile); input.addEventListener('change', acceptFile);
  input.addEventListener('cancel', () => { if (phase === 'choosing') cancel('No audio file was selected.'); });
  $('[data-transcribe]').addEventListener('click', sendClip);
  $('[data-cancel]').addEventListener('click', () => cancel());
  $('[data-dictation-close]').addEventListener('click', close);
  $('[data-settings]').addEventListener('click', () => { close(); openSettings(); });
  audio.addEventListener('error', () => { if (operation?.clip && audio.error) failOperation(operation, 'This browser could not read the audio clip. Record another clip or choose a playable audio file.'); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  window.addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (phase === 'recording') stopRecording('Recording stopped when the page was hidden. Review the clip, then select Transcribe.');
    else if (phase === 'requesting') cancel('Microphone permission was cancelled when the page was hidden.');
  });
  window.addEventListener('beforeunload', event => { if (operation) { event.preventDefault(); event.returnValue = ''; } });
  render();
  return { open, refresh, cancel, close, isBusy: () => !!operation };
}
