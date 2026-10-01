/** A deliberately restricted Markdown renderer. Raw HTML and remote images are never rendered. */
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function inline(input, depth = 0) {
  if (depth > 6) return escape(input);
  // Tokenize before escaping. Generated HTML never becomes input to another replacement.
  const pattern = /(`+)([^`\n]+?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|~~([^~\n]+)~~/g;
  let result = '', start = 0, match;
  while ((match = pattern.exec(input))) {
    result += escape(input.slice(start, match.index));
    if (match[1]) result += `<code>${escape(match[2])}</code>`;
    else if (match[3]) {
      let url;
      try { url = new URL(match[4]); } catch {}
      const safe = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      // An image expression is displayed as text, not as an external network request.
      const image = match.index > 0 && input[match.index - 1] === '!';
      result += safe && !image ? `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(match[3])}</a>` : escape(match[0]);
    } else if (match[5] || match[6]) result += `<strong>${inline(match[5] ?? match[6], depth + 1)}</strong>`;
    else if (match[7]) result += `<em>${inline(match[7], depth + 1)}</em>`;
    else result += `<del>${escape(match[8])}</del>`;
    start = pattern.lastIndex;
  }
  return result + escape(input.slice(start));
}
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
export function markdown(input) {
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([^ ]*)\s*$/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      output.push(`<div class="table-scroll"><table><thead><tr>${header.map(x => `<th>${inline(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const list = /^\s*([-+*]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]), tag = ordered ? 'ol' : 'ul', rows = [];
      while (i < lines.length) {
        const item = /^\s*([-+*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        rows.push(`<li>${inline(item[2])}</li>`); i++;
      }
      output.push(`<${tag}>${rows.join('')}</${tag}>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      output.push(`<blockquote>${quote.map(x => inline(x)).join('<br>')}</blockquote>`); continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*[-+*]\s|\s*\d+\.\s|>|\s*`{3,}|\s*~{3,})/.test(lines[i])) {
      if (i + 1 < lines.length && lines[i].includes('|') && lines[i + 1].includes('---')) break;
      paragraph.push(lines[i++]);
    }
    output.push(`<p>${paragraph.map(x => inline(x)).join('<br>')}</p>`);
  }
  return output.join('\n');
}
