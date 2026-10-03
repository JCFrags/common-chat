import { decodeBase64, text, object, fail, HttpError } from './validation.mjs';
import { responseError, errorText, limitedText } from './provider.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024;
const mimeAliases = new Map([
  ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'], ['audio/x-m4a', 'audio/mp4'], ['audio/m4a', 'audio/mp4']
]);

function webmSignature(bytes) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  const vint = (offset, isId = false) => {
    const first = bytes[offset];
    if (!first) return null;
    let width = 1, marker = 0x80;
    while (!(first & marker)) { width++; marker >>= 1; }
    if (width > (isId ? 4 : 8) || offset + width > bytes.length) return null;
    let value = isId ? first : first & (marker - 1);
    for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i];
    return Number.isSafeInteger(value) ? { value, next: offset + width } : null;
  };
  const header = vint(4);
  if (!header || header.value > 4096 || header.next + header.value >= bytes.length) return false;
  const end = header.next + header.value;
  for (let pos = header.next; pos < end;) {
    const id = vint(pos, true), size = id && vint(id.next);
    if (!size || size.next + size.value > end) return false;
    if (id.value === 0x4282) return bytes.subarray(size.next, size.next + size.value).toString('latin1') === 'webm';
    pos = size.next + size.value;
  }
  return false;
}

function mp4Signature(bytes) {
  if (bytes.length < 20 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > Math.min(bytes.length - 4, 4096) || size % 4) return false;
  const brands = new Set(['M4A ', 'M4B ', 'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'dash']);
  if (bytes.subarray(8, 12).toString('latin1') === 'qt  ') return false;
  for (let pos = 8; pos < size; pos += pos === 8 ? 8 : 4) {
    if (brands.has(bytes.subarray(pos, pos + 4).toString('latin1'))) return true;
  }
  return false;
}

function mp3Signature(bytes) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3') {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes.subarray(6, 10).some(n => n & 0x80)) return false;
    const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    offset = 10 + size + (bytes[3] === 4 && bytes[5] & 0x10 ? 10 : 0);
  }
  // Require a Layer III frame, not an ID3 tag alone or an AAC sync word.
  return offset + 4 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0
    && ((bytes[offset + 1] >> 3) & 3) !== 1 && ((bytes[offset + 1] >> 1) & 3) === 1
    && (bytes[offset + 2] >> 4) > 0 && (bytes[offset + 2] >> 4) < 15 && ((bytes[offset + 2] >> 2) & 3) !== 3;
}

function audioInput(value) {
  object(value);
  const model = text(value.model, 'transcription model', 300).trim();
  const name = text(value.name, 'audio name', 240).replace(/[\x00-\x1f\x7f/\\]/g, '_');
  const supplied = text(value.mime, 'audio MIME type', 100).trim().toLowerCase().split(';')[0].trim();
  const mime = mimeAliases.get(supplied) ?? supplied;
  const bytes = decodeBase64(value.data, MAX_BYTES);
  // These checks identify the container. They do not inspect duration or prove decodability.
  const valid = mime === 'audio/wav' ? bytes.length > 44 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE'
    : mime === 'audio/mpeg' ? mp3Signature(bytes)
    : ['audio/webm', 'video/webm'].includes(mime) ? webmSignature(bytes)
    : ['audio/mp4', 'video/mp4'].includes(mime) ? mp4Signature(bytes) : false;
  if (!valid) fail(400, 'Use a nonempty WAV, MP3, WebM, or MP4/M4A audio file whose signature matches its MIME type. Files are not converted.');
  return { model, name, mime, bytes };
}

/** Ephemeral file transcription. No conversation, attachment, or job state is written. */
export class Transcriptions {
  constructor({ timeoutMs = 60000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid transcription timeout.');
    this.timeoutMs = timeoutMs;
    this.pending = new Set();
    this.stopping = false;
  }

  async transcribe(provider, input, { signal } = {}) {
    if (this.stopping) fail(503, 'The transcription service is stopping.');
    if (signal?.aborted) fail(499, 'Speech transcription was cancelled.');
    if (this.pending.size >= 2) fail(429, 'Two transcriptions are already active. Wait or cancel one before trying again.');
    const clip = audioInput(input);
    const baseUrl = text(provider?.base_url, 'saved transcription base URL', 2000);
    const controller = new AbortController();
    let timedOut = false, resolveSettled;
    const pending = { controller, settled: new Promise(resolve => { resolveSettled = resolve; }) };
    this.pending.add(pending);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let response;
    try {
      const form = new FormData();
      form.set('file', new Blob([clip.bytes], { type: clip.mime }), clip.name);
      form.set('model', clip.model);
      response = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST', body: form, redirect: 'error', signal: controller.signal,
        headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
      });
      if (!response.ok) await responseError(response, provider);
      const raw = await limitedText(response, MAX_RESPONSE);
      if (controller.signal.aborted) throw controller.signal.reason;
      let result;
      try { result = JSON.parse(raw); } catch { fail(502, 'The speech endpoint did not return a JSON transcription.'); }
      if (!result || typeof result.text !== 'string') fail(502, 'The speech endpoint did not return transcription text.');
      return { text: text(result.text, 'transcription text', MAX_RESPONSE, true) };
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.stopping) fail(503, 'The transcription service is stopping.');
        if (timedOut) fail(504, 'Speech transcription timed out. Use a shorter clip or check the speech endpoint.');
        fail(499, 'Speech transcription was cancelled.');
      }
      if (error instanceof HttpError) throw new HttpError(error.status, errorText(error, provider.apiKey));
      // Fetch/parser errors can contain endpoint details. Do not return their raw messages.
      fail(502, 'Speech transcription failed or exceeded its response limit. Check the speech endpoint and supported audio format.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.abort();
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      this.pending.delete(pending); resolveSettled();
    }
  }

  async stop() {
    this.stopping = true;
    const pending = [...this.pending];
    for (const request of pending) request.controller.abort();
    await Promise.allSettled(pending.map(request => request.settled));
  }
}
