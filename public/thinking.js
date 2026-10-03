const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const labels = { on: 'On', off: 'Off', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
const effortProtocols = ['reasoning_effort', 'openrouter_reasoning'];
const $ = selector => document.querySelector(selector);
export function modelThinkingCapabilities(provider, model, details = []) {
  const profile = provider?.modelConfig?.profiles?.find(profile => profile.id === model), caps = provider?.capabilities;
  let thinking;
  if (profile?.thinking) thinking = { ...profile.thinking, source: 'profile', levels: profile.thinking.levels ?? (profile.thinking.protocol === 'llama_cpp' ? ['on', 'off'] : []) };
  else if (caps?.thinking && caps.thinking !== 'none') thinking = { protocol: caps.thinking, levels: caps.thinking === 'llama_cpp' ? ['on', 'off'] : caps.thinkingLevels ?? [], source: 'connection' };
  else thinking = (Array.isArray(details) ? details.find(detail => detail.id === model) : details?.id === model ? details : null)?.thinking;
  const protocol = thinking?.protocol ?? 'unknown';
  const allowed = protocol === 'llama_cpp' ? ['on', 'off'] : effortProtocols.includes(protocol) ? effortLevels : [];
  return { protocol, levels: [...new Set((thinking?.levels ?? []).filter(level => allowed.includes(level)))], source: thinking?.source ?? 'unknown' };
}
export function thinkingOptions(provider, model, details) {
  return modelThinkingCapabilities(provider, model, details).levels;
}
export function readThinkingCapabilities() {
  const thinking = $('#cap-thinking')?.value ?? 'none';
  return { thinking, ...(effortProtocols.includes(thinking) ? { thinkingLevels: ($('#cap-thinking-levels')?.value ?? '').split(/[\s,]+/).filter(Boolean) } : {}) };
}
export function writeThinkingCapabilities(capabilities = {}) {
  if ($('#cap-thinking')) $('#cap-thinking').value = capabilities.thinking ?? 'none';
  if ($('#cap-thinking-levels')) $('#cap-thinking-levels').value = (capabilities.thinkingLevels ?? []).join(', ');
  if ($('#thinking-levels-field')) $('#thinking-levels-field').hidden = !effortProtocols.includes(capabilities.thinking);
}
export function writeThinkingSetting(settings = {}) {
  const select = $('#thinking-level'), current = settings.thinking ?? '';
  if (!select) return;
  if (current && ![...select.options].some(option => option.value === current)) {
    const option = document.createElement('option'); option.value = current;
    option.textContent = `Unsupported saved level: ${labels[current] ?? current}`; option.disabled = true; select.append(option);
  }
  select.value = current;
}

/** Capability declarations are explicit. Model names and returned reasoning do not enable controls. */
export function installThinkingControls({ getProvider, getModel = () => '', getDetails = () => [], getSettings, onChange, busy, toast }) {
  const form = $('#connection-form');
  if (form && !$('#thinking-capabilities')) {
    const fieldset = document.createElement('fieldset'); fieldset.id = 'thinking-capabilities';
    fieldset.innerHTML = '<legend>Thinking</legend><label class="field">Protocol<select id="cap-thinking"><option value="none">Not configured</option><option value="llama_cpp">llama.cpp on/off</option><option value="reasoning_effort">OpenAI reasoning effort</option><option value="openrouter_reasoning">OpenRouter reasoning effort</option></select></label><label class="field" id="thinking-levels-field" hidden>Supported effort levels<input id="cap-thinking-levels" placeholder="low, medium, high" autocomplete="off"><small>Use only values supported by every model on this connection: none, minimal, low, medium, high, xhigh, max.</small></label><p class="small">Enable only for a compatible endpoint and model. Use separate connections for different capability sets. The provider default sends no thinking override. Audio input does not enable thinking or dictation.</p>';
    const before = form.querySelector('#token-parameter')?.closest('label') ?? form.querySelector('#connection-error');
    form.insertBefore(fieldset, before);
    $('#cap-thinking').addEventListener('change', () => { $('#thinking-levels-field').hidden = !effortProtocols.includes($('#cap-thinking').value); });
  }
  const button = $('#thinking-button');
  const menu = document.createElement('div'); menu.id = 'thinking-menu'; menu.className = 'composer-popover thinking-menu'; menu.hidden = true;
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Thinking level');
  button?.parentElement.append(menu);
  let optionsKey = '', menuKey = '', changing = false;
  function close() { menu.hidden = true; button?.setAttribute('aria-expanded', 'false'); }
  function refresh() {
    const provider = getProvider(), model = getModel(), thinking = modelThinkingCapabilities(provider, model, getDetails());
    const options = thinking.levels, current = getSettings()?.thinking ?? '';
    if (!button) return;
    button.hidden = !options.length && !current && !model;
    button.disabled = changing || busy();
    button.title = `Thinking: ${current ? labels[current] ?? 'unsupported saved level' : 'Provider default'}${current && !options.includes(current) ? ' (unsupported for this model)' : thinking.protocol === 'unknown' ? ' (support unknown)' : ''}`;
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', String(!menu.hidden));
    const field = $('#thinking-field'), select = $('#thinking-level');
    if (field) field.hidden = !options.length && !current && !model;
    const key = JSON.stringify([provider?.id, model, thinking.protocol, options, current]);
    if (select && key !== optionsKey) {
      select.replaceChildren(...['', ...options].map(level => {
        const item = document.createElement('option'); item.value = level; item.textContent = level ? labels[level] : 'Provider default'; return item;
      }));
      // Keep incompatible history visible until the user explicitly chooses a new level.
      writeThinkingSetting({ thinking: current });
      optionsKey = key;
    }
    if (key !== menuKey) {
      menu.replaceChildren(...['', ...options].map(level => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'ghost'; item.dataset.thinking = level;
        item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(level === current));
        item.textContent = level ? labels[level] : 'Provider default'; return item;
      }));
      menuKey = key;
    }
    if (button.hidden || changing || busy()) close();
  }
  button?.addEventListener('click', () => {
    if (button.disabled || button.hidden) return;
    const opening = menu.hidden; close();
    if (opening) { refresh(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector('button'))?.focus(); }
  });
  menu.addEventListener('click', async event => {
    const item = event.target.closest('[data-thinking]');
    if (!item || changing || busy() || !['', ...thinkingOptions(getProvider(), getModel(), getDetails())].includes(item.dataset.thinking)) return;
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
