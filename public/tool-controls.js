import { escape as esc } from './markdown.js';

const empty = () => ({ workspace: false, execute: false, packages: false });

/** Permissions come from this tab's controls, never from model output. */
export function installToolControls({ getProvider, getConversation, busy }) {
  const saved = new Map();
  const panel = document.createElement('details'); panel.className = 'tool-controls';
  panel.innerHTML = '<summary>Model tools</summary><p class="small">Allow this model to change files or run code in this chat. Choices apply to this tab and reset after reload. Review generated files before use.</p><div class="checks"><label class="check"><input type="checkbox" data-permission="workspace">Read, search and edit workspace files</label><label class="check"><input type="checkbox" data-permission="execute">Run Python and shell in the isolated runner</label><label class="check"><input type="checkbox" data-permission="packages">Install or restore registry packages</label></div><p class="small tool-availability"></p>';
  document.querySelector('#composer').before(panel);
  const key = () => getConversation()?.id ?? 'new';
  let currentKey = key();
  const inputs = [...panel.querySelectorAll('input')];
  const enabled = () => getProvider()?.capabilities.tools === true;
  function read() { return enabled() ? { ...(saved.get(currentKey) ?? empty()) } : empty(); }
  function refresh() {
    currentKey = key();
    const choices = saved.get(currentKey) ?? empty();
    for (const input of inputs) { input.checked = choices[input.dataset.permission]; input.disabled = !enabled() || busy(); }
    panel.querySelector('.tool-availability').textContent = enabled()
      ? 'Execution requires the optional runner. Package access is registry-only. Code cannot access the host or general network.'
      : 'Enable function tools on a compatible model connection to use these controls. Files can still be edited manually.';
  }
  panel.addEventListener('change', () => { saved.set(currentKey, Object.fromEntries(inputs.map(input => [input.dataset.permission, input.checked]))); });
  refresh();
  return { read, refresh,
    created(cid) {
      // Only explicit creation can transfer the new-chat grant. Navigation cannot.
      if (saved.has('new')) { saved.set(cid, saved.get('new')); saved.delete('new'); }
      currentKey = cid;
    },
    clear() { saved.clear(); refresh(); }
  };
}

export function toolActivityHtml(message) {
  const activity = message.metadata?.toolActivity;
  if (!Array.isArray(activity) || !activity.length) return '';
  const files = (items = []) => items.slice(0, 32).map(file => {
    if (typeof file?.path !== 'string' || typeof file?.url !== 'string') return '';
    // Imported activity remains untrusted display data, not a navigation authority.
    let url;
    try { url = new URL(file.url, location.origin); } catch { return ''; }
    const cid = encodeURIComponent(message.conversationId);
    if (url.origin !== location.origin || url.pathname !== `/api/conversations/${cid}/workspace/download`) return '';
    const image = /^image\/(png|jpeg|webp|gif)$/.test(file.mime ?? '');
    return `<a class="file-link" href="${esc(url.pathname + url.search)}" download>${esc(file.path)}</a>${image ? '<span class="small">Preview in Files.</span>' : ''}`;
  }).join('');
  return `<section class="tool-activity" aria-label="Tool activity">${activity.slice(0, 16).map(item => `<details${item.status === 'running' ? ' open' : ''}><summary>${esc(String(item.name ?? 'Tool'))} · ${esc(String(item.status ?? 'archived'))}</summary><pre>${esc(String(item.summary ?? ''))}</pre>${files(Array.isArray(item.files) ? item.files : [])}</details>`).join('')}</section>`;
}
