import { escape as esc, workspaceDownload } from './markdown.js';

// Only fixed paths enter these decorative SVGs. File names and tool text never do.
const icons = {
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  files: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6m-9 4-3 3 3 3m3-6 3 3-3 3"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L6 21"/>',
  audio: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  video: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4Z"/>',
  archive: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M10 3v2m0 2v2m0 2v2m0 2v3h3v-3Z"/>',
  preview: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/>',
  history: '<path d="M3 3v6h6M3 9a9 9 0 1 1 1 9M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  previous: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  console: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>'
};
export const presentationIcon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${Object.hasOwn(icons, name) ? icons[name] : icons.file}</svg>`;

const fileTypes = {
  py: ['Python', 'code'], ipynb: ['Notebook', 'code'], js: ['JavaScript', 'code'], mjs: ['JavaScript', 'code'], cjs: ['JavaScript', 'code'],
  ts: ['TypeScript', 'code'], jsx: ['React', 'code'], tsx: ['React', 'code'], html: ['HTML', 'code'], htm: ['HTML', 'code'], css: ['CSS', 'code'],
  sh: ['Shell', 'code'], bash: ['Shell', 'code'], json: ['JSON', 'code'], xml: ['XML', 'code'], yaml: ['YAML', 'code'], yml: ['YAML', 'code'], toml: ['TOML', 'code'],
  md: ['Markdown', 'file'], markdown: ['Markdown', 'file'], txt: ['Text', 'file'], csv: ['CSV', 'file'], tsv: ['TSV', 'file'],
  pdf: ['PDF', 'file'], docx: ['Word document', 'file'], xlsx: ['Spreadsheet', 'file'], pptx: ['Presentation', 'file'],
  png: ['PNG', 'image'], gif: ['GIF', 'image'], jpg: ['JPEG', 'image'], jpeg: ['JPEG', 'image'], webp: ['WebP', 'image'], svg: ['SVG', 'image'],
  wav: ['WAV', 'audio'], mp3: ['MP3', 'audio'], flac: ['FLAC', 'audio'], mp4: ['MP4', 'video'], webm: ['WebM', 'video'],
  zip: ['ZIP', 'archive'], gz: ['Archive', 'archive'], tar: ['Archive', 'archive']
};
const mimeTypes = {
  'image/png': ['PNG', 'image'], 'image/gif': ['GIF', 'image'], 'image/jpeg': ['JPEG', 'image'], 'image/webp': ['WebP', 'image'],
  'audio/wav': ['WAV', 'audio'], 'audio/mpeg': ['MP3', 'audio'], 'audio/flac': ['FLAC', 'audio'],
  'video/mp4': ['MP4', 'video'], 'video/webm': ['WebM', 'video'], 'application/pdf': ['PDF', 'file'],
  'application/json': ['JSON', 'code'], 'text/markdown': ['Markdown', 'file'], 'text/csv': ['CSV', 'file']
};
export function filePresentation(file) {
  const extension = /\.([^.\/]+)$/.exec(String(file?.path ?? ''))?.[1].toLowerCase();
  const mime = typeof file?.mime === 'string' ? file.mime : '';
  const [type, icon] = Object.hasOwn(fileTypes, extension) ? fileTypes[extension] : Object.hasOwn(mimeTypes, mime) ? mimeTypes[mime]
    : mime.startsWith('text/') ? ['Text', 'file'] : mime.startsWith('image/') ? ['Image', 'image']
    : mime.startsWith('audio/') ? ['Audio', 'audio'] : mime.startsWith('video/') ? ['Video', 'video'] : ['File', 'file'];
  return { type, icon };
}
const recordedActivity = message => Array.isArray(message?.metadata?.toolActivity)
  ? message.metadata.toolActivity.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
const fileArrays = item => [{ files: item.availableFiles, available: true }, { files: item.files, available: false }];
function fileSource(item, available) {
  if (available) return 'Available saved file';
  if (item.name === 'write_workspace') return 'Saved file revision';
  if (['run_python', 'run_shell'].includes(item.name)) return 'Created or changed output';
  return 'Recorded file result';
}

/** A link must match its path, revision, and conversation before it can be displayed. */
export function generatedFilesHtml(message) {
  const files = new Map();
  for (const item of recordedActivity(message)) for (const group of fileArrays(item)) for (const file of Array.isArray(group.files) ? group.files : []) {
    const link = workspaceDownload(file?.url, message.conversationId);
    if (!link || link.path !== file.path || link.revision !== file.revision) continue;
    const key = `${link.path}@${link.revision}`, sources = files.get(key)?.sources ?? new Set();
    sources.add(fileSource(item, group.available)); files.set(key, { ...file, ...link, sources });
  }
  if (!files.size) return '';
  return `<section class="generated-files compact-generated-files" aria-label="Workspace file results"><ul class="generated-file-list">${[...files.values()].map(file => {
    const { type, icon } = filePresentation(file), name = file.path.split('/').at(-1);
    const detail = `${file.path}\n${file.mime ?? type}${Number.isSafeInteger(file.size) && file.size >= 0 ? ` · ${file.size} bytes` : ''}\nRevision ${file.revision}\n${[...file.sources].join('; ')}. A file result is not proof that the file was tested.`;
    const preview = /^text\/|^image\/(png|jpeg|webp|gif)$|^audio\/(wav|mpeg|flac)$|^video\/(mp4|webm)$/.test(file.mime ?? '') || /\.(pdf|docx|py|js|json|csv|md|txt)$/i.test(file.path);
    return `<li class="generated-file-row"><span class="result-file-icon result-file-${icon}">${presentationIcon(icon)}</span><a class="generated-file-label" href="${esc(file.url)}" download title="${esc(`Download ${detail}`)}" aria-label="${esc(`Download ${file.path}, ${type}, revision ${file.revision.slice(0, 8)}`)}"><span class="generated-file-name">${esc(name)}</span><span class="generated-file-type">${esc(type)}</span></a>${preview ? `<button type="button" class="ghost tool-icon-button" data-workspace-preview="${esc(file.path)}" data-revision="${esc(file.revision)}" title="${esc(`Preview ${detail}`)}" aria-label="${esc(`Preview ${file.path}, ${type}, revision ${file.revision.slice(0, 8)}`)}">${presentationIcon('preview')}</button>` : `<span class="result-file-download" title="${esc(`Download ${file.path} to open this file type.`)}">${presentationIcon('download')}</span>`}</li>`;
  }).join('')}</ul></section>`;
}

const activeStatuses = new Set(['pending', 'queued', 'starting', 'running', 'cancelling', 'canceling']);
const failedStatuses = new Set(['error', 'failed', 'timed_out', 'interrupted']);
const statusLabels = { complete: 'complete', error: 'failed', timed_out: 'timed out', canceling: 'cancelling' };
const toolNames = { list_workspace: 'List files', read_workspace: 'Read file', write_workspace: 'Write file', search_workspace: 'Search files', run_python: 'Run Python', run_shell: 'Run shell', install_packages: 'Install packages' };
const statusLabel = value => Object.hasOwn(statusLabels, value) ? statusLabels[value] : value;
const statusClass = status => activeStatuses.has(status) ? 'tool-status-active' : failedStatuses.has(status) ? 'tool-status-error' : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unavailable';
const limit = value => value === null ? 'off' : count(value);
const grants = value => ['workspace', 'execute', 'packages'].filter(key => value?.[key] === true).map(key => ({ workspace: 'files', execute: 'execution', packages: 'packages' })[key]).join(', ') || 'none';

/** Display every saved call. Saved permissions and imported records never authorize tools. */
export function toolActivityHtml(message) {
  const activity = recordedActivity(message);
  if (!activity.length) return '';
  const meta = message.metadata, budget = meta.toolBudget, states = new Map();
  for (const item of activity) {
    const status = String(item.status ?? 'archived'); states.set(status, (states.get(status) ?? 0) + 1);
  }
  const extraErrors = activity.filter(item => item.error && !failedStatuses.has(String(item.status))).length;
  const pastGrants = meta.toolPermissions ?? meta.archivedToolContext?.permissions;
  const permissions = pastGrants && typeof pastGrants === 'object' && !Array.isArray(pastGrants) ? grants(pastGrants) : 'unavailable (archived or older history)';
  const provenance = meta.archivedToolContext ? 'Archived tool context' : pastGrants ? 'Recorded turn permissions' : 'Permission provenance unavailable';
  const details = `<details class="tool-turn-details" data-tool-detail="${esc(`turn:${message.id}`)}"><summary>Turn details</summary><p>Permissions recorded for this turn: ${esc(permissions)}. ${esc(provenance)}.</p><p>Saved activity is display history. Imported activity is not proof of local execution. Recorded permissions do not grant current access.</p>${budget ? `<p>${esc(count(budget.executedCalls))} executed calls, ${esc(count(budget.executedRounds))} tool rounds. Call budget: ${esc(limit(budget.callLimit))}. Round budget: ${esc(limit(budget.roundLimit))}.${budget.stopReason ? ` ${esc(budget.stopReason)}` : ''}</p>` : '<p>Work budget details are unavailable for this turn.</p>'}<p>File results can include unchanged available files. A saved file is not proof that it was created or tested by a call. Open an execution for its full saved console and results.</p></details>`;
  // The server bounds history by bytes, not by a fixed number of visible calls.
  return `<section class="tool-activity compact-tool-activity" aria-label="Tool activity"><details class="tool-activity-group" data-tool-detail="${esc(`activity:${message.id}`)}"><summary class="tool-activity-summary">${presentationIcon('chevron')}<span>Tools · ${activity.length} ${activity.length === 1 ? 'call' : 'calls'}</span><span class="tool-activity-states">${[...states].map(([status, total]) => `<span class="tool-summary-status ${statusClass(status)}">${total} ${esc(statusLabel(status))}</span>`).join('')}${extraErrors ? `<span class="tool-summary-status tool-status-error">${extraErrors} with errors</span>` : ''}</span></summary><div class="tool-activity-records">${activity.map(item => {
    const name = String(item.name ?? 'Tool'), label = Object.hasOwn(toolNames, name) ? toolNames[name] : name, status = String(item.status ?? 'archived');
    const console = [item.stdout ? `stdout\n${item.stdout}` : '', item.stderr ? `stderr\n${item.stderr}` : ''].filter(Boolean).join('\n\n');
    return `<details class="tool-call" data-tool-detail="${esc(message.id + ':' + item.id)}"${status === 'running' ? ' open' : ''}><summary title="${esc(`${name} · ${status}`)}">${presentationIcon('chevron')}<span class="tool-call-name">${esc(label)}</span><span class="tool-call-status ${statusClass(status)}">${esc(statusLabel(status))}${item.error && !failedStatuses.has(status) ? ' · error recorded' : ''}</span></summary><div class="tool-call-body"><pre>${esc(item.summary ?? '')}</pre>${item.error ? `<p class="error">${esc(item.error)}</p>` : ''}${console ? `<pre class="tool-console" aria-label="Saved console excerpt">${esc(console)}</pre>` : ''}${item.changed === false ? '<p class="small">File bytes were unchanged. No new revision was created.</p>' : ''}${item.totalAvailableFiles != null ? `<p class="small">${esc(count(item.totalAvailableFiles))} files were available after this call. Available files are not necessarily changed outputs.</p>` : ''}${item.exitCode != null ? `<p class="small">Exit code: ${esc(item.exitCode)}</p>` : ''}<div class="tool-call-footer"><p class="small">${esc(name)} · Call ${esc(item.id ?? 'unavailable')}${item.executionId ? `<br>Execution ${esc(item.executionId)}${item.operationId ? ` · runner operation ${esc(item.operationId)}` : ''}` : ''}</p>${item.executionId ? `<button type="button" class="ghost tool-icon-button" data-execution-result="${esc(item.executionId)}" title="Full console and results" aria-label="${esc(`Open full console and results for ${label}`)}">${presentationIcon('console')}</button>` : ''}</div></div></details>`;
  }).join('')}${details}</div></details></section>`;
}
