# Audio and video input

Common Chat sends original uploaded files through an explicitly selected provider protocol. It does not record a microphone or camera, fetch media URLs, trim files, transcode files, extract soundtracks, or generate audio/video output.

## Connection settings

Each connection has two independent protocol selections:

```json
{
  "audioInput": "llama_cpp",
  "videoInput": "llama_cpp"
}
```

These fields belong inside `capabilities`. Each accepts only `none` or `llama_cpp`. A missing field means `none`. Image input (`vision`) and live statistics (`llamaCppTimings`) do not enable either protocol. A generic OpenAI-compatible endpoint is not sufficient. Enable the protocol only when both the endpoint and selected model support it. Use separate connections for models with different capabilities.

Native llama.cpp video sends sampled visual frames. It does **not** send the soundtrack to the audio model. Browser playback can include the original soundtrack. The interface labels this difference beside each video. Attach a separate supported audio file when the task needs audio. Common Chat does not extract it automatically.

## Supported files and limits

| Input | Accepted files | Limit |
| --- | --- | --- |
| Audio | PCM WAV (`pcm_u8`, `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`), MP3, FLAC | 60 seconds per file and across the selected branch |
| Video | MP4 with H.264 or AV1, WebM with VP8, VP9, or AV1 | 5 seconds per clip and across the selected branch |
| Video dimensions | Landscape or portrait | Long side at most 1280 pixels, short side at most 720 pixels |
| Video frame estimate | Sum of `ceil(clip duration in seconds * 4)` for each clip | At most 20 frames across the selected branch |
| All attachments | Existing application bounds still apply | 10 MiB per file, ten files per message, 30 MiB across the branch |

The branch includes earlier messages, edited branches, and regeneration inputs. Each occurrence counts. A provider change does not remove or reinterpret saved media. If the new provider cannot accept a saved attachment, generation fails before it writes messages or a job.

AAC/M4A audio, audio-only WebM, MOV, and HEVC video are not accepted. WAV means the listed PCM formats, not every codec that a WAV container can hold. Audio files must have an audio stream and no video stream. A runner can exclude attached-picture album covers when it determines whether a real video stream exists. Video must have a supported video stream. Its ignored soundtrack does not need a particular audio codec.

MIME and header checks reject obvious mismatches. Server inspection must then establish a finite positive duration, stream types, the required codec, and video dimensions. Unknown duration, unsupported codecs, excessive limits, unavailable inspection, and inspection failures are errors. Browser metadata or imported metadata cannot replace this check. Header/metadata inspection does not prove that the selected model runtime can decode or understand a file.

Files stay unchanged. Download and native export use the original bytes. Native import must inspect those bytes again. A browser that lacks a playback codec can still offer the original download. Playback support is not the same as model input support.

### Context budget

The frame estimate uses the verified llama.cpp default of 4 frames/s. It is not a per-request runtime setting. Confirm this configuration before enabling native video on another deployment. Common Chat does not change the model server's frame rate, context size, batch size, or launch settings.

For the reference Gemma 4 12B Unified configuration, 20 frames at up to 1120 visual tokens each plus 60 seconds of audio at about 25 tokens/s use about 23,900 media tokens. That leaves roughly 8K of a 32K context for text, history, and output. This is a planning estimate, not a tokenizer result or a guarantee that a conversation fits. Keep upstream context-limit errors visible. Shorten the branch or files when needed. Do not silently drop or truncate media.

## Server module contract

`server/media.mjs` exports `Media` and the fixed `MEDIA_LIMITS` object.

```js
const media = new Media({
  mediaProbe: runner.mediaProbe.bind(runner),
  readAttachment: attachment => store.readAttachment(attachment)
});
```

The injected runner operation is:

```js
mediaProbe({ name, mime, bytes, signal })
// -> Promise<{
//   durationSeconds: number,
//   hasAudio: boolean,
//   hasVideo: boolean,
//   width?: number,
//   height?: number,
//   audioCodec?: string,
//   videoCodec?: string
// }>
```

The inspector receives a Buffer copy, a sanitized name, a canonical MIME type, and an AbortSignal. The runner owns process isolation, bounded input/output, subprocess cleanup, and stream inspection. Inspect the complete file, not a client-supplied duration. Do not execute filenames, follow media URLs, or treat the filename as an existing host path. The Common Chat module does not execute `ffprobe`, `ffmpeg`, or a shell.

Inspection has a 15-second application deadline and respects caller cancellation. A rejected or timed-out result is not cached. Runner error text is replaced with a fixed error so command output and host paths do not reach the browser. The internal `probeTimeoutMs` constructor option accepts 1 through 60,000 milliseconds. It is not an HTTP capability or user-supplied setting.

### Methods

- `await media.prepareAttachment({name, mime, bytes, kind}, {signal} = {})` validates bytes and returns verified flat metadata for audio/video. It returns `null` for valid image/text attachments. `kind` is optional, but must match the derived kind if provided. The result includes `sha256`, `kind`, `mime`, `durationSeconds`, `hasAudio`, and `hasVideo`. Audio adds `audioCodec`. Video adds `width`, `height`, and `videoCodec`.
- `await media.validateBranch(provider, attachments, {signal} = {})` checks every audio/video occurrence in the complete selected branch, including pending attachments. It uses `attachment.bytes` when supplied, otherwise the injected `readAttachment`. It gates the provider protocol, reuses or repeats inspection, and enforces combined limits. It returns `{audioSeconds, videoSeconds, estimatedVideoFrames}`.
- `media.contentPart(attachment, bytes, provider)` validates MIME/signature/kind and the explicit protocol, then returns the native content part. It does not perform async inspection or enforce the combined branch budget. Always await `validateBranch` before accepting generation. Do not use this method as a validation replacement.
- `attachmentBytes({name, mime, bytes})` from `server/validation.mjs` applies the same size, signature, MIME, and derived-kind validation as `attachmentData({name, mime, data})`. The latter decodes base64 first. These synchronous functions do not inspect duration or codec.

A 128-entry least-recently-used memory cache stores only successful verified metadata. Its key is a freshly computed SHA-256 of the actual bytes. It stores no file content. Uploaded/imported metadata, claimed hashes, and claimed kinds never establish a trusted cache entry. Callers receive metadata copies. After restart or eviction, saved media is inspected again. No SQLite migration or persistent probe metadata is required. `contentPart` does not require a cache hit because a valid branch can outlive an entry.

### Native content parts

The base64 value represents complete original file bytes. It is not a data URL, path, or raw PCM buffer.

```json
{"type":"input_audio","input_audio":{"data":"<BASE64_OF_COMPLETE_FILE>","format":"wav"}}
```

`format` is `wav`, `mp3`, or `flac`. The pinned llama.cpp parser sniffs bytes and ignores this field. It is retained as an explicit description of the audio input.

```json
{"type":"input_video","input_video":{"data":"<BASE64_OF_COMPLETE_FILE>"}}
```

The user supplies a normal task, such as "Transcribe this audio" or "Describe the visible sequence." Do not add hidden transcription prompts, model special tokens, synthetic image markers, or guessed frame-rate request fields. llama.cpp performs its own decoding, audio resampling, frame sampling, and media token insertion. Keep attachment order and original bytes.

## Application integration

These hooks are required around the module API:

1. **Upload:** call `attachmentData(body)`, then await `media.prepareAttachment(attachment)` before `store.addAttachment`. No invalid media file should become durable. Preserve existing ownership, idle-state, and size checks. Recheck state after the await when it can change concurrently.
2. **Import:** parse and validate every attachment, then await preparation for all supported media before opening the import transaction. Do not trust archived kind, hash, duration, dimensions, or codec fields. Preserve native original bytes. Continue archiving unsupported legacy attachment forms instead of guessing a conversion.
3. **Generation:** collect all branch attachments and pending attachments. Await `validateBranch` before durable submission. After any await, recheck request-ID idempotency, conversation version, and idle state before writing messages/jobs. Keep existing count and byte bounds. Build text explicitly, image explicitly, and audio/video with `contentPart`. Never decode a binary media kind as UTF-8 text.
4. **Attachment responses:** keep authentication and `X-Content-Type-Options: nosniff`. Return audio/video with the saved canonical MIME type and inline disposition, not `text/plain`. Text remains a download. Support bounded byte ranges if seeking is required. A full-file response alone does not establish reliable seeking.
5. **Static assets:** serve `/media.js` as a JavaScript module under the normal same-origin policy.

## Browser integration

`public/media.js` uses the existing dialog and attachment classes. It needs no inline styles or additional permission policy.

```js
import {
  installMediaControls, readMediaCapabilities, writeMediaCapabilities,
  updateMediaHints, validateUpload, attachmentHtml
} from './media.js';

installMediaControls(); // After the existing document controls are present.
```

- In `fillConnectionForm`, call `writeMediaCapabilities(provider?.capabilities)`.
- In `saveProvider`, merge `readMediaCapabilities()` into the existing capabilities object. Keep the existing boolean capabilities and token parameter.
- In control refreshes and provider selection changes, call `updateMediaHints(selectedProvider())`. The helper updates the selected-provider limit hint, file accept list, and attachment-button help.
- In upload, use `validateUpload(file, selectedProvider())` for the MIME value instead of `file.type || 'text/plain'`. It checks the byte-size limit and protocol, rejects unsupported media, and infers a MIME only from a known extension when the browser MIME is empty or generic binary. Server validation remains authoritative.
- In message rendering, map attachments through `attachmentHtml`. It renders image links, text downloads, and native audio/video controls with local attachment URLs. Names are escaped. Invalid identifiers do not become URLs.
- Preserve existing `.file-links` nodes when the attachment list has not changed. Unrelated response deltas, statistics, and metadata updates must not replace a playing audio/video element. If the message body is replaced, move its unchanged file node into the new message element rather than restarting playback.

`installMediaControls()` is idempotent and also returns `{read, write, update}` for callers that prefer one helper object. `providerMediaHint(provider)` returns the same selected-provider help text without accessing the DOM.

## Verification boundary

The native payloads and preprocessing behavior follow llama.cpp b11312, commit `0c1e57098bba43ac29e6e3b677cdceebdd22334f`:

- [Server API](https://github.com/ggml-org/llama.cpp/blob/0c1e57098bba43ac29e6e3b677cdceebdd22334f/tools/server/README.md)
- [Native content parser](https://github.com/ggml-org/llama.cpp/blob/0c1e57098bba43ac29e6e3b677cdceebdd22334f/tools/server/server-common.cpp)
- [Audio decoding and video frame extraction](https://github.com/ggml-org/llama.cpp/blob/0c1e57098bba43ac29e6e3b677cdceebdd22334f/tools/mtmd/mtmd-helper.cpp)
- [Media preparation and tokens](https://github.com/ggml-org/llama.cpp/blob/0c1e57098bba43ac29e6e3b677cdceebdd22334f/tools/mtmd/mtmd.cpp)
- [Gemma audio preprocessing](https://github.com/ggml-org/llama.cpp/blob/0c1e57098bba43ac29e6e3b677cdceebdd22334f/tools/mtmd/mtmd-audio.cpp)

Run existing project checks and exercise upload, playback, capability-off rejection, selected-branch limits, and native export/import with short synthetic files. Header checks, a successful inspector response, and a valid JSON payload do not establish successful model inference. Verify real audio transcription and visual sequence understanding separately when model use is authorized. No model start, restart, or inference request is required to check the module, runner, or browser integration.
