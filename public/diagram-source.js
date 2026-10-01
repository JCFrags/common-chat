export const DIAGRAM_LIMITS = Object.freeze({ diagram: 8192, diagramLines: 100 });
const unsafe = 'Diagram configuration, HTML, links, images, and callbacks are not supported.';
const styling = 'Unsupported diagram styling syntax. Source is shown.';
const id = '[A-Za-z0-9_][A-Za-z0-9_-]*';
const ids = `${id}(?:\\s*,\\s*${id})*`;
const styleCommand = new RegExp(`^(style|classDef)\\s+(${ids})\\s+(.+)$`);
const classCommand = new RegExp(`^class\\s+${ids}\\s+${ids}$`);
const linkCommand = /^linkStyle\s+(?:default|\d+(?:\s*,\s*\d+)*)\s+(.+)$/;
// Only simple declarations can be discarded. Do not consume an arbitrary tail
// that might include another Mermaid command without a statement separator.
const value = '(?:#[\\da-f]{3,8}|[a-z][a-z0-9-]*|-?\\d+(?:\\.\\d+)?(?:px|em|rem|%)?(?:[ \\t]+-?\\d+(?:\\.\\d+)?(?:px|em|rem|%)?)*)';
const declarations = new RegExp(`^[a-z][a-z0-9-]*\\s*:\\s*${value}(?:\\s*,\\s*[a-z][a-z0-9-]*\\s*:\\s*${value})*\\s*$`, 'i');

// Split only at real statement boundaries. Flowchart labels, quoted text,
// and pipe-delimited edge labels can contain semicolons or command words.
function statements(source, type) {
  const pieces = [], stack = [];
  const flowchart = type === 'graph' || type === 'flowchart';
  const classSyntax = flowchart || type === 'classDiagram' || type.startsWith('stateDiagram');
  let text = '', quote = false, pipe = false;
  // Other diagram types use lines inside their bodies as statements. Do not
  // hide a nested styling or link command inside a state or namespace body.
  const closes = flowchart ? { '[': ']', '(': ')', '{': '}' } : {};
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c !== '\n' || flowchart) {
        text += c;
        if (c === '\\' && source[i + 1] === '"') text += source[++i];
        else if (c === '"') quote = false;
        continue;
      }
      quote = false;
    }
    if (c === '"') { quote = true; text += c; continue; }
    if (source.startsWith('%%', i)) {
      // Configuration directives have already been rejected, even in comments.
      while (i < source.length && source[i] !== '\n') i++;
      i--; continue;
    }
    if (flowchart && c === '|' && !stack.length) { pipe = !pipe; text += c; continue; }
    if (!pipe) {
      if (closes[c]) stack.push(closes[c]);
      else if (stack.at(-1) === c) stack.pop();
    }
    if (!stack.length && !pipe && (c === ';' || c === '\n')) {
      pieces.push({ text, separator: c }); text = ''; continue;
    }
    if (classSyntax && !stack.length && !pipe && source.startsWith(':::', i)) {
      // A trailing hyphen can be the start of an edge, not a class name.
      const suffix = /^:::[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/.exec(source.slice(i));
      if (!suffix) return null;
      // Never pass input-provided class assignments to Mermaid or application CSS.
      i += suffix[0].length - 1; continue;
    }
    text += c;
  }
  if (quote || stack.length || pipe) return null;
  pieces.push({ text, separator: '' });
  return pieces;
}

export function normalizeDiagram(source) {
  const fail = problem => ({ source: null, problem });
  if (source.length > DIAGRAM_LIMITS.diagram || source.split(/[;\n]/).length > DIAGRAM_LIMITS.diagramLines || (source.match(/[A-Za-z0-9_]+/g) ?? []).length > 600) return fail('Diagram size limit exceeded.');
  // Check the original input before removing comments or styling. A directive or
  // network reference in a discarded statement must not reach the render stage.
  if (/%%\s*\{|^\s*---|<\/?[a-z!]|(?:https?:|data:|javascript:|url\s*\(|@\s*\{)/im.test(source)) return fail(unsafe);
  const type = /^\s*(graph\b|flowchart\b|sequenceDiagram\b|classDiagram\b|stateDiagram(?:-v2)?\b|erDiagram\b|pie\b)/.exec(source)?.[1];
  if (!type) return fail('Unsupported diagram type.');
  const flowchart = type === 'graph' || type === 'flowchart';
  const parts = statements(source, type);
  if (!parts) return fail('Invalid diagram delimiters. Source is shown.');
  let normalized = '';
  for (const part of parts) {
    const command = part.text.trim();
    if (/^(?:click|callback|href|src|image|icon|link|links|cssClass)(?:\s|$)/i.test(command)) return fail(unsafe);
    let discard = false;
    if (/^(?:style|classDef|linkStyle)(?:\s|$)/.test(command)) {
      const css = styleCommand.exec(command)?.[3] ?? linkCommand.exec(command)?.[1];
      if (!css || !declarations.test(css)) return fail(styling);
      discard = true;
    } else if ((flowchart || type.startsWith('stateDiagram')) && /^class(?:\s|$)/.test(command)) {
      if (!classCommand.test(command)) return fail(styling);
      discard = true;
    }
    normalized += (discard ? '' : part.text) + part.separator;
  }
  return { source: normalized, problem: null };
}
