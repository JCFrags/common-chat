import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = 'public/vendor';
mkdirSync(dir, { recursive: true });
mkdirSync('licenses/rendering', { recursive: true });
await build({ entryPoints: ['scripts/rich-text-entry.mjs'], outfile: `${dir}/rich-text.js`, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', sourcemap: false });
// Tiny is an upstream self-contained IIFE. Adapt its final export to ESM only.
// Keep all upstream license comments. Do not modify the rendering implementation.
const tinyPath = 'node_modules/@mermaid-js/tiny/dist/mermaid.tiny.js';
const original = readFileSync(tinyPath, 'utf8');
const footer = 'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;';
if (original.split(footer).length !== 2) throw new Error('The upstream Tiny export changed. Inspect it before updating.');
writeFileSync(`${dir}/mermaid.js`, original.replace(footer, 'export default __esbuild_esm_mermaid_nm.mermaid.default;'));
for (const [pkg, file] of [['katex','LICENSE'], ['highlight.js','LICENSE'], ['markdown-it','LICENSE'], ['dompurify','LICENSE'], ['dompurify','LICENSE-MPL'], ['argparse','LICENSE'], ['mdurl','LICENSE'], ['linkify-it','LICENSE'], ['entities','LICENSE'], ['punycode.js','LICENSE-MIT.txt'], ['uc.micro','LICENSE.txt']]) {
  copyFileSync(`node_modules/${pkg}/${file}`, `licenses/rendering/${pkg}-${file}`);
}
const manifest = {};
for (const name of ['rich-text.js', 'mermaid.js']) {
  const bytes = readFileSync(`${dir}/${name}`);
  manifest[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest);
