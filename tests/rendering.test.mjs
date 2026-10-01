import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown, diagramProblem, RENDER_LIMITS, fencePresentation } from '../public/markdown.js';
import { artifactGroups } from '../public/previews.js';
import { sandboxPolicy } from '../server/sandbox.mjs';
import { sidebarSwipe } from '../public/touch.js';
import { normalizeDiagram } from '../public/diagram-source.js';

test('Rich rendering supports nested tasks, math, highlighted code, safe diagrams, and visible bounded fallbacks', () => {
  const rich = markdown('# Heading\n\n- [x] done\n  - nested **bold** and ~~deleted~~\n\n> quote\n> second\n\n| A | B |\n| :--- | ---: |\n| one | two |\n\nInline $x^2$ and \\(y_1\\).\n\n$$\\frac{1}{2}$$\n\n\\[\nz^2\n\\]\n\n```python\ndef example():\n  return 42\n```\n\n```mermaid\nflowchart LR\nA-->B\n```');
  for (const part of ['<h1>', 'task-checkbox', 'checked', '<ul>', '<blockquote>', '<s>', '<table>', 'align-right', '<math', 'math-block', 'hljs-keyword', 'data-code-copy', 'data-code-view="artifact"']) assert(rich.includes(part), part);
  assert(!rich.includes('style='));
  assert(!rich.includes('data-diagram-source=""'));
  assert(rich.includes('A--&gt;B')); // Source stays in code text, not an XML-sensitive attribute.
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

test('Mermaid normalization discards bounded styling without changing labels or original source', async () => {
  const source = 'flowchart LR; A:::accent-->B; style A fill:#fff,stroke-width:2px; classDef accent fill:red; class A,B accent; linkStyle 0 stroke:blue;';
  const normalized = normalizeDiagram(source);
  assert.equal(normalized.problem, null);
  assert.equal(normalized.source, 'flowchart LR; A-->B;;;;;');
  const { default: mermaid } = await import('../public/vendor/mermaid.js');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false });
  assert.equal((await mermaid.parse(normalized.source)).diagramType, 'flowchart-v2');
  const rendered = markdown(`\`\`\`mermaid\n${source}\n\`\`\``);
  assert(!rendered.includes('data-diagram-source=""'));
  assert(rendered.includes('data-code-view="artifact"'));
  assert(rendered.includes('data-code-language="mermaid" data-code-complete="true"'));
  assert(markdown(`\`\`\`mermaid\n${source}\n\`\`\``, { streaming: true }).includes('data-code-complete="false"'));
  assert(markdown(`\`\`\`mermaid\n${source}`).includes('data-code-complete="false"'));
  assert(rendered.includes('classDef accent fill:red'));
  assert(rendered.includes('A:::accent--&gt;B')); // Copy still reads the original code text.
  const state = normalizeDiagram('stateDiagram-v2\nstate Group {\nA:::accent --> B\nclassDef accent fill:red\nclass A accent\n}');
  assert.equal(state.problem, null);
  assert.equal(state.source, 'stateDiagram-v2\nstate Group {\nA --> B\n\n\n}');
  assert.equal(normalizeDiagram('classDiagram\nclass Image:::accent\nclassDef accent fill:red').source, 'classDiagram\nclass Image\n');
  for (const source of [
    'flowchart LR\nA[style; classDef; click; callback; href; src; image; icon]-->B',
    'flowchart LR\nA["class; A:::accent"]-->|style; click|B',
    'sequenceDiagram\nAlice->>Bob: click the image to change its style',
    'classDiagram\nclass Image {\n+style()\n+click()\n}',
  ]) {
    assert.equal(diagramProblem(source), null);
    assert.equal(normalizeDiagram(source).source, source);
  }
  for (const source of [
    'flowchart LR;style A fill:red;click A call callback()',
    'flowchart LR\nclick\nA call callback()',
    'flowchart LR\nstyle\nA fill:red',
    'flowchart LR\nstyle A fill:red click A call callback()',
    'flowchart LR\nclassDef accent fill:url(https://example.test/x)',
    'flowchart LR\nstyle A fill:red %%{init: {securityLevel: "loose"}}%%',
    'flowchart LR\nclass A accent click A call callback()',
    'flowchart LR\nA:::accent@{img: "local.png"}',
    'flowchart LR\nA[<b>style</b>]',
    'classDiagram\nlink Image "/local" "Open"',
    'sequenceDiagram\nAlice->>Bob: Hello(\nlink Alice: /local\n)',
    'sequenceDiagram\nAlice->>Bob: Hello "\nlink Alice: /local',
    'stateDiagram-v2\nstate Group {\nclick A call callback()\n}',
    'classDiagram\nnamespace Group {\nlink Image "/local" "Open"\n}',
    'flowchart LR\nA[unterminated\nstyle A fill:red',
  ]) {
    assert(diagramProblem(source));
    const rejected = markdown(`\`\`\`mermaid\n${source}\n\`\`\``);
    assert(!rejected.includes('data-diagram-source=""'));
    assert(rejected.includes('data-code-language="mermaid" data-code-complete="true"'));
  }
});

test('Fence flags select default artifacts, examples, and bounded adjacent HTML/CSS/JS groups', () => {
  assert.equal(fencePresentation('mermaid', 'unknownDiagram\nraw input').view, 'artifact');
  assert.equal(fencePresentation('html', '<!doctype html><html></html>').view, 'artifact');
  assert.equal(fencePresentation('svg', '<svg><circle/></svg>').view, 'artifact');
  assert.equal(fencePresentation('html', '<button>Example</button>').view, 'source');
  assert.equal(fencePresentation('javascript', 'console.log(1)').view, 'source');
  assert.equal(fencePresentation('html run example', '<html></html>').view, 'source');
  assert.equal(fencePresentation('css preview', 'body { color: red }').view, 'artifact');
  assert.equal(fencePresentation('python run', 'print(1)').view, 'source'); // No installed Python browser runtime.
  const records = ['css', 'html preview', 'javascript', 'css source', 'javascript run', 'html artifact', 'mermaid example'].map(info => fencePresentation(info, ''));
  assert.deepEqual(artifactGroups(records), [{ index: 1, members: [0, 1, 2] }, { index: 5, members: [4, 5] }]);
  const page = markdown('```html preview\n<button>Run</button>\n```\n\n```mermaid example\nflowchart LR\nA-->B\n```');
  assert(page.includes('data-code-view="artifact" data-code-intent="artifact"'));
  assert(page.includes('<details class="artifact-source"><summary>Show code</summary>'));
  assert(page.includes('data-code-view="source" data-code-intent="example"'));
  assert(page.includes('<details class="diagram-source artifact-source" open>'));
  assert(!page.includes('data-diagram-source'));
});

test('Automatic sandbox CSP allows scripts only while manual sandbox privileges remain explicit', () => {
  const automatic = sandboxPolicy('https://chat.example', false, true);
  assert(automatic.includes('sandbox allow-scripts;'));
  assert(automatic.includes("connect-src 'none'"));
  const manual = sandboxPolicy('https://chat.example', true);
  assert(manual.includes('allow-forms allow-modals allow-downloads allow-popups'));
  assert(manual.includes('connect-src http: https: ws: wss:'));
  for (const policy of [automatic, manual]) for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-storage-access', 'allow-popups-to-escape-sandbox']) assert(!policy.includes(flag));
});

test('Mobile sidebar swipe classification excludes desktop, slow, short, vertical, and wrong-direction gestures', () => {
  const base = { mode: 'open', startX: 12, dx: 90, dy: 6, elapsed: 300, width: 390 };
  assert.equal(sidebarSwipe(base), 'open');
  assert.equal(sidebarSwipe({ ...base, mode: 'close', startX: 180, dx: -90 }), 'close');
  for (const change of [{ width: 761 }, { elapsed: 801 }, { dx: 63 }, { dy: 41 }, { dy: 60, dx: 70 }, { startX: 25 }, { dx: -90 }, { mode: 'close' }]) assert.equal(sidebarSwipe({ ...base, ...change }), null);
});
