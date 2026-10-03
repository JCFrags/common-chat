import { escape as esc, workspaceDownload } from './markdown.js';

const empty = () => ({ workspace: false, execute: false, packages: false });
const names = { workspace: 'files', execute: 'execution', packages: 'packages' };
const grants = value => Object.keys(names).filter(key => value?.[key] === true).map(key => names[key]).join(', ') || 'none';
const recordedActivity = message => Array.isArray(message.metadata?.toolActivity)
  ? message.metadata.toolActivity.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];

/** Permissions come from this tab's controls, never from model output or saved history. */
export function installToolControls({ api, getProvider, getConversation, busy }) {
  const saved = new Map();
  let runtime = null, checking = null;
  const panel = document.createElement('details'); panel.className = 'tool-controls';
  panel.innerHTML = '<summary>Model tools · grants: none</summary><p class="small">These grants apply only to this chat in this tab. Reload resets every grant to off. Saved activity records earlier grants, not current permission. Manual Run controls are separate.</p><div class="checks"><label class="check"><input type="checkbox" data-permission="workspace">Read, keyword-search and edit workspace files</label><label class="check"><input type="checkbox" data-permission="execute">Run Python and shell in the isolated runner</label><label class="check"><input type="checkbox" data-permission="packages">Install or restore registry packages</label></div><p class="small tool-availability"></p><button type="button" class="ghost" data-check-runtime>Check runner</button><details class="tool-inventory"><summary>Bundled libraries</summary><p class="small"></p></details>';
  document.querySelector('#composer').before(panel);
  const key = () => getConversation()?.id ?? 'new';
  let currentKey = key();
  const inputs = [...panel.querySelectorAll('input')];
  const enabled = () => getProvider()?.capabilities.tools === true;
  function read() { return enabled() ? { ...(saved.get(currentKey) ?? empty()) } : empty(); }
  function refresh() {
    currentKey = key();
    const choices = saved.get(currentKey) ?? empty();
    for (const input of inputs) {
      input.checked = choices[input.dataset.permission];
      const unavailable = input.dataset.permission !== 'workspace' && (!runtime?.ready || input.dataset.permission === 'packages' && !runtime.packages);
      input.disabled = !enabled() || busy() || unavailable && !input.checked;
    }
    panel.querySelector(':scope > summary').textContent = `Model tools · grants: ${grants(read())} · runner ${checking ? 'checking' : runtime?.ready ? 'ready' : runtime ? 'unavailable' : 'not checked'}`;
    panel.querySelector('.tool-availability').textContent = !enabled()
      ? 'This connection does not enable model tools. Manual Files and Run remain separate.'
      : runtime?.ready ? 'Runner ready. Each run uses a copied workspace, not a live shared filesystem. Execution is offline. Package access is registry-only. Save headless plots and animations to files.'
      : (runtime?.blockedReasons ?? ['Check the optional runner before granting execution or packages.']).join(' ');
    const inventory = runtime?.inventory;
    panel.querySelector('.tool-inventory p').textContent = inventory
      ? `Python ${inventory.pythonVersion}, Node ${inventory.nodeVersion}. Bundled: ${inventory.python.map(item => `${item.name}==${item.version}`).join(', ')}. Compatible bundled libraries need no install. Missing wheels must fit 32 MiB and 4096 regular files.`
      : 'Verified inventory is unavailable. Do not assume library versions.';
    panel.querySelector('[data-check-runtime]').disabled = !!checking;
  }
  async function checkRuntime() {
    if (checking) return checking;
    checking = api('/api/runtime').then(value => { runtime = value; }, error => { runtime = { ready: false, blockedReasons: [error.message] }; }).finally(() => { checking = null; refresh(); });
    refresh(); return checking;
  }
  panel.addEventListener('toggle', () => { if (panel.open) checkRuntime(); });
  panel.querySelector('[data-check-runtime]').addEventListener('click', checkRuntime);
  panel.addEventListener('change', () => { saved.set(currentKey, Object.fromEntries(inputs.map(input => [input.dataset.permission, input.checked]))); refresh(); });
  refresh();
  return { read, refresh, checkRuntime,
    created(cid) {
      // Only explicit creation transfers a new-chat grant. Navigation cannot.
      if (saved.has('new')) { saved.set(cid, saved.get('new')); saved.delete('new'); }
      currentKey = cid;
    },
    clear() { saved.clear(); runtime = null; refresh(); }
  };
}

export function generatedFilesHtml(message) {
  const files = new Map();
  for (const item of recordedActivity(message)) for (const file of [...(Array.isArray(item.availableFiles) ? item.availableFiles : []), ...(Array.isArray(item.files) ? item.files : [])]) {
    const link = workspaceDownload(file?.url, message.conversationId);
    if (link && link.path === file.path && link.revision === file.revision) files.set(`${link.path}@${link.revision}`, { ...file, ...link });
  }
  if (!files.size) return '';
  return `<section class="generated-files" aria-label="Workspace file results"><h3>Files</h3><div class="generated-file-grid">${[...files.values()].map(file => {
    const preview = /^text\/|^image\/(png|jpeg|webp|gif)$|^audio\/(wav|mpeg|flac)$|^video\/(mp4|webm)$/.test(file.mime ?? '') || /\.(pdf|docx|py|js|json|csv|md|txt)$/i.test(file.path);
    return `<article class="generated-file"><strong>${esc(file.path)}</strong><span class="small">${esc(file.mime ?? 'File')} · ${Number.isSafeInteger(file.size) ? esc(`${file.size} bytes`) : 'Size unavailable'} · revision ${esc(file.revision.slice(0, 8))}</span><div class="file-links"><a class="file-link" href="${esc(file.url)}" download>Download</a>${preview ? `<button type="button" class="file-link" data-workspace-preview="${esc(file.path)}" data-revision="${esc(file.revision)}">Preview</button>` : '<span class="small">Download to open.</span>'}</div></article>`;
  }).join('')}</div></section>`;
}

export function toolActivityHtml(message) {
  const activity = recordedActivity(message);
  if (!activity.length) return '';
  const budget = message.metadata.toolBudget;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 'unavailable';
  const limit = value => value === null ? 'off' : count(value);
  const counts = budget ? `${count(budget.executedCalls)} executed calls, ${count(budget.executedRounds)} tool rounds. Call budget: ${limit(budget.callLimit)}. Round budget: ${limit(budget.roundLimit)}. ${budget.stopReason ?? ''}` : '';
  const pastGrants = message.metadata.toolPermissions ? grants(message.metadata.toolPermissions) : 'unavailable (archived or older history)';
  // Local history is byte-bounded by the server. Do not hide later calls behind a fixed count.
  return `<section class="tool-activity" aria-label="Tool activity"><p class="small">${activity.length} recorded calls. Grants for this past turn: ${esc(pastGrants)}. These do not grant future permission. ${esc(counts)}</p>${activity.map(item => `<details data-tool-detail="${esc(message.id + ':' + item.id)}"${item.status === 'running' ? ' open' : ''}><summary>${esc(String(item.name ?? 'Tool'))} · ${esc(String(item.status ?? 'archived'))}</summary><pre>${esc(String(item.summary ?? ''))}</pre>${item.error ? `<p class="error">${esc(item.error)}</p>` : ''}${item.stdout || item.stderr ? `<pre class="tool-console">${esc([item.stdout ? `stdout\n${item.stdout}` : '', item.stderr ? `stderr\n${item.stderr}` : ''].filter(Boolean).join('\n\n'))}</pre>` : ''}${item.exitCode != null ? `<p class="small">Exit code: ${esc(item.exitCode)}</p>` : ''}${item.executionId ? `<p class="small">Execution ${esc(item.executionId)}${item.operationId ? ` · runner operation ${esc(item.operationId)}` : ''}</p><button type="button" data-execution-result="${esc(item.executionId)}">Full console and results</button>` : ''}</details>`).join('')}</section>`;
}
