import { markdown, escape as esc } from './markdown.js';
const $ = selector => document.querySelector(selector);
const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plug: '<path d="m8 3 3 3m2-4 3 3M7 7l10 10M6 8l-2 2a4 4 0 0 0 6 6l2-2m1-7 3-3 4 4-3 3M4 20l3-3"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>', download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  sliders: '<path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  attach: '<path d="m9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8m-5 12 8-8"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.chat}</svg>`;
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
fillIcons();
const state = { conversation: null, providers: [], preferences: {}, list: [], busy: false, attachments: [], editing: null, retry: null, drafts: new Map(), openReasoning: new Set(), authenticated: false };
let events, toastTimer, searchTimer, listTimer, pendingCheck = false;
const selectedProvider = () => state.providers.find(p => p.id === $('#provider-select').value);
const routeId = () => location.hash.slice(1) || null;
const uuid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(path, method = 'GET', value) {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Chat-Request': '1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) }) });
  } catch { throw new ApiError(0, 'The chat server is unreachable. Your unsent draft remains on this page.'); }
  let data;
  try { data = await response.json(); } catch { throw new ApiError(0, 'The server response could not be read. Check the connection.'); }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login')) showLogin();
    throw new ApiError(response.status, data.error ?? `Request failed with HTTP ${response.status}.`);
  }
  return data;
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 10000);
}
function showLogin() {
  state.authenticated = false; events?.close();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  $('#app').hidden = true; $('#login-screen').hidden = false; $('#password').focus();
}
function applyTheme() {
  const theme = state.preferences.theme ?? 'system';
  document.documentElement.classList.toggle('dark', theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-select').value = theme;
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function rememberDraft() {
  state.drafts.set(state.conversation?.id ?? 'new', { text: $('#prompt').value, attachments: [...state.attachments], editing: state.editing });
}
function restoreDraft(cid) {
  const draft = state.drafts.get(cid ?? 'new') ?? {};
  $('#prompt').value = draft.text ?? ''; state.attachments = draft.attachments ?? []; state.editing = draft.editing ?? null;
  renderDraft();
}
function renderDraft() {
  $('#attachment-list').innerHTML = state.attachments.map(a => `<span class="attachment-chip"><span>${esc(a.name)}</span><button type="button" data-remove-file="${esc(a.id)}" aria-label="Remove ${esc(a.name)}">&times;</button></span>`).join('');
  $('#draft-banner').hidden = !state.editing && !state.retry;
  $('#draft-label').textContent = state.retry ? 'Send status is unknown. Retry uses the same request ID.' : state.editing ? 'Edit creates a new branch. The original stays saved.' : '';
  $('#cancel-edit').hidden = !!state.retry;
  $('#prompt').rows = Math.min(10, Math.max(2, $('#prompt').value.split('\n').length));
  updateControls();
}
function updateControls() {
  const running = !!state.conversation?.activeJob || state.conversation?.messages.some(m => m.status === 'streaming');
  $('#stop').hidden = !running;
  $('#stop').disabled = !state.conversation?.activeJob || state.busy;
  $('#send').hidden = running && !state.retry;
  $('#send').disabled = state.busy || (!state.retry && (running || !selectedProvider() || !$('#model-input').value.trim() || (!$('#prompt').value.trim() && !state.attachments.length)));
  $('#send').innerHTML = `${state.retry ? 'Retry send' : 'Send'}${icon('send')}`;
  $('#new-chat').disabled = state.busy || !!state.retry;
  $('#attach-button').disabled = state.busy || !!state.retry;
  $('#prompt').disabled = !!state.retry;
  $('#generation-button').disabled = state.busy || running;
}
function renderList() {
  const current = routeId();
  $('#conversation-list').innerHTML = state.list.length ? state.list.map(c => `<button class="chat-item ${c.id === current ? 'active' : ''}" data-conversation="${esc(c.id)}" ${c.id === current ? 'aria-current="page"' : ''}><span class="chat-title">${esc(c.title)}</span>${c.running ? '<small>Active</small>' : ''}</button>`).join('')
    : `<p class="muted sidebar-empty">${$('#search').value ? 'No matching conversations.' : 'Your conversations will appear here.'}</p>`;
}
async function refreshList() { if (!state.authenticated) return; state.list = await api(`/api/conversations?q=${encodeURIComponent($('#search').value)}`); renderList(); }
function scheduleList() { clearTimeout(listTimer); listTimer = setTimeout(() => refreshList().catch(e => toast(e.message)), 100); }
function pathMessages(c) {
  const map = new Map(c.messages.map(m => [m.id, m])), seen = new Set(), path = []; let leaf = c.activeLeaf;
  while (leaf && map.has(leaf) && !seen.has(leaf)) { seen.add(leaf); const m = map.get(leaf); path.push(m); leaf = m.parentId; }
  return path.reverse();
}
function messageHtml(m, c) {
  if (!m.content && !m.reasoning && m.role === 'system' && !m.attachments.length) return '';
  const siblings = c.messages.filter(x => x.parentId === m.parentId && x.role === m.role).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const index = siblings.findIndex(x => x.id === m.id), active = !!c.activeJob;
  const label = m.role === 'assistant' ? m.model ?? 'Assistant' : m.role === 'user' ? 'You' : m.role === 'tool' ? 'Imported tool record' : 'System';
  const files = m.attachments.map(a => a.kind === 'image'
    ? `<a href="/api/attachments/${encodeURIComponent(a.id)}" target="_blank" rel="noopener"><img class="attached-image" src="/api/attachments/${encodeURIComponent(a.id)}" alt="${esc(a.name)}" loading="lazy"></a>`
    : `<a class="file-link" href="/api/attachments/${encodeURIComponent(a.id)}" download="${esc(a.name)}">${esc(a.name)} <span class="muted">${Math.ceil(a.size / 1024)} KiB</span></a>`).join('');
  const thinking = m.reasoning ? `<details class="reasoning" data-reasoning="${esc(m.id)}" ${state.openReasoning.has(m.id) ? 'open' : ''}><summary>Reasoning</summary><div class="message-body">${markdown(m.reasoning)}</div></details>` : '';
  const status = m.status === 'complete' ? '' : `<span class="badge">${esc(m.status)}</span>`;
  const body = m.role === 'user' ? esc(m.content) : markdown(m.content);
  const actions = `<button data-copy="${esc(m.id)}">Copy</button>${m.role === 'user' ? `<button data-edit="${esc(m.id)}" ${active ? 'disabled' : ''}>Edit</button>` : ''}${m.role === 'assistant' ? `<button data-regenerate="${esc(m.id)}" ${active ? 'disabled' : ''}>Regenerate</button>` : ''}`;
  const branches = siblings.length > 1 ? `<button data-branch="${esc(siblings[Math.max(0,index-1)].id)}" ${index === 0 || active ? 'disabled' : ''}>Previous</button><span class="branch-count">${index+1} / ${siblings.length}</span><button data-branch="${esc(siblings[Math.min(siblings.length-1,index+1)].id)}" ${index === siblings.length-1 || active ? 'disabled' : ''}>Next</button>` : '';
  const error = m.metadata.error ? `<div class="message-error">${esc(m.metadata.error)}</div>` : '';
  const unsupported = m.metadata.unsupportedAttachments?.length ? `<div class="message-error">Archived attachments are retained in the export but cannot be sent: ${m.metadata.unsupportedAttachments.map(esc).join(', ')}.</div>` : '';
  const usage = m.metadata.usage?.completion_tokens;
  const meta = `${m.providerName ? esc(m.providerName) : ''}${usage !== undefined ? ` · ${esc(usage)} output tokens` : ''}${m.metadata.finishReason === 'length' ? ' · Output token limit reached' : ''}`;
  return `<article class="message ${esc(m.role)}" data-message="${esc(m.id)}"><div class="message-header"><strong>${esc(label)}</strong>${status}</div>${thinking}<div class="message-body">${body || (m.status === 'streaming' ? '<span class="muted">Generating...</span>' : '')}</div>${files ? `<div class="file-links">${files}</div>` : ''}${error}${unsupported}${meta ? `<div class="message-meta">${meta}</div>` : ''}<div class="message-actions">${actions}${branches}</div></article>`;
}
function renderThread(forceBottom = false) {
  const thread = $('#thread'), top = thread.scrollTop, bottom = thread.scrollHeight - top - thread.clientHeight < 110;
  const c = state.conversation, path = c ? pathMessages(c) : [];
  document.title = c ? `${c.title} | Common Chat` : 'Common Chat';
  if (!path.length) {
    thread.innerHTML = `<div id="empty-state"><div class="brand-mark">${icon('chat')}</div><h1>Your models. Your conversations.</h1><p class="muted">Chat with the model server you choose.<br>Pick up the same conversation on your next device.</p><div class="empty-actions"><button class="primary" data-open-connections>${icon('plug')}${state.providers.length ? 'Manage connections' : 'Add a connection'}</button><button data-import>${icon('upload')}Import your chats</button></div><div class="empty-detail small">Conversations and attachments stay on this chat server.<br>Model endpoints only receive the context you send.</div></div>`;
  } else thread.innerHTML = `<div class="thread-inner">${path.map(m => messageHtml(m, c)).join('')}</div>`;
  thread.scrollTop = forceBottom || bottom ? thread.scrollHeight : top;
  updateControls();
}
async function loadCurrent(forceBottom = false) {
  const cid = routeId(); if (!cid) return;
  const c = await api(`/api/conversations/${encodeURIComponent(cid)}`);
  if (cid !== routeId()) return;
  if (state.conversation?.id === cid && state.conversation.version > c.version) return;
  state.conversation = c; renderThread(forceBottom); renderList();
}
async function navigate(cid, known = null) {
  if (state.busy || state.retry) { toast('Finish the current submission before switching conversations.'); return; }
  rememberDraft();
  if (routeId() !== cid) history.pushState(null, '', cid ? `#${encodeURIComponent(cid)}` : location.pathname);
  state.conversation = known; restoreDraft(cid); $('#app').classList.remove('sidebar-open');
  if (cid && !known) {
    try { await loadCurrent(true); } catch (e) { toast(e.message); if (e.status === 404) { history.replaceState(null,'',location.pathname); state.conversation = null; renderThread(); } }
  } else renderThread(true);
  if (state.conversation) {
    const last = [...pathMessages(state.conversation)].reverse().find(m => m.providerId && state.providers.some(p => p.id === m.providerId));
    if (last) { $('#provider-select').value = last.providerId; $('#model-input').value = last.model ?? ''; loadModels(false).catch(() => {}); }
  }
  renderList(); updateControls(); $('#prompt').focus();
}
async function createConversation() {
  const c = await api('/api/conversations', 'POST', { title: 'New chat' });
  history.pushState(null, '', `#${c.id}`); state.conversation = c; return c;
}
async function newChat() {
  if (state.busy || state.retry) return;
  rememberDraft(); state.busy = true; updateControls();
  try {
    const c = await createConversation(); restoreDraft(c.id); renderThread(true); await refreshList();
    $('#app').classList.remove('sidebar-open'); $('#prompt').focus();
  } catch (e) { toast(e.message); } finally { state.busy = false; updateControls(); }
}
async function refreshProviders() {
  const selected = $('#provider-select').value;
  state.providers = await api('/api/providers');
  $('#provider-select').innerHTML = state.providers.length ? state.providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') : '<option value="">Add a connection</option>';
  const pid = state.providers.some(p => p.id === selected) ? selected : state.providers.some(p => p.id === state.preferences.providerId) ? state.preferences.providerId : state.providers[0]?.id ?? '';
  $('#provider-select').value = pid;
  if (!$('#model-input').value && state.preferences.providerId === pid) $('#model-input').value = state.preferences.model ?? '';
  const oldEdit = $('#edit-provider').value;
  $('#edit-provider').innerHTML = '<option value="">New connection</option>' + state.providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (state.providers.some(p => p.id === oldEdit)) $('#edit-provider').value = oldEdit;
  updateControls();
}
async function loadModels(notify = true) {
  const p = selectedProvider(); if (!p) { $('#model-options').innerHTML = ''; return; }
  try {
    const { models } = await api(`/api/providers/${encodeURIComponent(p.id)}/models`);
    if (selectedProvider()?.id !== p.id) return;
    $('#model-options').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
    if (!$('#model-input').value && models.length) $('#model-input').value = models[0];
    updateControls();
    if (notify) toast(`${models.length} model names loaded.`);
  } catch (e) { if (notify) toast(`${e.message} You can enter a model name directly.`); }
}
async function saveSelection() {
  try { state.preferences = await api('/api/preferences', 'PUT', { providerId: $('#provider-select').value, model: $('#model-input').value.trim() }); }
  catch (e) { toast(e.message); }
}
async function acknowledged(cid) {
  const regenerate = state.retry?.body.regenerate === true;
  state.retry = null;
  if (!regenerate) state.drafts.delete(cid);
  if (!regenerate && state.conversation?.id === cid) { $('#prompt').value = ''; state.attachments = []; state.editing = null; renderDraft(); }
  await loadCurrent(true); scheduleList();
}
async function checkPending() {
  if (!state.retry || pendingCheck) return;
  const pending = state.retry; pendingCheck = true;
  try {
    await api(`/api/requests/${encodeURIComponent(pending.body.requestId)}`);
    if (state.retry === pending) await acknowledged(pending.cid);
  } catch (e) { if (e.status !== 404 && e.status !== 0) toast(e.message); }
  finally { pendingCheck = false; }
}
async function sendMessage(event) {
  event?.preventDefault();
  if (state.busy || !state.retry && $('#send').disabled) return;
  state.busy = true; updateControls();
  let pending = state.retry;
  try {
    if (!pending) {
      const content = $('#prompt').value, attachmentIds = state.attachments.map(a => a.id);
      const providerId = $('#provider-select').value, model = $('#model-input').value.trim();
      const c = state.conversation ?? await createConversation();
      pending = { cid: c.id, body: { requestId: uuid(), expectedVersion: c.version, providerId, model,
        parentId: state.editing ? state.editing.parentId : c.activeLeaf, content, attachments: attachmentIds, settings: c.settings } };
    }
    state.retry = pending;
    await api(`/api/conversations/${encodeURIComponent(pending.cid)}/generate`, 'POST', pending.body);
    await acknowledged(pending.cid);
    saveSelection();
  } catch (e) {
    if (e.status !== 0) { state.retry = null; if (e.status === 409) await loadCurrent().catch(() => {}); }
    else checkPending();
    toast(e.message);
  } finally { state.busy = false; renderDraft(); }
}
async function regenerate(messageId) {
  if (state.busy || state.retry || !state.conversation || state.conversation.activeJob) return;
  const c = state.conversation, m = c.messages.find(m => m.id === messageId);
  if (!m?.parentId) return;
  state.busy = true; updateControls();
  const pending = { cid: c.id, body: { requestId: uuid(), expectedVersion: c.version, providerId: $('#provider-select').value,
    model: $('#model-input').value.trim(), parentId: m.parentId, regenerate: true, settings: c.settings } };
  try {
    state.retry = pending;
    await api(`/api/conversations/${c.id}/generate`, 'POST', pending.body);
    state.retry = null; await loadCurrent();
  } catch (e) {
    if (e.status !== 0) { state.retry = null; if (e.status === 409) await loadCurrent().catch(() => {}); }
    toast(e.message);
  } finally { state.busy = false; renderDraft(); }
}
async function selectBranch(messageId) {
  if (state.busy || state.retry || state.conversation?.activeJob) return;
  const c = state.conversation; let leaf = messageId, seen = new Set();
  while (!seen.has(leaf)) {
    seen.add(leaf);
    const children = c.messages.filter(m => m.parentId === leaf).sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
    if (!children.length) break; leaf = children.at(-1).id;
  }
  try {
    state.conversation = await api(`/api/conversations/${c.id}`, 'PATCH', { expectedVersion: c.version, activeLeaf: leaf });
    renderThread();
  } catch (e) { toast(e.message); if (e.status === 409) await loadCurrent().catch(() => {}); }
}
function beginEdit(mid) {
  if (state.busy || state.retry || state.conversation?.activeJob) return;
  const m = state.conversation.messages.find(m => m.id === mid);
  if (!m) return;
  if (($('#prompt').value.trim() || state.attachments.length) && !confirm('Replace the unsent draft with this message?')) return;
  state.editing = { id: m.id, parentId: m.parentId }; $('#prompt').value = m.content;
  state.attachments = m.attachments.map(a => ({ ...a, existing: true })); renderDraft(); rememberDraft(); $('#prompt').focus();
}
async function copyMessage(mid) {
  const content = state.conversation?.messages.find(m => m.id === mid)?.content ?? '';
  try { await navigator.clipboard.writeText(content); toast('Message copied.'); }
  catch { toast('Clipboard access requires HTTPS or localhost. Select the message text and copy it.'); }
}
function openConnections() {
  $('#edit-provider').value = selectedProvider()?.id ?? '';
  fillConnectionForm(); $('#connections-dialog').showModal();
}
function fillConnectionForm() {
  const p = state.providers.find(p => p.id === $('#edit-provider').value);
  $('#connection-name').value = p?.name ?? ''; $('#connection-url').value = p?.baseUrl ?? '';
  $('#connection-key').value = ''; $('#connection-clear-key').checked = false;
  $('#connection-key').placeholder = p?.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Optional API key';
  $('#connection-models').value = p?.models.join('\n') ?? '';
  for (const key of ['streaming','vision','systemPrompt','temperature','topP','maxTokens']) $('#cap-'+key).checked = p ? p.capabilities[key] : key !== 'vision';
  $('#token-parameter').value = p?.capabilities.tokenParameter ?? 'max_tokens';
  $('#connection-error').textContent = ''; $('#delete-provider').hidden = !p;
}
async function saveProvider(event) {
  event.preventDefault(); $('#save-provider').disabled = true;
  const pid = $('#edit-provider').value, capabilities = {};
  for (const key of ['streaming','vision','systemPrompt','temperature','topP','maxTokens']) capabilities[key] = $('#cap-'+key).checked;
  capabilities.tokenParameter = $('#token-parameter').value;
  try {
    const p = await api(pid ? `/api/providers/${pid}` : '/api/providers', pid ? 'PUT' : 'POST', {
      name: $('#connection-name').value, baseUrl: $('#connection-url').value, apiKey: $('#connection-key').value,
      clearKey: $('#connection-clear-key').checked, models: $('#connection-models').value.split('\n').map(s => s.trim()).filter(Boolean), capabilities
    });
    $('#connection-key').value = ''; await refreshProviders(); $('#provider-select').value = p.id;
    $('#model-input').value = p.models[0] ?? ''; $('#connections-dialog').close();
    await loadModels(false); saveSelection(); renderThread(); toast('Connection saved.');
  } catch (e) { $('#connection-error').textContent = e.message; }
  finally { $('#save-provider').disabled = false; }
}
async function openGeneration() {
  if (!selectedProvider()) { openConnections(); return; }
  if (state.conversation?.activeJob || state.busy) return;
  try {
    if (!state.conversation) { await createConversation(); renderThread(); scheduleList(); }
    const opts = state.conversation.settings, caps = selectedProvider().capabilities;
    $('#system-prompt').value = opts.systemPrompt ?? '';
    $('#temperature').value = opts.temperature ?? ''; $('#top-p').value = opts.topP ?? ''; $('#max-tokens').value = opts.maxTokens ?? '';
    for (const key of ['systemPrompt','temperature','topP','maxTokens']) $('#field-'+key).hidden = !caps[key];
    $('#generation-error').textContent = ''; $('#generation-dialog').showModal();
  } catch (e) { toast(e.message); }
}
async function saveGeneration(event) {
  event.preventDefault(); const caps = selectedProvider()?.capabilities ?? {}, opts = {}, c = state.conversation;
  if (caps.systemPrompt) opts.systemPrompt = $('#system-prompt').value;
  for (const [key, selector] of [['temperature','#temperature'], ['topP','#top-p'], ['maxTokens','#max-tokens']]) {
    if (caps[key] && $(selector).value !== '') opts[key] = Number($(selector).value);
  }
  try {
    state.conversation = await api(`/api/conversations/${c.id}`, 'PATCH', { expectedVersion: c.version, settings: opts });
    $('#generation-dialog').close(); toast('Conversation settings saved.');
  } catch (e) { $('#generation-error').textContent = e.message; if (e.status === 409) await loadCurrent().catch(() => {}); }
}
async function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
  });
}
async function uploadFiles(files) {
  if (state.busy || state.retry) return;
  state.busy = true; updateControls();
  try {
    if (state.attachments.length + files.length > 10) throw new Error('Attach at most ten files to each message.');
    const c = state.conversation ?? await createConversation();
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB.`);
      const mime = file.type || 'text/plain';
      const data = await readAsBase64(file);
      const a = await api(`/api/conversations/${c.id}/attachments`, 'POST', { name: file.name, mime, data });
      state.attachments.push(a); renderDraft(); rememberDraft();
    }
    scheduleList(); renderThread();
  } catch (e) { toast(e.message); }
  finally { state.busy = false; $('#file-input').value = ''; renderDraft(); }
}
async function importFile(file) {
  if (!file) return;
  if (file.size > 24 * 1024 * 1024) { toast('Import files must not exceed 24 MiB. Split larger exports.'); return; }
  $('#import-button').disabled = true;
  try {
    const result = await api('/api/import', 'POST', { name: file.name, data: await readAsBase64(file) });
    $('#import-output').textContent = `Imported ${result.conversations} conversations and ${result.messages} messages.\n\n${result.warnings.length ? result.warnings.join('\n\n') : 'Branch relationships and supported attachments were imported.'}`;
    $('#import-dialog').showModal(); await refreshList();
    if (!state.conversation && result.conversationIds.length) await navigate(result.conversationIds[0]);
  } catch (e) { toast(e.message); }
  finally { $('#import-button').disabled = false; $('#import-input').value = ''; }
}
async function download(path, filename) {
  try {
    const data = await api(path), blob = new Blob([JSON.stringify(data)], { type:'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message); }
}
function connectEvents() {
  events?.close(); events = new EventSource('/api/events');
  events.onopen = () => { $('#sync-status').textContent = 'Connected to server'; };
  events.onerror = () => {
    $('#sync-status').textContent = 'Reconnecting to server';
    api('/api/session').catch(() => {});
  };
  events.onmessage = async event => {
    try {
      const change = JSON.parse(event.data);
      if (change.type === 'hello') {
        await Promise.all([refreshList(), refreshProviders(), loadCurrent()]); checkPending();
      } else if (change.type === 'providers') { await refreshProviders(); await loadModels(false); }
      else if (change.type === 'preferences') { const session = await api('/api/session'); state.preferences = session.settings; applyTheme(); }
      else if (change.type === 'deleted') {
        if (change.conversationId === state.conversation?.id) {
          rememberDraft(); history.replaceState(null,'',location.pathname); state.conversation = null; restoreDraft(null); renderThread();
          toast('This conversation was deleted on another device.');
        }
        scheduleList();
      } else if (change.type === 'delta') {
        const c = state.conversation;
        if (c?.id === change.conversationId && change.version >= c.version) {
          const index = c.messages.findIndex(m => m.id === change.message.id);
          if (index >= 0) c.messages[index] = change.message;
          else { await loadCurrent(); return; }
          c.version = change.version; renderThread();
        }
      } else if (change.type === 'changed') {
        scheduleList();
        if (!change.conversationId || change.conversationId === state.conversation?.id || change.conversationId === routeId()) await loadCurrent();
        checkPending();
      }
    } catch (e) { if (e.status !== 0) toast(e.message); }
  };
}
async function boot() {
  try {
    const session = await api('/api/session'); state.preferences = session.settings; state.authenticated = true;
    applyTheme(); $('#login-screen').hidden = true; $('#app').hidden = false;
    $('#logout').hidden = session.authenticationRequired === false;
    await Promise.all([refreshList(), refreshProviders()]); await loadModels(false);
    if (routeId()) await navigate(routeId()); else renderThread();
    connectEvents();
  } catch (e) { showLogin(); if (e.status !== 401) $('#login-error').textContent = e.message; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-button').disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', 'POST', { password: $('#password').value }); $('#password').value = ''; await boot(); }
  catch (e) { $('#login-error').textContent = e.message; }
  finally { $('#login-button').disabled = false; }
});
$('#composer').addEventListener('submit', sendMessage);
$('#prompt').addEventListener('input', () => { renderDraft(); rememberDraft(); });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
$('#new-chat').addEventListener('click', newChat);
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshList().catch(e => toast(e.message)), 200); });
$('#conversation-list').addEventListener('click', event => { const b = event.target.closest('[data-conversation]'); if (b) navigate(b.dataset.conversation); });
$('#provider-select').addEventListener('change', async () => { $('#model-input').value = ''; await loadModels(false); saveSelection(); updateControls(); });
$('#model-input').addEventListener('input', updateControls);
$('#model-input').addEventListener('change', saveSelection);
$('#refresh-models').addEventListener('click', () => loadModels());
$('#connections-button').addEventListener('click', openConnections);
$('#connection-form').addEventListener('submit', saveProvider);
$('#edit-provider').addEventListener('change', fillConnectionForm);
$('#delete-provider').addEventListener('click', async () => {
  const pid = $('#edit-provider').value; if (!pid || !confirm('Delete this model connection? Existing messages will remain.')) return;
  try { await api(`/api/providers/${pid}`, 'DELETE'); await refreshProviders(); $('#edit-provider').value = ''; fillConnectionForm(); }
  catch (e) { $('#connection-error').textContent = e.message; }
});
$('#generation-button').addEventListener('click', openGeneration);
$('#generation-form').addEventListener('submit', saveGeneration);
$('#reset-generation').addEventListener('click', () => { for (const s of ['#system-prompt','#temperature','#top-p','#max-tokens']) $(s).value = ''; });
$('#preferences-button').addEventListener('click', () => $('#preferences-dialog').showModal());
$('#theme-select').addEventListener('change', async () => {
  try { state.preferences = await api('/api/preferences','PUT',{ theme: $('#theme-select').value }); applyTheme(); }
  catch(e) { toast(e.message); }
});
$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout','POST');
    state.drafts.clear(); state.conversation = null; state.attachments = []; state.editing = null; state.retry = null;
    $('#prompt').value = ''; $('#thread').innerHTML = ''; $('#conversation-list').innerHTML = ''; showLogin();
  } catch(e) { toast(e.message); }
});
$('#attach-button').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', () => uploadFiles([...$('#file-input').files]));
$('#prompt').addEventListener('paste', event => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); uploadFiles(files); } });
$('#composer').addEventListener('dragover', event => { event.preventDefault(); });
$('#composer').addEventListener('drop', event => { event.preventDefault(); uploadFiles([...event.dataTransfer.files]); });
$('#attachment-list').addEventListener('click', async event => {
  const b = event.target.closest('[data-remove-file]'); if (!b || state.busy || state.retry) return;
  const a = state.attachments.find(a => a.id === b.dataset.removeFile);
  try { if (!a.existing) await api(`/api/attachments/${a.id}`, 'DELETE'); state.attachments = state.attachments.filter(x => x.id !== a.id); renderDraft(); rememberDraft(); }
  catch (e) { toast(e.message); }
});
$('#cancel-edit').addEventListener('click', () => { state.editing = null; state.attachments = []; $('#prompt').value = ''; renderDraft(); rememberDraft(); });
$('#stop').addEventListener('click', async () => { try { if (state.conversation?.activeJob) await api(`/api/jobs/${state.conversation.activeJob.id}/cancel`, 'POST'); } catch (e) { toast(e.message); } });
$('#thread').addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b) return;
  if ('openConnections' in b.dataset) openConnections();
  if ('import' in b.dataset) $('#import-input').click();
  if (b.dataset.copy) copyMessage(b.dataset.copy);
  if (b.dataset.edit) beginEdit(b.dataset.edit);
  if (b.dataset.regenerate) regenerate(b.dataset.regenerate);
  if (b.dataset.branch) selectBranch(b.dataset.branch);
});
$('#thread').addEventListener('toggle', event => {
  const target = event.target;
  if (!target.dataset.reasoning) return;
  if (target.open) state.openReasoning.add(target.dataset.reasoning); else state.openReasoning.delete(target.dataset.reasoning);
}, true);
$('#import-button').addEventListener('click', () => $('#import-input').click());
$('#import-input').addEventListener('change', () => importFile($('#import-input').files[0]));
$('#export-all').addEventListener('click', () => download('/api/export', 'common-chat-export.json'));
$('#conversation-button').addEventListener('click', () => {
  if (!state.conversation) { toast('Create or open a conversation first.'); return; }
  $('#conversation-title').value = state.conversation.title; $('#conversation-error').textContent = '';
  $('#delete-conversation').disabled = !!state.conversation.activeJob; $('#conversation-dialog').showModal();
});
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault(); const c = state.conversation;
  try { state.conversation = await api(`/api/conversations/${c.id}`, 'PATCH', { expectedVersion: c.version, title: $('#conversation-title').value }); $('#conversation-dialog').close(); renderThread(); scheduleList(); }
  catch (e) { $('#conversation-error').textContent = e.message; if (e.status === 409) await loadCurrent().catch(() => {}); }
});
$('#export-conversation').addEventListener('click', () => { if (state.conversation) download(`/api/conversations/${state.conversation.id}/export`, 'conversation.common-chat.json'); });
$('#delete-conversation').addEventListener('click', async () => {
  const c = state.conversation; if (!c || !confirm('Permanently delete this conversation, all branches, and its attachments?')) return;
  try {
    await api(`/api/conversations/${c.id}`, 'DELETE', { expectedVersion: c.version }); $('#conversation-dialog').close();
    state.drafts.delete(c.id); history.replaceState(null,'',location.pathname); state.conversation = null; restoreDraft(null); renderThread(); await refreshList();
  } catch(e) { $('#conversation-error').textContent = e.message; if (e.status === 409) await loadCurrent().catch(() => {}); }
});
$('#sidebar-toggle').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));
$('#sidebar-backdrop').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
window.addEventListener('hashchange', () => { if (state.authenticated) navigate(routeId()); });
window.addEventListener('online', () => { if (state.authenticated) { connectEvents(); checkPending(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) { loadCurrent().catch(() => {}); refreshList().catch(() => {}); checkPending(); } });
document.addEventListener('keydown', event => {
  if (!state.authenticated || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#app').classList.add('sidebar-open'); $('#search').focus(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newChat(); }
});
window.addEventListener('beforeunload', event => { if ($('#prompt').value.trim() || state.retry) { event.preventDefault(); event.returnValue = ''; } });
boot();
