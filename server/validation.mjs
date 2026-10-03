import { createHash, randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const id = () => randomUUID();
export const now = () => Date.now();
export const hash = value => createHash('sha256').update(value).digest('hex');
export function object(value, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, `${label} must be an object.`);
  return value;
}
export function text(value, label, max = 1000, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    fail(400, `${label} must be ${empty ? 'at most' : 'between 1 and'} ${max} characters.`);
  }
  return value;
}
export function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `Invalid ${label}.`);
  return value;
}
export function settings(value = {}) {
  object(value, 'settings');
  const allowed = new Set(['systemPrompt', 'temperature', 'topP', 'maxTokens', 'toolCalls', 'toolRounds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(400, `Unknown setting: ${key}.`);
  const result = {};
  if ('systemPrompt' in value) result.systemPrompt = text(value.systemPrompt, 'systemPrompt', 100000, true);
  for (const [key, min, max] of [['temperature', 0, 2], ['topP', 0, 1]]) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) fail(400, `Invalid ${key}.`);
      result[key] = value[key];
    }
  }
  if (value.maxTokens !== undefined && value.maxTokens !== null && value.maxTokens !== '') {
    result.maxTokens = integer(value.maxTokens, 'maxTokens', 1, 1000000);
  }
  // These are local work budgets, not provider sampling controls. Omission disables them.
  for (const key of ['toolCalls', 'toolRounds']) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') result[key] = integer(value[key], key, 1, 1000000);
  }
  return result;
}
export function providerConfig(value) {
  object(value);
  const name = text(value.name, 'name', 100).trim();
  let u;
  try { u = new URL(text(value.baseUrl, 'baseUrl', 2000)); } catch { fail(400, 'Use a full HTTP or HTTPS base URL, including /v1 when required.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    fail(400, 'The base URL cannot contain credentials, a query, or a fragment.');
  }
  const models = value.models ?? [];
  if (!Array.isArray(models) || models.length > 2000) fail(400, 'Invalid model list.');
  models.forEach(m => text(m, 'model', 300));
  const c = object(value.capabilities ?? {}, 'capabilities');
  const capabilities = {};
  for (const k of ['streaming', 'vision', 'systemPrompt', 'temperature', 'topP', 'maxTokens', 'llamaCppTimings', 'tools']) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') fail(400, `Invalid capability: ${k}.`);
    capabilities[k] = c[k] ?? (k === 'streaming' || k === 'systemPrompt');
  }
  for (const key of ['audioInput', 'videoInput']) {
    capabilities[key] = c[key] === undefined ? 'none' : c[key];
    if (!['none', 'llama_cpp'].includes(capabilities[key])) fail(400, `Invalid capability: ${key}.`);
  }
  capabilities.tokenParameter = c.tokenParameter ?? 'max_tokens';
  if (!['max_tokens', 'max_completion_tokens'].includes(capabilities.tokenParameter)) fail(400, 'Invalid token parameter.');
  return { name, baseUrl: u.href.replace(/\/+$/, ''), models: [...new Set(models)], capabilities };
}
export async function body(req, limit = 34 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'The request is too large. Split the import or reduce attachment sizes.');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, 'Invalid JSON body.'); }
}
export function decodeBase64(value, max = 10 * 1024 * 1024) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(400, 'Invalid or oversized base64 attachment.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max) fail(413, 'An attachment exceeds 10 MiB.');
  return bytes;
}
const mediaMimeAliases = new Map([
  ['audio/x-wav', 'audio/wav'], ['audio/wave', 'audio/wav'], ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'], ['audio/x-flac', 'audio/flac']
]);
function webmSignature(bytes) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  const vint = (offset, id = false) => {
    const first = bytes[offset];
    if (!first) return null;
    let width = 1, marker = 0x80;
    while (!(first & marker)) { width++; marker >>= 1; }
    if (width > (id ? 4 : 8) || offset + width > bytes.length) return null;
    let value = id ? first : first & (marker - 1);
    for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i];
    return Number.isSafeInteger(value) ? { value, next: offset + width } : null;
  };
  const header = vint(4);
  if (!header || header.value > 4096 || header.next + header.value > bytes.length) return false;
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
  if (bytes.length < 16 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > Math.min(bytes.length, 4096) || size % 4) return false;
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'av01', 'dash', 'M4V ']);
  if (bytes.subarray(8, 12).toString('latin1') === 'qt  ') return false;
  for (let pos = 8; pos < size; pos += pos === 8 ? 8 : 4) {
    if (brands.has(bytes.subarray(pos, pos + 4).toString('latin1'))) return true;
  }
  return false;
}
export function attachmentBytes(value) {
  object(value, 'attachment');
  const name = text(value.name, 'attachment name', 240).replace(/[\x00-\x1f\x7f/\\]/g, '_');
  const suppliedMime = text(value.mime, 'MIME type', 100).trim().toLowerCase();
  const mime = mediaMimeAliases.get(suppliedMime) ?? suppliedMime;
  const bytes = value.bytes;
  if (!Buffer.isBuffer(bytes)) fail(400, 'Attachment bytes must be a Buffer.');
  if (bytes.length > 10 * 1024 * 1024) fail(413, 'An attachment exceeds 10 MiB.');
  let kind;
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) fail(400, 'The image signature does not match its MIME type.');
    kind = 'image';
  } else if (['audio/wav', 'audio/mpeg', 'audio/flac'].includes(mime)) {
    const valid = mime === 'audio/wav' ? bytes.length >= 44 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE'
      : mime === 'audio/flac' ? bytes.length >= 42 && bytes.subarray(0, 4).toString('latin1') === 'fLaC'
      : bytes.length >= 12 && (bytes.subarray(0, 3).toString('latin1') === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    if (!valid) fail(400, 'The audio signature does not match its MIME type.');
    kind = 'audio';
  } else if (['video/mp4', 'video/webm'].includes(mime)) {
    if (!(mime === 'video/mp4' ? mp4Signature(bytes) : webmSignature(bytes))) fail(400, 'The video signature does not match its MIME type.');
    kind = 'video';
  } else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime)) {
    if (bytes.includes(0)) fail(400, 'Text attachments cannot contain NUL bytes.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'Text attachments must use UTF-8.'); }
    kind = 'text';
  } else { fail(400, 'Use UTF-8 text, PNG/JPEG/WebP/GIF images, WAV/MP3/FLAC audio, or MP4/WebM video. Media files also require inspection and a supported provider protocol.'); }
  return { name, mime, bytes, kind };
}
export function attachmentData(value) {
  object(value, 'attachment');
  return attachmentBytes({ name: value.name, mime: value.mime, bytes: decodeBase64(value.data) });
}
