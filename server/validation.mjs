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
  const allowed = new Set(['systemPrompt', 'temperature', 'topP', 'maxTokens']);
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
  for (const k of ['streaming', 'vision', 'systemPrompt', 'temperature', 'topP', 'maxTokens']) {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') fail(400, `Invalid capability: ${k}.`);
    capabilities[k] = c[k] ?? (k === 'streaming' || k === 'systemPrompt');
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
export function attachmentData(value) {
  object(value, 'attachment');
  const name = text(value.name, 'attachment name', 240).replace(/[\x00-\x1f\x7f/\\]/g, '_');
  const mime = text(value.mime, 'MIME type', 100).toLowerCase();
  const bytes = decodeBase64(value.data);
  let kind;
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) fail(400, 'The image signature does not match its MIME type.');
    kind = 'image';
  } else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime)) {
    if (bytes.includes(0)) fail(400, 'Text attachments cannot contain NUL bytes.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'Text attachments must use UTF-8.'); }
    kind = 'text';
  } else { fail(400, 'Only UTF-8 text and PNG, JPEG, WebP, or GIF images are supported.'); }
  return { name, mime, bytes, kind };
}
