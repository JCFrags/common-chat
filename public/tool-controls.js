export { generatedFilesHtml, toolActivityHtml } from './tool-presentation.js';

const empty = () => ({ workspace: false, execute: false, packages: false });

/** Automatic native availability is evaluated locally, never from saved model history. */
export function installToolControls({ api, getProvider }) {
  let runtime = null, checking = null, generation = 0;
  const panel = document.createElement('section'); panel.className = 'tool-controls';
  panel.setAttribute('aria-label', 'Native tool availability');
  panel.innerHTML = '<div class="row spread"><p class="small tool-availability" role="status"></p><button type="button" class="ghost icon" data-check-runtime aria-label="Refresh tool availability" title="Refresh tool availability"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg></button></div><ul class="native-tool-list"></ul><details><summary>Scope and safety</summary><p class="small">Supported native tools are available automatically. Files belong to this conversation. Code runs in a copied workspace with no host access or general network. Packages use approved registries only. Cancellation does not undo completed file changes. Saved activity describes a past turn, not future permission. Manual code review and Run remain separate.</p></details><details class="tool-inventory"><summary>Bundled libraries</summary><p class="small"></p></details>';
  const host = document.querySelector('#native-tools-panel');
  if (host) host.append(panel); else document.querySelector('#composer').before(panel);
  const enabled = () => getProvider()?.capabilities?.tools === true;
  function read() {
    return enabled() ? { workspace: true, execute: runtime?.ready === true, packages: runtime?.ready === true && runtime?.packages === true } : empty();
  }
  function refresh() {
    panel.querySelector('.tool-availability').textContent = !enabled()
      ? 'This connection does not support configured function tools. Files and manual Run remain separate.'
      : checking ? 'Checking native tools…'
      : runtime?.ready ? 'Native tools are available automatically.'
      : `File tools are available automatically. ${(runtime?.blockedReasons ?? ['Runner availability has not been checked.']).join(' ')}`;
    const list = panel.querySelector('.native-tool-list'); list.replaceChildren();
    const permissions = read();
    for (const tool of runtime?.nativeTools ?? []) {
      const row = document.createElement('li'), label = document.createElement('span'), status = document.createElement('small');
      label.textContent = tool.title ?? tool.name; label.title = tool.description ?? '';
      status.textContent = permissions[tool.category] && tool.available === true ? 'Available' : !enabled() ? 'Unsupported connection' : 'Unavailable';
      row.append(label, status); list.append(row);
    }
    const inventory = runtime?.inventory;
    panel.querySelector('.tool-inventory p').textContent = inventory
      ? `Python ${inventory.pythonVersion}, Node ${inventory.nodeVersion}. Bundled: ${inventory.python.map(item => `${item.name}==${item.version}`).join(', ')}. Compatible bundled libraries need no install. Missing wheels must fit 32 MiB and 4096 regular files.`
      : 'Verified inventory is unavailable. Do not assume library versions.';
    panel.querySelector('[data-check-runtime]').disabled = !!checking;
  }
  async function checkRuntime() {
    if (checking) return checking;
    const current = generation;
    const pending = api('/api/runtime').then(value => { if (current === generation) runtime = value; }, error => {
      if (current === generation) runtime = { ready: false, packages: false, blockedReasons: [error.message] };
    }).finally(() => { if (checking === pending) checking = null; refresh(); });
    checking = pending; refresh(); return pending;
  }
  async function readForTurn() {
    const providerId = getProvider()?.id, current = generation;
    if (!enabled()) return empty();
    await checkRuntime();
    if (current !== generation || getProvider()?.id !== providerId) throw new Error('The connection changed while checking tools. Review it before sending.');
    return read();
  }
  panel.querySelector('[data-check-runtime]').addEventListener('click', checkRuntime);
  refresh();
  return { read, readForTurn, refresh, checkRuntime, created() {},
    clear() { generation++; runtime = null; checking = null; refresh(); }
  };
}
