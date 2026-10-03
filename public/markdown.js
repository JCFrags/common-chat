import { MarkdownIt, katex, hljs, DOMPurify } from './vendor/rich-text.js';
import { normalizeDiagram, DIAGRAM_LIMITS } from './diagram-source.js';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export const RENDER_LIMITS = Object.freeze({ message: 128 * 1024, code: 16 * 1024, math: 4096, mathCount: 100, mathTotal: 32 * 1024, ...DIAGRAM_LIMITS, diagrams: 4 });
const md = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false, maxNesting: 32 });
const revisionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Accept only an exact conversation-scoped revision download. Never accept arbitrary relative navigation. */
export function workspaceDownload(value, conversationId) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || /[\\\p{C}]/u.test(value) || !revisionId.test(conversationId ?? '')) return null;
  try {
    const url = new URL(value, 'http://workspace.invalid'), expected = `/api/conversations/${encodeURIComponent(conversationId)}/workspace/download`;
    if (url.pathname !== expected || value.split('?')[0] !== expected || url.hash || url.searchParams.size !== 2 ||
        url.searchParams.getAll('path').length !== 1 || url.searchParams.getAll('revision').length !== 1 ||
        !revisionId.test(url.searchParams.get('revision') ?? '')) return null;
    const path = url.searchParams.get('path');
    if (!path || !path.isWellFormed() || path !== path.normalize('NFC') || new TextEncoder().encode(path).length > 512 || /[\\<>:"|?*\p{C}]/u.test(path) || path.startsWith('~')) return null;
    const parts = path.split('/');
    if (parts.length > 8 || parts.some(part => !part || ['.', '..'].includes(part) || part !== part.trim() || part.endsWith('.') || new TextEncoder().encode(part).length > 120 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
    return { url: expected + '?' + url.searchParams, path, revision: url.searchParams.get('revision') };
  } catch { return null; }
}
md.validateLink = value => {
  if (value.startsWith('/')) return !!workspaceDownload(value, /^\/api\/conversations\/([^/]+)\//.exec(value)?.[1]);
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};
// Image syntax remains visible. It never creates an image, even for same-origin URLs.
md.renderer.rules.image = (tokens, i) => escape(`![${tokens[i].content}](${tokens[i].attrGet('src')})`);
const linkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, i, options, env, renderer) => {
  const href = tokens[i].attrGet('href') ?? '';
  if (href.startsWith('/')) {
    const file = workspaceDownload(href, env.conversationId);
    if (file) { tokens[i].attrSet('href', file.url); tokens[i].attrSet('download', ''); }
    else tokens[i].attrs = (tokens[i].attrs ?? []).filter(([name]) => name !== 'href');
  } else { tokens[i].attrSet('target', '_blank'); tokens[i].attrSet('rel', 'noopener noreferrer'); }
  return linkOpen ? linkOpen(tokens, i, options, env, renderer) : renderer.renderToken(tokens, i, options);
};
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
// Use classes instead of inline alignment styles under style-src 'self'.
for (const tag of ['th_open', 'td_open']) md.renderer.rules[tag] = (tokens, i, options, env, renderer) => {
  const alignment = /^text-align:(left|right|center)$/.exec(tokens[i].attrGet('style') ?? '');
  tokens[i].attrs = (tokens[i].attrs ?? []).filter(([name]) => name !== 'style');
  if (alignment) tokens[i].attrSet('class', `align-${alignment[1]}`);
  return renderer.renderToken(tokens, i, options);
};
md.core.ruler.after('inline', 'tasks', state => {
  for (let i = 2; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type !== 'inline' || state.tokens[i - 1].type !== 'paragraph_open' || state.tokens[i - 2].type !== 'list_item_open') continue;
    const first = token.children?.[0], task = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
    if (!task) continue;
    first.content = first.content.slice(task[0].length);
    const checkbox = new state.Token('task_checkbox', '', 0); checkbox.meta = { checked: task[1] !== ' ' };
    token.children.unshift(checkbox);
  }
});
md.renderer.rules.task_checkbox = (tokens, i) => `<input class="task-checkbox" type="checkbox" disabled${tokens[i].meta.checked ? ' checked' : ''} aria-label="${tokens[i].meta.checked ? 'Completed task' : 'Incomplete task'}"> `;

function mathHtml(source, display, env) {
  const reason = source.length > RENDER_LIMITS.math || ++env.mathCount > RENDER_LIMITS.mathCount || (env.mathTotal += source.length) > RENDER_LIMITS.mathTotal ? 'size limit' : null;
  try {
    if (reason) throw new Error(reason);
    // Fresh macros prevent one expression from changing later expressions.
    const result = katex.renderToString(source, { output: 'mathml', displayMode: display, trust: false, strict: 'error', throwOnError: true, maxExpand: 500, maxSize: 10, macros: {} });
    return display ? `<div class="math-block">${result}</div>` : result;
  } catch {
    const tag = display ? 'div' : 'span';
    return `<${tag} class="render-fallback"><span class="render-note">Math not rendered (${reason ?? 'invalid or unsupported'}).</span> <code>${escape(source)}</code></${tag}>`;
  }
}
// These rules run before escapes and code-independent inline text processing.
md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const start = state.pos, text = state.src;
  const opener = text.startsWith('\\(', start) ? '\\(' : text[start] === '$' && text[start + 1] !== '$' ? '$' : null;
  if (!opener) return false;
  const closer = opener === '$' ? '$' : '\\)';
  if (opener === '$' && /\s/.test(text[start + 1] ?? ' ')) return false;
  let end = start + opener.length;
  for (;;) {
    end = text.indexOf(closer, end);
    if (end < 0 || text.slice(start, end).includes('\n')) return false;
    let slash = 0; for (let j = end - 1; j >= 0 && text[j] === '\\'; j--) slash++;
    if (slash % 2 === 0) break;
    end += closer.length;
  }
  if (end === start + opener.length || opener === '$' && (/\s/.test(text[end - 1]) || /\d/.test(text[end + 1] ?? ''))) return false;
  if (!silent) { const token = state.push('math_inline', '', 0); token.content = text.slice(start + opener.length, end); }
  state.pos = end + closer.length; return true;
});
md.renderer.rules.math_inline = (tokens, i, options, env) => mathHtml(tokens[i].content, false, env);
md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine], first = state.src.slice(start, state.eMarks[startLine]).trim();
  const opener = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
  if (!opener || state.sCount[startLine] - state.blkIndent >= 4) return false;
  const closer = opener === '$$' ? '$$' : '\\]';
  const pieces = []; let line = startLine, current = first.slice(opener.length), closed = false;
  for (; line < endLine; line++) {
    if (line !== startLine) current = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const end = current.indexOf(closer);
    if (end >= 0 && !current.slice(end + closer.length).trim()) { pieces.push(current.slice(0, end)); closed = true; break; }
    pieces.push(current);
  }
  if (!closed) return false; // Incomplete streaming delimiters stay visible as text.
  if (silent) return true;
  const token = state.push('math_block', '', 0); token.block = true; token.content = pieces.join('\n').trim(); token.map = [startLine, line + 1];
  state.line = line + 1; return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_block = (tokens, i, options, env) => mathHtml(tokens[i].content, true, env) + '\n';

export function diagramProblem(source) {
  return normalizeDiagram(source).problem;
}
export function fencePresentation(info, source) {
  const [language = '', ...flags] = info.trim().toLowerCase().split(/\s+/);
  const name = language.slice(0, 80);
  const intent = flags.some(flag => ['example', 'source'].includes(flag)) ? 'example' : flags.some(flag => ['preview', 'run', 'artifact'].includes(flag)) ? 'artifact' : 'auto';
  const supported = ['html', 'htm', 'xml', 'svg', 'css', 'js', 'javascript', 'mjs', 'cjs', 'mermaid'].includes(name);
  const document = ['html', 'htm', 'xml', 'svg'].includes(name) && (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source) || /^\s*(?:<\?xml[^>]*>\s*)?<svg\b(?:[^>]*\/>|[\s\S]*<\/svg>)\s*$/i.test(source));
  const view = supported && intent !== 'example' && (intent === 'artifact' || name === 'mermaid' || document) ? 'artifact' : 'source';
  return { name, intent, view };
}
md.renderer.rules.fence = (tokens, i, options, env) => {
  const token = tokens[i], source = token.content.replace(/\n$/, ''), { name, intent, view } = fencePresentation(token.info, source);
  const last = token.map ? env.lines[token.map[1] - 1] ?? '' : '';
  const closed = new RegExp(`^\\s*${token.markup[0]}{${token.markup.length},}\\s*$`).test(last);
  const copy = '<button type="button" data-code-copy>Copy code</button>' + (closed && !env.streaming && ['python', 'py'].includes(name)
    ? '<button type="button" data-python-run>Run in isolated Python</button>' : '');
  const plain = `<pre><code>${escape(source)}</code></pre>`;
  const complete = closed && !env.streaming;
  const attributes = `data-code-language="${escape(name)}" data-code-complete="${complete}" data-code-view="${view}" data-code-intent="${intent}"`;
  if (name === 'mermaid') {
    const note = env.streaming ? 'Preview waits until the response ends.' : !closed ? 'Incomplete Mermaid fence.' : '';
    return `<div class="code-block diagram-block" ${attributes}><div class="code-toolbar"><span>Mermaid</span>${copy}</div>${note ? `<p class="render-note">${note}</p>` : ''}<details class="diagram-source artifact-source"${view === 'source' || !complete ? ' open' : ''}><summary>Show code</summary>${plain}</details></div>\n`;
  }
  let rendered = escape(source), note = !closed ? 'Incomplete code fence.' : '';
  if (source.length > RENDER_LIMITS.code) note = 'Highlighting size limit exceeded. Source is shown.';
  else if (closed && !env.streaming && name && hljs.getLanguage(name)) {
    try { rendered = hljs.highlight(source, { language: name, ignoreIllegals: true }).value; }
    catch { note = 'Highlighting failed. Source is shown.'; }
  }
  const code = `<pre><code>${rendered}</code></pre>`;
  const content = view === 'artifact' && complete ? `<details class="artifact-source"><summary>Show code</summary>${code}</details>` : code;
  return `<div class="code-block" ${attributes}><div class="code-toolbar"><span>${escape(name || 'text')}</span>${copy}</div>${note ? `<p class="render-note">${note}</p>` : ''}${content}</div>\n`;
};

const cache = new Map(); let cacheBytes = 0;
export function markdown(input, { streaming = false, conversationId = null } = {}) {
  const source = String(input ?? '').replace(/\r\n?/g, '\n');
  if (source.length > RENDER_LIMITS.message) return `<p class="render-note">Rich rendering size limit exceeded. Source is shown.</p><pre><code>${escape(source)}</code></pre>`;
  const key = `${streaming ? 's' : 'c'}:${conversationId ?? ''}:${source}`;
  if (cache.has(key)) return cache.get(key);
  let result;
  try { result = md.render(source, { streaming, conversationId, lines: source.split('\n'), mathCount: 0, mathTotal: 0, diagrams: 0 }); }
  catch { result = `<p class="render-note">Rich rendering failed. Source is shown.</p><pre><code>${escape(source)}</code></pre>`; }
  // The parser never enables raw HTML. Sanitize generated HTML and MathML in the
  // browser as a second boundary. Node unit tests use the same parser without a DOM.
  if (DOMPurify.isSupported) result = DOMPurify.sanitize(result, { USE_PROFILES: { html: true, mathMl: true }, FORBID_TAGS: ['img', 'style', 'svg', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style', 'src', 'srcset'], ADD_ATTR: ['target'] });
  if (!streaming) {
    cache.set(key, result); cacheBytes += key.length + result.length;
    while (cache.size > 32 || cacheBytes > 512 * 1024) { const oldest = cache.keys().next().value; cacheBytes -= oldest.length + cache.get(oldest).length; cache.delete(oldest); }
  }
  return result;
}
