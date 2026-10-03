/** The app sync and selected model API are separate connections. No inference is used. */
export function installConnectionStatus() {
  const app = document.querySelector('#server-connection-status');
  const model = document.querySelector('#model-connection-status');
  const states = new Set(['connected', 'checking', 'error', 'unknown']);
  const catalogues = new Map();
  let selected = { providerId: '', model: '' };
  const pending = new Set();
  function write(element, state, message) {
    if (!element) return;
    element.dataset.state = states.has(state) ? state : 'unknown';
    element.title = message;
    const text = element.querySelector('[role="status"]');
    if (text && text.textContent !== message) text.textContent = message;
  }
  function renderModel() {
    if (!selected.providerId || !selected.model) {
      write(model, 'unknown', 'Model API: no model selected.'); return;
    }
    if (pending.has(selected.providerId)) {
      write(model, 'checking', 'Model API: checking the selected connection.'); return;
    }
    const result = catalogues.get(selected.providerId);
    if (!result) { write(model, 'unknown', 'Model API: not checked yet.'); return; }
    if (result.error) { write(model, 'error', `Model API: ${result.error}`); return; }
    if (result.reachable !== true || result.checkedAt && Date.now() - result.checkedAt > 60000) {
      const message = result.source === 'manual' ? 'using saved manual model IDs. Live availability is not verified.'
        : 'no fresh API check. Refresh the model list to check availability.';
      write(model, 'unknown', `Model API: ${message}`); return;
    }
    if (!result.models.includes(selected.model)) {
      write(model, 'error', 'Model API: the selected model is not listed by this connection.'); return;
    }
    write(model, 'connected', `Model API: reachable and the selected model is listed${result.checkedAt ? `, checked at ${new Date(result.checkedAt).toLocaleTimeString()}` : ''}. This is not an inference check.`);
  }
  return {
    sync(state, message) { write(app, state, `Common Chat server: ${message}`); },
    select(providerId, modelId) { selected = { providerId: providerId ?? '', model: modelId ?? '' }; renderModel(); },
    checking(providerId) { pending.add(providerId); renderModel(); },
    models(providerId, result) {
      pending.delete(providerId);
      catalogues.set(providerId, { models: result.models ?? [], reachable: result.reachable === true, error: result.error ?? null, checkedAt: result.checkedAt, source: result.source });
      renderModel();
    },
    error(providerId, message) { pending.delete(providerId); catalogues.set(providerId, { error: message }); renderModel(); },
    clear() { pending.clear(); catalogues.clear(); selected = { providerId: '', model: '' }; renderModel(); }
  };
}
