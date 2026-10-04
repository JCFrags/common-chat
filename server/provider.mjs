import { fail, HttpError, llamaSamplingFields, genericSamplingCapabilities } from './validation.mjs';
import { getModelCatalog, getThinkingCapabilities } from './model-catalog.mjs';

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

/** Map only validated, explicitly enabled controls. No request object can override server authority. */
export function samplingPayload(provider, settings) {
  const caps = provider.capabilities, payload = {};
  for (const [setting, parameter] of [['temperature', 'temperature'], ['topP', 'top_p'], ['maxTokens', caps.tokenParameter ?? 'max_tokens']]) {
    if (settings[setting] === undefined || setting === 'maxTokens' && settings.maxTokens === -1) continue;
    if (caps[setting] !== true) fail(400, `The selected connection does not enable ${setting}. Remove that setting or edit its capabilities.`);
    payload[parameter] = settings[setting];
  }
  for (const key of llamaSamplingFields) {
    if (settings[key] === undefined) continue;
    if (caps.llamaCppSampling !== true) fail(400, `The selected connection does not enable llamaCppSampling for ${key}.`);
    payload[key] = settings[key];
  }
  for (const [key, capability] of Object.entries(genericSamplingCapabilities)) {
    if (settings[key] === undefined) continue;
    if (caps.llamaCppSampling !== true && caps[capability] !== true) fail(400, `The selected connection does not enable ${capability} for ${key}.`);
    payload[key] = settings[key];
  }
  return payload;
}

/** Provider default sends no override. Preflight and payload use the same model resolver. */
export function thinkingPayload(provider, settings, model) {
  const hasBudget = settings.thinking_budget_tokens !== undefined && settings.thinking_budget_tokens >= 0;
  if (settings.thinking === undefined && !hasBudget) return {};
  const thinking = getThinkingCapabilities(provider, model), payload = {};
  if (thinking.protocol === 'unknown') fail(400, 'Thinking support is unknown or stale for this model. Refresh models, configure its protocol, or use the provider default.');
  if (hasBudget) {
    if (provider.capabilities.llamaCppThinkingBudget !== true || thinking.protocol !== 'llama_cpp') fail(400, 'Thinking token budgets require llamaCppThinkingBudget and a llama_cpp thinking declaration for this model.');
    if (settings.thinking === 'off') fail(400, 'A thinking token budget cannot be combined with thinking off.');
    payload.thinking_budget_tokens = settings.thinking_budget_tokens;
  }
  if (settings.thinking === undefined) return payload;
  if (thinking.levels.includes(settings.thinking)) {
    if (thinking.protocol === 'llama_cpp') return { ...payload, chat_template_kwargs: { enable_thinking: settings.thinking === 'on' } };
    if (thinking.protocol === 'reasoning_effort') return { reasoning_effort: settings.thinking };
    if (thinking.protocol === 'openrouter_reasoning') return { reasoning: { effort: settings.thinking } };
  }
  fail(400, 'The selected connection and model do not enable this thinking level. Use the provider default or configure its supported protocol.');
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
export async function listModels(provider, options) {
  return (await getModelCatalog(provider, options)).models;
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
export function promptProgressStats(value) {
  const result = { ...numericStats(value, ['total', 'cache', 'processed'], true), ...numericStats(value, ['time_ms']) };
  // A progress sample describes one prompt. Reject incomplete or contradictory samples.
  if (Object.keys(result).length !== 4 || result.cache > result.processed || result.processed > result.total) return null;
  return result;
}
export function deltaText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(x => typeof x?.text === 'string' ? x.text : '').join('');
  return '';
}
