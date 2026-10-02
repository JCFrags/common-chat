import { attachmentBytes, fail, hash, HttpError } from './validation.mjs';

export const MEDIA_LIMITS = Object.freeze({
  audioSeconds: 60, videoSeconds: 5, videoLongSide: 1280, videoShortSide: 720,
  videoFrames: 20, videoFramesPerSecond: 4
});
const audioCodecs = new Map([
  ['audio/wav', new Set(['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'])],
  ['audio/mpeg', new Set(['mp3'])], ['audio/flac', new Set(['flac'])]
]);
const videoCodecs = new Map([
  ['video/mp4', new Set(['h264', 'av1'])], ['video/webm', new Set(['vp8', 'vp9', 'av1'])]
]);
const cancelled = () => new HttpError(499, 'Media inspection was cancelled.');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };
function requireProtocol(provider, kind) {
  if (provider?.capabilities?.[`${kind}Input`] !== 'llama_cpp') {
    fail(400, `The selected connection does not enable llama.cpp ${kind} input. Choose a compatible connection or a branch without ${kind}.`);
  }
}
function checkedAttachment(value) {
  const attachment = attachmentBytes(value);
  if (value.kind !== undefined && value.kind !== attachment.kind) fail(400, 'The attachment kind does not match its MIME type.');
  return attachment;
}
function verifiedMetadata(attachment, result, sha256) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.durationSeconds !== 'number' || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0
    || typeof result.hasAudio !== 'boolean' || typeof result.hasVideo !== 'boolean') {
    fail(422, 'Media inspection did not establish a safe duration and stream type. Use a supported file with a known duration.');
  }
  const { durationSeconds, hasAudio, hasVideo } = result;
  const metadata = { sha256, kind: attachment.kind, mime: attachment.mime, durationSeconds, hasAudio, hasVideo };
  if (attachment.kind === 'audio') {
    if (!hasAudio || hasVideo) fail(422, 'An audio attachment must contain audio and no video stream.');
    if (!audioCodecs.get(attachment.mime)?.has(result.audioCodec)) fail(422, 'Unsupported audio codec. Use PCM WAV, MP3, or FLAC.');
    if (durationSeconds > MEDIA_LIMITS.audioSeconds) fail(400, 'Audio must not exceed 60 seconds per file or across the selected branch. Shorten it before upload.');
    metadata.audioCodec = result.audioCodec;
  } else {
    if (!hasVideo) fail(422, 'A video attachment must contain a video stream. Audio-only MP4 or WebM files are not supported.');
    if (!videoCodecs.get(attachment.mime)?.has(result.videoCodec)) fail(422, 'Unsupported video codec. Use MP4 with H.264/AV1 or WebM with VP8/VP9/AV1. HEVC is not supported.');
    const { width, height } = result;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) fail(422, 'Media inspection did not establish safe video dimensions.');
    if (Math.max(width, height) > MEDIA_LIMITS.videoLongSide || Math.min(width, height) > MEDIA_LIMITS.videoShortSide) {
      fail(400, 'Video must fit 1280 by 720 pixels, in landscape or portrait. Resize it before upload.');
    }
    if (durationSeconds > MEDIA_LIMITS.videoSeconds) fail(400, 'Video must not exceed 5 seconds per clip or across the selected branch. Shorten it before upload.');
    Object.assign(metadata, { width, height, videoCodec: result.videoCodec });
    // Native input_video ignores the soundtrack. Its codec is not a decode requirement.
  }
  return Object.freeze(metadata);
}

export class Media {
  constructor({ mediaProbe, readAttachment, probeTimeoutMs = 15000 } = {}) {
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 60000) throw new TypeError('Invalid media probe timeout.');
    this.mediaProbe = mediaProbe;
    this.readAttachment = readAttachment;
    this.probeTimeoutMs = probeTimeoutMs;
    this.cache = new Map();
  }

  async inspect(attachment, signal) {
    checkSignal(signal);
    if (typeof this.mediaProbe !== 'function') fail(503, 'Media inspection is unavailable. Enable the isolated media runner before uploading audio or video.');
    const controller = new AbortController();
    let timer, abort, timedOut = false;
    const stopped = new Promise((resolve, reject) => {
      abort = () => { controller.abort(); reject(cancelled()); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true; controller.abort();
        reject(new HttpError(504, 'Media inspection timed out. Use a shorter or simpler file.'));
      }, this.probeTimeoutMs);
    });
    try {
      const operation = Promise.resolve().then(() => {
        checkSignal(signal);
        // The inspector receives a copy and cannot change the stored/uploaded original.
        return this.mediaProbe({ name: attachment.name, mime: attachment.mime, bytes: Buffer.from(attachment.bytes), signal: controller.signal });
      });
      return await Promise.race([operation, stopped]);
    } catch (error) {
      checkSignal(signal);
      if (timedOut) fail(504, 'Media inspection timed out. Use a shorter or simpler file.');
      if (error?.status === 503) fail(503, 'Media inspection is unavailable. Check the isolated media runner.');
      fail(422, 'Media inspection failed. Use a supported, decodable file and check the isolated media runner.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  }

  async prepareAttachment(value, { signal } = {}) {
    checkSignal(signal);
    const attachment = checkedAttachment(value);
    if (!['audio', 'video'].includes(attachment.kind)) return null;
    const sha256 = hash(attachment.bytes), cached = this.cache.get(sha256);
    if (cached?.mime === attachment.mime && cached.kind === attachment.kind) {
      this.cache.delete(sha256); this.cache.set(sha256, cached);
      return { ...cached };
    }
    const result = await this.inspect(attachment, signal);
    checkSignal(signal);
    if (hash(attachment.bytes) !== sha256) fail(400, 'The attachment changed during inspection. Upload it again.');
    const metadata = verifiedMetadata(attachment, result, sha256);
    this.cache.delete(sha256); this.cache.set(sha256, metadata);
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
    return { ...metadata };
  }

  async validateBranch(provider, attachments, { signal } = {}) {
    if (!Array.isArray(attachments)) fail(400, 'Branch attachments must be a list.');
    const totals = { audioSeconds: 0, videoSeconds: 0, estimatedVideoFrames: 0 };
    for (const attachment of attachments) {
      checkSignal(signal);
      const mimeKind = typeof attachment?.mime === 'string' ? /^(audio|video)\//.exec(attachment.mime.trim().toLowerCase())?.[1] : null;
      const kind = mimeKind ?? attachment?.kind;
      if (!['audio', 'video'].includes(kind)) continue;
      requireProtocol(provider, kind);
      let bytes = attachment.bytes;
      if (bytes === undefined) {
        if (typeof this.readAttachment !== 'function') fail(503, 'Saved media cannot be inspected because attachment storage is unavailable.');
        try { bytes = await this.readAttachment(attachment); }
        catch { checkSignal(signal); fail(422, 'A saved media attachment could not be read. Restore or attach the original file before retrying.'); }
      }
      const metadata = await this.prepareAttachment({ name: attachment.name, mime: attachment.mime, kind: attachment.kind, bytes }, { signal });
      if (!metadata) fail(400, 'The media attachment kind does not match its contents.');
      requireProtocol(provider, metadata.kind);
      if (metadata.kind === 'audio') totals.audioSeconds += metadata.durationSeconds;
      else {
        totals.videoSeconds += metadata.durationSeconds;
        totals.estimatedVideoFrames += Math.ceil(metadata.durationSeconds * MEDIA_LIMITS.videoFramesPerSecond);
      }
      if (totals.audioSeconds > MEDIA_LIMITS.audioSeconds) fail(400, 'The selected branch exceeds 60 seconds of total audio, including history. Use a shorter branch or shorter files.');
      if (totals.videoSeconds > MEDIA_LIMITS.videoSeconds || totals.estimatedVideoFrames > MEDIA_LIMITS.videoFrames) {
        fail(400, 'The selected branch exceeds 5 seconds or 20 estimated video frames, including history. Use a shorter branch or shorter clips.');
      }
    }
    checkSignal(signal);
    return totals;
  }

  contentPart(attachment, bytes, provider) {
    const checked = checkedAttachment({ name: attachment.name, mime: attachment.mime, kind: attachment.kind, bytes });
    if (!['audio', 'video'].includes(checked.kind)) fail(400, 'Native media content requires an audio or video attachment.');
    requireProtocol(provider, checked.kind);
    // The caller must await validateBranch before accepting a generation request.
    // Requiring a cache hit here would break valid branches after cache eviction.
    const data = bytes.toString('base64');
    if (checked.kind === 'video') return { type: 'input_video', input_video: { data } };
    const format = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac' }[checked.mime];
    return { type: 'input_audio', input_audio: { data, format } };
  }
}
