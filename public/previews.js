const languages = new Map([['html', 'html'], ['htm', 'html'], ['xml', 'html'], ['svg', 'html'], ['css', 'css'], ['js', 'js'], ['javascript', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['mermaid', 'mermaid']]);
// Never add same-origin, top-navigation, storage-access, or popup escape rights.
const manualSandbox = 'allow-scripts allow-forms allow-modals allow-downloads allow-popups';
const inlineStates = new WeakMap(), groupOwners = new WeakMap(), activeInline = new Set();
let dialog, manualSession, answer;
function createDialog() {
  if (dialog) return;
  dialog = document.createElement('dialog'); dialog.id = 'preview-dialog';
  dialog.innerHTML = `<div class="dialog-header"><h2>Code sandbox</h2><button type="button" data-preview-close>Close</button></div>
    <p class="small">HTML, CSS, and JavaScript run in an isolated browser frame, not on the server. The frame cannot read your chats, credentials, or host files. Do not enter secrets. Code can navigate the frame to websites. Enable external resources only if you trust the code to contact websites and devices on your network.</p>
    <div class="preview-editors"><label class="field">HTML<textarea data-preview-html rows="6" spellcheck="false"></textarea></label><label class="field">CSS<textarea data-preview-css rows="4" spellcheck="false"></textarea></label><label class="field">JavaScript<textarea data-preview-js rows="6" spellcheck="false"></textarea></label></div>
    <label class="field">Mermaid (optional)<textarea data-preview-mermaid rows="5" spellcheck="false"></textarea></label>
    <div class="preview-controls"><button type="button" data-preview-combine>Load code blocks from this answer</button><label class="check"><input type="checkbox" data-preview-external>Allow external scripts, styles, images, and requests</label><label class="check"><input type="checkbox" data-preview-module>JavaScript is an ES module</label><button type="button" class="primary" data-preview-run>Run / Restart</button><button type="button" data-preview-stop>Stop</button></div>
    <p class="render-note" data-preview-status>Review the source, then choose Run.</p><div data-preview-output></div><details><summary>Console</summary><pre class="preview-console" data-preview-console></pre></details>`;
  document.body.append(dialog);
  dialog.querySelector('[data-preview-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stopPreview);
  dialog.querySelector('[data-preview-stop]').addEventListener('click', stopPreview);
  dialog.querySelector('[data-preview-run]').addEventListener('click', runPreview);
  dialog.querySelector('[data-preview-combine]').addEventListener('click', () => loadBlocks(answer));
}
const field = name => dialog.querySelector(`[data-preview-${name}]`);
function payloadFor(blocks) {
  const parts = { html: [], css: [], js: [], mermaid: [] };
  for (const block of blocks ?? []) {
    const name = languages.get(block.dataset.codeLanguage), code = block.querySelector('pre code');
    if (name && code) parts[name].push(code.textContent ?? '');
  }
  return { type: 'common-chat-preview', html: parts.html.join('\n\n'), css: parts.css.join('\n\n'), js: parts.js.join('\n\n'), mermaid: parts.mermaid[0] ?? '', module: blocks?.some(block => block.dataset.codeLanguage === 'mjs') ?? false };
}
function loadBlocks(blocks) {
  const payload = payloadFor(blocks);
  for (const name of ['html', 'css', 'js', 'mermaid']) field(name).value = payload[name];
  field('module').checked = payload.module;
  field('status').textContent = (blocks ?? []).filter(block => block.dataset.codeLanguage === 'mermaid').length > 1 ? 'First Mermaid block loaded. Preview other diagrams separately.' : 'Source loaded. Review it, then choose Run.';
}
function openPreview(block, blocks) {
  createDialog(); stopPreview();
  answer = [...(block.closest('.message-body') ?? block.parentElement).querySelectorAll('[data-code-complete="true"][data-code-language]')];
  loadBlocks(blocks); field('external').checked = false;
  field('console').textContent = ''; field('console').closest('details').open = false; field('status').classList.remove('artifact-error'); dialog.showModal();
}

// A CSS/JS neighbor belongs to the nearest HTML artifact without crossing an
// unrelated code example or another artifact. Each script runs in one frame.
export function artifactGroups(records) {
  const html = records.map((record, index) => record.view === 'artifact' && languages.get(record.name) === 'html' ? index : -1).filter(index => index >= 0);
  const owners = new Map();
  const sibling = record => ['css', 'js'].includes(languages.get(record.name)) && record.intent !== 'example';
  for (let index = 0; index < records.length; index++) {
    if (!sibling(records[index])) continue;
    const candidates = html.filter(anchor => records.slice(Math.min(anchor, index) + 1, Math.max(anchor, index)).every(sibling));
    candidates.sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || a - b);
    if (candidates.length) owners.set(index, candidates[0]);
  }
  return records.flatMap((record, index) => record.view !== 'artifact' || owners.has(index) ? [] : [{ index, members: records.map((_, i) => i).filter(i => i === index || owners.get(i) === index) }]);
}
function sourceDetails(block) {
  let details = block.querySelector('details.artifact-source');
  if (!details) {
    details = document.createElement('details'); details.className = 'artifact-source';
    const summary = document.createElement('summary'); summary.textContent = 'Show code'; details.append(summary);
    const source = block.querySelector('pre'); if (source) details.append(source);
    block.append(details);
  }
  details.open = false;
  return details;
}
function artifactToolbar(block) {
  const toolbar = block.querySelector('.code-toolbar'); toolbar.classList.add('artifact-toolbar');
  const copy = toolbar.querySelector('[data-code-copy]');
  if (copy) { copy.textContent = 'Copy'; copy.title = 'Copy code'; copy.setAttribute('aria-label', 'Copy code'); }
  let actions = toolbar.querySelector('.artifact-actions');
  if (!actions) {
    actions = document.createElement('details'); actions.className = 'artifact-actions';
    const summary = document.createElement('summary'); summary.textContent = 'Actions'; summary.setAttribute('aria-label', 'Preview actions');
    const panel = document.createElement('div'); panel.className = 'artifact-actions-panel';
    actions.append(summary, panel); toolbar.append(actions);
    panel.addEventListener('click', event => { if (event.target.closest('button')) { actions.open = false; if (!dialog?.open) summary.focus(); } });
    actions.addEventListener('keydown', event => { if (event.key === 'Escape') { actions.open = false; summary.focus(); } });
  }
  return actions.querySelector('.artifact-actions-panel');
}
function setViewLabel(toggle, result) {
  toggle.textContent = result ? 'Source' : 'Result';
  toggle.title = result ? 'Show as code' : 'Show result'; toggle.setAttribute('aria-label', toggle.title);
}
function createSession(output, consoleOutput, status, payload, automatic, external = false) {
  if (['html', 'css', 'js', 'mermaid'].some(name => payload[name].length > 128 * 1024)) {
    status.hidden = false; status.classList.add('artifact-error');
    status.textContent = 'Each combined source field must fit the 128 Ki-character message limit. Show code or open the sandbox to edit it.';
    return null;
  }
  const diagramOnly = Boolean(payload.mermaid && !payload.html && !payload.css && !payload.js);
  const frame = document.createElement('iframe'); frame.className = `code-preview-frame${diagramOnly ? ' mermaid-preview-frame' : ''}`; frame.title = diagramOnly ? 'Isolated Mermaid diagram' : 'Isolated code preview';
  frame.setAttribute('sandbox', automatic ? 'allow-scripts' : manualSandbox);
  frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('credentialless', ''); frame.loading = 'lazy';
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  const channel = new MessageChannel(); let active = true, entries = 0, bytes = 0, layouts = 0;
  channel.port1.onmessage = event => {
    if (!active || !frame.isConnected) return;
    const data = event.data;
    if (data?.type === 'common-chat-mermaid-layout') {
      // Only a diagram-only payload can size its own frame. No parent commands.
      if (!diagramOnly || layouts >= 16 || !data || Array.isArray(data) || Object.keys(data).length !== 2 || typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height <= 0) return;
      layouts++; frame.style.height = `${Math.round(Math.max(96, Math.min(800, data.height)))}px`;
      return;
    }
    const { level, text } = data ?? {};
    if (!['log', 'info', 'warn', 'error', 'debug', 'status'].includes(level) || typeof text !== 'string' || entries >= 100 || bytes >= 20000) return;
    const line = `[${level}] ${text.slice(0, Math.min(2000, 20000 - bytes))}\n`;
    entries++; bytes += line.length; consoleOutput.append(document.createTextNode(line));
    if (level === 'error') {
      const logs = consoleOutput.closest('details'); logs.hidden = false; logs.open = true;
      status.hidden = false; status.classList.add('artifact-error');
      status.textContent = 'Preview reported an error. Show code or open the sandbox to correct it.';
    }
  };
  frame.addEventListener('load', () => {
    if (!active || !frame.isConnected) return;
    // The opaque receiver gets source once. Replies contain bounded console text
    // or diagram-only layout data. No message can invoke chat APIs or parent actions.
    frame.contentWindow.postMessage({ ...payload, dark: document.documentElement.classList.contains('dark') }, '*', [channel.port2]);
  }, { once: true });
  frame.src = `/sandbox?automatic=${automatic ? '1' : '0'}&external=${external ? '1' : '0'}`;
  // Theme messages travel only to the sandbox. They do not accept parent actions.
  const themeObserver = payload.mermaid ? new MutationObserver(() => {
    if (active) channel.port1.postMessage({ type: 'common-chat-theme', dark: document.documentElement.classList.contains('dark') });
  }) : null;
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  output.append(frame); status.textContent = automatic ? 'Running in an isolated sandbox. External resources are off.' : 'Running. Stop removes the frame. A busy loop can require closing the browser tab.';
  status.hidden = automatic; status.classList.remove('artifact-error');
  return { close() { active = false; themeObserver?.disconnect(); channel.port1.close(); channel.port2.close(); frame.remove(); } };
}
function installArtifact(block, members) {
  if (inlineStates.has(block)) return inlineStates.get(block);
  block.classList.add('inline-artifact');
  const details = sourceDetails(block), actions = artifactToolbar(block);
  for (const member of members) {
    member.removeAttribute('data-diagram-source');
    if (member === block) continue;
    sourceDetails(member); member.dataset.artifactSibling = 'true';
    const source = document.createElement('div'); source.className = 'code-block artifact-group-source';
    const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar artifact-toolbar';
    const label = document.createElement('span'); label.textContent = member.dataset.codeLanguage;
    const copy = document.createElement('button'); copy.type = 'button'; copy.dataset.codeCopy = ''; copy.textContent = 'Copy'; copy.setAttribute('aria-label', `Copy ${member.dataset.codeLanguage} code`);
    toolbar.append(label, copy); source.append(toolbar, member.querySelector('pre').cloneNode(true)); details.append(source);
  }
  const output = document.createElement('div'); output.className = 'artifact-output';
  const status = document.createElement('p'); status.className = 'render-note artifact-status'; status.textContent = 'Preview starts when visible.'; status.hidden = true;
  const logs = document.createElement('details'); logs.className = 'artifact-console';
  logs.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = 'Console';
  const consoleOutput = document.createElement('pre'); consoleOutput.className = 'preview-console'; logs.append(summary, consoleOutput);
  block.insertBefore(output, details); block.insertBefore(status, details); block.insertBefore(logs, details);
  const stop = document.createElement('button'), restart = document.createElement('button');
  stop.type = restart.type = 'button'; stop.textContent = 'Stop'; restart.textContent = 'Restart';
  stop.dataset.artifactStop = ''; restart.dataset.artifactRestart = '';
  const consoleButton = document.createElement('button'); consoleButton.type = 'button'; consoleButton.textContent = 'Console';
  consoleButton.addEventListener('click', () => { logs.hidden = !logs.hidden; logs.open = !logs.hidden; });
  const safety = document.createElement('details'); safety.className = 'artifact-safety';
  const safetyLabel = document.createElement('summary'); safetyLabel.textContent = 'Sandbox information';
  const safetyText = document.createElement('p'); safetyText.textContent = 'Isolated browser frame. External resources are off. Do not enter secrets. Code can navigate its frame. A busy loop can require closing the browser tab.';
  safety.append(safetyLabel, safetyText); actions.append(stop, restart, consoleButton, safety);
  const state = {
    block, observer: null, session: null, started: false, paused: false, hidden: false,
    close() { this.paused = true; this.started = true; this.observer?.disconnect(); this.session?.close(); stop.disabled = true; status.hidden = false; status.classList.remove('artifact-error'); status.textContent = 'Preview stopped. Use Actions to restart.'; },
    restart() { this.close(); activeInline.add(this); this.paused = false; this.started = false; stop.disabled = false; consoleOutput.textContent = ''; logs.hidden = true; logs.open = false; status.hidden = true; status.textContent = 'Preview starts when visible.'; schedule(); },
    hide() { this.close(); this.hidden = true; block.dataset.codeDisplay = 'source'; output.hidden = status.hidden = logs.hidden = stop.hidden = restart.hidden = consoleButton.hidden = true; details.open = true; const toggle = block.querySelector('[data-code-view-toggle]'); if (toggle) setViewLabel(toggle, false); },
    show() { output.hidden = stop.hidden = restart.hidden = consoleButton.hidden = false; details.open = false; if (this.paused) this.restart(); this.hidden = false; block.dataset.codeDisplay = 'artifact'; const toggle = block.querySelector('[data-code-view-toggle]'); if (toggle) setViewLabel(toggle, true); },
  };
  stop.addEventListener('click', () => state.close());
  restart.addEventListener('click', () => { state.restart(); state.show(); });
  inlineStates.set(block, state); activeInline.add(state);
  const start = () => {
    if (state.started || !block.isConnected) return;
    state.started = true; state.observer?.disconnect();
    state.session = createSession(output, consoleOutput, status, payloadFor(members), true);
  };
  function schedule() {
    if (typeof IntersectionObserver === 'function') {
      state.observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) start(); });
      state.observer.observe(block);
    } else start(); // Native iframe lazy loading remains the fallback.
  }
  schedule();
  return state;
}
export function installPreviews(root) {
  for (const state of activeInline) if (!state.block.isConnected) { state.close(); activeInline.delete(state); }
  const blocks = [...root.querySelectorAll('[data-code-complete="true"][data-code-language]')];
  const bodies = new Set(blocks.map(block => block.closest('.message-body') ?? root));
  for (const body of bodies) {
    const bodyBlocks = blocks.filter(block => (block.closest('.message-body') ?? root) === body);
    const records = bodyBlocks.map(block => ({ name: block.dataset.codeLanguage, view: block.dataset.codeView, intent: block.dataset.codeIntent }));
    const membersFor = new Map();
    for (const group of artifactGroups(records)) {
      const members = group.members.map(index => bodyBlocks[index]);
      for (const member of members) { membersFor.set(member, members); groupOwners.set(member, bodyBlocks[group.index]); }
      installArtifact(bodyBlocks[group.index], members);
    }
    for (const block of bodyBlocks) {
      if (block.dataset.codeLanguage === 'mermaid') block.removeAttribute('data-diagram-source');
      if (!languages.has(block.dataset.codeLanguage) || block.dataset.previewInstalled === 'true') continue;
      block.dataset.previewInstalled = 'true';
      const button = document.createElement('button'); button.type = 'button'; button.dataset.codePreview = '';
      button.textContent = membersFor.has(block) ? 'Open sandbox' : 'Preview / Run';
      button.addEventListener('click', () => openPreview(block, membersFor.get(block) ?? [block]));
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.codeViewToggle = '';
      const defaultResult = block.dataset.codeView === 'artifact' || block.dataset.artifactSibling === 'true';
      setViewLabel(toggle, defaultResult);
      toggle.addEventListener('click', () => {
        const result = !(block.dataset.codeDisplay ? block.dataset.codeDisplay === 'artifact' : defaultResult);
        block.dataset.codeDisplay = result ? 'artifact' : 'source';
        if (result) {
          const state = inlineStates.get(block) ?? inlineStates.get(groupOwners.get(block)) ?? installArtifact(block, [block]);
          sourceDetails(block); state.show();
          if (state.block !== block) state.block.scrollIntoView({ block: 'nearest' });
        } else {
          inlineStates.get(block)?.hide(); sourceDetails(block).open = true;
        }
        setViewLabel(toggle, result);
      });
      const actions = artifactToolbar(block); actions.prepend(button);
      block.querySelector('.code-toolbar').insertBefore(toggle, actions.parentElement);
    }
  }
}
export function stopPreview() {
  manualSession?.close(); manualSession = null;
  if (dialog) field('status').textContent = 'Preview stopped. Source edits are retained until you close or switch chats.';
}
export function cancelPreviews() {
  stopPreview(); if (dialog?.open) dialog.close(); answer = null;
  for (const state of activeInline) state.close();
  activeInline.clear();
}
function runPreview() {
  stopPreview();
  const payload = { type: 'common-chat-preview', html: field('html').value, css: field('css').value, js: field('js').value, mermaid: field('mermaid').value, module: field('module').checked };
  field('console').textContent = ''; field('console').closest('details').open = false;
  manualSession = createSession(field('output'), field('console'), field('status'), payload, false, field('external').checked);
}
