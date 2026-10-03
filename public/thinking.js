const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const labels = { on: 'On', off: 'Off', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
const $ = selector => document.querySelector(selector);
export function thinkingOptions(provider) {
  const caps = provider?.capabilities;
  if (caps?.thinking === 'llama_cpp') return ['on', 'off'];
  if (caps?.thinking === 'reasoning_effort') return [...new Set((caps.thinkingLevels ?? []).filter(level => effortLevels.includes(level)))];
  return [];
}
export function readThinkingCapabilities() {
  const thinking = $('#cap-thinking')?.value ?? 'none';
  return { thinking, ...(thinking === 'reasoning_effort' ? { thinkingLevels: ($('#cap-thinking-levels')?.value ?? '').split(/[\s,]+/).filter(Boolean) } : {}) };
}
export function writeThinkingCapabilities(capabilities = {}) {
  if ($('#cap-thinking')) $('#cap-thinking').value = capabilities.thinking ?? 'none';
  if ($('#cap-thinking-levels')) $('#cap-thinking-levels').value = (capabilities.thinkingLevels ?? []).join(', ');
  if ($('#thinking-levels-field')) $('#thinking-levels-field').hidden = capabilities.thinking !== 'reasoning_effort';
}
export function writeThinkingSetting(settings = {}) {
  if ($('#thinking-level')) $('#thinking-level').value = settings.thinking ?? '';
}

/** Capability declarations are explicit. Model names and returned reasoning do not enable controls. */
export function installThinkingControls({ getProvider, getSettings, onChange, busy, toast }) {
  const form = $('#connection-form');
  if (form && !$('#thinking-capabilities')) {
    const fieldset = document.createElement('fieldset'); fieldset.id = 'thinking-capabilities';
    fieldset.innerHTML = '<legend>Thinking</legend><label class="field">Protocol<select id="cap-thinking"><option value="none">Not configured</option><option value="llama_cpp">llama.cpp on/off</option><option value="reasoning_effort">OpenAI reasoning effort</option></select></label><label class="field" id="thinking-levels-field" hidden>Supported effort levels<input id="cap-thinking-levels" placeholder="low, medium, high" autocomplete="off"><small>Use only values supported by every model on this connection: none, minimal, low, medium, high, xhigh, max.</small></label><p class="small">Enable only for a compatible endpoint and model. Use separate connections for different capability sets. The provider default sends no thinking override. Audio input does not enable thinking or dictation.</p>';
    const before = form.querySelector('#token-parameter')?.closest('label') ?? form.querySelector('#connection-error');
    form.insertBefore(fieldset, before);
    $('#cap-thinking').addEventListener('change', () => { $('#thinking-levels-field').hidden = $('#cap-thinking').value !== 'reasoning_effort'; });
  }
  const button = $('#thinking-button');
  const menu = document.createElement('div'); menu.id = 'thinking-menu'; menu.className = 'composer-popover thinking-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Thinking level');
  button?.parentElement.append(menu);
  let optionsKey = '', changing = false;
  function close() { menu.hidden = true; button?.setAttribute('aria-expanded', 'false'); }
  function refresh() {
    const options = thinkingOptions(getProvider()), current = getSettings()?.thinking ?? '';
    if (!button) return;
    button.hidden = !options.length;
    button.disabled = changing || busy();
    button.title = `Thinking: ${current ? labels[current] ?? 'unsupported saved level' : 'Provider default'}`;
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', String(!menu.hidden));
    const field = $('#thinking-field'), select = $('#thinking-level');
    if (field) field.hidden = !options.length;
    const key = JSON.stringify([getProvider()?.id, options]);
    if (select && key !== optionsKey) {
      const old = select.value;
      select.replaceChildren(...['', ...options].map(level => {
        const item = document.createElement('option'); item.value = level; item.textContent = level ? labels[level] : 'Provider default'; return item;
      }));
      select.value = options.includes(old) ? old : options.includes(current) ? current : '';
      optionsKey = key;
    }
    menu.replaceChildren(...['', ...options].map(level => {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'ghost'; item.dataset.thinking = level;
      item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(level === current));
      item.textContent = level ? labels[level] : 'Provider default'; return item;
    }));
    if (!options.length || changing || busy()) close();
  }
  button?.addEventListener('click', () => {
    if (button.disabled || button.hidden) return;
    const opening = menu.hidden; close();
    if (opening) { refresh(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); menu.querySelector('[aria-checked="true"]')?.focus(); }
  });
  menu.addEventListener('click', async event => {
    const item = event.target.closest('[data-thinking]');
    if (!item || changing || busy() || !['', ...thinkingOptions(getProvider())].includes(item.dataset.thinking)) return;
    const value = item.dataset.thinking; close(); changing = true; refresh();
    try { await onChange(value); } catch (error) { toast(error.message); }
    finally { changing = false; refresh(); button.focus(); }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  });
  document.addEventListener('click', event => { if (!menu.contains(event.target) && !button?.contains(event.target)) close(); });
  document.addEventListener('focusin', event => { if (!menu.contains(event.target) && event.target !== button) close(); });
  refresh(); return { refresh, close };
}
