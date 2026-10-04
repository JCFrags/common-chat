import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = join(root, 'ui');
let commit = process.env.COMMON_CHAT_COMMIT;
if (!commit && existsSync(join(root, 'release.json'))) {
  commit = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).commit;
}
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { commit = 'development'; }
}
if (commit !== 'development' && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid frontend source commit.');
if (!existsSync(join(ui, 'node_modules'))) throw new Error('Install build dependencies with npm --prefix ui ci --ignore-scripts first.');
execFileSync('npm', ['run', 'build'], { cwd: ui, stdio: 'inherit', env: { ...process.env, LLAMA_BUILD_NUMBER: commit, LLAMA_UI_OUT_DIR: join(ui, 'dist') } });
const output = join(ui, 'dist'), files = [];
function visit(relative = '') {
  for (const entry of readdirSync(join(output, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && !['frontend.json', 'frontend-manifest.json'].includes(path)) {
      const bytes = readFileSync(join(output, path));
      files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else if (!entry.isFile()) throw new Error('Frontend output must contain only regular files and directories.');
  }
}
visit();
files.sort((a, b) => a.path.localeCompare(b.path));
const manifest = `${JSON.stringify({ sourceCommit: commit, files }, null, 2)}\n`;
const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
writeFileSync(join(output, 'frontend-manifest.json'), manifest);
writeFileSync(join(output, 'frontend.json'), `${JSON.stringify({ sourceCommit: commit, manifestSha256 }, null, 2)}\n`);
console.log(`Built Common Chat frontend from ${commit}: ${files.length} files, manifest ${manifestSha256}.`);
