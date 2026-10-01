const languages = new Map([['html', 'html'], ['htm', 'html'], ['xml', 'html'], ['svg', 'html'], ['css', 'css'], ['js', 'js'], ['javascript', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['mermaid', 'mermaid']]);
// Never add allow-same-origin or allow-popups-to-escape-sandbox.
const sandbox = 'allow-scripts allow-forms allow-modals allow-downloads allow-popups';
let dialog, frame, channel, answer;
function createDialog() {
  if (dialog) return;
  dialog = document.createElement('dialog'); dialog.id = 'preview-dialog';
  dialog.innerHTML = `<div class="dialog-header"><h2>Code sandbox</h2><button type="button" data-preview-close>Close</button></div>
    <p class="small">HTML, CSS, and JavaScript run in an isolated browser frame, not on the server. The frame cannot read your chats, credentials, or host files. Do not enter secrets. Code can navigate the frame to websites. Enable external resources only if you trust the code to contact websites and devices on your network.</p>
    <div class="preview-editors"><label class="field">HTML<textarea data-preview-html rows="6" spellcheck="false"></textarea></label><label class="field">CSS<textarea data-preview-css rows="4" spellcheck="false"></textarea></label><label class="field">JavaScript<textarea data-preview-js rows="6" spellcheck="false"></textarea></label></div>
    <label class="field">Mermaid (optional)<textarea data-preview-mermaid rows="5" spellcheck="false"></textarea></label>
    <div class="preview-controls"><button type="button" data-preview-combine>Load code blocks from this answer</button><label class="check"><input type="checkbox" data-preview-external>Allow external scripts, styles, images, and requests</label><label class="check"><input type="checkbox" data-preview-module>JavaScript is an ES module</label><button type="button" class="primary" data-preview-run>Run / Restart</button><button type="button" data-preview-stop>Stop</button></div>
    <p class="render-note" data-preview-status>Review the source, then choose Run.</p><div data-preview-output></div><details open><summary>Console</summary><pre class="preview-console" data-preview-console></pre></details>`;
  document.body.append(dialog);
  dialog.querySelector('[data-preview-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stopPreview);
  dialog.querySelector('[data-preview-stop]').addEventListener('click', stopPreview);
  dialog.querySelector('[data-preview-run]').addEventListener('click', runPreview);
  dialog.querySelector('[data-preview-combine]').addEventListener('click', () => loadBlocks(answer));
}
const field = name => dialog.querySelector(`[data-preview-${name}]`);
function loadBlocks(blocks) {
  const parts = { html: [], css: [], js: [], mermaid: [] };
  for (const block of blocks ?? []) {
    const name = languages.get(block.dataset.codeLanguage), code = block.querySelector('pre code');
    if (name && code) parts[name].push(code.textContent ?? '');
  }
  for (const name of ['html', 'css', 'js']) field(name).value = parts[name].join('\n\n');
  field('mermaid').value = parts.mermaid[0] ?? '';
  field('status').textContent = parts.mermaid.length > 1 ? 'First Mermaid block loaded. Preview other diagrams separately.' : 'Source loaded. Review it, then choose Run.';
}
export function installPreviews(root) {
  for (const block of root.querySelectorAll('[data-code-complete="true"][data-code-language]')) {
    if (!languages.has(block.dataset.codeLanguage) || block.querySelector('[data-code-preview]')) continue;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.codePreview = ''; button.textContent = 'Preview / Run';
    button.addEventListener('click', () => {
      createDialog(); stopPreview();
      answer = [...block.closest('.message-body').querySelectorAll('[data-code-complete="true"][data-code-language]')];
      loadBlocks([block]); field('external').checked = false; field('module').checked = block.dataset.codeLanguage === 'mjs';
      field('console').textContent = ''; dialog.showModal();
    });
    block.querySelector('.code-toolbar').append(button);
  }
}
export function stopPreview() {
  channel?.port1.close(); channel?.port2.close(); channel = null;
  frame?.remove(); frame = null;
  if (dialog) field('status').textContent = 'Preview stopped. Source edits are retained until you close or switch chats.';
}
export function cancelPreviews() { stopPreview(); if (dialog?.open) dialog.close(); answer = null; }
function runPreview() {
  stopPreview();
  const payload = { type: 'common-chat-preview', html: field('html').value, css: field('css').value, js: field('js').value, mermaid: field('mermaid').value, module: field('module').checked };
  if (['html', 'css', 'js', 'mermaid'].some(name => payload[name].length > 128 * 1024)) { field('status').textContent = 'Each source field must fit the 128 Ki-character message limit.'; return; }
  field('console').textContent = '';
  field('status').textContent = 'Running. Stop removes the frame. A busy loop can require closing the browser tab.';
  const currentFrame = document.createElement('iframe');
  currentFrame.className = 'code-preview-frame'; currentFrame.title = 'Isolated code preview';
  currentFrame.setAttribute('sandbox', sandbox); currentFrame.setAttribute('referrerpolicy', 'no-referrer');
  // Chromium supports this additional defense. Isolation does not depend on it.
  currentFrame.setAttribute('credentialless', '');
  currentFrame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  const currentChannel = new MessageChannel(); channel = currentChannel; frame = currentFrame;
  let entries = 0, bytes = 0;
  currentChannel.port1.onmessage = event => {
    if (frame !== currentFrame || channel !== currentChannel) return;
    const { level, text } = event.data ?? {};
    if (!['log', 'info', 'warn', 'error', 'debug', 'status'].includes(level) || typeof text !== 'string' || entries >= 100 || bytes >= 20000) return;
    const line = `[${level}] ${text.slice(0, Math.min(2000, 20000 - bytes))}\n`;
    entries++; bytes += line.length; field('console').append(document.createTextNode(line));
  };
  currentFrame.addEventListener('load', () => {
    if (frame !== currentFrame) return;
    // The receiver has an opaque origin. Send only the selected source, once,
    // over a dedicated channel. No preview message can request a chat action.
    currentFrame.contentWindow.postMessage(payload, '*', [currentChannel.port2]);
  }, { once: true });
  currentFrame.src = `/sandbox?external=${field('external').checked ? '1' : '0'}`;
  field('output').append(currentFrame);
}
