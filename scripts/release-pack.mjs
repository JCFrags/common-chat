import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const [version, channel, output = 'dist'] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version ?? '') || !['preview', 'stable'].includes(channel)) {
  throw new Error('Usage: node scripts/release-pack.mjs VERSION preview|stable [OUTPUT_DIRECTORY]');
}
if (channel === 'stable' && version.includes('-')) throw new Error('A stable version cannot contain a prerelease suffix.');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim();
const root = git('rev-parse', '--show-toplevel');
process.chdir(root);
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Commit the intended source and use a clean checkout before packaging.');
const commit = git('rev-parse', 'HEAD');
const directory = resolve(output), name = `common-chat-${version}-${channel}.tar.gz`, target = join(directory, name);
mkdirSync(directory, { recursive: true });
if (existsSync(target)) throw new Error('The output archive already exists. Choose a new output directory.');
const temporary = mkdtempSync(join(tmpdir(), 'common-chat-release-'));
try {
  const archive = join(temporary, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '--prefix=common-chat/', '-o', archive, commit]);
  execFileSync('tar', ['-xf', archive, '-C', temporary]);
  const release = { version, channel, commit, builtAt: new Date().toISOString() };
  writeFileSync(join(temporary, 'common-chat', 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX', '-czf', target, '-C', temporary, 'common-chat']);
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  writeFileSync(`${target}.sha256`, `${sha256}  ${name}\n`, { flag: 'wx' });
  writeFileSync(`${target}.json`, `${JSON.stringify({ ...release, archive: name, sha256 }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ archive: target, sha256, commit, version, channel }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
