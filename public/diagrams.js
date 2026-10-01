import { DOMPurify } from './vendor/rich-text.js';
import { normalizeDiagram } from './diagram-source.js';

let generation = 0, serial = Promise.resolve(), library, nextId = 0;
const cache = new Map(); let cacheBytes = 0;
const tags = ['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc'];
const attrs = ['id', 'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'text-anchor', 'dominant-baseline', 'dy', 'dx', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'preserveAspectRatio', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby'];
export function sanitizeDiagram(svg) {
  if (!DOMPurify.isSupported || svg.length > 512 * 1024) throw new Error('Diagram output unavailable or too large.');
  const fragment = DOMPurify.sanitize(svg, { ALLOWED_TAGS: tags, ALLOWED_ATTR: attrs, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['foreignObject', 'style', 'image', 'a', 'script', 'use', 'animate', 'set'], FORBID_ATTR: ['style', 'href', 'xlink:href'] });
  const root = fragment.querySelector('svg');
  if (!root || fragment.childElementCount !== 1 || root.querySelectorAll('*').length > 2500) throw new Error('Invalid or oversized diagram output.');
  const elements = [root, ...root.querySelectorAll('*')], ids = new Map(), prefix = `cc-svg-${++nextId}-`;
  for (const el of elements) if (el.id) { const old = el.id, value = `${prefix}${ids.size}`; if (ids.has(old)) throw new Error('Duplicate diagram ID.'); ids.set(old, value); el.id = value; }
  for (const el of elements) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase(), value = attr.value;
      // Never retain arbitrary style text, links, network references or callbacks.
      if (name.startsWith('on') || /(?:https?:|data:|javascript:|\/\/)/i.test(value)) { el.removeAttribute(attr.name); continue; }
      if (['marker-start', 'marker-mid', 'marker-end'].includes(name)) {
        const ref = /^url\(#([A-Za-z0-9_:.-]+)\)$/.exec(value);
        if (ref && ids.has(ref[1])) el.setAttribute(attr.name, `url(#${ids.get(ref[1])})`); else el.removeAttribute(attr.name);
      } else if (name === 'fill' || name === 'stroke') {
        if (!/^(?:none|currentColor|#[\da-f]{3,8}|[a-z]{1,20})$/i.test(value)) el.removeAttribute(attr.name);
      } else if (name === 'aria-labelledby' || name === 'aria-describedby') {
        const refs = value.split(/\s+/).map(id => ids.get(id)).filter(Boolean);
        if (refs.length) el.setAttribute(attr.name, refs.join(' ')); else el.removeAttribute(attr.name);
      }
    }
  }
  // Fixed palette classes keep pie sectors and legends consistent without
  // preserving upstream inline CSS or any input-provided style.
  for (const selector of ['.pieCircle', '.legend rect']) root.querySelectorAll(selector).forEach((el, i) => el.classList.add(`diagram-palette-${i % 6}`));
  root.removeAttribute('width'); root.removeAttribute('height');
  root.setAttribute('class', 'rendered-diagram'); root.setAttribute('role', 'img');
  if (!root.hasAttribute('aria-label') && !root.hasAttribute('aria-labelledby')) root.setAttribute('aria-label', 'Mermaid diagram. Original source follows.');
  return root;
}
async function mermaid() {
  if (!library) library = import('./vendor/mermaid.js').then(({ default: api }) => {
    api.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base', fontFamily: 'sans-serif', layout: 'dagre', maxTextSize: 8192, maxEdges: 100, suppressErrorRendering: true, flowchart: { htmlLabels: false, useMaxWidth: false }, sequence: { useMaxWidth: false }, secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'fontFamily', 'layout', 'flowchart', 'sequence', 'secure'] });
    return api;
  });
  return library;
}
export function cancelDiagrams() { generation++; }
export function renderDiagrams(root, onRendered = () => {}) {
  const current = ++generation;
  const blocks = [...root.querySelectorAll('[data-diagram-source]')];
  for (const block of blocks.slice(8)) {
    block.querySelector('[data-diagram-status]').textContent = 'Visible diagram limit exceeded. Source is shown.';
    block.querySelector('.diagram-source').open = true;
  }
  // One render at a time. A changed thread invalidates queued jobs before they run.
  serial = serial.catch(() => {}).then(async () => {
    for (const block of blocks.slice(0, 8)) {
      if (current !== generation || !block.isConnected || !root.contains(block)) return;
      // Read visible source text. XML-safe sanitizers remove attributes that contain arrows.
      const source = block.querySelector('.diagram-source code').textContent, status = block.querySelector('[data-diagram-status]');
      let stage;
      try {
        const normalized = normalizeDiagram(source); if (normalized.problem) throw new Error(normalized.problem);
        let svg = cache.get(source);
        if (!svg) {
          const api = await mermaid();
          if (current !== generation || !block.isConnected) return;
          stage = document.createElement('div'); stage.className = 'diagram-stage'; stage.setAttribute('aria-hidden', 'true'); document.body.append(stage);
          // Do not call bindFunctions. The source and output cannot add callbacks.
          ({ svg } = await api.render(`cc-diagram-${++nextId}`, normalized.source, stage));
          if (svg.length <= 512 * 1024) {
            cache.set(source, svg); cacheBytes += source.length + svg.length;
            while (cache.size > 16 || cacheBytes > 1024 * 1024) { const oldest = cache.keys().next().value; cacheBytes -= oldest.length + cache.get(oldest).length; cache.delete(oldest); }
          }
        }
        if (current !== generation || !block.isConnected || !root.contains(block)) return;
        block.querySelector('.diagram-output').replaceChildren(sanitizeDiagram(svg));
        status.hidden = true; onRendered();
      } catch {
        if (current === generation && block.isConnected) {
          status.textContent = 'Diagram not rendered (invalid, unsupported, or too large). Source is shown.';
          block.querySelector('.diagram-source').open = true;
        }
      } finally { stage?.remove(); }
    }
  });
  return serial;
}
