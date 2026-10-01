import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, chmodSync } from 'node:fs';
import { resolve, join, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
export function offlineBackup(source, destination) {
  source=resolve(source);destination=resolve(destination);
  if(destination===source || destination.startsWith(source+sep)) throw new Error('The backup directory must be outside the data directory.');
  if(existsSync(join(source,'server.lock'))) throw new Error('Stop the server before backup. A server.lock file is present.');
  if(!existsSync(join(source,'chat.sqlite')) || !existsSync(join(source,'master.key'))) throw new Error('The source must contain chat.sqlite and master.key.');
  if(existsSync(destination)) throw new Error('The backup destination already exists. Use a new directory.');
  const db=new DatabaseSync(join(source,'chat.sqlite'),{readOnly:true});
  try { if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('SQLite integrity check failed.'); }
  finally { db.close(); }
  const manifest={format:'common-chat-backup',version:1,createdAt:new Date().toISOString(),files:[]};
  mkdirSync(destination,{recursive:true,mode:0o700});
  function copy(directory) {
    for(const name of readdirSync(directory)) {
      const from=join(directory,name),path=relative(source,from),to=join(destination,path),stat=lstatSync(from);
      if(stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in a backup.');
      if(stat.isDirectory()) { mkdirSync(to,{recursive:true,mode:0o700});copy(from); }
      else if(stat.isFile()) {
        copyFileSync(from,to);chmodSync(to,0o600);
        manifest.files.push({path:path.split(sep).join('/'),size:stat.size,sha256:createHash('sha256').update(readFileSync(to)).digest('hex')});
      } else throw new Error('Unsupported filesystem object in the data directory.');
    }
  }
  copy(source);writeFileSync(join(destination,'backup-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return manifest;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [source,destination]=process.argv.slice(2);
  if(!source||!destination) { console.error('Usage: npm run backup -- DATA_DIRECTORY NEW_BACKUP_DIRECTORY');process.exit(1); }
  try { const result=offlineBackup(source,destination);console.log(`Backed up ${result.files.length} files to ${resolve(destination)}.`); }
  catch(e) { console.error(e.message);process.exit(1); }
}
