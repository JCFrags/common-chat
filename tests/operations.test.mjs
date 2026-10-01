import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { offlineBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore.mjs';
import { passwordHash, passwordMatches } from '../server/auth.mjs';

test('Offline backup and restore preserve messages, files, and encrypted provider keys',t=>{
 const root=mkdtempSync(join(tmpdir(),'common-chat-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const data=join(root,'data'),backup=join(root,'backup'),restored=join(root,'restored');let s=new Store(data);
 const cid=s.createConversation('Backup check');s.addMessage({id:'message',conversationId:cid,role:'user',content:'Keep this.'});
 const a=s.addAttachment(cid,{name:'note.txt',mime:'text/plain',kind:'text',bytes:Buffer.from('A durable attachment')},'message');
 s.run('INSERT INTO providers(id,name,base_url,api_key,models,capabilities,created_at) VALUES(?,?,?,?,?,?,?)','p','Provider','http://localhost:1234/v1',s.encrypt('restored-secret'),'[]','{}',Date.now());
 assert.throws(()=>offlineBackup(data,backup),/Stop the server/);s.close();
 const manifest=offlineBackup(data,backup);assert(manifest.files.length>=3);assert.throws(()=>offlineBackup(data,backup),/already exists/);
 restoreBackup(backup,restored);s=new Store(restored);
 assert.equal(s.snapshot(cid).messages[0].content,'Keep this.');assert.equal(s.readAttachment(a).toString(),'A durable attachment');assert.equal(s.provider('p').apiKey,'restored-secret');s.close();
});
test('Restore rejects tampered bytes and unsafe paths before writing the destination',t=>{
 const root=mkdtempSync(join(tmpdir(),'common-chat-restore-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const s=new Store(join(root,'data'));s.close();offlineBackup(join(root,'data'),join(root,'backup'));
 writeFileSync(join(root,'backup','master.key'),'tampered');
 assert.throws(()=>restoreBackup(join(root,'backup'),join(root,'dest')),/checksum/);assert(!existsSync(join(root,'dest')));
 const m=JSON.parse(readFileSync(join(root,'backup','backup-manifest.json')));m.files.unshift({path:'../outside',size:0,sha256:''});
 writeFileSync(join(root,'backup','backup-manifest.json'),JSON.stringify(m));
 assert.throws(()=>restoreBackup(join(root,'backup'),join(root,'dest')),/Unsafe/);
});
test('A second server cannot use the same data directory concurrently',t=>{
 const dir=mkdtempSync(join(tmpdir(),'common-chat-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=new Store(dir);assert.throws(()=>new Store(dir),/locked/);s.close();
});
test('Password hashing uses distinct salts and preserves password verification',async()=>{
 const a=await passwordHash('long-test-password'),b=await passwordHash('long-test-password');assert.notEqual(a,b);
 assert(await passwordMatches('long-test-password',a));assert(!await passwordMatches('different-password',a));
 await assert.rejects(()=>passwordHash('short'),/at least 12/);
});
