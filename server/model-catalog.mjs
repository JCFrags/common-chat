import { fail, text, object, hash, HttpError, modelConfig as validateModelConfig, thinkingEffortLevels } from './validation.mjs';
import { headers, limitedText, responseError, errorText } from './provider.mjs';

const cache = new Map(), cacheLimit = 64, freshMs = 30000, failedMs = 5000;
const unknownThinking = () => ({ protocol: 'unknown', levels: [], source: 'unknown' });
const configFor = provider => provider.modelConfig ?? {};
const savedModels = provider => [...new Set((provider.models ?? []).filter(model => typeof model === 'string' && model.trim() && model.length <= 300))].slice(0, 2000);
const profileFor = (provider, model) => configFor(provider).profiles?.find(profile => profile.id === model);
const baseUrl = provider => provider.base_url ?? provider.baseUrl;
function fingerprint(provider) {
  // Do not retain credentials as cache keys or expose them with catalog metadata.
  return hash(JSON.stringify([baseUrl(provider), provider.apiKey ?? '', provider.api_key ?? '', provider.models ?? [], provider.capabilities ?? {}, configFor(provider)]));
}
const slotFor = provider => provider.id ? `provider:${provider.id}` : `anonymous:${fingerprint(provider)}`;
export function modelDiscoveryMode(provider) {
  return configFor(provider).discovery ?? (provider.models?.length ? 'manual' : 'auto');
}
export function invalidateModelCatalog(providerId) {
  for (const [slot, entry] of cache) {
    if (providerId !== undefined && slot !== `provider:${providerId}`) continue;
    cache.delete(slot); entry.controller.abort();
  }
}
function entryFor(provider) {
  const slot = slotFor(provider), entry = cache.get(slot);
  if (entry && entry.key !== fingerprint(provider)) {
    cache.delete(slot); entry.controller.abort(); return null;
  }
  return entry;
}
function declaredThinking(provider, model) {
  const declaration = profileFor(provider, model)?.thinking, caps = provider.capabilities ?? {};
  const protocol = declaration?.protocol ?? (caps.thinking !== 'none' ? caps.thinking : undefined);
  const source = declaration ? 'profile' : 'connection';
  if (protocol === 'none') return { protocol, levels: [], source };
  if (protocol === 'llama_cpp') return { protocol, levels: declaration?.levels ? declaration.levels.filter(level => ['on', 'off'].includes(level)) : ['on', 'off'], source };
  if (['reasoning_effort', 'openrouter_reasoning'].includes(protocol)) {
    const levels = declaration ? declaration.levels : caps.thinkingLevels;
    return { protocol, levels: [...new Set((levels ?? []).filter(level => thinkingEffortLevels.includes(level)))], source };
  }
  return null;
}
/** Resolve only explicit declarations or fresh server-owned metadata. This never performs I/O. */
export function getThinkingCapabilities(provider, model) {
  const declaration = declaredThinking(provider, model);
  if (declaration) return declaration;
  const entry = entryFor(provider);
  if (entry?.success && entry.expiresAt > Date.now()) {
    const thinking = entry.apiDetails.get(model)?.thinking;
    if (thinking) return { ...thinking, levels: [...thinking.levels] };
  }
  return unknownThinking();
}
function isOpenRouter(provider) {
  if (configFor(provider).metadata === 'openrouter') return true;
  try {
    const url = new URL(baseUrl(provider));
    return url.protocol === 'https:' && url.hostname === 'openrouter.ai' && !url.port && url.pathname.replace(/\/+$/, '') === '/api/v1';
  } catch { return false; }
}
function apiDetail(model, openrouter) {
  const detail = {};
  if (!openrouter) return detail;
  if (typeof model.name === 'string') {
    const name = model.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100);
    if (name) detail.name = name;
  }
  const reasoning = model.reasoning;
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const efforts = reasoning.supported_efforts;
    const levels = efforts === null ? [...thinkingEffortLevels]
      : Array.isArray(efforts) ? [...new Set(efforts.filter(level => thinkingEffortLevels.includes(level)))] : [];
    detail.thinking = { protocol: 'openrouter_reasoning', levels: reasoning.mandatory === true ? levels.filter(level => level !== 'none') : levels, source: 'api' };
  }
  return detail;
}
function detailsFor(provider, models, apiDetails = new Map()) {
  return models.map(id => {
    const api = apiDetails.get(id), profile = profileFor(provider, id);
    const thinking = declaredThinking(provider, id) ?? api?.thinking ?? unknownThinking();
    return { id, ...(api?.name ? { name: api.name } : {}), ...(profile?.nickname ? { nickname: profile.nickname } : {}), thinking: { ...thinking, levels: [...thinking.levels] } };
  });
}
function resultFor(provider, entry, cached = false) {
  return {
    models: [...entry.models], details: detailsFor(provider, entry.models, entry.success ? entry.apiDetails : undefined),
    reachable: cached ? null : entry.success, source: cached ? 'cache' : entry.success ? 'api' : 'fallback',
    checkedAt: entry.checkedAt, catalogState: cached ? 'cached' : entry.success ? 'fresh' : 'failed',
    ...(entry.error ? { error: entry.error } : {})
  };
}
/** Refresh only /models. Generic model names and llama.cpp booleans do not prove thinking support. */
export async function getModelCatalog(provider, { refresh = false } = {}) {
  const existing = entryFor(provider);
  if (modelDiscoveryMode(provider) === 'manual') {
    const models = savedModels(provider);
    return { models, details: detailsFor(provider, models), reachable: null, source: 'manual', checkedAt: null, catalogState: 'manual' };
  }
  if (existing?.pending) return structuredClone(await existing.pending);
  if (!refresh && existing && existing.expiresAt > Date.now()) return resultFor(provider, existing, true);
  const slot = slotFor(provider), entry = { key: fingerprint(provider), controller: new AbortController(), success: false, models: [], apiDetails: new Map() };
  existing?.controller.abort(); cache.delete(slot); cache.set(slot, entry);
  while (cache.size > cacheLimit) {
    const first = cache.keys().next().value, evicted = cache.get(first);
    cache.delete(first); evicted.controller.abort();
  }
  entry.pending = (async () => {
    try {
      const response = await fetch(`${baseUrl(provider)}/models`, { headers: headers(provider), redirect: 'error', signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) await responseError(response, provider);
      const json = JSON.parse(await limitedText(response, 2 * 1024 * 1024));
      if (!Array.isArray(json.data)) fail(502, 'The models endpoint did not return an OpenAI-compatible model list. Configure manual discovery if needed.');
      const openrouter = isOpenRouter(provider);
      for (const model of json.data) {
        const id = model?.id;
        if (typeof id !== 'string' || !id.trim() || id.length > 300 || entry.apiDetails.has(id)) continue;
        entry.apiDetails.set(id, apiDetail(model, openrouter));
        if (entry.apiDetails.size === 2000) break;
      }
      entry.models = [...entry.apiDetails.keys()]; entry.success = true;
    } catch (error) {
      entry.models = savedModels(provider); entry.apiDetails.clear();
      entry.error = error instanceof HttpError ? errorText(error, provider.apiKey)
        : 'The model catalog could not be refreshed. Check the connection and refresh models.';
    }
    entry.checkedAt = Date.now(); entry.expiresAt = entry.checkedAt + (entry.success ? freshMs : failedMs);
    if (cache.get(slot) !== entry) {
      const models = savedModels(provider);
      return { models, details: detailsFor(provider, models), reachable: null, source: 'cache', checkedAt: entry.checkedAt, catalogState: 'stale', error: 'The connection changed during discovery. Refresh models.' };
    }
    return resultFor(provider, entry);
  })();
  try { return structuredClone(await entry.pending); }
  finally { entry.pending = null; }
}
/** Change one profile without updating keys, manual IDs, or other connection fields. */
export function updateModelProfile(store, providerId, input) {
  object(input); const model = text(input.model, 'model', 300);
  store.transaction(() => {
    const provider = store.provider(providerId), config = validateModelConfig(configFor(provider));
    const index = config.profiles.findIndex(profile => profile.id === model);
    const profile = { ...(index < 0 ? { id: model } : config.profiles[index]) };
    if ('nickname' in input) {
      if (input.nickname === null) delete profile.nickname;
      else profile.nickname = text(input.nickname, 'model nickname', 100, true);
    }
    if ('thinking' in input) {
      if (input.thinking === null) delete profile.thinking;
      else profile.thinking = input.thinking;
    }
    if (index < 0) {
      if (profile.nickname || profile.thinking) config.profiles.push(profile);
    } else config.profiles[index] = profile;
    const normalized = validateModelConfig(config);
    const selected = normalized.profiles.findIndex(profile => profile.id === model);
    if (selected >= 0 && !normalized.profiles[selected].nickname && !normalized.profiles[selected].thinking) normalized.profiles.splice(selected, 1);
    store.run('UPDATE providers SET model_config=? WHERE id=?', JSON.stringify(normalized), providerId);
  });
  invalidateModelCatalog(providerId);
  return store.providers().find(provider => provider.id === providerId);
}
