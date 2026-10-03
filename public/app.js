import { markdown, escape as esc } from './markdown.js';
import { renderDiagrams, cancelDiagrams } from './diagrams.js';
import { installSidebarGestures } from './touch.js';
import { installPreviews, cancelPreviews } from './previews.js';
import { installWorkspace } from './workspace.js';
import { installMediaControls, writeMediaCapabilities, readMediaCapabilities, updateMediaHints, validateUpload, attachmentHtml } from './media.js';
import { installToolControls, toolActivityHtml, generatedFilesHtml } from './tool-controls.js';
import { createDraftStore, DRAFT_LOGOUT_KEY } from './drafts.js';
import { installShell } from './ui-shell.js';
import { installThinkingControls, readThinkingCapabilities, writeThinkingCapabilities, writeThinkingSetting } from './thinking.js';
import { installConnectionStatus } from './connection-status.js';
import { installModelControls } from './model-controls.js';
import { installDictationSettings } from './dictation-settings.js';
import { installDictation } from './dictation.js';
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
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L20 8l-5-5L4 14v6Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>', previous: '<path d="m14 5-7 7 7 7"/>', next: '<path d="m10 5 7 7-7 7"/>',
  model: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  thinking: '<path d="M9 18H8a4 4 0 0 1-4-4 4 4 0 0 1 1-7 4 4 0 0 1 7-3 4 4 0 0 1 7 3 4 4 0 0 1 1 7 4 4 0 0 1-4 4h-1M12 4v16M8 8l4 2 4-2M8 14l4-2 4 2"/>',
  microphone: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  tools: '<path d="m14 6 4-4a6 6 0 0 1-7 8L3 18a2 2 0 0 0 3 3l8-8a6 6 0 0 0 8-7l-4 4-4-4Z"/>',
  files: '<path d="M3 6h7l2 2h9v12H3V6Z"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  appearance: '<path d="M12 3a9 9 0 0 0 0 18 9 9 0 0 0 0-18ZM12 3v18"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',
  logout: '<path d="M10 3H4v18h6M9 12h12m-5-5 5 5-5 5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.chat}</svg>`;
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
fillIcons();
let draftWarning = '';
const drafts = createDraftStore({ onWarning: message => { draftWarning = message; renderDraftStatus(); } });
const state = { conversation: null, providers: [], preferences: {}, list: [], busy: false, attachments: [], editing: null, retry: null, draftKey: undefined, loading: false, missing: false, openReasoning: new Set(), openStats: new Set(), openTools: new Set(), authenticated: false };
const connectionStatus = installConnectionStatus();
let syncReconnectTimer, syncDisconnectedAt = 0;
let events, toastTimer, searchTimer, listTimer, pendingCheck = false, workspaceUI, toolControls, thinkingControls, shellUI, modelControls, dictationUI, dictationSettings;
let composerEpoch = 0;
let actionConversation = null, actionLoad = 0, actionReading = false, deletingConversation = null;
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
async function api(path, method = 'GET', value, { signal } = {}) {
  let response;
  try {
    response = await fetch(path, { method, signal, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Chat-Request': '1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value ?? {}) }) });
  } catch (error) { if (signal?.aborted) throw error; throw new ApiError(0, 'The chat server is unreachable. Your unsent draft remains on this page.'); }
  let data;
  try { data = await response.json(); } catch (error) { if (signal?.aborted) throw error; throw new ApiError(0, 'The server response could not be read. Check the connection.'); }
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
function invalidateDictation() { composerEpoch++; if (dictationUI?.isBusy()) dictationUI.cancel(); }
function dictationSelection() {
  const choice = state.preferences.dictation;
  const p = state.providers.find(item => item.id === choice?.providerId);
  return p && choice?.model ? { ...choice, name: p.name } : null;
}
function canDictate() {
  return state.authenticated && !state.busy && !state.loading && !state.missing && !state.retry && !editTargetMissing()
    && state.draftKey !== undefined && (!state.draftKey || state.conversation?.id === state.draftKey);
}
function showLogin() {
  invalidateDictation();
  state.authenticated = false; events?.close(); clearTimeout(syncReconnectTimer); cancelDiagrams(); cancelPreviews();
  connectionStatus.sync('unknown', 'sign in required.'); connectionStatus.clear();
  workspaceUI?.close(); toolControls?.clear(); thinkingControls?.close(); shellUI?.closePopups(); modelControls?.clear();
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
function currentDraft() {
  return { text: $('#prompt').value, attachments: state.attachments, editing: state.editing, retry: state.retry };
}
function rememberDraft() {
  if (state.draftKey !== undefined && state.authenticated) return drafts.set(state.draftKey, currentDraft());
  return true;
}
function restoreDraft(cid) {
  invalidateDictation();
  state.draftKey = cid; state.missing = false;
  const draft = drafts.get(cid) ?? {};
  $('#prompt').value = draft.text ?? ''; state.attachments = draft.attachments ?? []; state.editing = draft.editing ?? null; state.retry = draft.retry ?? null;
  renderDraft();
  validateAttachments();
}
function renderDraftStatus() {
  const footer = $('.composer-footer');
  footer.textContent = draftWarning; footer.hidden = !draftWarning;
  footer.setAttribute('role', 'status');
}
async function validateAttachments() {
  const cid = state.draftKey, attachments = state.attachments;
  if (!attachments.length || state.retry || !state.authenticated) return;
  await Promise.all(attachments.map(async a => {
    try {
      // The API has no metadata-only file route. Stop reading after the status.
      const response = await fetch(`/api/attachments/${encodeURIComponent(a.id)}`, { credentials: 'same-origin', cache: 'no-store' });
      response.body?.cancel().catch(() => {});
      if (cid !== state.draftKey || attachments !== state.attachments) return;
      a.missing = response.status === 404;
      a.unchecked = !response.ok && !a.missing;
      if (response.status === 401) showLogin();
    } catch { if (attachments === state.attachments) a.unchecked = true; }
  }));
  if (cid === state.draftKey && attachments === state.attachments) renderDraft();
}
function editTargetMissing() {
  return state.editing && state.conversation && !state.conversation.messages.some(m => m.id === state.editing.id && m.role === 'user' && m.parentId === state.editing.parentId);
}
function renderDraft() {
  $('#attachment-list').innerHTML = state.attachments.map(a => `<span class="attachment-chip"><span>${esc(a.name)}${a.missing ? ' (missing, remove and attach again)' : a.unchecked ? ' (not verified)' : ''}</span><button type="button" class="ghost icon" data-remove-file="${esc(a.id)}" aria-label="Remove ${esc(a.name)}" title="Remove ${esc(a.name)}">${icon('close')}</button></span>`).join('');
  const hasDraft = !!($('#prompt').value || state.attachments.length || state.editing);
  const warning = state.retry ? 'Send status is unknown. Retry uses the same request ID.' : state.missing ? 'This conversation is unavailable. Your draft is kept at this address. Copy its text to a new chat.' : editTargetMissing() ? 'The edited message is unavailable. Copy this draft to a new chat or cancel the edit.' : state.editing ? 'Edit creates a new branch. The original stays saved.' : '';
  $('#draft-banner').hidden = !warning; $('#draft-label').textContent = warning;
  $('#cancel-edit').hidden = !!state.retry || !hasDraft;
  const discardLabel = state.editing ? 'Cancel edit' : 'Discard draft';
  $('#cancel-edit').setAttribute('aria-label', discardLabel); $('#cancel-edit').title = discardLabel;
  $('#cancel-edit').disabled = state.busy;
  $('#prompt').rows = Math.min(10, Math.max(2, $('#prompt').value.split('\n').length));
  renderDraftStatus(); updateControls();
}
function updateControls() {
  toolControls?.refresh(); thinkingControls?.refresh(); dictationUI?.refresh(); modelControls?.refresh(); updateMediaHints(selectedProvider());
  const unavailable = state.loading || state.missing || !!state.draftKey && state.conversation?.id !== state.draftKey;
  const running = !!state.conversation?.activeJob || state.conversation?.messages.some(m => m.status === 'streaming');
  const locked = state.busy || state.loading || !!state.retry;
  $('#stop').hidden = !running;
  $('#stop').disabled = !state.conversation?.activeJob || state.busy;
  $('#send').hidden = running && !state.retry;
  $('#send').disabled = dictationUI?.isBusy() || state.busy || state.loading || (!state.retry && (unavailable || editTargetMissing() || state.attachments.some(a => a.missing) || running || !selectedProvider() || !$('#model-input').value.trim() || (!$('#prompt').value.trim() && !state.attachments.length)));
  const sendLabel = state.retry ? 'Retry send' : 'Send';
  $('#send').innerHTML = icon('send'); $('#send').title = sendLabel; $('#send').setAttribute('aria-label', sendLabel);
  $('#new-chat').disabled = state.busy || !!state.retry;
  $('#attach-button').disabled = state.busy || unavailable || !!state.retry;
  $('#prompt').disabled = state.busy || !!state.retry;
  $('#provider-select').disabled = locked; $('#model-input').disabled = locked; $('#model-button').disabled = locked;
  const model = $('#model-input').value.trim();
  connectionStatus.select(selectedProvider()?.id, model);
  const displayModel = modelControls?.label() ?? model;
  $('#model-button').title = model ? `Model: ${displayModel} (${model})` : 'Select model';
  $('#model-button').setAttribute('aria-label', $('#model-button').title); $('#active-model').textContent = displayModel || 'Not selected';
  $('#refresh-models').disabled = locked || !selectedProvider(); $('#settings-model-button').disabled = locked;
  $('#generation-button').disabled = locked || unavailable || running;
  const generationLocked = locked || unavailable || running || !selectedProvider();
  $('#generation-form').querySelectorAll('input, textarea, button').forEach(control => { control.disabled = generationLocked; });
  $('#thinking-level').disabled = generationLocked || $('#thinking-field').hidden;
  $('#generation-status').textContent = !selectedProvider() ? 'Select a connection before saving generation settings.'
    : running ? 'A response is active. Wait for it to finish before changing generation settings.'
    : unavailable ? 'This conversation is unavailable. Your draft stays saved.'
    : 'Settings apply to this conversation. Blank fields use provider defaults.';
  updateConversationActions();
}
function renderList() {
  const current = routeId();
  $('#conversation-list').innerHTML = state.list.length ? state.list.map(c => `<div class="chat-row ${c.id === current ? 'active' : ''}"><button type="button" class="chat-item" data-conversation="${esc(c.id)}" title="${esc(c.title)}" ${c.id === current ? 'aria-current="page"' : ''}><span class="chat-title">${esc(c.title)}</span>${c.running ? '<span class="chat-running" aria-label="Active generation" title="Active generation"></span>' : ''}</button><button type="button" class="ghost icon chat-actions" data-chat-actions="${esc(c.id)}" aria-label="Actions for ${esc(c.title)}" title="Actions for ${esc(c.title)}" aria-haspopup="dialog" aria-controls="conversation-dialog">${icon('more')}</button></div>`).join('')
    : `<p class="muted sidebar-empty">${$('#search').value ? 'No matching conversations.' : 'No conversations yet.'}</p>`;
}
async function refreshList() { if (!state.authenticated) return; state.list = await api(`/api/conversations?q=${encodeURIComponent($('#search').value)}`); renderList(); }
function scheduleList() { clearTimeout(listTimer); listTimer = setTimeout(() => refreshList().catch(e => toast(e.message)), 100); }
function pathMessages(c) {
  const map = new Map(c.messages.map(m => [m.id, m])), seen = new Set(), path = []; let leaf = c.activeLeaf;
  while (leaf && map.has(leaf) && !seen.has(leaf)) { seen.add(leaf); const m = map.get(leaf); path.push(m); leaf = m.parentId; }
  return path.reverse();
}
function statisticsHtml(m) {
  if (m.role !== 'assistant') return '';
  const { usage = {}, timings = {}, observed = {}, promptProgress = {} } = m.metadata;
  const valid = (n, integer = false) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(n));
  const count = n => valid(n, true) ? String(n) : 'unavailable';
  const rate = n => valid(n) ? `${n.toFixed(2)} tokens/s` : 'unavailable';
  const seconds = n => valid(n) ? `${(n / 1000).toFixed(2)} s` : 'unavailable';
  const metric = (label, value, help) => `<div title="${esc(help)}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  const u = usage ?? {}, t = timings ?? {}, o = observed ?? {}, p = promptProgress ?? {};
  const promptRate = m.status === 'streaming' && t.prompt_n === 0 && t.prompt_per_second === 0 ? 'pending' : rate(t.prompt_per_second);
  const generationRate = m.status === 'streaming' && t.predicted_n === 0 && t.predicted_per_second === 0 ? 'pending' : rate(t.predicted_per_second);
  const hasProgress = valid(p.total, true) && valid(p.processed, true) && p.processed <= p.total;
  const progress = hasProgress ? `${p.processed} / ${p.total} tokens${p.total > 0 ? ` (${(100 * p.processed / p.total).toFixed(1)}%)` : ''}` : 'unavailable';
  const inputFromUsage = valid(u.prompt_tokens, true), outputFromUsage = valid(u.completion_tokens, true);
  const items = [
    metric('PP', promptRate, 'Prompt-processing speed reported by the model server. Not estimated from chat duration.'),
    metric('TG', generationRate, 'Token-generation speed reported by the model server. Includes reasoning when the provider counts it.'),
    metric(inputFromUsage || !valid(t.prompt_n, true) ? 'Input tokens' : 'Input tokens (timed)', count(inputFromUsage ? u.prompt_tokens : t.prompt_n), 'Upstream prompt_tokens, or prompt_n if usage is absent. The timed count can exclude cached input.'),
    metric('Output tokens', count(outputFromUsage ? u.completion_tokens : t.predicted_n), 'Upstream completion_tokens, or predicted_n if usage is absent. For llama.cpp this includes reasoning, not just the visible answer. Other providers define their own token counts.'),
    metric(m.status === 'streaming' ? 'Elapsed (server)' : 'Duration (server)', seconds(o.durationMs), 'Chat server observation from the model request start to response end or failure. Includes queue, transport, and response processing time.'),
    metric('First text', o.responseMode === 'non-streaming' ? 'unavailable (non-streaming)' : seconds(o.firstTextMs), 'Chat server observation from request start to the first nonempty answer or reasoning delta. A buffered JSON response cannot expose this latency.')
  ];
  if (hasProgress) items.push(metric('Prompt progress', progress, 'Prompt processing reported by the model server. Processed includes cached tokens. This is the last recorded sample, not an estimated token count.'),
    metric('Prompt cached tokens', count(p.cache), 'Cached prompt tokens reported in the upstream progress sample.'),
    metric('Prompt elapsed (upstream)', seconds(p.time_ms), 'Elapsed prompt-processing time reported by the model server in the last progress sample.'));
  if (valid(u.completion_tokens_details?.reasoning_tokens, true)) items.push(metric('Reasoning tokens', count(u.completion_tokens_details.reasoning_tokens), 'Reasoning token count reported separately by the provider. Not estimated from reasoning text.'));
  if (valid(t.draft_n, true) || valid(t.draft_n_accepted, true)) items.push(metric('MTP accepted / drafted', `${count(t.draft_n_accepted)} / ${count(t.draft_n)}`, 'Multi-token prediction (MTP) counts reported by the model server. Accepted draft tokens / proposed draft tokens.'));
  return `<details class="message-stats" data-stats="${esc(m.id)}" ${state.openStats.has(m.id) ? 'open' : ''}><summary title="Expand or collapse generation statistics"><span>PP ${esc(promptRate)}</span><span>TG ${esc(generationRate)}</span>${m.status === 'streaming' && hasProgress ? `<span>Prompt ${esc(progress)}</span>` : ''}</summary><dl>${items.slice(2).join('')}</dl>${m.status === 'streaming' ? '<p>Live upstream statistics. Values can change until the response ends. Unavailable fields need upstream support.</p>' : ''}<p>PP/TG: upstream. Duration/first text: chat server. First text includes reasoning. llama.cpp output counts include reasoning. Unavailable means not reported or not recorded.</p></details>`;
}
function messageHtml(m, c) {
  if (!m.content && !m.reasoning && m.role === 'system' && !m.attachments.length) return '';
  const siblings = c.messages.filter(x => x.parentId === m.parentId && x.role === m.role).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const index = siblings.findIndex(x => x.id === m.id), active = !!c.activeJob;
  const label = m.role === 'assistant' ? m.model ?? 'Assistant' : m.role === 'user' ? 'You' : m.role === 'tool' ? 'Imported tool record' : 'System';
  const files = m.attachments.map(attachmentHtml).join('');
  const thinking = m.reasoning ? `<details class="reasoning" data-reasoning="${esc(m.id)}" ${state.openReasoning.has(m.id) ? 'open' : ''}><summary>Reasoning</summary><div class="message-body">${markdown(m.reasoning, { streaming: m.status === 'streaming', conversationId: c.id })}</div></details>` : '';
  const status = m.status === 'complete' ? '' : `<span class="badge">${esc(m.status)}</span>`;
  const body = m.role === 'user' ? esc(m.content) : markdown(m.content, { streaming: m.status === 'streaming', conversationId: c.id });
  const actions = `<button type="button" class="ghost icon" data-copy="${esc(m.id)}" aria-label="Copy message" title="Copy message">${icon('copy')}</button>${m.role === 'user' ? `<button type="button" class="ghost icon" data-edit="${esc(m.id)}" aria-label="Edit message" title="Edit message" ${active ? 'disabled' : ''}>${icon('edit')}</button>` : ''}${m.role === 'assistant' ? `<button type="button" class="ghost icon" data-regenerate="${esc(m.id)}" aria-label="Regenerate response" title="Regenerate response" ${active ? 'disabled' : ''}>${icon('refresh')}</button>` : ''}`;
  const branches = siblings.length > 1 ? `<button type="button" class="ghost icon" data-branch="${esc(siblings[Math.max(0,index-1)].id)}" aria-label="Previous branch" title="Previous branch" ${index === 0 || active ? 'disabled' : ''}>${icon('previous')}</button><span class="branch-count">${index+1} / ${siblings.length}</span><button type="button" class="ghost icon" data-branch="${esc(siblings[Math.min(siblings.length-1,index+1)].id)}" aria-label="Next branch" title="Next branch" ${index === siblings.length-1 || active ? 'disabled' : ''}>${icon('next')}</button>` : '';
  const error = m.metadata.error ? `<div class="message-error">${esc(m.metadata.error)}</div>` : '';
  const unsupported = m.metadata.unsupportedAttachments?.length ? `<div class="message-error">Archived attachments are retained in the export but cannot be sent: ${m.metadata.unsupportedAttachments.map(esc).join(', ')}.</div>` : '';
  const meta = `${m.providerName ? esc(m.providerName) : ''}${m.metadata.finishReason === 'length' ? ' · Output token limit reached' : ''}`;
  return `<article class="message ${esc(m.role)}" data-message="${esc(m.id)}"><div class="message-header"><strong>${esc(label)}</strong>${status}</div>${thinking}<div class="message-body">${body || (m.status === 'streaming' ? '<span class="muted">Generating...</span>' : '')}</div>${files ? `<div class="file-links">${files}</div>` : ''}${generatedFilesHtml(m)}${toolActivityHtml(m)}${error}${unsupported}${meta ? `<div class="message-meta">${meta}</div>` : ''}${statisticsHtml(m)}<div class="message-actions">${actions}${branches}</div></article>`;
}
function renderThread(forceBottom = false) {
  const thread = $('#thread'), top = thread.scrollTop, bottom = thread.scrollHeight - top - thread.clientHeight < 110;
  // Read native state before replacing DOM. Queued toggle events may not run yet.
  for (const details of thread.querySelectorAll('details[data-reasoning], details[data-stats]')) {
    const set = details.dataset.reasoning ? state.openReasoning : state.openStats, id = details.dataset.reasoning ?? details.dataset.stats;
    if (details.open) set.add(id); else set.delete(id);
  }
  for (const details of thread.querySelectorAll('details[data-tool-detail]')) {
    if (details.open) state.openTools.add(details.dataset.toolDetail); else state.openTools.delete(details.dataset.toolDetail);
  }
  const c = state.conversation, path = c ? pathMessages(c) : [];
  document.title = c ? `${c.title} | Common Chat` : 'Common Chat';
  if (!path.length) {
    thread.innerHTML = `<div id="empty-state"><h1>New chat</h1>${state.providers.length
      ? ''
      : `<p class="muted">Add a connection to start chatting.</p><div class="empty-actions"><button type="button" class="ghost icon" data-open-connections aria-label="Add a connection" title="Add a connection">${icon('plug')}</button></div>`}</div>`;
  } else {
    // Keep completed message bodies in place. Replacing an iframe would restart
    // its code on every server update, even when the answer did not change.
    let inner = thread.querySelector('.thread-inner');
    if (!inner) { inner = document.createElement('div'); inner.className = 'thread-inner'; thread.replaceChildren(inner); }
    const existing = new Map([...inner.children].map(node => [node.dataset.message, node]));
    const keep = new Set(); let previous = null;
    for (const m of path) {
      const html = messageHtml(m, c); if (!html) continue;
      const template = document.createElement('template'); template.innerHTML = html;
      const fresh = template.content.firstElementChild, old = existing.get(m.id);
      for (const details of fresh.querySelectorAll('[data-tool-detail]')) if (state.openTools.has(details.dataset.toolDetail)) details.open = true;
      const sourceKey = JSON.stringify([m.role, m.content, m.reasoning, m.status]);
      let node = fresh;
      if (old?.renderSourceKey === sourceKey) {
        node = old;
        // Update statistics, actions and metadata without moving the body.
        for (const name of ['message-header', 'message-stats', 'message-actions', 'message-meta', 'message-error', 'generated-files', 'tool-activity']) {
          const oldPart = old.querySelector(`:scope > .${name}`), newPart = fresh.querySelector(`:scope > .${name}`);
          if (oldPart && newPart) oldPart.replaceWith(newPart);
          else if (oldPart) oldPart.remove();
          else if (newPart) old.append(newPart);
        }
        const oldFiles = old.querySelector(':scope > .file-links'), newFiles = fresh.querySelector(':scope > .file-links');
        if (oldFiles?.innerHTML !== newFiles?.innerHTML) {
          if (oldFiles && newFiles) oldFiles.replaceWith(newFiles);
          else if (oldFiles) oldFiles.remove(); else if (newFiles) old.append(newFiles);
        }
      } else if (old) old.replaceWith(fresh);
      node.renderSourceKey = sourceKey; keep.add(node);
      const next = previous ? previous.nextElementSibling : inner.firstElementChild;
      if (next !== node) inner.insertBefore(node, next);
      previous = node;
    }
    for (const node of [...inner.children]) if (!keep.has(node)) node.remove();
  }
  thread.scrollTop = forceBottom || bottom ? thread.scrollHeight : top;
  installPreviews(thread);
  renderDiagrams(thread, () => { if (forceBottom || bottom) thread.scrollTop = thread.scrollHeight; });
  updateControls();
}
async function loadCurrent(forceBottom = false) {
  const cid = state.draftKey; if (!cid || cid !== routeId()) return;
  let c;
  try { c = await api(`/api/conversations/${encodeURIComponent(cid)}`); }
  catch (e) {
    if (e.status === 404 && cid === state.draftKey && cid === routeId()) {
      state.conversation = null; state.missing = true; renderThread(); renderDraft();
    }
    throw e;
  }
  if (!state.authenticated || cid !== routeId() || cid !== state.draftKey) return;
  if (state.conversation?.id === cid && state.conversation.version > c.version) return;
  if (state.conversation?.id === cid && state.conversation.activeLeaf !== c.activeLeaf) invalidateDictation();
  state.conversation = c; state.missing = false; renderThread(forceBottom); renderList(); renderDraft();
  workspaceUI?.refresh();
}
async function navigate(cid, known = null) {
  if (state.busy || state.retry && cid !== state.draftKey) {
    history.replaceState(null, '', state.draftKey ? `#${encodeURIComponent(state.draftKey)}` : location.pathname);
    toast('Finish the current submission before switching conversations.'); return;
  }
  rememberDraft(); cancelDiagrams(); cancelPreviews();
  if (routeId() !== cid) history.pushState(null, '', cid ? `#${encodeURIComponent(cid)}` : location.pathname);
  if (state.draftKey !== cid) { state.conversation = known; restoreDraft(cid); }
  state.loading = !!cid && !state.conversation;
  $('#app').classList.remove('sidebar-open'); renderThread(true); updateControls();
  if (cid && !known) {
    try { await loadCurrent(true); } catch (e) { if (cid === state.draftKey) toast(e.message); }
  }
  if (cid !== state.draftKey || !state.authenticated) return;
  state.loading = false;
  if (state.conversation) {
    const last = [...pathMessages(state.conversation)].reverse().find(m => m.providerId && state.providers.some(p => p.id === m.providerId));
    if (last) { $('#provider-select').value = last.providerId; $('#model-input').value = last.model ?? ''; loadModels(false).catch(() => {}); }
  }
  renderList(); updateControls(); workspaceUI?.refresh(); $('#prompt').focus(); checkPending();
}
async function createConversation() {
  const previousKey = state.draftKey;
  if (previousKey !== null) throw new Error('Open New chat before creating a conversation. Your current draft was kept.');
  const c = await api('/api/conversations', 'POST', { title: 'New chat' });
  if (!state.authenticated || previousKey !== state.draftKey) throw new Error('The chat changed before creation completed. Your draft was kept.');
  const draft = currentDraft();
  // Save the destination before removing the new-chat slot. Never migrate on a refresh.
  if (drafts.set(c.id, draft)) drafts.delete(previousKey, draft);
  invalidateDictation();
  history.pushState(null, '', `#${c.id}`); state.conversation = c; state.draftKey = c.id;
  toolControls?.created(c.id); return c;
}
async function newChat() { await navigate(null); }
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
  if ($('#empty-state')) renderThread();
  updateControls();
}
async function loadModels(notify = true, refresh = notify) {
  const p = selectedProvider(); if (p) connectionStatus.checking(p.id);
  return modelControls.load(notify, refresh);
}
async function saveSelection() {
  try { state.preferences = await api('/api/preferences', 'PUT', { providerId: $('#provider-select').value, model: $('#model-input').value.trim() }); }
  catch (e) { toast(e.message); }
}
async function acknowledged(pending) {
  if (state.retry !== pending) return;
  const submitted = currentDraft();
  state.retry = null;
  if (!pending.body.regenerate && state.draftKey === pending.cid) {
    drafts.delete(pending.cid, submitted);
    $('#prompt').value = ''; state.attachments = []; state.editing = null;
  } else rememberDraft();
  renderDraft(); await loadCurrent(true); scheduleList();
}
async function checkPending() {
  if (!state.retry || pendingCheck) return;
  const pending = state.retry; pendingCheck = true;
  try {
    await api(`/api/requests/${encodeURIComponent(pending.body.requestId)}`);
    if (state.retry === pending) await acknowledged(pending);
  } catch (e) { if (e.status !== 404 && e.status !== 0) toast(e.message); }
  finally { pendingCheck = false; }
}
async function sendMessage(event) {
  event?.preventDefault();
  if (state.busy || dictationUI?.isBusy() || !state.retry && $('#send').disabled) return;
  invalidateDictation(); state.busy = true; updateControls();
  let pending = state.retry;
  try {
    if (!pending) {
      const content = $('#prompt').value, attachmentIds = state.attachments.map(a => a.id);
      const providerId = $('#provider-select').value, model = $('#model-input').value.trim();
      const c = state.conversation ?? await createConversation();
      pending = { cid: c.id, body: { requestId: uuid(), expectedVersion: c.version, providerId, model,
        parentId: state.editing ? state.editing.parentId : c.activeLeaf, content, attachments: attachmentIds, settings: c.settings, tools: await toolControls.readForTurn() } };
    }
    state.retry = pending; rememberDraft(); renderDraft();
    await api(`/api/conversations/${encodeURIComponent(pending.cid)}/generate`, 'POST', pending.body);
    await acknowledged(pending);
    saveSelection();
  } catch (e) {
    if (e.status && e.status < 500) { state.retry = null; rememberDraft(); if (e.status === 409) await loadCurrent().catch(() => {}); }
    else checkPending();
    if (!state.retry) validateAttachments();
    toast(e.message);
  } finally { state.busy = false; renderDraft(); }
}
async function regenerate(messageId) {
  if (state.busy || state.retry || !state.conversation || state.conversation.activeJob) return;
  const c = state.conversation, m = c.messages.find(m => m.id === messageId);
  if (!m?.parentId) return;
  invalidateDictation(); state.busy = true; updateControls();
  try {
    const providerId = $('#provider-select').value, model = $('#model-input').value.trim();
    const pending = { cid: c.id, body: { requestId: uuid(), expectedVersion: c.version, providerId,
      model, parentId: m.parentId, regenerate: true, settings: c.settings, tools: await toolControls.readForTurn() } };
    state.retry = pending; rememberDraft(); renderDraft();
    await api(`/api/conversations/${c.id}/generate`, 'POST', pending.body);
    await acknowledged(pending);
  } catch (e) {
    if (e.status && e.status < 500) { state.retry = null; rememberDraft(); if (e.status === 409) await loadCurrent().catch(() => {}); }
    else checkPending();
    toast(e.message);
  } finally { state.busy = false; renderDraft(); }
}
async function selectBranch(messageId) {
  if (state.busy || state.retry || state.conversation?.activeJob) return;
  invalidateDictation(); cancelPreviews();
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
  if (state.busy || state.retry || !state.conversation || state.conversation.activeJob) return;
  const m = state.conversation.messages.find(m => m.id === mid);
  if (!m) return;
  if (($('#prompt').value.trim() || state.attachments.length) && !confirm('Replace the unsent draft with this message?')) return;
  invalidateDictation();
  state.editing = { id: m.id, parentId: m.parentId }; $('#prompt').value = m.content;
  state.attachments = m.attachments.map(a => ({ ...a, existing: true })); rememberDraft(); renderDraft(); $('#prompt').focus();
}
async function copyMessage(mid) {
  const content = state.conversation?.messages.find(m => m.id === mid)?.content ?? '';
  try { await navigator.clipboard.writeText(content); toast('Message copied.'); }
  catch { toast('Clipboard access requires HTTPS or localhost. Select the message text and copy it.'); }
}
async function copyCode(button) {
  const block = button.closest('.code-block'), code = block?.querySelector('pre code');
  if (!code) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(code.textContent ?? ''); toast('Code copied.');
  } catch {
    const details = block.querySelector('.diagram-source, .artifact-source'); if (details) details.open = true;
    const selection = window.getSelection();
    if (selection) { const range = document.createRange(); range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range); }
    code.scrollIntoView({ block: 'nearest' });
    toast('Source selected. Use your browser Copy command or press Ctrl+C. On touchscreens, long-press the source to copy.');
  }
}
function openPreferences(tab = 'connections') {
  if (tab === 'connections') { $('#edit-provider').value = selectedProvider()?.id ?? ''; fillConnectionForm(); }
  thinkingControls?.close(); shellUI.openSettings(tab);
}
function openConnections() { openPreferences('connections'); }
function fillConnectionForm() {
  const p = state.providers.find(p => p.id === $('#edit-provider').value);
  $('#connection-name').value = p?.name ?? ''; $('#connection-url').value = p?.baseUrl ?? '';
  $('#connection-key').value = ''; $('#connection-clear-key').checked = false;
  $('#connection-key').placeholder = p?.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Optional API key';
  $('#connection-models').value = p?.models.join('\n') ?? '';
  $('#connection-discovery').value = p?.modelConfig?.discovery ?? (p?.models.length ? 'manual' : 'auto');
  $('#connection-metadata').value = p?.modelConfig?.metadata ?? 'generic';
  $('#connection-models-field').hidden = $('#connection-discovery').value !== 'manual';
  for (const key of ['streaming','vision','systemPrompt','temperature','topP','maxTokens','llamaCppTimings']) $('#cap-'+key).checked = p ? p.capabilities[key] === true : !['vision','llamaCppTimings'].includes(key);
  $('#cap-tools').checked = p?.capabilities.tools === true;
  writeMediaCapabilities(p?.capabilities); writeThinkingCapabilities(p?.capabilities);
  $('#token-parameter').value = p?.capabilities.tokenParameter ?? 'max_tokens';
  $('#connection-error').textContent = ''; $('#delete-provider').hidden = !p;
}
async function saveProvider(event) {
  event.preventDefault(); $('#save-provider').disabled = true;
  const pid = $('#edit-provider').value, capabilities = {};
  for (const key of ['streaming','vision','systemPrompt','temperature','topP','maxTokens','llamaCppTimings']) capabilities[key] = $('#cap-'+key).checked;
  capabilities.tokenParameter = $('#token-parameter').value;
  capabilities.tools = $('#cap-tools').checked;
  Object.assign(capabilities, readMediaCapabilities(), readThinkingCapabilities());
  try {
    const p = await api(pid ? `/api/providers/${pid}` : '/api/providers', pid ? 'PUT' : 'POST', {
      name: $('#connection-name').value, baseUrl: $('#connection-url').value, apiKey: $('#connection-key').value,
      clearKey: $('#connection-clear-key').checked, models: $('#connection-models').value.split('\n').map(s => s.trim()).filter(Boolean), capabilities,
      modelConfig: { discovery: $('#connection-discovery').value, metadata: $('#connection-metadata').value,
        profiles: state.providers.find(item => item.id === pid)?.modelConfig?.profiles ?? [] }
    });
    $('#connection-key').value = ''; await refreshProviders(); $('#provider-select').value = p.id;
    $('#model-input').value = p.models[0] ?? ''; shellUI.closeSettings();
    await loadModels(false); saveSelection(); renderThread(); toast('Connection saved.');
  } catch (e) { $('#connection-error').textContent = e.message; }
  finally { $('#save-provider').disabled = false; }
}
function fillGenerationForm() {
  const opts = state.conversation?.settings ?? {}, caps = selectedProvider()?.capabilities ?? {};
  $('#system-prompt').value = opts.systemPrompt ?? '';
  $('#temperature').value = opts.temperature ?? ''; $('#top-p').value = opts.topP ?? ''; $('#max-tokens').value = opts.maxTokens ?? '';
  $('#tool-calls').value = opts.toolCalls ?? ''; $('#tool-rounds').value = opts.toolRounds ?? '';
  for (const key of ['systemPrompt','temperature','topP','maxTokens']) $('#field-'+key).hidden = !caps[key];
  thinkingControls?.refresh(); writeThinkingSetting(opts);
  $('#generation-error').textContent = ''; updateControls();
}
function openGeneration() {
  if (!selectedProvider()) { openConnections(); return; }
  openPreferences('generation');
}
async function saveGeneration(event) {
  event.preventDefault();
  if ($('#save-generation').disabled) return;
  const caps = selectedProvider()?.capabilities ?? {}, opts = {};
  if (caps.systemPrompt) opts.systemPrompt = $('#system-prompt').value;
  for (const [key, selector] of [['temperature','#temperature'], ['topP','#top-p'], ['maxTokens','#max-tokens']]) {
    if (caps[key] && $(selector).value !== '') opts[key] = Number($(selector).value);
  }
  for (const [key, selector] of [['toolCalls', '#tool-calls'], ['toolRounds', '#tool-rounds']]) if ($(selector).value !== '') opts[key] = Number($(selector).value);
  if (!$('#thinking-field').hidden && $('#thinking-level').value) opts.thinking = $('#thinking-level').value;
  state.busy = true; updateControls();
  try {
    const c = state.conversation ?? await createConversation();
    state.conversation = await api(`/api/conversations/${c.id}`, 'PATCH', { expectedVersion: c.version, settings: opts });
    shellUI.closeSettings(); renderThread(); scheduleList(); toast('Conversation settings saved.');
  } catch (e) { $('#generation-error').textContent = e.message; if (e.status === 409) await loadCurrent().catch(() => {}); }
  finally { state.busy = false; renderDraft(); }
}
async function changeThinking(value) {
  if (state.busy || state.loading || state.missing || state.retry || state.conversation?.activeJob) throw new Error('Finish the current chat action before changing thinking.');
  invalidateDictation(); state.busy = true; updateControls();
  try {
    const c = state.conversation ?? await createConversation(), settings = { ...c.settings };
    if (value) settings.thinking = value; else delete settings.thinking;
    state.conversation = await api(`/api/conversations/${c.id}`, 'PATCH', { expectedVersion: c.version, settings });
    writeThinkingSetting(settings); renderThread(); scheduleList();
  } catch (e) { if (e.status === 409) await loadCurrent().catch(() => {}); throw e; }
  finally { state.busy = false; renderDraft(); }
}
async function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
  });
}
async function uploadFiles(files) {
  if (state.busy || state.retry || state.loading || state.missing || !files.length) return;
  state.busy = true; updateControls();
  try {
    if (state.attachments.length + files.length > 10) throw new Error('Attach at most ten files to each message.');
    const c = state.conversation ?? await createConversation();
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB.`);
      const mime = validateUpload(file, selectedProvider());
      const data = await readAsBase64(file);
      const a = await api(`/api/conversations/${c.id}/attachments`, 'POST', { name: file.name, mime, data });
      if (!state.authenticated || state.draftKey !== c.id) return;
      state.attachments.push(a); rememberDraft(); renderDraft();
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
    shellUI.closeSettings(); $('#import-dialog').showModal(); await refreshList();
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
function updateConversationActions() {
  const c = actionConversation && actionConversation.id === state.conversation?.id && state.conversation.version > actionConversation.version ? state.conversation : actionConversation;
  const running = !!c?.activeJob || c?.messages.some(m => m.status === 'streaming');
  const locked = !actionConversation || actionReading || state.busy || !!state.retry || running;
  $('#rename-conversation').disabled = locked; $('#delete-conversation').disabled = locked;
  $('#conversation-title').readOnly = locked;
  $('#export-conversation').disabled = !actionConversation || state.busy || actionReading;
  $('#refresh-conversation-actions').disabled = !actionConversation || state.busy || actionReading;
  $('#conversation-status').hidden = !running;
  $('#conversation-status').textContent = running ? 'A response is active. Rename and delete are unavailable until it finishes.' : '';
}
async function openConversationActions(cid) {
  if (!cid || state.busy || state.loading) return;
  const request = ++actionLoad;
  try {
    const c = await api(`/api/conversations/${encodeURIComponent(cid)}`);
    if (request !== actionLoad || !state.authenticated) return;
    actionConversation = c; actionReading = false;
    $('#conversation-title').value = c.title; $('#conversation-error').textContent = '';
    updateConversationActions(); $('#conversation-dialog').showModal();
  } catch (e) { if (request === actionLoad) toast(e.message); }
}
async function reloadActionConversation(fillTitle = false) {
  const c = actionConversation, request = actionLoad;
  if (!c) return;
  actionReading = true; updateConversationActions();
  try {
    const latest = await api(`/api/conversations/${encodeURIComponent(c.id)}`);
    if (request !== actionLoad || actionConversation?.id !== c.id || !state.authenticated) return;
    actionConversation = latest;
    if (fillTitle) $('#conversation-title').value = latest.title;
    if (state.conversation?.id === latest.id && state.conversation.version <= latest.version) {
      state.conversation = latest; renderThread(); renderDraft();
    }
    scheduleList(); return latest;
  } finally { if (request === actionLoad) { actionReading = false; updateConversationActions(); } }
}
async function conversationActionError(error) {
  let message = error.message;
  if (error.status === 409) {
    const latest = await reloadActionConversation().catch(() => null);
    if (latest && !latest.activeJob) message += ` Latest title: "${latest.title}". Review it before trying again.`;
  } else if (error.status === 404) { actionConversation = null; updateConversationActions(); }
  $('#conversation-error').textContent = message;
}
async function refreshActionActivity(cid) {
  const target = actionConversation, request = actionLoad;
  if (!target || target.id !== cid || !$('#conversation-dialog').open || actionReading) return;
  const latest = await api(`/api/conversations/${encodeURIComponent(cid)}`);
  if (request !== actionLoad || actionConversation !== target) return;
  // Keep the action's version and title. A remote edit must still cause a conflict.
  actionConversation = { ...target, activeJob: latest.activeJob, messages: latest.messages };
  updateConversationActions();
}
function setSyncStatus(message, status = 'checking') { connectionStatus.sync(status, message); }
function connectEvents() {
  events?.close(); clearTimeout(syncReconnectTimer); syncReconnectTimer = undefined; syncDisconnectedAt = 0;
  events = new EventSource('/api/events');
  const source = events;
  setSyncStatus('connecting.');
  events.onopen = () => { clearTimeout(syncReconnectTimer); syncReconnectTimer = undefined; syncDisconnectedAt = 0; setSyncStatus('connected and synchronizing.', 'connected'); };
  events.onerror = () => {
    if (!syncDisconnectedAt) syncDisconnectedAt = Date.now();
    const disconnected = Date.now() - syncDisconnectedAt >= 15000;
    setSyncStatus(disconnected ? 'synchronization disconnected.' : 'reconnecting.', disconnected ? 'error' : 'checking');
    if (!disconnected && !syncReconnectTimer) syncReconnectTimer = setTimeout(() => {
      syncReconnectTimer = undefined;
      if (state.authenticated && events === source && source.readyState !== EventSource.OPEN) setSyncStatus('synchronization disconnected.', 'error');
    }, Math.max(0, 15000 - (Date.now() - syncDisconnectedAt)));
    api('/api/session').catch(error => {
      if (state.authenticated && events === source && source.readyState !== EventSource.OPEN && error.status !== 401) setSyncStatus('unreachable.', 'error');
    });
  };
  events.onmessage = async event => {
    try {
      const change = JSON.parse(event.data);
      if (change.type === 'hello') {
        await Promise.all([refreshList(), refreshProviders(), loadCurrent()]); checkPending();
      } else if (change.type === 'providers') { invalidateDictation(); await refreshProviders(); await loadModels(false); }
      else if (change.type === 'preferences') {
        const session = await api('/api/session');
        if (JSON.stringify(state.preferences.dictation) !== JSON.stringify(session.settings.dictation)) invalidateDictation();
        state.preferences = session.settings; applyTheme(); dictationUI?.refresh();
      }
      else if (change.type === 'deleted') {
        if (change.conversationId === state.draftKey && change.conversationId !== deletingConversation) {
          invalidateDictation(); cancelPreviews(); state.conversation = null; state.missing = true; renderThread(); renderDraft();
          toast('This conversation was deleted on another device. Your draft is kept at this address.');
        }
        if (change.conversationId === actionConversation?.id && change.conversationId !== deletingConversation) {
          actionConversation = null; updateConversationActions(); $('#conversation-error').textContent = 'This conversation was deleted. No other conversation is selected for these actions.';
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
        if (change.conversationId) await refreshActionActivity(change.conversationId);
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
    $('#release-info').textContent = `Common Chat ${session.version} · ${session.release?.channel ?? 'preview'} · ${session.release?.commit?.slice(0, 12) ?? 'development'}`;
    $('#release-badge').textContent = session.release?.channel ?? 'preview';
    await Promise.all([refreshList(), refreshProviders()]); await loadModels(false);
    await navigate(routeId());
    connectEvents(); toolControls?.checkRuntime();
  } catch (e) { showLogin(); if (e.status !== 401) $('#login-error').textContent = e.message; }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-button').disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', 'POST', { password: $('#password').value }); $('#password').value = ''; await boot(); }
  catch (e) { $('#login-error').textContent = e.message; }
  finally { $('#login-button').disabled = false; }
});
$('#composer').addEventListener('submit', sendMessage);
$('#prompt').addEventListener('input', () => { rememberDraft(); renderDraft(); });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
$('#new-chat').addEventListener('click', newChat);
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refreshList().catch(e => toast(e.message)), 200); });
$('#conversation-list').addEventListener('click', event => {
  const action = event.target.closest('[data-chat-actions]');
  if (action) { openConversationActions(action.dataset.chatActions); return; }
  const b = event.target.closest('[data-conversation]'); if (b) navigate(b.dataset.conversation);
});
window.addEventListener('offline', () => {
  clearTimeout(syncReconnectTimer); setSyncStatus('browser reports offline.', 'error');
  const p = selectedProvider(); if (p) connectionStatus.error(p.id, 'browser reports offline.');
});
window.addEventListener('online', () => { if (state.authenticated) { connectEvents(); checkPending(); loadModels(false, true); } });
setInterval(() => { if (state.authenticated && !document.hidden && !state.busy && navigator.onLine) loadModels(false, true); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated && navigator.onLine) loadModels(false); });
$('#provider-select').addEventListener('change', async () => { $('#model-input').value = ''; updateControls(); await loadModels(false); saveSelection(); updateControls(); });
$('#picker-refresh-models').addEventListener('click', () => loadModels());
$('#connection-discovery').addEventListener('change', () => { $('#connection-models-field').hidden = $('#connection-discovery').value !== 'manual'; });
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
$('#reset-generation').addEventListener('click', () => { for (const s of ['#system-prompt','#temperature','#top-p','#max-tokens','#tool-calls','#tool-rounds','#thinking-level']) $(s).value = ''; });
$('#preferences-button').addEventListener('click', () => openPreferences());
$('#settings-model-button').addEventListener('click', event => { event.stopPropagation(); thinkingControls?.close(); shellUI.openModel(); });
$('#model-info-button').addEventListener('click', () => openPreferences('info'));
$('#dictation-button').addEventListener('click', () => { thinkingControls?.close(); shellUI.closePopups(); dictationUI.open(); });
$('#menu-tool-settings').addEventListener('click', () => openPreferences('tools'));
function openWorkspace() {
  thinkingControls?.close(); shellUI.closePopups(); shellUI.closeSettings();
  const button = $('#workspace-button');
  if (button) button.click(); else toast('Files and code are unavailable on this page.');
}
$('#menu-workspace').addEventListener('click', openWorkspace);
$('#settings-workspace-button').addEventListener('click', openWorkspace);
$('#theme-select').addEventListener('change', async () => {
  try { state.preferences = await api('/api/preferences','PUT',{ theme: $('#theme-select').value }); applyTheme(); }
  catch(e) { toast(e.message); }
});
function clearDraftView() {
  invalidateDictation();
  state.conversation = null; state.attachments = []; state.editing = null; state.retry = null; state.draftKey = undefined;
  state.loading = false; state.missing = false;
  $('#prompt').value = ''; $('#thread').innerHTML = ''; $('#conversation-list').innerHTML = ''; showLogin();
}
$('#logout').addEventListener('click', async () => {
  if (state.busy) { toast('Finish the current operation before signing out.'); return; }
  if (!confirm('Sign out and discard all drafts saved in this browser for this server? This does not cancel submitted generations or delete uploaded files.')) return;
  try {
    await api('/api/logout','POST');
    const cleared = drafts.clear(); clearDraftView();
    if (!cleared) { $('#login-error').textContent = draftWarning; toast(draftWarning); }
  } catch(e) { toast(e.message); }
});
$('#upload-button').addEventListener('click', () => { shellUI.closeUploadMenu(true); $('#file-input').click(); });
$('#file-input').addEventListener('change', () => uploadFiles([...$('#file-input').files]));
$('#prompt').addEventListener('paste', event => { const files = [...(event.clipboardData?.files ?? [])]; if (files.length) { event.preventDefault(); uploadFiles(files); } });
$('#composer').addEventListener('dragover', event => { event.preventDefault(); });
$('#composer').addEventListener('drop', event => { event.preventDefault(); uploadFiles([...event.dataTransfer.files]); });
$('#attachment-list').addEventListener('click', async event => {
  const b = event.target.closest('[data-remove-file]'); if (!b || state.busy || state.retry) return;
  const a = state.attachments.find(a => a.id === b.dataset.removeFile);
  if (!a) return;
  state.busy = true; updateControls();
  try {
    if (!a.existing) {
      try { await api(`/api/attachments/${encodeURIComponent(a.id)}`, 'DELETE'); }
      // A missing upload or a file already attached by another tab can be unlinked.
      catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }
    }
    if (!state.authenticated) return;
    state.attachments = state.attachments.filter(x => x.id !== a.id); rememberDraft();
  } catch (e) { toast(e.message); }
  finally { state.busy = false; renderDraft(); }
});
$('#cancel-edit').addEventListener('click', () => {
  if (state.busy || state.retry || !confirm('Discard this unsent draft, including its edit and attachment references? Uploaded files stay on the server.')) return;
  invalidateDictation();
  drafts.delete(state.draftKey, currentDraft()); state.editing = null; state.attachments = []; $('#prompt').value = ''; renderDraft();
});
$('#stop').addEventListener('click', async () => { try { if (state.conversation?.activeJob) await api(`/api/jobs/${state.conversation.activeJob.id}/cancel`, 'POST'); } catch (e) { toast(e.message); } });
$('#thread').addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b) return;
  if ('codeCopy' in b.dataset) copyCode(b);
  if ('pythonRun' in b.dataset) {
    const block = b.closest('.code-block'), message = state.conversation?.messages.find(item => item.id === b.closest('[data-message]')?.dataset.message);
    if (message?.role === 'assistant' && message.status !== 'streaming' && block?.dataset.codeComplete === 'true') workspaceUI?.openCode(block.querySelector('pre code')?.textContent ?? '');
  }
  if (b.dataset.workspacePreview) workspaceUI?.openFile(b.dataset.workspacePreview, b.dataset.revision);
  if (b.dataset.executionResult) workspaceUI?.openExecution(b.dataset.executionResult);
  if ('openConnections' in b.dataset) openConnections();
  if ('import' in b.dataset) $('#import-input').click();
  if (b.dataset.copy) copyMessage(b.dataset.copy);
  if (b.dataset.edit) beginEdit(b.dataset.edit);
  if (b.dataset.regenerate) regenerate(b.dataset.regenerate);
  if (b.dataset.branch) selectBranch(b.dataset.branch);
});
$('#thread').addEventListener('toggle', event => {
  const target = event.target;
  if (!target.isConnected) return;
  const id = target.dataset.reasoning ?? target.dataset.stats ?? target.dataset.toolDetail;
  if (!id) return;
  const set = target.dataset.reasoning ? state.openReasoning : target.dataset.stats ? state.openStats : state.openTools;
  if (target.open) set.add(id); else set.delete(id);
}, true);
$('#import-button').addEventListener('click', () => $('#import-input').click());
$('#import-input').addEventListener('change', () => importFile($('#import-input').files[0]));
$('#export-all').addEventListener('click', () => download('/api/export', 'common-chat-export.json'));
$('#conversation-button')?.addEventListener('click', () => {
  if (state.conversation) openConversationActions(state.conversation.id); else toast('Create or open a conversation first.');
});
$('#conversation-dialog').addEventListener('close', () => { actionConversation = null; actionReading = false; actionLoad++; });
$('#refresh-conversation-actions').addEventListener('click', async () => {
  if (actionConversation && $('#conversation-title').value !== actionConversation.title && !confirm('Reload the saved title and discard the unsaved title in this dialog?')) return;
  try { await reloadActionConversation(true); $('#conversation-error').textContent = ''; }
  catch (e) { await conversationActionError(e); }
});
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault(); const c = actionConversation;
  if (!c || $('#rename-conversation').disabled) return;
  const title = $('#conversation-title').value;
  state.busy = true; updateControls();
  try {
    const renamed = await api(`/api/conversations/${encodeURIComponent(c.id)}`, 'PATCH', { expectedVersion: c.version, title });
    if (state.conversation?.id === c.id) { state.conversation = renamed; renderThread(); }
    $('#conversation-dialog').close(); scheduleList();
  } catch (e) { await conversationActionError(e); }
  finally { state.busy = false; renderDraft(); }
});
$('#export-conversation').addEventListener('click', () => {
  if (actionConversation) download(`/api/conversations/${encodeURIComponent(actionConversation.id)}/export`, 'conversation.common-chat.json');
});
$('#delete-conversation').addEventListener('click', async () => {
  const c = actionConversation;
  if (!c || $('#delete-conversation').disabled || !confirm(`Permanently delete "${c.title}", all branches, attachments, workspace files, and its draft on this device?`)) return;
  state.busy = true; deletingConversation = c.id; updateControls();
  try {
    await api(`/api/conversations/${encodeURIComponent(c.id)}`, 'DELETE', { expectedVersion: c.version }); $('#conversation-dialog').close();
    drafts.delete(c.id);
    if (state.draftKey === c.id) {
      cancelPreviews(); cancelDiagrams(); history.replaceState(null, '', location.pathname);
      state.conversation = null; restoreDraft(null); renderThread(); workspaceUI?.refresh();
    }
    await refreshList();
  } catch(e) { await conversationActionError(e); }
  finally { deletingConversation = null; state.busy = false; renderDraft(); }
});
$('#sidebar-toggle').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));
$('#sidebar-backdrop').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));
installSidebarGestures($('#app'), $('#sidebar'));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
window.addEventListener('hashchange', () => { if (state.authenticated) navigate(routeId()); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) { loadCurrent().catch(() => {}); refreshList().catch(() => {}); checkPending(); } });
document.addEventListener('keydown', event => {
  if (!state.authenticated || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); shellUI.expandSidebar(); $('#search').focus(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newChat(); }
});
window.addEventListener('storage', event => {
  if (event.key === DRAFT_LOGOUT_KEY && event.newValue) { drafts.forget(); clearDraftView(); }
});
window.addEventListener('pagehide', invalidateDictation);
window.addEventListener('beforeunload', event => {
  rememberDraft();
  if (drafts.hasUnsaved || state.busy) { event.preventDefault(); event.returnValue = ''; }
});
shellUI = installShell({ onSettingsTab: tab => {
  if (tab === 'generation') fillGenerationForm();
  else if (tab === 'dictation') dictationSettings?.fill();
  else { updateControls(); if (tab === 'tools') toolControls?.checkRuntime(); }
} });
installMediaControls();
modelControls = installModelControls({ api, getProvider: selectedProvider,
  onCatalog: (pid, result) => connectionStatus.models(pid, result),
  onChange: save => { updateControls(); if (save) saveSelection(); },
  onSaved: p => { const index = state.providers.findIndex(item => item.id === p.id); if (index >= 0) state.providers[index] = p; },
  busy: () => state.busy || state.loading || !!state.retry, toast });
dictationUI = installDictation({ transcribe: (input, options) => api('/api/transcriptions', 'POST', input, options),
  getSelection: dictationSelection, getTarget: () => ({ draftKey: state.draftKey, epoch: composerEpoch, authenticated: state.authenticated }),
  canUse: canDictate, appendTranscript: (text, target) => {
    if (!canDictate() || !target.authenticated || target.draftKey !== state.draftKey || target.epoch !== composerEpoch) return false;
    const current = $('#prompt').value;
    $('#prompt').value = current + (current && !/\s$/.test(current) ? '\n' : '') + text;
    rememberDraft(); renderDraft(); return true;
  }, onStateChange: updateControls, openSettings: () => openPreferences('dictation'), toast });
dictationSettings = installDictationSettings({ api, catalog: (pid, options) => modelControls.catalog(pid, options),
  getProviders: () => state.providers, getSelection: () => state.preferences.dictation,
  onSaved: preferences => { invalidateDictation(); state.preferences = preferences; dictationUI.refresh(); dictationSettings.fill(); }, openConnections, toast });
thinkingControls = installThinkingControls({ getProvider: selectedProvider, getModel: () => $('#model-input').value,
  getDetails: () => modelControls.details(), getSettings: () => state.conversation?.settings ?? {},
  onChange: changeThinking, busy: () => state.busy || state.loading || state.missing || !!state.retry || !!state.conversation?.activeJob, toast });
toolControls = installToolControls({ api, getProvider: selectedProvider, getConversation: () => state.conversation,
  busy: () => state.busy || state.loading || !!state.retry || !!state.conversation?.activeJob });
workspaceUI = installWorkspace({ api, getConversation: () => state.conversation,
  ensureConversation: async () => {
    if (state.busy || state.loading || state.retry || state.missing) throw new Error('Finish the current chat action before opening files.');
    if (state.conversation) return state.conversation;
    state.busy = true; updateControls();
    try { const c = await createConversation(); renderThread(); scheduleList(); return c; }
    finally { state.busy = false; updateControls(); }
  },
  onChanged: async ({ conversationId }) => { if (state.conversation?.id === conversationId) await loadCurrent(); scheduleList(); }, toast });
boot();
