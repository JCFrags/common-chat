// Touch-only gestures. Native buttons and scrollable message content keep their input.
export function sidebarSwipe({ mode, startX, dx, dy, elapsed, width }) {
  if (width > 760 || elapsed > 800 || Math.abs(dx) < 64 || Math.abs(dy) > 40 || Math.abs(dx) < Math.abs(dy) * 1.7) return null;
  if (mode === 'open' && startX <= 24 && dx > 0) return 'open';
  if (mode === 'close' && dx < 0) return 'close';
  return null;
}
export function installSidebarGestures(app, sidebar) {
  let gesture = null;
  const excluded = 'button,a,input,textarea,select,label,summary,[contenteditable],pre,code,table,svg,.message-body,.reasoning,.table-scroll,.diagram-output';
  const selected = () => !!window.getSelection()?.toString();
  document.addEventListener('touchstart', event => {
    gesture = null;
    if (event.touches.length !== 1 || !matchMedia('(max-width: 760px)').matches || app.hidden || selected()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(excluded)) return;
    const touch = event.touches[0], open = app.classList.contains('sidebar-open');
    if (open ? !sidebar.contains(target) : touch.clientX > 24 || !app.contains(target)) return;
    gesture = { mode: open ? 'close' : 'open', id: touch.identifier, startX: touch.clientX, startY: touch.clientY, started: performance.now() };
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (!gesture) return;
    if (event.touches.length !== 1 || selected()) { gesture = null; return; }
    const touch = [...event.touches].find(t => t.identifier === gesture.id); if (!touch) return;
    const dx = touch.clientX - gesture.startX, dy = touch.clientY - gesture.startY;
    if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
    const intended = gesture.mode === 'open' ? dx > 0 : dx < 0;
    if (intended && Math.abs(dx) >= 12 && Math.abs(dx) > Math.abs(dy) * 1.7 && event.cancelable) event.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', event => {
    const current = gesture; gesture = null;
    if (!current || event.touches.length || selected()) return;
    const touch = [...event.changedTouches].find(t => t.identifier === current.id); if (!touch) return;
    const result = sidebarSwipe({ ...current, dx: touch.clientX - current.startX, dy: touch.clientY - current.startY, elapsed: performance.now() - current.started, width: window.innerWidth });
    if (result) app.classList.toggle('sidebar-open', result === 'open');
  }, { passive: true });
  document.addEventListener('touchcancel', () => { gesture = null; }, { passive: true });
}
