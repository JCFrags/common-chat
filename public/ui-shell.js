/** Shell navigation only. Existing app handlers own all saved state and operations. */
export function installShell({ onSettingsTab = () => {} } = {}) {
  const $ = selector => document.querySelector(selector);
  const settings = $('#preferences-dialog'), tablist = $('#settings-tabs');
  const tabs = [...tablist.querySelectorAll('[data-settings-tab]')];
  const panels = [...settings.querySelectorAll('[data-settings-panel]')];
  const attach = $('#attach-button'), menu = $('#composer-menu');
  const uploadPanel = $('#upload-menu-panel'), toolsPanel = $('#tools-submenu'), tools = $('#tools-menu-button');
  const model = $('#model-button'), picker = $('#model-controls');
  let selectedTab = 'connections';

  function selectTab(name, focus = false) {
    const selected = tabs.find(tab => tab.dataset.settingsTab === name);
    if (!selected) return;
    selectedTab = name;
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== name;
    if (focus) selected.focus();
    onSettingsTab(name);
  }
  const mobile = matchMedia('(max-width: 760px)');
  const sidebarToggle = $('#sidebar-compact-toggle'), app = $('#app');
  const sidebarKey = 'common-chat:sidebar-compact';
  let compact = true;
  try { compact = localStorage.getItem(sidebarKey) !== 'false'; } catch { /* Layout storage is optional. */ }
  function setCompact(value) {
    compact = value; app.classList.toggle('sidebar-compact', compact);
    sidebarToggle.setAttribute('aria-expanded', String(!compact));
    sidebarToggle.setAttribute('aria-label', compact ? 'Expand sidebar' : 'Collapse sidebar');
    sidebarToggle.title = compact ? 'Expand sidebar' : 'Collapse sidebar';
  }
  function saveCompact(value) {
    setCompact(value);
    try { localStorage.setItem(sidebarKey, String(value)); } catch { /* Keep the in-page layout. */ }
  }
  function expandSidebar() {
    if (mobile.matches) app.classList.add('sidebar-open'); else saveCompact(false);
  }
  setCompact(compact);
  sidebarToggle.addEventListener('click', () => saveCompact(!compact));
  const orientTabs = () => tablist.setAttribute('aria-orientation', mobile.matches ? 'horizontal' : 'vertical');
  orientTabs(); mobile.addEventListener('change', orientTabs);
  tablist.addEventListener('click', event => {
    const tab = event.target.closest('[data-settings-tab]');
    if (tab) selectTab(tab.dataset.settingsTab);
  });
  tablist.addEventListener('keydown', event => {
    const tab = event.target.closest('[data-settings-tab]');
    if (!tab) return;
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (next === undefined) return;
    event.preventDefault(); selectTab(tabs[next].dataset.settingsTab, true);
  });

  function closeModel(focus = false) {
    const wasOpen = !picker.hidden;
    picker.hidden = true; model.setAttribute('aria-expanded', 'false');
    if (focus && wasOpen) model.focus();
  }
  function closeUploadMenu(focus = false) {
    const wasOpen = !menu.hidden;
    menu.hidden = true; attach.setAttribute('aria-expanded', 'false');
    toolsPanel.hidden = true; uploadPanel.hidden = false; tools.setAttribute('aria-expanded', 'false');
    if (focus && wasOpen) attach.focus();
  }
  function closePopups() { closeModel(); closeUploadMenu(); }
  function openSettings(name = selectedTab) {
    closePopups(); selectTab(name);
    if (!settings.open) settings.showModal();
  }
  function closeSettings() { if (settings.open) settings.close(); }
  function openModel() {
    if (model.disabled) return;
    closeUploadMenu(); closeSettings();
    picker.hidden = false; model.setAttribute('aria-expanded', 'true'); $('#model-select').focus();
  }
  function openUploadMenu() {
    if (attach.disabled) return;
    closeModel(); menu.hidden = false; attach.setAttribute('aria-expanded', 'true');
    uploadPanel.hidden = false; toolsPanel.hidden = true; tools.setAttribute('aria-expanded', 'false');
    $('#upload-button').focus();
  }
  function showTools() {
    uploadPanel.hidden = true; toolsPanel.hidden = false; tools.setAttribute('aria-expanded', 'true');
    $('#menu-workspace').focus();
  }
  function showUpload() {
    toolsPanel.hidden = true; uploadPanel.hidden = false; tools.setAttribute('aria-expanded', 'false'); tools.focus();
  }
  attach.addEventListener('click', () => menu.hidden ? openUploadMenu() : closeUploadMenu(true));
  attach.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); openUploadMenu(); }
  });
  tools.addEventListener('click', showTools);
  $('#tools-menu-back').addEventListener('click', showUpload);
  menu.addEventListener('keydown', event => {
    const button = event.target.closest('[role="menuitem"]');
    if (!button) return;
    if (event.key === 'ArrowRight' && button === tools) { event.preventDefault(); showTools(); return; }
    if (event.key === 'ArrowLeft' && !toolsPanel.hidden) { event.preventDefault(); showUpload(); return; }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!toolsPanel.hidden) showUpload(); else closeUploadMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault(); closeUploadMenu();
      (event.shiftKey ? attach : $('#dictation-button')).focus(); return;
    }
    const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.closest('[hidden]') && !item.disabled);
    const index = items.indexOf(button);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
    if (next === undefined || !items.length) return;
    event.preventDefault(); items[next].focus();
  });
  model.addEventListener('click', () => picker.hidden ? openModel() : closeModel(true));
  model.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); openModel(); }
  });
  $('#close-model-picker').addEventListener('click', () => closeModel(true));
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModel(true); }
    if (event.key === 'Enter' && event.target === $('#model-select')) {
      event.preventDefault(); event.target.dispatchEvent(new Event('change', { bubbles: true })); closeModel(true);
    }
  });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !attach.contains(event.target)) closeUploadMenu();
    if (!picker.contains(event.target) && !model.contains(event.target)) closeModel();
  });
  document.addEventListener('focusin', event => {
    if (!menu.contains(event.target) && event.target !== attach) closeUploadMenu();
    if (!picker.contains(event.target) && event.target !== model) closeModel();
  });
  return { openSettings, closeSettings, openModel, closePopups, closeUploadMenu, expandSidebar };
}
