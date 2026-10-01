import { existsSync, mkdirSync, readFileSync, copyFileSync, chmodSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
export function restoreBackup(source,destination) {
  source=resolve(source);destination=resolve(destination);
  if(existsSync(destination)) throw new Error('Restore into a new directory. The destination already exists.');
  if(destination===source || destination.startsWith(source+sep)) throw new Error('The destination cannot be inside the backup.');
  const manifest=JSON.parse(readFileSync(join(source,'backup-manifest.json'),'utf8'));
  if(manifest.format!=='common-chat-backup'||manifest.version!==1||!Array.isArray(manifest.files)) throw new Error('Unsupported backup manifest.');
  const seen=new Set();
  for(const file of manifest.files) {
    if(typeof file.path!=='string'||file.path.includes('\\')||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(file.path)) throw new Error('Unsafe or duplicate backup path.');
    seen.add(file.path);let current=source;
    for(const component of file.path.split('/')) {current=join(current,component);if(lstatSync(current).isSymbolicLink()) throw new Error('Backup paths cannot contain symbolic links.');}
    const bytes=readFileSync(current);
    if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256) throw new Error(`Backup checksum failed for ${file.path}.`);
  }
  if(!seen.has('chat.sqlite')||!seen.has('master.key')||seen.has('server.lock')) throw new Error('The backup is incomplete or contains a server lock.');
  mkdirSync(destination,{recursive:true,mode:0o700});
  for(const file of manifest.files) {const to=join(destination,file.path);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(join(source,file.path),to);chmodSync(to,0o600);}
  const db=new DatabaseSync(join(destination,'chat.sqlite'),{readOnly:true});
  try {if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Restored SQLite integrity check failed.');}finally{db.close();}
  return manifest.files.length;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [source,destination]=process.argv.slice(2);
  if(!source||!destination) {console.error('Usage: npm run restore -- BACKUP_DIRECTORY NEW_DATA_DIRECTORY');process.exit(1);}
  try {console.log(`Restored ${restoreBackup(source,destination)} files to ${resolve(destination)}.`);}catch(e){console.error(e.message);process.exit(1);}
}
