const $ = selector => document.querySelector(selector);
const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
export function modelLabel(detail, id) { return detail?.nickname || detail?.name || id || 'Not selected'; }
export function catalogMessage(result) {
  if (result.error) return `${result.error} Saved IDs are shown as a fallback, not verified availability.`;
  if (result.source === 'cache') return `Cached model list${result.checkedAt ? `, checked at ${new Date(result.checkedAt).toLocaleTimeString()}` : ''}. This is not a fresh availability check.`;
  if (result.reachable !== true) return 'Saved manual model IDs. API availability is not verified.';
  return `${result.models.length} models listed by the API. Listing does not prove inference or transcription support.`;
}

/** Keep API identities separate from display labels and model declarations. */
export function installModelControls({ api, getProvider, onCatalog, onChange, onSaved, busy, toast }) {
  const catalogs = new Map(), requests = new Map();
  let profileContext = '', saving = false;
  const raw = $('#model-input'), select = $('#model-select');
  function details(providerId = getProvider()?.id, model = raw.value) {
    return catalogs.get(providerId)?.details?.find(item => item.id === model);
  }
  function label() { return modelLabel(details(), raw.value); }
  function levelsVisibility() {
    $('#model-thinking-levels-field').hidden = !['reasoning_effort', 'openrouter_reasoning'].includes($('#model-thinking-protocol').value);
  }
  function renderProfile(force = false) {
    const p = getProvider(), model = raw.value, context = JSON.stringify([p?.id, model]);
    if (force || context !== profileContext) {
      const profile = p?.modelConfig?.profiles?.find(item => item.id === model);
      $('#model-nickname').value = profile?.nickname ?? '';
      $('#model-thinking-protocol').value = profile?.thinking?.protocol ?? 'inherit';
      $('#model-thinking-levels').value = (profile?.thinking?.levels ?? []).join(', ');
      $('#model-profile-error').textContent = '';
      profileContext = context; levelsVisibility();
    }
    const thinking = details()?.thinking;
    $('#model-thinking-source').textContent = thinking?.protocol && thinking.protocol !== 'none'
      ? `Current support: ${thinking.protocol}. Source: ${thinking.source ?? 'declaration'}.`
      : 'No supported thinking levels are known. Provider default sends no override.';
    $('#model-profile-form').querySelectorAll('input, select, button').forEach(node => { node.disabled = saving || busy() || !p || !model; });
  }
  function render() {
    const p = getProvider(), result = catalogs.get(p?.id), models = result?.models ?? [];
    const current = raw.value;
    const nodes = [option('', p ? 'Select an available model' : 'Select a connection first')];
    for (const id of models) {
      const text = modelLabel(result.details?.find(item => item.id === id), id);
      nodes.push(option(id, text === id ? id : `${text} (${id})`));
    }
    // Preserve a historical selection without silently replacing its identity.
    if (current && !models.includes(current)) nodes.push(option(current, `${current} (not in current list)`));
    select.replaceChildren(...nodes); select.value = current;
    select.disabled = busy() || !p;
    $('#picker-refresh-models').disabled = busy() || !p;
    $('#model-catalog-status').textContent = result ? catalogMessage(result) : p ? 'Model list has not been checked.' : 'Add a connection to discover its models.';
    $('#model-id').textContent = current ? `API model ID: ${current}` : '';
    renderProfile();
  }
  async function catalog(providerId, { refresh = false } = {}) {
    const ticket = (requests.get(providerId) ?? 0) + 1; requests.set(providerId, ticket);
    const result = await api(`/api/providers/${encodeURIComponent(providerId)}/models${refresh ? '?refresh=1' : ''}`);
    if (requests.get(providerId) === ticket) { catalogs.set(providerId, result); onCatalog(providerId, result); }
    return result;
  }
  async function load(notify = true, refresh = notify) {
    const p = getProvider(); if (!p) { render(); return; }
    try {
      const result = await catalog(p.id, { refresh });
      if (getProvider()?.id !== p.id) return;
      if (!raw.value && result.models.length) raw.value = result.models[0];
      render(); onChange(false);
      if (notify) toast(catalogMessage(result));
      return result;
    } catch (error) {
      const result = { models: catalogs.get(p.id)?.models ?? [], details: catalogs.get(p.id)?.details ?? [], reachable: false, error: error.message };
      catalogs.set(p.id, result); onCatalog(p.id, result);
      if (getProvider()?.id === p.id) { render(); onChange(false); }
      if (notify) toast(error.message);
    }
  }
  select.addEventListener('change', () => { raw.value = select.value; render(); onChange(true); });
  $('#model-thinking-protocol').addEventListener('change', levelsVisibility);
  $('#model-profile-form').addEventListener('submit', async event => {
    event.preventDefault(); const p = getProvider(), model = raw.value;
    if (!p || !model || saving || busy()) return;
    const protocol = $('#model-thinking-protocol').value;
    const thinking = protocol === 'inherit' ? null : { protocol,
      ...(['reasoning_effort', 'openrouter_reasoning'].includes(protocol) ? { levels: $('#model-thinking-levels').value.split(/[\s,]+/).filter(Boolean) } : {}) };
    saving = true; renderProfile();
    try {
      const updated = await api(`/api/providers/${encodeURIComponent(p.id)}/models`, 'PATCH', { model, nickname: $('#model-nickname').value, thinking });
      await onSaved(updated);
      if (getProvider()?.id === p.id && raw.value === model) { renderProfile(true); await load(false); }
      toast('Model nickname and support saved. The API model ID is unchanged.');
    } catch (error) { if (getProvider()?.id === p.id && raw.value === model) $('#model-profile-error').textContent = error.message; }
    finally { saving = false; render(); }
  });
  return { load, catalog, details, label, render, refresh() {
    select.disabled = busy() || !getProvider(); $('#picker-refresh-models').disabled = select.disabled; renderProfile();
  }, clear() { catalogs.clear(); requests.clear(); profileContext = ''; } };
}
