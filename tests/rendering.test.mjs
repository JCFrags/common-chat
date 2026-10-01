import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, diagramProblem, RENDER_LIMITS } from '../public/markdown.js';
import { sidebarSwipe } from '../public/touch.js';

test('Rich rendering supports nested tasks, math, highlighted code, safe diagrams, and visible bounded fallbacks', () => {
  const rich = markdown('# Heading\n\n- [x] done\n  - nested **bold** and ~~deleted~~\n\n> quote\n> second\n\n| A | B |\n| :--- | ---: |\n| one | two |\n\nInline $x^2$ and \\(y_1\\).\n\n$$\\frac{1}{2}$$\n\n\\[\nz^2\n\\]\n\n```python\ndef example():\n  return 42\n```\n\n```mermaid\nflowchart LR\nA-->B\n```');
  for (const part of ['<h1>', 'task-checkbox', 'checked', '<ul>', '<blockquote>', '<s>', '<table>', 'align-right', '<math', 'math-block', 'hljs-keyword', 'data-code-copy', 'data-diagram-source']) assert(rich.includes(part), part);
  assert(!rich.includes('style='));
  assert(!markdown('```mermaid\nflowchart LR\nA-->B\n```', { streaming: true }).includes('data-diagram-source='));
  assert(!markdown('```mermaid\nflowchart LR\nA-->B').includes('data-diagram-source='));
  assert(markdown('$\\unknown{bad}$').includes('Math not rendered'));
  assert(markdown(`$${'x'.repeat(RENDER_LIMITS.math + 1)}$`).includes('size limit'));
  assert(markdown(`\n\n${'$x$ '.repeat(RENDER_LIMITS.mathCount + 1)}`).includes('size limit'));
  assert(markdown('x'.repeat(RENDER_LIMITS.message + 1)).includes('Rich rendering size limit'));
  assert(markdown('```js\n' + 'x'.repeat(RENDER_LIMITS.code + 1) + '\n```').includes('Highlighting size limit'));
  const malicious = markdown('<script>alert(1)</script>\n\n![x](https://tracker.example/pixel)\n\n[x](javascript:alert(1))\n\n[x](data:text/html,bad)\n\n[x](https://user:password@example.test/)\n\n[x](https://example.test/)\n\n$\\includegraphics{https://tracker.example/math}$');
  for (const part of ['<script', '<img', 'href="javascript:', 'href="data:', 'href="https://user:']) assert(!malicious.includes(part), part);
  assert(malicious.includes('&lt;script&gt;')); assert(malicious.includes('rel="noopener noreferrer"'));
  assert.equal(diagramProblem('sequenceDiagram\nAlice->>Bob: Hello'), null);
  for (const source of ['---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B', 'flowchart LR\n%%{init: {securityLevel: "loose"}}%%\nA-->B', 'flowchart LR\nclick A "https://example.test"', 'flowchart LR\nA@{img: "https://tracker.example/a"}', 'flowchart LR\nA[<img src=x>]', 'flowchart LR\nclassDef x fill:url(test)', 'mindmap\nroot', 'flowchart LR\n' + 'A;'.repeat(101)]) assert(diagramProblem(source), source);
});

test('Mobile sidebar swipe classification excludes desktop, slow, short, vertical, and wrong-direction gestures', () => {
  const base = { mode: 'open', startX: 12, dx: 90, dy: 6, elapsed: 300, width: 390 };
  assert.equal(sidebarSwipe(base), 'open');
  assert.equal(sidebarSwipe({ ...base, mode: 'close', startX: 180, dx: -90 }), 'close');
  for (const change of [{ width: 761 }, { elapsed: 801 }, { dx: 63 }, { dy: 41 }, { dy: 60, dx: 70 }, { startX: 25 }, { dx: -90 }, { mode: 'close' }]) assert.equal(sidebarSwipe({ ...base, ...change }), null);
});
