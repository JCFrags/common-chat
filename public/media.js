import { escape as esc } from './markdown.js';

const protocols = new Set(['none', 'llama_cpp']);
const audioMimes = new Set(['audio/wav', 'audio/mpeg', 'audio/flac']);
const videoMimes = new Set(['video/mp4', 'video/webm']);
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const textMimes = new Set(['application/json', 'application/xml', 'application/javascript']);
const aliases = new Map([
  ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'], ['audio/x-flac', 'audio/flac']
]);
const extensions = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
  ['wav', 'audio/wav'], ['mp3', 'audio/mpeg'], ['flac', 'audio/flac'], ['mp4', 'video/mp4'], ['webm', 'video/webm'],
  ['json', 'application/json'], ['xml', 'application/xml'], ['js', 'application/javascript'],
  ...['txt', 'md', 'py', 'ts', 'rs', 'go', 'c', 'cpp', 'h', 'yaml', 'yml', 'toml', 'log', 'csv', 'sh', 'html', 'css'].map(ext => [ext, 'text/plain'])
]);
const baseAccept = 'image/png,image/jpeg,image/webp,image/gif,text/*,.txt,.py,.js,.ts,.json,.md,.rs,.go,.c,.cpp,.h,.yaml,.yml,.toml,.log,.csv,.sh,.html,.xml,.css';
const enabled = (provider, kind) => provider?.capabilities?.[`${kind}Input`] === 'llama_cpp';
const protocol = value => protocols.has(value) ? value : 'none';

export function validateUpload(file, provider) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('The selected file could not be read.');
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB.`);
  const supplied = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  let mime = aliases.get(supplied) ?? supplied;
  if (!mime || mime === 'application/octet-stream') mime = extensions.get(file.name.split('.').at(-1).toLowerCase()) ?? '';
  const kind = audioMimes.has(mime) ? 'audio' : videoMimes.has(mime) ? 'video' : null;
  if (kind && !enabled(provider, kind)) throw new Error(`The selected connection does not enable llama.cpp ${kind} input. Enable it only for a compatible endpoint and model.`);
  if (!kind && !imageMimes.has(mime) && !textMimes.has(mime) && !mime.startsWith('text/')) {
    throw new Error('Use UTF-8 text, PNG/JPEG/WebP/GIF images, WAV/MP3/FLAC audio, or MP4/WebM video. Other media formats are not converted.');
  }
  return mime;
}

export function attachmentHtml(attachment) {
  const name = esc(attachment?.name ?? 'Attachment');
  if (typeof attachment?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(attachment.id)) return `<span class="small">${name}: attachment unavailable.</span>`;
  const url = `/api/attachments/${encodeURIComponent(attachment.id)}`;
  const size = Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? `<span class="muted">${Math.ceil(attachment.size / 1024)} KiB</span>` : '';
  const download = `<a href="${url}" download="${name}">Download original</a>`;
  if (attachment.kind === 'image') return `<a href="${url}" target="_blank" rel="noopener"><img class="attached-image" src="${url}" alt="${name}" loading="lazy"></a>`;
  if (attachment.kind === 'audio' || attachment.kind === 'video') {
    const video = attachment.kind === 'video', tag = video ? 'video' : 'audio';
    const note = video ? 'Model input is visual-only. The soundtrack is not sent as audio.' : 'Ask the model to transcribe or analyze the audio.';
    return `<div class="file-link" data-media-attachment="${esc(attachment.id)}"><div>${name} ${size}</div><${tag} class="attached-image" controls preload="metadata" ${video ? 'playsinline width="320" ' : ''}src="${url}" aria-label="Play ${name}">Your browser cannot play this file.</${tag}><p class="small">${note} Browser playback depends on its codec support.</p>${download}</div>`;
  }
  return `<a class="file-link" href="${url}" download="${name}">${name} ${size}</a>`;
}

export function readMediaCapabilities() {
  return Object.fromEntries(['audioInput', 'videoInput'].map(key => [key, protocol(document.querySelector(`#cap-${key}`)?.value)]));
}

export function writeMediaCapabilities(capabilities = {}) {
  for (const key of ['audioInput', 'videoInput']) {
    const control = document.querySelector(`#cap-${key}`);
    if (control) control.value = protocol(capabilities?.[key]);
  }
}

export function providerMediaHint(provider) {
  if (!provider) return 'Select a connection. Audio and video input stay off until their protocols are enabled for a compatible model.';
  const audio = enabled(provider, 'audio') ? 'Audio: WAV/MP3/FLAC, up to 60 seconds total.' : 'Audio input: off.';
  const video = enabled(provider, 'video') ? 'Video: MP4/WebM, up to 5 seconds total, 720p, and 20 estimated frames at 4 frames/s. Visual-only, no soundtrack.' : 'Video input: off.';
  return `${audio} ${video} Limits include selected branch history. Each file must not exceed 10 MiB.`;
}

export function updateMediaHints(provider) {
  const hint = document.querySelector('#media-input-hint');
  if (hint) hint.textContent = providerMediaHint(provider);
  const input = document.querySelector('#file-input');
  if (input) input.accept = baseAccept + (enabled(provider, 'audio') ? ',audio/wav,audio/mpeg,audio/flac,.wav,.mp3,.flac' : '') + (enabled(provider, 'video') ? ',video/mp4,video/webm,.mp4,.webm' : '');
  const button = document.querySelector('#attach-button');
  if (button) {
    button.title = 'Attach images or UTF-8 text' + (enabled(provider, 'audio') ? ', WAV/MP3/FLAC audio' : '') + (enabled(provider, 'video') ? ', or short MP4/WebM video (visual-only)' : '');
    button.setAttribute('aria-describedby', 'media-input-hint');
  }
}

export function installMediaControls() {
  const form = document.querySelector('#connection-form');
  if (form && !form.querySelector('#media-capabilities')) {
    const fieldset = document.createElement('fieldset'); fieldset.id = 'media-capabilities';
    fieldset.innerHTML = `<legend>Media input protocols</legend><div class="form-grid"><label class="field">Audio input<select id="cap-audioInput"><option value="none">Off</option><option value="llama_cpp">llama.cpp native audio</option></select></label><label class="field">Video input<select id="cap-videoInput"><option value="none">Off</option><option value="llama_cpp">llama.cpp native video (visual-only)</option></select></label></div><p class="small">Enable only for an endpoint and model that support the exact protocol. Image input and live statistics do not enable audio or video. Use separate connections for different model capabilities.</p><p class="small">Audio: PCM WAV, MP3, or FLAC, up to 60 seconds total. Video: MP4 (H.264/AV1) or WebM (VP8/VP9/AV1), up to 5 seconds total, 1280 by 720 pixels in either orientation, and 20 estimated frames at 4 frames/s. HEVC is not supported. The model does not hear a video soundtrack.</p><small>Limits include selected branch history. Each file must not exceed 10 MiB. Server inspection is required. Files are not trimmed or converted. Model context limits can still reject a long conversation.</small>`;
    const before = form.querySelector('#token-parameter')?.closest('label') ?? form.querySelector('#connection-error');
    form.insertBefore(fieldset, before);
  }
  if (!document.querySelector('#media-input-hint')) {
    const composer = document.querySelector('#composer');
    if (composer) {
      const hint = document.createElement('div'); hint.id = 'media-input-hint'; hint.className = 'small';
      composer.after(hint); updateMediaHints(null);
    }
  }
  return { read: readMediaCapabilities, write: writeMediaCapabilities, update: updateMediaHints };
}
