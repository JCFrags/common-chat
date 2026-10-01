import { fail, HttpError } from './validation.mjs';

/** Parse SSE records across arbitrary byte boundaries, including UTF-8 and CRLF. */
export async function* sseRecords(stream) {
  const decoder = new TextDecoder();
  let buffer = '', data = [], dataSize = 0;
  function take(line) {
    if (line === '') {
      if (!data.length) return null;
      const value = data.join('\n'); data = []; dataSize = 0; return value;
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5); if (value.startsWith(' ')) value = value.slice(1);
      dataSize += value.length;
      if (dataSize > 2 * 1024 * 1024) throw new Error('An upstream SSE event is too large.');
      data.push(value);
    }
    return null;
  }
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      // A trailing CR can be the first half of a CRLF delimiter.
      if (match[0] === '\r' && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const result = take(line); if (result !== null) yield result;
    }
    if (buffer.length > 2 * 1024 * 1024) throw new Error('An upstream SSE line is too large.');
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r\n|\r|\n/)) { const result = take(line); if (result !== null) yield result; }
  // Tolerate a final data line without a trailing blank line.
  const result = take(''); if (result !== null) yield result;
}

export function headers(provider) {
  return { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) };
}
export function errorText(error, secret = '') {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join('[redacted]');
  return message.slice(0, 1000);
}
export async function responseError(response, provider) {
  // Do not echo an arbitrary upstream response body or request headers into the UI.
  const reasons = { 401: 'The model server rejected its API key.', 403: 'The model server denied access.',
    404: 'The endpoint or model was not found. Check the base URL and model name.',
    429: 'The model server is rate-limited or busy.', 503: 'The model server is unavailable or busy.' };
  throw new HttpError(502, `${provider.name}: HTTP ${response.status}. ${reasons[response.status] ?? 'The model server rejected the request. Check its logs.'}`);
}
export async function listModels(provider) {
  if (provider.models.length) return provider.models;
  const response = await fetch(`${provider.base_url}/models`, { headers: headers(provider), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) await responseError(response, provider);
  const bytes = await limitedText(response, 2 * 1024 * 1024);
  const json = JSON.parse(bytes);
  if (!Array.isArray(json.data)) fail(502, 'The models endpoint did not return an OpenAI-compatible model list. Enter model names in the connection settings.');
  return [...new Set(json.data.map(m => m.id).filter(m => typeof m === 'string' && m.length <= 300))].slice(0, 2000);
}
export async function limitedText(response, max) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) { throw new Error('The upstream response exceeds the configured limit.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Keep recognized numeric statistics only. Do not retain arbitrary upstream fields.
function numericStats(value, keys, integer = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of keys) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(n))) result[key] = n;
  }
  return Object.keys(result).length ? result : null;
}
export function usageStats(value) {
  const result = numericStats(value, ['prompt_tokens', 'completion_tokens', 'total_tokens'], true) ?? {};
  for (const [key, fields] of [
    ['prompt_tokens_details', ['cached_tokens', 'audio_tokens']],
    ['completion_tokens_details', ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']]
  ]) {
    const details = numericStats(value?.[key], fields, true);
    if (details) result[key] = details;
  }
  return Object.keys(result).length ? result : null;
}
export function timingStats(value) {
  const result = {
    ...numericStats(value, ['prompt_n', 'predicted_n', 'draft_n', 'draft_n_accepted'], true),
    ...numericStats(value, ['prompt_ms', 'prompt_per_second', 'predicted_ms', 'predicted_per_second'])
  };
  return Object.keys(result).length ? result : null;
}
export function deltaText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(x => typeof x?.text === 'string' ? x.text : '').join('');
  return '';
}
