import { modelLabel, catalogMessage } from './model-controls.js';
const $ = selector => document.querySelector(selector);
const option = (id, name) => { const node = document.createElement('option'); node.value = id; node.textContent = name; return node; };
/** Transcription selection is independent of the chat model. */
export function installDictationSettings({ api, catalog, getProviders, getSelection, onSaved, openConnections, toast }) {
  let request = 0, saving = false;
  function controls(loading = false) {
    $('#dictation-save').disabled = saving || loading || !$('#dictation-provider').value || !$('#dictation-model').value;
    $('#dictation-refresh-models').disabled = saving || loading || !$('#dictation-provider').value;
    $('#dictation-disable').disabled = saving;
  }
  async function load(refresh = false, retained = '') {
    const pid = $('#dictation-provider').value, ticket = ++request;
    $('#dictation-model').replaceChildren(option('', pid ? 'Loading models...' : 'Select a connection first'));
    $('#dictation-model-status').textContent = ''; controls(!!pid);
    if (!pid) return;
    try {
      const result = await catalog(pid, { refresh });
      if (ticket !== request || $('#dictation-provider').value !== pid) return;
      const nodes = [option('', 'Select a speech-to-text model')];
      for (const id of result.models) {
        const label = modelLabel(result.details?.find(item => item.id === id), id);
        nodes.push(option(id, label === id ? id : `${label} (${id})`));
      }
      if (retained && !result.models.includes(retained)) nodes.push(option(retained, `${retained} (saved, not in current list)`));
      $('#dictation-model').replaceChildren(...nodes); $('#dictation-model').value = retained;
      $('#dictation-model-status').textContent = catalogMessage(result);
    } catch (error) {
      if (ticket !== request || $('#dictation-provider').value !== pid) return;
      $('#dictation-model').replaceChildren(option('', 'Model discovery failed'), ...(retained ? [option(retained, `${retained} (saved, not verified)`)] : []));
      $('#dictation-model').value = retained; $('#dictation-model-status').textContent = error.message;
    } finally { if (ticket === request) controls(); }
  }
  function fill() {
    const selection = getSelection();
    $('#dictation-provider').replaceChildren(option('', 'Not configured'), ...getProviders().map(p => option(p.id, p.name)));
    $('#dictation-provider').value = selection?.providerId ?? '';
    $('#dictation-settings-error').textContent = '';
    load(false, selection?.model ?? '');
  }
  async function save(dictation) {
    if (saving) return; saving = true; controls(); $('#dictation-settings-error').textContent = '';
    try { await onSaved(await api('/api/preferences', 'PUT', { dictation })); toast(dictation ? 'Dictation service saved. Audio is sent only when you click Transcribe.' : 'Dictation disabled.'); }
    catch (error) { $('#dictation-settings-error').textContent = error.message; }
    finally { saving = false; controls(); }
  }
  $('#dictation-provider').addEventListener('change', () => load());
  $('#dictation-model').addEventListener('change', () => controls());
  $('#dictation-refresh-models').addEventListener('click', () => load(true, $('#dictation-model').value));
  $('#dictation-connections').addEventListener('click', openConnections);
  $('#dictation-disable').addEventListener('click', () => save(null));
  $('#dictation-settings-form').addEventListener('submit', event => {
    event.preventDefault(); if ($('#dictation-save').disabled) return;
    save({ providerId: $('#dictation-provider').value, model: $('#dictation-model').value });
  });
  return { fill };
}
