import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { mockModel } from '../tests/mock-model.mjs';
const dir=mkdtempSync(join(tmpdir(),'common-chat-demo-')), model=await mockModel();
const password='local-demo-password';
const app=await createApp({dataDir:dir,password,publicUrl:process.env.PUBLIC_URL});
const p={id:'demo',name:'Demo provider',baseUrl:model.url};
app.store.run('INSERT INTO providers(id,name,base_url,models,capabilities,created_at) VALUES(?,?,?,?,?,?)',
 p.id,p.name,p.baseUrl,JSON.stringify(['demo-model','slow','plain']),JSON.stringify({streaming:true,vision:true,systemPrompt:true,temperature:true,topP:true,maxTokens:true,tokenParameter:'max_tokens'}),Date.now());
const url=await app.listen(Number(process.env.PORT??3000),'127.0.0.1');
console.log(`Demo only. Responses come from a simulated model.\nOpen ${url}\nPassword: ${password}\nDemo data is deleted when this process stops.`);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();await model.close();rmSync(dir,{recursive:true,force:true});process.exit(0);});
