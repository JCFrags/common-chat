import { markdown } from './markdown.js';
import { filePresentation, presentationIcon } from './tool-presentation.js';

const MiB = 1024 * 1024;
const PREVIEW_CHARS = 128 * 1024, CONSOLE_CHARS = 64 * 1024, PASSAGES_PER_PAGE = 25;
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const activeStatuses = new Set(['queued', 'pending', 'starting', 'running', 'cancelling', 'canceling']);
const terminalStatuses = new Set(['complete', 'error', 'cancelled', 'timed_out', 'interrupted']);
const node = (tag, className = '', text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
function iconAction(element, label, icon) {
  element.innerHTML = presentationIcon(icon);
  element.classList.add('ghost', 'workspace-icon-button');
  element.title = label; element.setAttribute('aria-label', label);
}
const bytesLabel = bytes => Number.isFinite(bytes) ? bytes < 1024 ? `${bytes} B` : bytes < MiB ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / MiB).toFixed(1)} MiB` : 'Size unavailable';
const revisionLabel = file => Number.isSafeInteger(file?.version) ? `Revision ${file.version}` : `Revision ${String(file?.revision ?? '').slice(0, 8)}`;
const dateLabel = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : ''; };
const utf8Size = value => new TextEncoder().encode(value).length;
function metadata(value) {
  if (!value || typeof value.path !== 'string' || typeof value.revision !== 'string' || !value.revision) throw new Error('The server returned invalid workspace file metadata. Refresh before making changes.');
  return value;
}
function readResult(value) {
  metadata(value?.file);
  if (typeof value.text !== 'string' && typeof value.data !== 'string') throw new Error('The server did not return file content. Your draft is unchanged.');
  return value;
}
function citationText(file, passage = {}) {
  if (typeof passage.citation?.id === 'string') return passage.citation.id;
  const location = new URLSearchParams();
  for (const key of ['page', 'paragraph', 'part']) if (Number.isSafeInteger(passage[key]) && passage[key] > 0) location.set(key, passage[key]);
  return `workspace:${encodeURIComponent(file.path)}@${file.revision}${location.size ? `#${location}` : ''}`;
}
function locationLabel(passage = {}) {
  const parts = [];
  for (const key of ['page', 'paragraph', 'part']) if (Number.isSafeInteger(passage[key]) && passage[key] > 0) parts.push(`${key} ${passage[key]}`);
  return parts.join(', ');
}
function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

/** Install once after the app DOM exists. Drafts remain in this page, not storage. */
export function installWorkspace({ api, getConversation, ensureConversation, onChanged = () => {}, toast = () => {} }) {
  const launchTarget = document.querySelector('#workspace-slot') ?? document.querySelector('#topbar .toolbar');
  if (!launchTarget) throw new Error('The workspace needs the sidebar workspace slot or topbar toolbar.');
  if (document.getElementById('workspace-dialog')) throw new Error('The workspace is already installed.');
  const sessions = new Map(), previewUrls = new Set();
  const releasePreview = () => { for (const url of previewUrls) URL.revokeObjectURL(url); previewUrls.clear(); };
  let current = null, opening = false, counter = 0, activeSection = 'files', runtime = null, runtimeError = '', runtimeRequest = null, pollTimer, pollRequest = null;
  const launch = node('button', 'ghost workspace-launch');
  launch.type = 'button'; launch.id = 'workspace-button'; iconAction(launch, 'Files and code', 'files');
  launch.setAttribute('aria-haspopup', 'dialog'); launch.setAttribute('aria-controls', 'workspace-dialog');
  launchTarget.prepend(launch);
  const dialog = node('dialog', 'workspace-dialog'); dialog.id = 'workspace-dialog';
  dialog.setAttribute('aria-labelledby', 'workspace-title');
  // This template contains only fixed UI text. File and execution content use text nodes.
  dialog.innerHTML = `<div class="dialog-header workspace-header"><div><h2 id="workspace-title">Files and code</h2><p id="workspace-conversation" class="small"></p></div><button type="button" class="ghost" id="workspace-close">Close</button></div>
    <div class="workspace-tabs" role="tablist" aria-label="Workspace sections">
      <button type="button" id="workspace-files-tab" role="tab" aria-controls="workspace-files-panel" aria-selected="true">Files</button>
      <button type="button" id="workspace-run-tab" role="tab" aria-controls="workspace-run-panel" aria-selected="false" tabindex="-1">Run code</button>
    </div>
    <p id="workspace-error" class="error" role="alert" hidden></p>
    <section id="workspace-files-panel" role="tabpanel" aria-labelledby="workspace-files-tab">
      <div class="workspace-grid"><aside class="workspace-sidebar" aria-label="Workspace files">
        <div class="workspace-actions"><button type="button" id="workspace-new">New file</button><button type="button" id="workspace-upload">Upload</button><button type="button" class="ghost" id="workspace-refresh">Refresh</button></div>
        <input id="workspace-upload-input" type="file" multiple hidden>
        <form id="workspace-search-form" class="workspace-search"><label class="workspace-sr-only" for="workspace-search">Search file contents</label><input id="workspace-search" type="search" placeholder="Search file contents" maxlength="500"><button type="submit">Search</button><button type="button" class="ghost" id="workspace-clear-search" hidden>Clear</button></form>
        <p class="small workspace-list-status" id="workspace-list-status" role="status"></p><div id="workspace-file-list"></div><details class="workspace-help"><summary>Storage details</summary><p class="small" id="workspace-usage"></p></details>
      </aside><section class="workspace-detail" aria-label="Selected file">
        <p class="muted" id="workspace-empty">Select a file, upload files, or create a text file.</p>
        <div id="workspace-file" hidden>
          <label class="field" id="workspace-path-field">File path<input id="workspace-path" placeholder="notes/summary.md" autocomplete="off" spellcheck="false"></label>
          <h3 id="workspace-file-title"></h3><details class="workspace-help workspace-file-details"><summary id="workspace-file-type">File details</summary><p class="small workspace-meta" id="workspace-file-meta"></p></details>
          <div class="workspace-actions"><button type="button" class="ghost" id="workspace-save">Save</button><a id="workspace-download" class="file-link">Download</a><button type="button" id="workspace-reload">Reload file</button><button type="button" class="ghost danger" id="workspace-delete">Delete</button><button type="button" class="ghost" id="workspace-discard">Discard draft</button></div>
          <p id="workspace-file-notice" class="small" role="status"></p><p id="workspace-file-error" class="error" role="alert" hidden></p>
          <div class="workspace-tabs workspace-view-tabs" role="tablist" aria-label="File view">
            <button type="button" role="tab" id="workspace-edit-tab" aria-controls="workspace-edit-panel" aria-selected="true">Edit</button>
            <button type="button" role="tab" id="workspace-preview-tab" aria-controls="workspace-preview-panel" aria-selected="false" tabindex="-1">Preview</button>
            <button type="button" role="tab" id="workspace-history-tab" aria-controls="workspace-history-panel" aria-selected="false" tabindex="-1">Revisions</button>
          </div>
          <section role="tabpanel" id="workspace-edit-panel" aria-labelledby="workspace-edit-tab"><label class="workspace-sr-only" for="workspace-editor">File text</label><textarea id="workspace-editor" rows="16" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea><p class="small">Unsaved drafts stay in this tab when you close the panel or switch chats. Reloading the page can lose them.</p><details class="workspace-help"><summary>Editor help</summary><p class="small">Ctrl+S or Command+S saves the selected file.</p></details></section>
          <section role="tabpanel" id="workspace-preview-panel" aria-labelledby="workspace-preview-tab" hidden><div id="workspace-preview" class="workspace-preview"></div></section>
          <section role="tabpanel" id="workspace-history-panel" aria-labelledby="workspace-history-tab" hidden><p class="small">Restore creates a new revision. Earlier revisions remain available.</p><div id="workspace-history"></div></section>
        </div>
      </section></div>
    </section>
    <section id="workspace-run-panel" role="tabpanel" aria-labelledby="workspace-run-tab" hidden>
      <p class="small workspace-safety">Code runs on the configured server runner and can change this conversation's files. Review the code before Run. Closing this panel does not stop a server job.</p>
      <div class="workspace-actions"><p id="workspace-runtime-status" class="small" role="status"></p><button type="button" class="ghost" id="workspace-runtime-refresh">Check runner</button></div>
      <p class="small workspace-safety">Execution is offline. Package access is registry-only. These manual settings do not change automatic model tool access.</p>
      <div class="workspace-run-controls"><label class="field">Language<select id="workspace-language"><option value="python">Python</option><option value="shell">Shell</option></select></label><label class="check"><input type="checkbox" id="workspace-allow-packages">Allow package downloads from approved registries for this run</label></div>
      <details class="workspace-help"><summary>Runner details and bundled libraries</summary><p class="small">Each run uses a fresh copied workspace, not a live shared filesystem. Only successful changed outputs become revisions. Python uses headless Agg: save plots and animations to files instead of plt.show().</p><dl id="workspace-runtime-limits" class="workspace-limits"></dl><p id="workspace-inventory" class="small"></p></details>
      <label class="field">Code<textarea id="workspace-code" rows="12" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Enter code to run"></textarea></label>
      <div class="workspace-actions workspace-run-actions"><button type="button" class="ghost" id="workspace-run">Run</button><button type="button" id="workspace-stop" disabled>Stop</button><button type="button" class="ghost" id="workspace-recent">Recent runs</button><span id="workspace-job-status" class="small" role="status"></span></div>
      <p id="workspace-run-error" class="error" role="alert" hidden></p><div id="workspace-recent-list"></div>
      <div id="workspace-job" hidden><details class="workspace-help"><summary>Run details</summary><p id="workspace-job-details" class="small"></p></details><h3>Console</h3><pre id="workspace-console" class="workspace-console" tabindex="0" aria-label="Execution console"></pre><p id="workspace-console-note" class="small"></p><div class="workspace-actions"><button type="button" id="workspace-console-previous">Previous console page</button><button type="button" id="workspace-console-next">Next console page</button><button type="button" id="workspace-console-download">Download full console</button></div><h3 id="workspace-output-title" hidden>Created or changed files</h3><div id="workspace-output-files" class="workspace-output-list"></div><p id="workspace-available-note" class="small"></p></div>
      <details id="workspace-packages"><summary>Conversation packages</summary><p class="small workspace-safety">Registry packages only. Validation replaces the saved package list. URLs, paths, flags, and version ranges are not allowed.</p><details class="workspace-help"><summary>Package formats and validation</summary><p class="small">Use package names, optionally with exact versions. One package per line. Python uses name==version. npm uses name@version. Validation can take up to five minutes. You can keep editing while it runs.</p></details>
        <div class="workspace-package-grid"><label class="field">Python packages<textarea id="workspace-pip" rows="3" spellcheck="false" placeholder="Package names"></textarea></label><label class="field">npm packages<textarea id="workspace-npm" rows="3" spellcheck="false" placeholder="Package names"></textarea></label></div>
        <label class="check"><input type="checkbox" id="workspace-package-consent">Allow these packages to be downloaded from approved registries</label>
        <div class="workspace-actions"><button type="button" id="workspace-package-load">Load saved list</button><button type="button" id="workspace-package-save">Validate and save packages</button></div><p id="workspace-package-status" class="small" role="status"></p><p id="workspace-package-error" class="error" role="alert" hidden></p>
      </details>
    </section>`;
  document.body.append(dialog);
  const field = name => dialog.querySelector(`#workspace-${name}`);
  for (const [name, label, icon] of [
    ['close', 'Close files and code', 'close'], ['new', 'New file', 'plus'], ['upload', 'Upload files', 'upload'], ['refresh', 'Refresh file list', 'refresh'],
    ['clear-search', 'Clear file search', 'close'], ['save', 'Save file', 'save'], ['download', 'Download saved revision', 'download'],
    ['reload', 'Reload current file', 'refresh'], ['delete', 'Delete file', 'trash'], ['discard', 'Discard unsaved draft', 'undo'],
    ['runtime-refresh', 'Check runner', 'refresh'], ['stop', 'Stop run', 'stop'], ['recent', 'Recent runs', 'history'],
    ['console-previous', 'Previous console page', 'previous'], ['console-next', 'Next console page', 'next'], ['console-download', 'Download full console', 'download'],
    ['package-load', 'Load saved package list', 'refresh']
  ]) iconAction(field(name), label, icon);
  iconAction(field('search-form').querySelector('[type=submit]'), 'Search file contents', 'search');
  const selected = context => context?.drafts.get(context.selected);
  const dirty = draft => draft?.isNew || draft?.text !== draft?.baseText;
  const visible = context => dialog.open && current === context;
  const prefix = context => `/api/conversations/${encodeURIComponent(context.cid)}`;
  const workspace = context => `${prefix(context)}/workspace`;
  const queryFor = (path, revision) => new URLSearchParams({ path, ...(revision ? { revision } : {}) });
  const downloadUrl = (context, file) => `${workspace(context)}/download?${queryFor(file.path, file.revision)}`;
  function action(label, handler, className = '', icon) {
    const button = node('button', className, label); button.type = 'button';
    if (icon) iconAction(button, label, icon);
    button.addEventListener('click', handler); return button;
  }
  function errorText(target, message = '') { target.textContent = message; target.hidden = !message; }
  function newContext(conversation) {
    return { cid: conversation.id, title: conversation.title, files: [], limits: {}, usage: null, drafts: new Map(), selected: null, query: '', results: null, indexing: [], searching: false, searchSeq: 0, listReady: false, listRequest: null, loadingPath: null, openSeq: 0, busy: false, error: '',
      run: { kind: 'python', code: '', allowPackages: false, job: null, consoleOffset: 0, starting: false, canceling: false, unknown: false, recent: null, recovering: false, error: '' },
      packages: { pip: '', npm: '', consent: false, dirty: false, loading: false, saving: false, loaded: false, status: '', error: '' } };
  }
  function syncContext() {
    const conversation = getConversation();
    const next = conversation?.id ? sessions.get(conversation.id) ?? newContext(conversation) : null;
    if (next) { sessions.set(next.cid, next); next.title = conversation.title; }
    if (next !== current) { clearTimeout(pollTimer); current = next; showContext(); }
    else field('conversation').textContent = next?.title || (next ? 'Current conversation' : 'No conversation selected');
    return next;
  }
  function changed(context, type = 'workspace', path) {
    Promise.resolve().then(() => onChanged({ conversationId: context.cid, type, ...(path ? { path } : {}) })).catch(() => toast('The change was saved, but the conversation could not be refreshed.'));
  }
  function setFile(context, file) {
    metadata(file); context.files = context.files.filter(item => item.path !== file.path); context.files.push(file); context.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  function draftFrom(result) {
    const content = readResult(result), file = content.file;
    return { key: file.path, file, content, path: file.path, text: content.text ?? '', baseText: content.text ?? '', isNew: false, view: file.text && typeof content.text === 'string' ? 'edit' : 'preview', history: null, historyLoading: false, historical: null, passageOffset: 0, error: '', notice: '', busy: false, locked: false, conflict: false };
  }
  function deletedDraft(file) {
    return { key: file.path, file, content: null, path: file.path, text: '', baseText: '', isNew: false, view: 'history', history: null, historyLoading: false, historical: null, passageOffset: 0, error: '', notice: '', busy: false, locked: false, conflict: false };
  }
  function setTabs(names, active) {
    for (const name of names) {
      const button = field(`${name}-tab`); button.setAttribute('aria-selected', String(name === active)); button.tabIndex = name === active ? 0 : -1;
      field(`${name}-panel`).hidden = name !== active;
    }
  }
  function selectSection(name) {
    activeSection = name; setTabs(['files', 'run'], name);
    if (name === 'run') { renderRun(); checkRuntime(); if (current?.run.job && activeStatuses.has(current.run.job.status)) pollJob(current); }
  }
  function installTabKeys(names, choose) {
    for (const name of names) field(`${name}-tab`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const available = names.filter(item => !field(`${item}-tab`).disabled), index = available.indexOf(name);
      const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1) : available[(index + (event.key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length];
      if (next) { event.preventDefault(); choose(next); field(`${next}-tab`).focus(); }
    });
  }
  function showContext() {
    field('conversation').textContent = current?.title || (current ? 'Current conversation' : 'No conversation selected');
    field('search').value = current?.query ?? '';
    renderList(); renderFile(); renderRun(true); renderPackages(true);
  }
  function renderList() {
    const context = current, root = field('file-list'), focusedKey = root.contains(document.activeElement) ? document.activeElement.dataset.workspaceKey : null;
    root.replaceChildren();
    errorText(field('error'), context?.error);
    field('new').disabled = field('upload').disabled = !context || context.busy;
    field('refresh').disabled = !context || !!context.listRequest;
    field('search').disabled = !context; field('search-form').querySelector('[type=submit]').disabled = !context || context.searching;
    field('clear-search').hidden = !context?.results;
    field('list-status').textContent = !context ? 'Open Files from a conversation to use its workspace.' : context.busy ? 'Updating files…' : context.searching ? 'Searching…' : context.loadingPath ? `Opening ${context.loadingPath}…` : !context.listReady ? context.error ? 'Files unavailable. Use Refresh to retry.' : 'Loading files…' : context.results ? `${context.results.length} search results` : `${context.files.filter(file => !file.deleted).length} files`;
    field('usage').textContent = context?.usage ? `${bytesLabel(context.usage.bytes)} retained across ${context.usage.revisions} revisions. Deleted files retain their history.` : '';
    if (!context) return;
    const local = [...context.drafts.values()].filter(draft => draft.isNew);
    function fileButton(label, key, detail, handler, file = { path: label }, notice = '') {
      const { type, icon } = filePresentation(file), button = action('', handler, 'workspace-file-item'); button.dataset.workspaceKey = key;
      if (context.selected === key) button.setAttribute('aria-current', 'true');
      button.title = [label, file.mime, detail].filter(Boolean).join('\n');
      button.setAttribute('aria-label', `${label}, ${type}${notice ? `, ${notice}` : ''}`);
      const mark = node('span', `workspace-file-icon workspace-file-${icon}`); mark.innerHTML = presentationIcon(icon);
      const text = node('span', 'workspace-file-label'); text.append(node('span', 'workspace-file-name', label), node('small', '', [type, notice].filter(Boolean).join(' · ')));
      button.append(mark, text); root.append(button);
    }
    for (const draft of local) fileButton(draft.path || 'Untitled file', draft.key, 'Unsaved new file', () => { context.selected = draft.key; renderList(); renderFile(); }, { path: draft.path, mime: 'text/plain' }, 'Unsaved new file');
    if (context.results) {
      for (const [index, result] of context.results.entries()) {
        const item = node('article', 'workspace-search-result'), place = result.citation ?? {};
        const button = action(result.path, () => openPath(context, result.path, { revision: result.revision, citation: place }), 'workspace-result-link');
        button.dataset.workspaceKey = `result:${index}`;
        item.append(button, node('small', 'workspace-citation-label', `${locationLabel(place)}${locationLabel(place) ? ' · ' : ''}${String(result.revision).slice(0, 8)}`), node('p', '', String(result.text ?? '').slice(0, 4096)), citationControl(result, { citation: place })); root.append(item);
      }
      for (const item of context.indexing) root.append(node('p', 'small workspace-index-note', `${item.path}: ${item.error || item.status}`));
      if (!context.results.length) root.append(node('p', 'small', 'No matching extracted text. Search does not include deleted files.'));
    } else {
      for (const file of context.files) {
        const draft = context.drafts.get(file.path);
        fileButton(file.path, file.path, `${bytesLabel(file.size)} · ${revisionLabel(file)}`, () => openPath(context, file.path), file, [file.deleted ? 'Deleted' : '', dirty(draft) ? 'Unsaved draft' : ''].filter(Boolean).join(' · '));
      }
      if (context.listReady && !context.files.length && !local.length) root.append(node('p', 'small', 'No files yet. Upload documents or create a text file.'));
    }
    if (focusedKey) [...root.querySelectorAll('[data-workspace-key]')].find(item => item.dataset.workspaceKey === focusedKey)?.focus({ preventScroll: true });
  }
  function renderFile({ preserveInput = false } = {}) {
    const context = current, draft = selected(context);
    field('empty').hidden = !!draft; field('file').hidden = !draft;
    if (!draft) return;
    field('path-field').hidden = !draft.isNew; field('file-title').hidden = draft.isNew;
    field('file-title').textContent = draft.path;
    if (!preserveInput && field('path').value !== draft.path) field('path').value = draft.path;
    if (!preserveInput && field('editor').value !== draft.text) field('editor').value = draft.text;
    const editable = draft.isNew || draft.file.text === true && typeof draft.content?.text === 'string' && !draft.file.deleted;
    const stale = context.files.find(file => file.path === draft.path)?.revision;
    field('file-type').textContent = `${filePresentation(draft.isNew ? { path: draft.path, mime: 'text/plain' } : draft.file).type}${draft.file.deleted ? ' · Deleted' : ''} · file details`;
    field('file-meta').textContent = draft.isNew ? 'New UTF-8 text file' : `${revisionLabel(draft.file)} · ${bytesLabel(draft.file.size)} · ${draft.file.mime}${draft.file.deleted ? ' · Deleted' : ''}`;
    field('file-notice').textContent = [dirty(draft) ? 'Unsaved changes.' : '', stale && stale !== draft.file.revision ? 'The server has a newer revision. Reload before saving. Your draft is kept until you confirm.' : '', draft.notice].filter(Boolean).join(' ');
    errorText(field('file-error'), draft.error);
    field('path').disabled = draft.busy || context.busy; field('editor').readOnly = draft.locked || !editable;
    field('save').hidden = !editable; field('save').disabled = draft.busy || context.busy || !dirty(draft) || draft.conflict;
    iconAction(field('save'), draft.busy && !draft.locked ? 'Saving file…' : 'Save file', 'save');
    field('reload').hidden = draft.isNew; field('reload').disabled = draft.busy || context.busy;
    field('delete').hidden = draft.isNew || draft.file.deleted; field('delete').disabled = draft.busy || context.busy;
    field('discard').hidden = !dirty(draft); field('discard').disabled = draft.busy || context.busy;
    field('download').hidden = draft.isNew || draft.file.deleted;
    if (!draft.isNew && !draft.file.deleted) { field('download').href = downloadUrl(context, draft.file); field('download').download = draft.path.split('/').at(-1); }
    field('edit-tab').disabled = !editable; field('history-tab').disabled = draft.isNew;
    if (!editable && draft.view === 'edit') draft.view = 'preview';
    setTabs(['edit', 'preview', 'history'], draft.view);
    if (draft.view === 'preview') renderPreview(context, draft);
    if (draft.view === 'history') renderHistory(context, draft);
  }
  async function copyText(text, source) {
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch {
      const selection = window.getSelection();
      if (source && selection) { const range = document.createRange(); range.selectNodeContents(source); selection.removeAllRanges(); selection.addRange(range); source.scrollIntoView({ block: 'nearest' }); }
      toast(source ? 'Text selected. Use your browser Copy command.' : 'Clipboard access is unavailable. Select the text and use your browser Copy command.');
    }
  }
  function citationControl(file, passage) {
    const box = node('details', 'workspace-citation'), summary = node('summary', '', 'Source citation'), text = citationText(file, passage), code = node('code', '', text);
    box.append(summary, code, action('Copy citation', () => copyText(text, code), 'ghost', 'copy')); return box;
  }
  function renderPreview(context, draft) {
    const root = field('preview'); releasePreview(); root.replaceChildren();
    const content = draft.historical ?? draft.content, file = content?.file ?? draft.file;
    if (draft.historical) {
      const bar = node('div', 'workspace-actions'); bar.append(node('p', 'small', `Viewing ${revisionLabel(file).toLowerCase()}. This is a read-only saved revision.`), action('Return to current file', () => { draft.historical = null; draft.passageOffset = 0; renderPreview(context, draft); }, 'ghost', 'undo'));
      const link = node('a', 'file-link'); iconAction(link, `Download ${revisionLabel(file).toLowerCase()}`, 'download'); link.href = downloadUrl(context, file); link.download = file.path.split('/').at(-1); bar.append(link); root.append(bar);
    }
    if (file.deleted && !draft.historical) { root.append(node('p', 'small', 'This file was deleted. Use Revisions to view or restore earlier content.')); return; }
    if (!draft.isNew) root.append(citationControl(file));
    if (draft.isNew || file.text === true && typeof content?.text === 'string') {
      const text = draft.historical ? content.text : draft.text;
      if (!draft.historical && dirty(draft)) root.append(node('p', 'small', 'Preview of unsaved text. Source citations refer to the last saved revision, not these edits.'));
      const bounded = text.slice(0, PREVIEW_CHARS);
      if (text.length > PREVIEW_CHARS) root.append(node('p', 'small', 'Preview is shortened to 128 Ki characters. The editor and download retain the full source.'));
      if (/\.(?:md|markdown)$/i.test(file.path || draft.path) || file.mime === 'text/markdown') {
        const body = node('div', 'message-body'); body.innerHTML = markdown(bounded, { conversationId: context.cid });
        // Workspace previews never start artifact frames, scripts, or Mermaid jobs.
        for (const details of body.querySelectorAll('.artifact-source, .diagram-source')) details.open = true;
        root.append(body);
      } else root.append(node('pre', 'workspace-source', bounded));
      return;
    }
    if (rasterTypes.has(file.mime) && typeof content?.data === 'string') {
      const data = content.data;
      if (data.length <= Math.ceil(10 * MiB / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        const image = node('img', 'workspace-image'); image.alt = file.path; image.decoding = 'async'; image.loading = 'lazy'; image.src = `data:${file.mime};base64,${data}`;
        image.addEventListener('error', () => { image.replaceWith(node('p', 'error', 'This image could not be displayed. Download the original file.')); }, { once: true }); root.append(image);
      } else root.append(node('p', 'small', 'Image preview is unavailable or exceeds 10 MiB. Download the original file.'));
      return;
    }
    if (/^(video\/(mp4|webm)|audio\/(wav|mpeg|flac))$/.test(file.mime) && typeof content?.data === 'string') {
      const data = content.data;
      if (data.length <= Math.ceil(10 * MiB / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        const media = node(file.mime.startsWith('video/') ? 'video' : 'audio', 'workspace-media');
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: file.mime }));
        previewUrls.add(url); media.controls = true; media.preload = 'metadata'; media.src = url; root.append(media);
        root.append(node('p', 'small', 'Saved media preview. Browser codec support can vary. Download the original file if playback fails.'));
      } else root.append(node('p', 'small', 'Saved media preview exceeds its limit or is invalid. Download the original.'));
      return;
    }
    const documentFile = /\.(pdf|docx)$/i.test(file.path) || ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mime);
    if (documentFile) {
      root.append(node('p', 'small', 'Extracted text only. PDF and DOCX layout, images, and some content may be missing. Download the original for its full layout. Scanned PDFs need OCR, which is not supported.'));
      const passages = Array.isArray(content?.passages) ? content.passages : [];
      if (!passages.length) root.append(node('p', 'small', file.index?.error || 'No extracted text is available. The original file remains downloadable.'));
      const offset = Math.min(draft.passageOffset, Math.max(0, passages.length - 1));
      for (const passage of passages.slice(offset, offset + PASSAGES_PER_PAGE)) {
        const section = node('section', 'workspace-passage'); section.append(node('h3', '', locationLabel(passage) || 'Extracted passage'), node('p', '', String(passage.text ?? '').slice(0, 8192)), citationControl(file, passage)); root.append(section);
      }
      if (passages.length > PASSAGES_PER_PAGE) {
        const controls = node('div', 'workspace-actions');
        const previous = action('Previous passages', () => { draft.passageOffset = Math.max(0, offset - PASSAGES_PER_PAGE); renderPreview(context, draft); }, 'ghost', 'previous'); previous.disabled = offset === 0;
        const next = action('Next passages', () => { draft.passageOffset = offset + PASSAGES_PER_PAGE; renderPreview(context, draft); }, 'ghost', 'next'); next.disabled = offset + PASSAGES_PER_PAGE >= passages.length;
        controls.append(previous, node('span', 'small', `${offset + 1}–${Math.min(offset + PASSAGES_PER_PAGE, passages.length)} of ${passages.length}`), next); root.append(controls);
      }
      return;
    }
    root.append(node('p', 'small', file.index?.error || 'No safe inline preview is available for this file type. Download the original file.'));
  }
  function renderHistory(context, draft) {
    const root = field('history'); root.replaceChildren();
    if (draft.historyLoading) { root.append(node('p', 'small', 'Loading revisions…')); return; }
    if (!draft.history) { root.append(action('Load revisions', () => loadHistory(context, draft), 'ghost', 'refresh')); return; }
    for (const file of draft.history.revisions) {
      const row = node('div', 'workspace-revision'); row.append(node('div', '', `${revisionLabel(file)}${file.revision === draft.history.currentRevision ? ' · Current' : ''}${file.deleted ? ' · Deleted' : ''}`), node('small', '', `${dateLabel(file.createdAt)} · ${bytesLabel(file.size)}`));
      if (!file.deleted) {
        const controls = node('div', 'workspace-actions');
        const preview = action(`View ${revisionLabel(file).toLowerCase()}`, () => viewRevision(context, draft, file.revision), 'ghost', 'preview'); preview.disabled = draft.busy || context.busy;
        const restore = action(`Restore ${revisionLabel(file).toLowerCase()}`, () => restoreRevision(context, draft, file), 'ghost', 'history'); restore.disabled = draft.busy || context.busy || file.revision === draft.file.revision;
        controls.append(preview, restore); row.append(controls);
      }
      root.append(row);
    }
  }
  async function listFiles(context) {
    if (context.listRequest) return context.listRequest;
    context.listRequest = (async () => {
      try {
        const result = await api(`${workspace(context)}/files`);
        if (!Array.isArray(result.files)) throw new Error('The server returned an invalid workspace file list.');
        context.files = result.files.map(metadata); context.limits = result.limits ?? {}; context.usage = result.usage; context.listReady = true;
        for (const file of context.files) {
          const draft = context.drafts.get(file.path);
          if (draft?.history && draft.history.currentRevision !== file.revision) draft.history = null;
        }
      } catch (error) { context.error = error.message; }
      finally { context.listRequest = null; if (visible(context)) { renderList(); renderFile({ preserveInput: true }); } }
    })();
    if (visible(context)) renderList();
    return context.listRequest;
  }
  async function openPath(context, path, { revision, citation } = {}) {
    const sequence = ++context.openSeq; context.selected = path; context.loadingPath = path;
    if (visible(context)) { renderList(); renderFile(); }
    try {
      let draft = context.drafts.get(path);
      if (!draft) {
        const head = context.files.find(file => file.path === path);
        draft = head?.deleted ? deletedDraft(head) : draftFrom(await api(`${workspace(context)}/files?${queryFor(path)}`));
        context.drafts.set(path, draft);
      }
      if (sequence !== context.openSeq) return;
      draft.historical = null; draft.passageOffset = 0;
      if (revision && (revision !== draft.file.revision || dirty(draft) || citation)) draft.historical = readResult(await api(`${workspace(context)}/files?${queryFor(path, revision)}`));
      if (sequence !== context.openSeq) return;
      if (citation || revision) {
        draft.view = 'preview'; const passages = (draft.historical ?? draft.content)?.passages ?? [];
        const index = passages.findIndex(passage => ['page', 'paragraph', 'part'].every(key => citation?.[key] == null || passage[key] === citation[key]));
        if (index >= 0) draft.passageOffset = Math.floor(index / PASSAGES_PER_PAGE) * PASSAGES_PER_PAGE;
      }
      if (draft.view === 'history' && !draft.history) loadHistory(context, draft);
      context.error = '';
    } catch (error) { context.error = error.message; }
    finally { if (sequence === context.openSeq) context.loadingPath = null; if (visible(context)) { renderList(); renderFile(); } }
  }
  function createFile() {
    const context = current; if (!context || context.busy) return;
    const key = `new:${++counter}`, draft = { key, file: { path: '', revision: null, mime: 'text/plain', text: true }, content: null, path: '', text: '', baseText: '', isNew: true, view: 'edit', history: null, historical: null, passageOffset: 0, error: '', notice: '', busy: false, locked: false, conflict: false };
    context.openSeq++; context.loadingPath = null; context.drafts.set(key, draft); context.selected = key;
    renderList(); renderFile(); field('path').focus();
  }
  function mutationError(draft, error) {
    draft.error = error.message;
    if (error.status === 409) { draft.conflict = true; draft.error += ' Your editor text is unchanged. Copy it or discard it only when ready, then reload the current file.'; }
    if (error.status === 0) { draft.conflict = true; draft.error += ' The change could not be confirmed. Refresh the file list and read the current revision before trying again.'; }
  }
  async function saveFile() {
    const context = current, draft = selected(context); if (!draft || draft.busy || context.busy || !dirty(draft) || draft.conflict) return;
    const path = draft.path, text = draft.text;
    if (!path) { draft.error = 'Enter a relative file path, such as notes/summary.md.'; renderFile({ preserveInput: true }); field('path').focus(); return; }
    if (utf8Size(text) > (context.limits.textBytes ?? MiB)) { draft.error = `Text files must fit ${bytesLabel(context.limits.textBytes ?? MiB)}.`; renderFile({ preserveInput: true }); return; }
    draft.busy = true; draft.error = ''; renderFile({ preserveInput: true });
    try {
      const file = metadata(await api(`${workspace(context)}/files`, 'PUT', { path, text, ...(draft.isNew ? {} : { mime: draft.file.mime }), expectedRevision: draft.isNew ? null : draft.file.revision }));
      const oldKey = draft.key; draft.key = file.path; draft.path = file.path; draft.file = file; draft.content = { file, text }; draft.baseText = text; draft.isNew = false; draft.history = null; draft.historical = null; draft.notice = 'Saved.';
      context.drafts.delete(oldKey); context.drafts.set(draft.key, draft); if (context.selected === oldKey) context.selected = draft.key;
      setFile(context, file); changed(context, 'workspace', file.path); listFiles(context);
    } catch (error) { mutationError(draft, error); }
    finally { draft.busy = false; if (visible(context)) { renderList(); renderFile({ preserveInput: selected(context) === draft }); } }
  }
  async function reloadFile(context, draft) {
    if (draft.busy || context.busy) return;
    if (dirty(draft) && !confirm(`Discard the unsaved editor text for ${draft.path} and reload the server version?`)) return;
    draft.busy = draft.locked = true; draft.error = ''; context.error = ''; if (visible(context)) renderFile({ preserveInput: true });
    try {
      await listFiles(context);
      if (context.error) throw new Error(context.error);
      const head = context.files.find(file => file.path === draft.path);
      const fresh = head?.deleted ? deletedDraft(head) : draftFrom(await api(`${workspace(context)}/files?${queryFor(draft.path)}`));
      context.drafts.set(draft.key, fresh); if (fresh.view === 'history') loadHistory(context, fresh);
    } catch (error) { draft.error = error.message; }
    finally { draft.busy = draft.locked = false; if (visible(context)) { renderList(); renderFile(); } }
  }
  async function removeFile() {
    const context = current, draft = selected(context); if (!draft || draft.isNew || draft.busy || context.busy) return;
    if (!confirm(`Delete ${draft.path}? Earlier revisions remain available.${dirty(draft) ? ' This also discards its unsaved editor text after deletion succeeds.' : ''}`)) return;
    draft.busy = draft.locked = true; draft.error = ''; renderFile({ preserveInput: true });
    try {
      const file = metadata(await api(`${workspace(context)}/files`, 'DELETE', { path: draft.path, expectedRevision: draft.file.revision }));
      const fresh = deletedDraft(file); context.drafts.set(draft.key, fresh); setFile(context, file); changed(context, 'workspace', file.path); loadHistory(context, fresh); listFiles(context);
    } catch (error) { mutationError(draft, error); }
    finally { draft.busy = draft.locked = false; if (visible(context)) { renderList(); renderFile(); } }
  }
  function discardDraft() {
    const context = current, draft = selected(context); if (!draft || draft.busy || context.busy || !confirm('Discard this unsaved file draft?')) return;
    if (draft.isNew) { context.drafts.delete(draft.key); context.selected = null; }
    else { draft.text = draft.baseText; draft.error = ''; draft.notice = 'Unsaved text discarded. Reload to read the current server revision.'; }
    renderList(); renderFile();
  }
  async function uploadFiles(files) {
    const context = current; if (!context || context.busy || !files.length) return;
    context.busy = true; context.error = ''; renderList(); renderFile({ preserveInput: true }); let saved = 0;
    try {
      await listFiles(context); if (!context.listReady || context.error) throw new Error(context.error || 'Read the file list before uploading.');
      for (const file of files) {
        if (file.size > (context.limits.binaryBytes ?? 10 * MiB)) throw new Error(`${file.name} exceeds ${bytesLabel(context.limits.binaryBytes ?? 10 * MiB)}.`);
        const existing = context.files.find(item => item.path === file.name), draft = context.drafts.get(file.name);
        if (draft?.busy) throw new Error(`${file.name} is being saved. Wait before replacing it.`);
        if (existing && !confirm(`${existing.deleted ? 'Recreate' : 'Replace'} ${file.name} with the selected upload?${dirty(draft) ? ' The unsaved editor draft will be discarded only after upload succeeds.' : ''}`)) continue;
        if (draft) draft.locked = true;
        if (visible(context)) renderFile({ preserveInput: true });
        try {
          const result = metadata(await api(`${workspace(context)}/files`, 'PUT', { path: file.name, ...(file.type ? { mime: file.type } : {}), data: await base64(file), expectedRevision: existing?.revision ?? null }));
          context.drafts.delete(file.name); setFile(context, result); saved++; changed(context, 'workspace', file.name);
          if (context.selected === file.name) await openPath(context, file.name);
        } finally { if (draft) draft.locked = false; }
      }
      if (saved) toast(`${saved} ${saved === 1 ? 'file' : 'files'} uploaded.`);
    } catch (error) { context.error = `${saved ? `${saved} files uploaded before this error. ` : ''}${error.message}${error.status === 409 ? ' No conflicting file was overwritten. Refresh and review its current revision.' : ''}`; }
    finally { context.busy = false; field('upload-input').value = ''; listFiles(context); if (visible(context)) { renderList(); renderFile(); } }
  }
  async function loadHistory(context, draft) {
    if (draft.historyLoading || draft.isNew) return;
    draft.historyLoading = true; if (visible(context) && selected(context) === draft) renderHistory(context, draft);
    try {
      const history = await api(`${workspace(context)}/history?${queryFor(draft.path)}`);
      if (!Array.isArray(history.revisions)) throw new Error('The server returned an invalid revision history.');
      history.revisions.forEach(metadata); draft.history = history;
    } catch (error) { draft.error = error.message; }
    finally { draft.historyLoading = false; if (visible(context) && selected(context) === draft) renderFile({ preserveInput: true }); }
  }
  async function viewRevision(context, draft, revision) {
    try {
      const result = readResult(await api(`${workspace(context)}/files?${queryFor(draft.path, revision)}`));
      draft.historical = result; draft.passageOffset = 0; draft.view = 'preview'; draft.error = '';
    } catch (error) { draft.error = error.message; }
    if (visible(context) && selected(context) === draft) renderFile({ preserveInput: true });
  }
  async function restoreRevision(context, draft, revision) {
    if (draft.busy || context.busy || !confirm(`Restore ${draft.path} to ${revisionLabel(revision).toLowerCase()}?${dirty(draft) ? ' This discards its unsaved editor text only after restore succeeds.' : ''}`)) return;
    draft.busy = draft.locked = true; draft.error = ''; if (visible(context)) renderFile({ preserveInput: true });
    let restored = false;
    try {
      const file = metadata(await api(`${workspace(context)}/restore`, 'POST', { path: draft.path, revision: revision.revision, expectedRevision: draft.file.revision }));
      restored = true; setFile(context, file); changed(context, 'workspace', file.path); listFiles(context);
      // Keep the prior draft if the follow-up read fails, and report that restore succeeded.
      draft.notice = `${revisionLabel(file)} restored. Reload to read it.`;
      const fresh = draftFrom(await api(`${workspace(context)}/files?${queryFor(file.path, file.revision)}`));
      fresh.notice = 'Revision restored.'; context.drafts.set(draft.key, fresh);
    } catch (error) {
      if (restored) { draft.conflict = true; draft.error = 'The revision was restored, but its contents could not be loaded. Reload file. The prior editor text is retained.'; }
      else mutationError(draft, error);
    }
    finally { draft.busy = draft.locked = false; if (visible(context)) { renderList(); renderFile(); } }
  }
  async function searchFiles(event) {
    event.preventDefault(); const context = current; if (!context) return;
    const query = field('search').value.trim(), sequence = ++context.searchSeq; context.query = field('search').value;
    if (!query) { context.results = null; context.searching = false; renderList(); return; }
    context.searching = true; context.error = ''; renderList();
    try {
      const result = await api(`${workspace(context)}/search?${new URLSearchParams({ q: query, limit: '25' })}`);
      if (!Array.isArray(result.results)) throw new Error('The server returned invalid search results.');
      if (sequence === context.searchSeq) { context.results = result.results; context.indexing = result.indexing ?? []; }
    } catch (error) { if (sequence === context.searchSeq) context.error = error.message; }
    finally { if (sequence === context.searchSeq) context.searching = false; if (visible(context)) renderList(); }
  }

  function runtimeReady() { return runtime?.enabled === true && runtime?.ready === true; }
  async function checkRuntime() {
    if (runtimeRequest) return runtimeRequest;
    runtimeRequest = (async () => {
      try { runtime = await api('/api/runtime'); runtimeError = ''; }
      catch (error) { runtime = null; runtimeError = error.message; }
      finally { runtimeRequest = null; if (dialog.open) { renderRun(); renderPackages(); } }
    })();
    renderRun(); return runtimeRequest;
  }
  function renderRun(fillInputs = false) {
    const context = current, run = context?.run, job = run?.job;
    const reasons = Array.isArray(runtime?.blockedReasons) ? runtime.blockedReasons.join(' ') : '';
    field('runtime-status').textContent = runtimeError || (runtimeRequest ? 'Checking runner…' : !runtime ? 'Runner status has not been checked.' : runtimeReady() ? 'Runner available.' : `Code execution is unavailable. ${reasons || (runtime.enabled ? 'The configured runner is not ready.' : 'No runner is enabled.')}`);
    field('runtime-refresh').disabled = !!runtimeRequest;
    field('inventory').textContent = runtime?.inventory ? `Python ${runtime.inventory.pythonVersion}, Node ${runtime.inventory.nodeVersion}. ${runtime.inventory.python.map(item => `${item.name}==${item.version}`).join(', ')}. Compatible bundled libraries need no installation. Additional wheels must fit 32 MiB and 4096 files.` : 'Verified inventory is unavailable. Do not assume versions.';
    const limits = field('runtime-limits'); limits.replaceChildren();
    for (const [key, value] of Object.entries(runtime?.limits ?? {}).slice(0, 16)) {
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') continue;
      const row = node('div'); row.append(node('dt', '', key.replace(/([a-z])([A-Z])/g, '$1 $2')), node('dd', '', String(value).slice(0, 160))); limits.append(row);
    }
    if (fillInputs) { field('language').value = run?.kind ?? 'python'; field('code').value = run?.code ?? ''; field('allow-packages').checked = run?.allowPackages ?? false; }
    field('code').disabled = field('language').disabled = !context;
    field('allow-packages').disabled = !context || runtime?.packages !== true && !run.allowPackages;
    field('run').disabled = !context || !!getConversation()?.activeJob || !runtimeReady() || run.starting || run.unknown || job && !terminalStatuses.has(job.status) || !run.code.trim() || run.allowPackages && runtime?.packages !== true;
    field('run').textContent = run?.starting ? 'Starting…' : 'Run';
    field('stop').disabled = !job?.id || !activeStatuses.has(job.status) || run?.canceling;
    iconAction(field('stop'), run?.canceling ? 'Stopping run…' : 'Stop run', 'stop');
    field('recent').disabled = !context || run.recovering;
    field('job-status').textContent = getConversation()?.activeJob ? 'Stop the active generation before a manual run.' : run?.unknown ? 'Start status unknown. Check Recent runs before submitting again.' : job ? `${job.status}${job.exitCode != null ? ` · exit ${job.exitCode}` : ''}` : '';
    field('job-status').title = job ? `Execution ${job.id}${job.operationId ? ` · runner operation ${job.operationId}` : ''}` : '';
    field('job-details').textContent = job ? `Execution ${job.id}${job.operationId ? ` · runner operation ${job.operationId}` : ''}` : '';
    errorText(field('run-error'), run?.error);
    field('job').hidden = !job;
    if (job) {
      const output = field('console'), bottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
      const text = [typeof job.stdout === 'string' && job.stdout ? `stdout\n${job.stdout}` : '', typeof job.stderr === 'string' && job.stderr ? `stderr\n${job.stderr}` : '', job.error ? `error\n${typeof job.error === 'string' ? job.error : 'Execution failed.'}` : ''].filter(Boolean).join('\n\n');
      const offset = Math.min(run.consoleOffset ?? 0, Math.max(0, text.length - 1));
      const bounded = text.slice(offset, offset + CONSOLE_CHARS);
      run.consoleText = text;
      if (output.textContent !== bounded) { output.textContent = bounded || 'No output yet.'; if (bottom) output.scrollTop = output.scrollHeight; }
      field('console-note').textContent = text.length > CONSOLE_CHARS ? `Showing characters ${offset + 1}–${Math.min(offset + CONSOLE_CHARS, text.length)} of ${text.length}. All saved console output is available through paging or download.` : 'All saved output is shown. Runner output limits still apply.';
      field('console-previous').disabled = offset === 0; field('console-next').disabled = offset + CONSOLE_CHARS >= text.length;
      field('available-note').textContent = `${job.files?.length ?? 0} created or changed files. ${job.availableFiles?.length ?? 0} current files remain available in Files. Unchanged files do not get duplicate revisions.`;
      const files = field('output-files'); files.replaceChildren();
      for (const file of (Array.isArray(job.files) ? job.files : []).slice(0, 32)) {
        const path = typeof file === 'string' ? file : file.path; if (typeof path !== 'string') continue;
        const button = action('', () => { selectSection('files'); openPath(context, path, { revision: typeof file === 'object' ? file.revision : undefined }); }, 'workspace-output-file');
        const { type, icon } = filePresentation(typeof file === 'object' ? file : { path });
        button.title = `${path}${typeof file === 'object' && file.revision ? `\nRevision ${file.revision}` : ''}`; button.setAttribute('aria-label', `Preview ${path}, ${type}`);
        const mark = node('span', `workspace-file-icon workspace-file-${icon}`); mark.innerHTML = presentationIcon(icon);
        const label = node('span', 'workspace-file-label'); label.append(node('span', 'workspace-file-name', path.split('/').at(-1)), node('small', '', type));
        button.append(mark, label); files.append(button);
      }
      field('output-title').hidden = !files.children.length;
    }
    const recent = field('recent-list'); recent.replaceChildren();
    if (run?.recent) {
      recent.append(node('p', 'small', 'Recent server runs. Select a run to inspect it. Starting code is never retried automatically.'));
      for (const item of run.recent) recent.append(action(`${String(item.id).slice(0, 8)} · ${item.status}${item.createdAt ? ` · ${dateLabel(item.createdAt)}` : ''}`, () => recoverJob(context, item.id), 'workspace-recent-item'));
      if (!run.recent.length) recent.append(node('p', 'small', 'No recent runs were returned.'));
      if (run.unknown) recent.append(action('Allow a new submission', () => {
        if (confirm('An earlier request may still be running. Have you checked the recent runs and confirmed that starting another job is safe?')) { run.unknown = false; run.error = ''; renderRun(); }
      }));
    }
  }
  async function startRun() {
    const context = current, run = context?.run; if (!run || field('run').disabled) return;
    const codeLimit = runtime?.limits?.codeBytes ?? 64 * 1024;
    if (utf8Size(run.code) > codeLimit) { run.error = `Code must fit ${bytesLabel(codeLimit)}.`; renderRun(); return; }
    run.starting = true; run.error = ''; run.recent = null; renderRun();
    try {
      const result = await api(`${prefix(context)}/executions`, 'POST', { kind: run.kind, code: run.code, allowPackages: run.allowPackages });
      if (typeof result.id !== 'string' || typeof result.status !== 'string') { run.unknown = true; throw new Error('The server did not return a usable execution ID. Check Recent runs.'); }
      run.job = result; run.consoleOffset = 0; run.unknown = false; changed(context, 'execution');
      await pollJob(context);
    } catch (error) {
      run.error = error.message;
      if (error.status === 0 || error.status >= 500 || run.unknown) { run.unknown = true; run.error += ' A job may have started. Use Recent runs to recover it. Do not replay the code blindly.'; recentRuns(context); }
    } finally { run.starting = false; if (visible(context)) renderRun(); }
  }
  async function pollJob(context) {
    const id = context.run.job?.id; if (!id || !visible(context)) return;
    if (pollRequest?.context === context && pollRequest.id === id) return pollRequest.promise;
    clearTimeout(pollTimer);
    const request = { context, id, promise: null };
    request.promise = (async () => {
      try {
        const job = await api(`${prefix(context)}/executions/${encodeURIComponent(id)}`);
        if (job.id !== id || typeof job.status !== 'string') throw new Error('The server returned an invalid execution status.');
        if (context.run.job?.id !== id) return;
        const wasActive = activeStatuses.has(context.run.job.status); context.run.job = job; context.run.error = '';
        if (!activeStatuses.has(job.status) && !terminalStatuses.has(job.status)) context.run.error = 'The runner returned an unknown status. Check Recent runs before submitting again.';
        if (terminalStatuses.has(job.status) && wasActive) { listFiles(context); changed(context, 'execution'); }
      } catch (error) { if (context.run.job?.id === id) context.run.error = `${error.message} The last known job status is shown. Use Recent runs to reconnect.`; }
      finally {
        if (pollRequest === request) pollRequest = null;
        if (visible(context)) {
          renderRun();
          if (context.run.job?.id === id && activeStatuses.has(context.run.job.status) && !context.run.error) pollTimer = setTimeout(() => pollJob(context), 1000);
        }
      }
    })();
    pollRequest = request; return request.promise;
  }
  async function stopRun() {
    const context = current, run = context?.run, id = run?.job?.id; if (!id || run.canceling) return;
    run.canceling = true; run.error = ''; renderRun();
    try { await api(`${prefix(context)}/executions/${encodeURIComponent(id)}/cancel`, 'POST'); await pollJob(context); }
    catch (error) { run.error = `${error.message} Cancellation is not confirmed. Check Recent runs.`; }
    finally { run.canceling = false; if (visible(context)) renderRun(); }
  }
  async function recentRuns(context = current) {
    if (!context || context.run.recovering) return;
    context.run.recovering = true; context.run.error = ''; if (visible(context)) renderRun();
    try {
      const result = await api(`${prefix(context)}/executions`);
      if (!Array.isArray(result.executions)) throw new Error('The server returned an invalid recent-run list.');
      context.run.recent = result.executions.slice(0, 20);
    } catch (error) { context.run.error = error.message; }
    finally { context.run.recovering = false; if (visible(context)) renderRun(); }
  }
  async function recoverJob(context, id) {
    if (typeof id !== 'string') return;
    try {
      const job = await api(`${prefix(context)}/executions/${encodeURIComponent(id)}`);
      if (job.id !== id || typeof job.status !== 'string') throw new Error('The server returned an invalid execution status.');
      if (activeStatuses.has(context.run.job?.status) && context.run.job.id !== id && !confirm('A different run is active. View this run instead? The active run will not be stopped.')) return;
      context.run.job = job; context.run.consoleOffset = 0; context.run.unknown = false; context.run.error = '';
      if (activeStatuses.has(job.status)) pollJob(context);
      else { listFiles(context); changed(context, 'execution'); }
    } catch (error) { context.run.error = error.message; }
    if (visible(context)) renderRun();
  }
  function renderPackages(fillInputs = false) {
    const context = current, packages = context?.packages;
    if (fillInputs) { field('pip').value = packages?.pip ?? ''; field('npm').value = packages?.npm ?? ''; field('package-consent').checked = packages?.consent ?? false; }
    field('pip').disabled = field('npm').disabled = field('package-consent').disabled = !context;
    field('package-load').disabled = !context || packages.loading || packages.saving;
    field('package-save').disabled = !context || packages.loading || packages.saving || !packages.consent || !runtimeReady() || runtime?.packages !== true;
    field('package-save').textContent = packages?.saving ? 'Validating…' : 'Validate and save';
    field('package-status').textContent = packages?.loading ? 'Loading package list…' : packages?.saving ? 'Package validation is running. File and code editors remain available.' : packages?.status || (runtime?.packages === false ? 'This runner does not provide package installation.' : 'Load the saved list before changing existing packages.');
    errorText(field('package-error'), packages?.error);
  }
  async function loadPackages() {
    const context = current, packages = context?.packages; if (!packages || packages.loading || packages.saving) return;
    if (packages.dirty && !confirm('Replace the unsaved package list with the server list?')) return;
    packages.loading = true; packages.error = ''; renderPackages();
    const original = [packages.pip, packages.npm];
    try {
      const result = await api(`${prefix(context)}/packages`);
      if (!Array.isArray(result.pip) || !Array.isArray(result.npm)) throw new Error('The server returned an invalid package list.');
      if (packages.pip === original[0] && packages.npm === original[1]) { packages.pip = result.pip.join('\n'); packages.npm = result.npm.join('\n'); packages.dirty = false; packages.loaded = true; packages.status = 'Saved package list loaded.'; }
      else packages.status = 'The package list changed while loading. Your edits were kept. Load again when ready.';
    } catch (error) { packages.error = error.message; }
    finally { packages.loading = false; if (visible(context)) renderPackages(true); }
  }
  async function savePackages() {
    const context = current, packages = context?.packages; if (!packages || field('package-save').disabled) return;
    if (!packages.loaded && !confirm('The saved package list has not been loaded. Replace it with the list shown here?')) return;
    const pip = packages.pip.split(/\r?\n/).map(value => value.trim()).filter(Boolean), npm = packages.npm.split(/\r?\n/).map(value => value.trim()).filter(Boolean), original = [packages.pip, packages.npm];
    packages.saving = true; packages.error = ''; renderPackages();
    try {
      const result = await api(`${prefix(context)}/packages`, 'POST', { pip, npm, allowPackages: true });
      context.run.job = result; context.run.consoleOffset = 0;
      if (!result.saved) { packages.error = `${result.error ?? 'Package validation failed.'} Execution: ${result.id}. The previous saved list is unchanged. See Console.`; return; }
      packages.loaded = true; packages.dirty = packages.pip !== original[0] || packages.npm !== original[1]; packages.status = packages.dirty ? 'The submitted package list was saved. Later edits are still unsaved.' : 'Packages validated and saved.'; changed(context, 'execution');
    } catch (error) { packages.error = `${error.message}${error.status === 0 ? ' The install result is unknown. Load the saved list before resubmitting.' : ''}`; }
    finally { packages.saving = false; if (visible(context)) { renderPackages(); renderRun(); } }
  }

  async function refresh() {
    const context = syncContext(); if (!dialog.open || !context) return;
    await listFiles(context);
    if (context.run.job && activeStatuses.has(context.run.job.status)) pollJob(context);
  }
  function close() { clearTimeout(pollTimer); for (const media of field('preview').querySelectorAll('audio, video')) media.pause(); releasePreview(); if (dialog.open) dialog.close(); }
  async function open() {
    if (opening) return; opening = true; launch.disabled = true;
    try {
      const conversation = await ensureConversation();
      if (!conversation?.id && !getConversation()?.id) throw new Error('A conversation is required for workspace files.');
      syncContext(); if (!dialog.open) dialog.showModal(); showContext();
      field(`${activeSection}-tab`).focus(); await Promise.all([refresh(), checkRuntime()]);
    } catch (error) { toast(error.message); }
    finally { opening = false; launch.disabled = false; }
  }
  launch.addEventListener('click', open); field('close').addEventListener('click', close);
  dialog.addEventListener('close', () => { clearTimeout(pollTimer); for (const media of field('preview').querySelectorAll('audio, video')) media.pause(); releasePreview(); });
  for (const name of ['files', 'run']) field(`${name}-tab`).addEventListener('click', () => selectSection(name));
  installTabKeys(['files', 'run'], selectSection);
  const selectView = name => { const draft = selected(current); if (!draft) return; draft.view = name; renderFile({ preserveInput: true }); if (name === 'history' && !draft.history) loadHistory(current, draft); };
  for (const name of ['edit', 'preview', 'history']) field(`${name}-tab`).addEventListener('click', () => selectView(name));
  installTabKeys(['edit', 'preview', 'history'], selectView);
  field('new').addEventListener('click', createFile); field('save').addEventListener('click', saveFile); field('delete').addEventListener('click', removeFile); field('discard').addEventListener('click', discardDraft);
  field('reload').addEventListener('click', () => { const draft = selected(current); if (draft) reloadFile(current, draft); });
  field('refresh').addEventListener('click', () => { if (current) current.error = ''; refresh(); }); field('upload').addEventListener('click', () => field('upload-input').click());
  field('upload-input').addEventListener('change', () => uploadFiles([...field('upload-input').files]));
  field('path').addEventListener('input', () => { const draft = selected(current); if (draft?.isNew) { draft.path = field('path').value; draft.conflict = false; renderList(); renderFile({ preserveInput: true }); } });
  field('editor').addEventListener('input', () => { const draft = selected(current); if (draft) { draft.text = field('editor').value; draft.notice = ''; renderList(); renderFile({ preserveInput: true }); } });
  field('search').addEventListener('input', () => { if (current) current.query = field('search').value; });
  field('search-form').addEventListener('submit', searchFiles);
  field('clear-search').addEventListener('click', () => { if (!current) return; current.searchSeq++; current.searching = false; current.results = null; current.query = ''; field('search').value = ''; renderList(); });
  field('preview').addEventListener('click', event => { const button = event.target.closest('[data-code-copy]'), code = button?.closest('.code-block')?.querySelector('pre code'); if (code) copyText(code.textContent, code); });
  field('language').addEventListener('change', () => { if (current) current.run.kind = field('language').value; });
  field('code').addEventListener('input', () => { if (current) { current.run.code = field('code').value; renderRun(); } });
  field('allow-packages').addEventListener('change', () => { if (current) { current.run.allowPackages = field('allow-packages').checked; renderRun(); } });
  field('run').addEventListener('click', startRun); field('stop').addEventListener('click', stopRun); field('recent').addEventListener('click', () => recentRuns()); field('runtime-refresh').addEventListener('click', checkRuntime);
  for (const name of ['pip', 'npm']) field(name).addEventListener('input', () => { if (current) { current.packages[name] = field(name).value; current.packages.dirty = true; } });
  field('package-consent').addEventListener('change', () => { if (current) { current.packages.consent = field('package-consent').checked; renderPackages(); } });
  field('package-load').addEventListener('click', loadPackages); field('package-save').addEventListener('click', savePackages);
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (activeSection === 'files') saveFile(); }
  });
  window.addEventListener('beforeunload', event => {
    if ([...sessions.values()].some(context => [...context.drafts.values()].some(dirty) || context.run.code.trim() || context.packages.dirty || context.packages.saving)) { event.preventDefault(); event.returnValue = ''; }
  });
  async function openFile(path, revision) { await open(); if (!current || !dialog.open) return; selectSection('files'); await openPath(current, path, { revision }); }
  async function openExecution(id) { await open(); if (!current || !dialog.open) return; selectSection('run'); await recoverJob(current, id); }
  async function openCode(code) {
    if (!code.trim() || utf8Size(code) > 64 * 1024) { toast('Python source must be nonempty and at most 64 KiB.'); return; }
    await open(); if (!current || !dialog.open) return;
    if (current.run.code && current.run.code !== code && !confirm('Replace the unsaved Run code draft with this Python source?')) return;
    current.run.kind = 'python'; current.run.code = code;
    // Review first. Opening source never executes it or changes package consent.
    selectSection('run'); renderRun(true); field('code').focus(); toast('Review the Python source, then press Run. No code has run yet.');
  }
  field('console-previous').addEventListener('click', () => { if (current) { current.run.consoleOffset = Math.max(0, current.run.consoleOffset - CONSOLE_CHARS); renderRun(); } });
  field('console-next').addEventListener('click', () => { if (current) { current.run.consoleOffset += CONSOLE_CHARS; renderRun(); } });
  field('console-download').addEventListener('click', () => {
    if (!current?.run.job) return;
    const url = URL.createObjectURL(new Blob([current.run.consoleText ?? ''], { type: 'text/plain' }));
    const link = node('a'); link.href = url; link.download = `execution-${current.run.job.id}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { refresh, close, openFile, openExecution, openCode };
}
