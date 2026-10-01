import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { mockModel } from './mock-model.mjs';
import { makeZip } from './zip-fixture.mjs';
import { sseRecords } from '../server/provider.mjs';
const password='a-strong-test-password-42';
const caps={streaming:true,vision:true,systemPrompt:true,temperature:true,topP:true,maxTokens:true,tokenParameter:'max_tokens'};

async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'common-chat-test-')), model=await mockModel();
  const app=await createApp({dataDir:dir,password,logErrors:false});const url=await app.listen(0);
  t.after(async()=>{await app.close();await model.close();rmSync(dir,{recursive:true,force:true});});
  async function request(path,method='GET',data,cookie='',extra={}) {
    const response=await fetch(url+path,{method,headers:{...(method==='GET'?{}:{'Content-Type':'application/json','X-Chat-Request':'1'}),...(cookie?{Cookie:cookie}:{}),...extra},...(method==='GET'?{}:{body:JSON.stringify(data??{})})});
    const body=await response.json();return{status:response.status,body,headers:response.headers};
  }
  async function login(){const r=await request('/api/login','POST',{password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  const cookie=await login();
  const api=(p,m,d)=>request(p,m,d,cookie);
  const connection=await api('/api/providers','POST',{name:'Mock server',baseUrl:model.url,apiKey:'provider-secret-123',capabilities:caps});
  assert.equal(connection.status,201);const providerId=connection.body.id;
  const conversation=async()=>{const r=await api('/api/conversations','POST',{});assert.equal(r.status,201);return r.body;};
  const generate=async(c,extra={})=>api(`/api/conversations/${c.id}/generate`,'POST',{requestId:randomUUID(),expectedVersion:c.version,providerId,model:'demo-model',content:'Hi',parentId:c.activeLeaf,settings:{},...extra});
  const waitJob=async jobId=>{for(let i=0;i<150;i++){const r=await api(`/api/jobs/${jobId}`);if(r.body.status!=='running')return r.body;await delay(25);}throw new Error('Job timeout');};
  return{dir,model,app,url,request,login,cookie,api,providerId,conversation,generate,waitJob};
}
test('Authentication protects chats and attachments and uses HttpOnly SameSite cookies',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/conversations')).status,401);
  assert.equal((await f.request('/api/attachments/not-found')).status,401);
  const signed=await f.request('/api/login','POST',{password});
  assert.match(signed.headers.get('set-cookie'),/HttpOnly/);assert.match(signed.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await f.request('/api/login','POST',{password:'wrong-password'})).status,401);
  assert.equal((await f.request('/api/conversations','POST',{},f.cookie,{'X-Chat-Request':'0'})).status,403);
  assert.equal((await f.request('/api/conversations','POST',{},f.cookie,{Origin:'https://evil.example'})).status,403);
  const badHostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(f.url+'/api/conversations',{headers:{Host:'evil.example',Cookie:f.cookie}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(badHostStatus,403);
  const raw=readFileSync(join(f.dir,'chat.sqlite'));assert(!raw.includes(Buffer.from(password)));
});
test('Preview execution policy is isolated from the chat policy and opaque-origin API calls are rejected',async t=>{
  const f=await fixture(t);
  const main=await fetch(f.url+'/');
  assert.match(main.headers.get('content-security-policy'),/script-src 'self'; style-src 'self'/);
  assert.equal(main.headers.get('x-frame-options'),'DENY');
  for (const external of [false,true]) {
    const preview=await fetch(f.url+'/sandbox?external='+(external?'1':'0'));
    assert.equal(preview.status,200);
    const policy=preview.headers.get('content-security-policy');
    assert.match(policy,/sandbox allow-scripts/);
    assert(!policy.includes('allow-same-origin')); assert(!policy.includes('allow-top-navigation')); assert(!policy.includes('allow-popups-to-escape-sandbox'));
    assert.match(policy,/frame-ancestors http:\/\/127\.0\.0\.1:/);
    assert.equal(preview.headers.get('x-frame-options'),null);
    assert(policy.includes(external?'connect-src http: https: ws: wss:':"connect-src 'none'"));
    const automatic=await fetch(f.url+'/sandbox?automatic=1&external='+(external?'1':'0'));
    assert.match(automatic.headers.get('content-security-policy'),/sandbox allow-scripts;/);
    assert((await preview.text()).includes('event.source !== parent'));
  }
  const renderer=await fetch(f.url+'/sandbox-mermaid.js');
  assert.equal(renderer.status,200); assert.equal(renderer.headers.get('access-control-allow-origin'),'*');
  assert.equal((await fetch(f.url+'/diagram-source.js')).status,200);
  const rejected=await f.request('/api/session','GET',null,f.cookie,{Origin:'null'});
  assert.equal(rejected.status,403); assert.equal(rejected.headers.get('access-control-allow-origin'),null);
  assert.equal((await f.request('/api/conversations','POST',{},f.cookie,{Origin:'null'})).status,403);
});
test('Provider keys are encrypted at rest and absent from API and export responses',async t=>{
  const f=await fixture(t),p=(await f.api('/api/providers')).body[0];
  assert.equal(p.hasKey,true);assert(!JSON.stringify(p).includes('provider-secret'));
  const raw=f.app.store.get('SELECT api_key FROM providers WHERE id=?',f.providerId).api_key;
  assert(!raw.includes('provider-secret'));assert.equal(f.app.store.provider(f.providerId).apiKey,'provider-secret-123');
  assert(!JSON.stringify((await f.api('/api/export')).body).includes('provider-secret'));
  assert.equal((await f.api(`/api/providers/${f.providerId}/models`)).body.models[0],'demo-model');
});
test('Streaming saves content, reasoning, model provenance, usage, and exact generation settings',async t=>{
  const f=await fixture(t),c=await f.conversation();
  const r=await f.generate(c,{settings:{systemPrompt:'Be clear.',temperature:0,topP:0.5,maxTokens:99}});assert.equal(r.status,202);
  assert.equal((await f.waitJob(r.body.jobId)).status,'complete');
  const saved=(await f.api(`/api/conversations/${c.id}`)).body;
  assert.equal(saved.messages.length,2);const answer=saved.messages.find(m=>m.role==='assistant');
  assert.equal(answer.content,'Hello from the test model. 🌍');assert.equal(answer.reasoning,'Consider the request. ');
  assert.equal(answer.providerName,'Mock server');assert.equal(answer.model,'demo-model');assert.equal(answer.settings.temperature,0);
  assert.equal(answer.metadata.usage.completion_tokens,6);
  assert.equal(f.model.requests[0].temperature,0);assert.equal(f.model.requests[0].max_tokens,99);
  assert.equal(f.model.requests[0].timings_per_token,undefined);assert.equal(f.model.requests[0].return_progress,undefined);
  assert.equal(f.model.requests[0].messages[0].role,'system');
  assert(f.model.requests[0].messages[0].content.startsWith('Be clear.\n\nCommon Chat rendering:'));
  assert(f.model.requests[0].messages[0].content.includes('html preview'));
  assert.equal(f.model.authHeaders[0],'Bearer provider-secret-123');
});
test('Live and final stream statistics persist through regeneration and native export/import',async t=>{
  const f=await fixture(t),c=await f.conversation();
  const configured=await f.api(`/api/providers/${f.providerId}`,'PUT',{
    name:'Mock server',baseUrl:f.model.url,capabilities:{...caps,llamaCppTimings:true}
  });
  assert.equal(configured.status,200);assert.equal(configured.body.capabilities.llamaCppTimings,true);
  const controller=new AbortController(),events=[];
  t.after(()=>controller.abort());
  const stream=await fetch(f.url+'/api/events',{headers:{Cookie:f.cookie},signal:controller.signal});
  const collected=(async()=>{
    try { for await (const record of sseRecords(stream.body)) events.push(JSON.parse(record)); }
    catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const r=await f.generate(c,{model:'stats'});
  const live=async predicate=>{
    for(let i=0;i<50;i++) {
      const answer=(await f.api(`/api/conversations/${c.id}`)).body.messages.find(m=>m.id===r.body.messageId);
      if (answer && predicate(answer)) { assert.equal(answer.status,'streaming');return answer; }
      await delay(10);
    }
    throw new Error('Live statistics were not saved before completion');
  };
  const progress=await live(m=>m.metadata.promptProgress?.processed===5);
  assert.equal(progress.content,'');assert.equal(progress.reasoning,'');assert.equal(progress.metadata.observed.firstTextMs,null);
  const interim=await live(m=>m.metadata.timings?.predicted_n===1);
  assert.equal(interim.content,'');assert.equal(interim.metadata.usage.completion_tokens,1);
  assert.equal(interim.metadata.promptProgress.processed,9);assert(interim.metadata.observed.firstTextMs>=0);
  assert.equal((await f.waitJob(r.body.jobId)).status,'complete');
  await delay(20);controller.abort();await collected;
  const deltas=events.filter(e=>e.type==='delta' && e.message.id===r.body.messageId);
  assert(deltas.some(e=>e.message.metadata.promptProgress?.processed===9 && !e.message.content && !e.message.reasoning));
  assert(deltas.some(e=>e.message.metadata.timings?.predicted_n===1 && !e.message.content));
  assert(deltas.some(e=>e.message.metadata.timings?.predicted_n>1 && e.message.content));
  assert(deltas.every(e=>e.message.status==='streaming'));
  let saved=(await f.api(`/api/conversations/${c.id}`)).body;
  const answer=saved.messages.find(m=>m.id===r.body.messageId);
  assert.deepEqual(f.model.requests[0].stream_options,{include_usage:true});
  assert.equal(f.model.requests[0].timings_per_token,true);assert.equal(f.model.requests[0].return_progress,true);
  assert.deepEqual(answer.metadata.promptProgress,{total:9,cache:2,processed:9,time_ms:20});
  assert.deepEqual(answer.metadata.timings,{prompt_n:7,predicted_n:6,draft_n:10,draft_n_accepted:4,
    prompt_ms:20,prompt_per_second:350,predicted_ms:60,predicted_per_second:100});
  assert.equal(answer.metadata.usage.prompt_tokens,9);assert.equal(answer.metadata.usage.completion_tokens,6);
  assert.equal(answer.metadata.observed.responseMode,'streaming');
  assert(answer.metadata.observed.firstTextMs>=0);
  // Reasoning is sent before the delayed answer. It must count as the first text.
  assert(answer.metadata.observed.durationMs-answer.metadata.observed.firstTextMs>=200);
  const nonstream=await f.api('/api/providers','POST',{name:'JSON model',baseUrl:f.model.url,capabilities:{...caps,streaming:false,llamaCppTimings:true}});
  const regenerated=await f.generate(saved,{providerId:nonstream.body.id,regenerate:true,parentId:answer.parentId,content:undefined});
  assert.equal((await f.waitJob(regenerated.body.jobId)).status,'complete');
  assert.equal(f.model.requests[1].stream,false);assert.equal(f.model.requests[1].stream_options,undefined);
  assert.equal(f.model.requests[1].timings_per_token,undefined);assert.equal(f.model.requests[1].return_progress,undefined);
  saved=(await f.api(`/api/conversations/${c.id}`)).body;
  assert.deepEqual(saved.messages.find(m=>m.id===answer.id).metadata,answer.metadata);
  const jsonAnswer=saved.messages.find(m=>m.id===regenerated.body.messageId);
  assert.equal(jsonAnswer.metadata.timings,null);assert.equal(jsonAnswer.metadata.observed.firstTextMs,null);
  assert.equal(jsonAnswer.metadata.observed.responseMode,'non-streaming');assert(jsonAnswer.metadata.observed.durationMs>=0);
  const exported=(await f.api(`/api/conversations/${c.id}/export`)).body;
  const imported=await f.api('/api/import','POST',{text:JSON.stringify(exported)});assert.equal(imported.status,201);
  const copy=(await f.api(`/api/conversations/${imported.body.conversationIds[0]}`)).body;
  assert.deepEqual(copy.messages.find(m=>m.model==='stats').metadata,answer.metadata);
});
test('Two independent sessions read the same server history',async t=>{
  const f=await fixture(t),other=await f.login(),c=await f.conversation(),r=await f.generate(c);
  await f.waitJob(r.body.jobId);
  const second=await f.request(`/api/conversations/${c.id}`,'GET',null,other);
  assert.equal(second.status,200);assert.equal(second.body.messages.length,2);assert.equal(second.body.messages.find(m=>m.role==='assistant').content,'Hello from the test model. 🌍');
});
test('Closing an SSE browser connection does not stop generation',async t=>{
  const f=await fixture(t),c=await f.conversation(),controller=new AbortController();
  const stream=await fetch(f.url+'/api/events',{headers:{Cookie:f.cookie},signal:controller.signal});
  const reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/hello/);
  const r=await f.generate(c,{model:'slow'});await delay(150);controller.abort();
  const job=await f.waitJob(r.body.jobId);assert.equal(job.status,'complete');
  const s=(await f.api(`/api/conversations/${c.id}`)).body;assert(s.messages.find(m=>m.role==='assistant').content.includes('browser disconnects.'));
  const reconnect=await fetch(f.url+'/api/events',{headers:{Cookie:f.cookie}});const rr=reconnect.body.getReader();await rr.read();await rr.cancel();
});
test('Idempotent retries create one model request and one message pair',async t=>{
  const f=await fixture(t),c=await f.conversation(),requestId=randomUUID();
  const first=await f.generate(c,{requestId}),retry=await f.generate(c,{requestId});
  assert.equal(first.status,202);assert.deepEqual(first.body,retry.body);
  await f.waitJob(first.body.jobId);assert.equal(f.model.requests.length,1);
  assert.equal((await f.api(`/api/requests/${requestId}`)).body.jobId,first.body.jobId);
  assert.equal((await f.generate(c,{requestId,content:'Different'})).status,409);
});
test('Concurrent submissions and stale edits are rejected without duplicate messages',async t=>{
  const f=await fixture(t),c=await f.conversation();
  const [a,b]=await Promise.all([f.generate(c,{model:'slow'}),f.generate(c,{model:'slow'})]);
  assert.deepEqual([a.status,b.status].sort(),[202,409]);
  const current=(await f.api(`/api/conversations/${c.id}`)).body;
  assert.equal((await f.api(`/api/conversations/${c.id}`,'PATCH',{expectedVersion:current.version,title:'Race'})).status,409);
  await f.api(`/api/jobs/${(a.status===202?a:b).body.jobId}/cancel`,'POST');await f.waitJob((a.status===202?a:b).body.jobId);
  assert.equal((await f.api(`/api/conversations/${c.id}`,'PATCH',{expectedVersion:c.version,title:'Stale'})).status,409);
  assert.equal((await f.api(`/api/conversations/${c.id}`)).body.messages.length,2);
});
test('Cancellation retains partial text and records a terminal cancelled state',async t=>{
  const f=await fixture(t),c=await f.conversation(),r=await f.generate(c,{model:'slow'});await delay(230);
  assert.equal((await f.api(`/api/jobs/${r.body.jobId}/cancel`,'POST')).status,200);assert.equal((await f.waitJob(r.body.jobId)).status,'cancelled');
  const answer=(await f.api(`/api/conversations/${c.id}`)).body.messages.find(m=>m.role==='assistant');assert.equal(answer.status,'cancelled');assert(answer.content.length>0);
});
test('Truncated streams preserve partial output and are not marked complete',async t=>{
  const f=await fixture(t),c=await f.conversation(),r=await f.generate(c,{model:'truncated'});
  assert.equal((await f.waitJob(r.body.jobId)).status,'interrupted');
  const m=(await f.api(`/api/conversations/${c.id}`)).body.messages.find(m=>m.role==='assistant');assert(m.content.includes('Hello'));assert.match(m.metadata.error,/completion marker/);
});
test('Non-streaming JSON providers work',async t=>{
  const f=await fixture(t),c=await f.conversation(),r=await f.generate(c,{model:'plain'});assert.equal((await f.waitJob(r.body.jobId)).status,'complete');
  assert.equal((await f.api(`/api/conversations/${c.id}`)).body.messages.find(m=>m.role==='assistant').content,'A non-streaming answer.');
});
test('Provider errors, tool calls, malformed data, and redirects fail explicitly',async t=>{
  const f=await fixture(t);
  for(const model of ['error','tools','malformed','redirect']){
    const c=await f.conversation(),r=await f.generate(c,{model}),job=await f.waitJob(r.body.jobId);
    assert.equal(job.status,'error',model);assert(!job.error.includes('provider-secret'));assert(!job.error.includes('secret-provider-response'));
  }
  assert(!f.model.requests.some(r=>r.leaked));
});
test('Unsupported capabilities reject requests before saving a user message',async t=>{
  const f=await fixture(t);
  const p=await f.api('/api/providers','POST',{name:'Restricted',baseUrl:f.model.url,capabilities:{streaming:true,systemPrompt:false}});
  const c=await f.conversation();
  assert.equal((await f.generate(c,{providerId:p.body.id,settings:{temperature:1}})).status,400);
  assert.equal((await f.generate(c,{providerId:p.body.id,settings:{systemPrompt:'No'}})).status,400);
  assert.equal((await f.api(`/api/conversations/${c.id}`)).body.messages.length,0);
});
test('Text attachments persist, are included in context, and cannot cross conversations',async t=>{
  const f=await fixture(t),c=await f.conversation(),other=await f.conversation();
  const uploaded=await f.api(`/api/conversations/${c.id}/attachments`,'POST',{name:'note.txt',mime:'text/plain',data:Buffer.from('The code is 73.').toString('base64')});assert.equal(uploaded.status,201);
  assert.equal((await f.generate(other,{attachments:[uploaded.body.id]})).status,400);
  const r=await f.generate(c,{attachments:[uploaded.body.id]});await f.waitJob(r.body.jobId);
  assert(f.model.requests[0].messages.find(m=>m.role==='user').content.includes('The code is 73.'));
  const file=await fetch(f.url+`/api/attachments/${uploaded.body.id}`,{headers:{Cookie:f.cookie}});assert.equal(await file.text(),'The code is 73.');
  assert.match(file.headers.get('content-type'),/text\/plain/);
  assert.equal((await f.api(`/api/attachments/${uploaded.body.id}`,'DELETE')).status,409);
  assert(existsSync(join(f.dir,'files',uploaded.body.id)));
});
test('Regeneration creates siblings and edited user messages preserve the original branch',async t=>{
  const f=await fixture(t),c=await f.conversation(),first=await f.generate(c);await f.waitJob(first.body.jobId);
  let s=(await f.api(`/api/conversations/${c.id}`)).body;const user=s.messages.find(m=>m.role==='user');
  const next=await f.generate(s,{parentId:user.id,regenerate:true,content:undefined});await f.waitJob(next.body.jobId);
  s=(await f.api(`/api/conversations/${c.id}`)).body;assert.equal(s.messages.filter(m=>m.parentId===user.id).length,2);
  const edited=await f.generate(s,{parentId:null,content:'Edited prompt'});await f.waitJob(edited.body.jobId);
  s=(await f.api(`/api/conversations/${c.id}`)).body;assert.equal(s.messages.filter(m=>m.role==='user').length,2);
  assert(s.messages.some(m=>m.content==='Hi'));assert(s.messages.some(m=>m.content==='Edited prompt'));
  const selected=await f.api(`/api/conversations/${c.id}`,'PATCH',{expectedVersion:s.version,activeLeaf:first.body.messageId});assert.equal(selected.status,200);
  assert.equal(selected.body.activeLeaf,first.body.messageId);
});
test('Legacy import preserves branches, timestamps, reasoning, and unknown source metadata',async t=>{
  const f=await fixture(t);
  const legacy={conv:{id:'old',name:'Legacy chat',currNode:'b',lastModified:123,custom:'preserved'},messages:[
    {id:'u',parent:null,role:'user',content:'Question',timestamp:100,children:['a','b'],extra:[{type:'textFile',name:'context.txt',content:'Context'}]},
    {id:'a',parent:'u',role:'assistant',content:'First',timestamp:110,children:[],model:'model-a'},
    {id:'b',parent:'u',role:'assistant',content:'Second',reasoningContent:'Reason',timestamp:120,children:[],model:'model-b',futureField:73}
  ]};
  const r=await f.api('/api/import','POST',{text:JSON.stringify(legacy)});assert.equal(r.status,201);assert.equal(r.body.warnings.length,0);
  const cid=r.body.conversationIds[0],s=(await f.api(`/api/conversations/${cid}`)).body;
  assert.equal(s.messages.length,3);assert.equal(s.messages.find(m=>m.id===s.activeLeaf).content,'Second');
  assert.equal(s.messages.find(m=>m.content==='Question').attachments.length,1);assert.equal(s.messages.find(m=>m.content==='Second').reasoning,'Reason');
  const out=(await f.api(`/api/conversations/${cid}/export`)).body.conversations[0];
  assert.equal(out.conversation.source.custom,'preserved');assert.equal(out.messages.find(m=>m.content==='Second').metadata.source.futureField,73);
});
test('JSONL import supports current upstream session records',async t=>{
  const f=await fixture(t);const lines=[{harness:'llama.cpp',type:'session',id:'c',name:'JSONL',currNode:'u'},{type:'message',message:{id:'u',parent:null,role:'user',content:'From JSONL',timestamp:100,children:[]}}].map(x=>JSON.stringify(x)).join('\n');
  const r=await f.api('/api/import','POST',{text:lines});assert.equal(r.status,201);assert.equal(r.body.messages,1);
});
test('Invalid imports are atomic and reject cycles and missing parents',async t=>{
  const f=await fixture(t);const before=(await f.api('/api/conversations')).body.length;
  for(const messages of [
    [{id:'a',parent:'b',role:'user',content:'a'},{id:'b',parent:'a',role:'assistant',content:'b'}],
    [{id:'a',parent:'missing',role:'user',content:'a'}]
  ]){
    const good={conv:{name:'Good'},messages:[{id:'x',parent:null,role:'user',content:'good'}]};
    const bad={conv:{name:'Bad'},messages};
    assert.equal((await f.api('/api/import','POST',{text:JSON.stringify([good,bad])})).status,400);
    assert.equal((await f.api('/api/conversations')).body.length,before);
  }
});
test('Unsupported imported files remain in exports and block silent context loss',async t=>{
  const f=await fixture(t);const original={conv:{name:'Audio',currNode:'u'},messages:[{id:'u',parent:null,role:'user',content:'Listen',extra:[{type:'audio',name:'sample.wav',base64Data:'abcd',mimeType:'audio/wav'}]}]};
  const r=await f.api('/api/import','POST',{text:JSON.stringify(original)});assert.equal(r.status,201);assert(r.body.warnings.length>0);
  const s=(await f.api(`/api/conversations/${r.body.conversationIds[0]}`)).body;
  assert.equal((await f.generate(s)).status,400);
  const output=(await f.api(`/api/conversations/${s.id}/export`)).body;
  assert.equal(output.conversations[0].messages[0].metadata.source.extra[0].base64Data,'abcd');
});
test('Native export/import round trip retains attachments and branch structure',async t=>{
  const f=await fixture(t),c=await f.conversation();
  const file=await f.api(`/api/conversations/${c.id}/attachments`,'POST',{name:'a.txt',mime:'text/plain',data:Buffer.from('attachment').toString('base64')});
  const r=await f.generate(c,{attachments:[file.body.id]});await f.waitJob(r.body.jobId);
  const exported=(await f.api(`/api/conversations/${c.id}/export`)).body;
  const imported=await f.api('/api/import','POST',{text:JSON.stringify(exported)});assert.equal(imported.status,201);
  const copy=(await f.api(`/api/conversations/${imported.body.conversationIds[0]}`)).body;
  assert.notEqual(copy.id,c.id);assert.equal(copy.messages.length,2);assert.equal(copy.messages.find(m=>m.role==='user').attachments[0].name,'a.txt');
  assert.equal(copy.messages.find(m=>m.role==='assistant').parentId,copy.messages.find(m=>m.role==='user').id);
});
test('Data and sessions survive a server restart, and orphaned jobs become interrupted',async t=>{
  const f=await fixture(t),c=await f.conversation(),r=await f.generate(c);await f.waitJob(r.body.jobId);
  const s=(await f.api(`/api/conversations/${c.id}`)).body;
  f.app.store.run("UPDATE messages SET status='streaming' WHERE id=?",r.body.messageId);
  f.app.store.run("UPDATE jobs SET status='running' WHERE id=?",r.body.jobId);
  await f.app.close();
  const restarted=await createApp({dataDir:f.dir,password:'this-should-not-overwrite',logErrors:false});
  t.after(()=>restarted.close());const url=await restarted.listen(0);
  const response=await fetch(url+`/api/conversations/${c.id}`,{headers:{Cookie:f.cookie}});const data=await response.json();
  assert.equal(response.status,200);assert.equal(data.messages.find(m=>m.role==='assistant').status,'interrupted');
  assert.equal(data.messages.find(m=>m.role==='assistant').content,s.messages.find(m=>m.role==='assistant').content);
  assert.equal(restarted.store.provider(f.providerId).apiKey,'provider-secret-123');
  await restarted.close();
});
test('Deleting a conversation removes its messages and attachment files',async t=>{
  const f=await fixture(t),c=await f.conversation();const a=await f.api(`/api/conversations/${c.id}/attachments`,'POST',{name:'x.txt',mime:'text/plain',data:Buffer.from('x').toString('base64')});
  const result=await f.api(`/api/conversations/${c.id}`,'DELETE',{expectedVersion:c.version});assert.equal(result.status,200);
  assert.equal((await f.api(`/api/conversations/${c.id}`)).status,404);assert(!existsSync(join(f.dir,'files',a.body.id)));
});

test('Vision attachments reach a capable model and are rejected by a text-only connection',async t=>{
  const f=await fixture(t),c=await f.conversation();
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XcAAAAASUVORK5CYII=';
  const file=await f.api(`/api/conversations/${c.id}/attachments`,'POST',{name:'pixel.png',mime:'image/png',data});assert.equal(file.status,201);
  const textOnly=await f.api('/api/providers','POST',{name:'Text only',baseUrl:f.model.url,capabilities:{streaming:true,vision:false}});
  const rejected=await f.generate(c,{providerId:textOnly.body.id,attachments:[file.body.id]});assert.equal(rejected.status,400);
  assert.equal((await f.api(`/api/conversations/${c.id}`)).body.messages.length,0);
  const generated=await f.generate(c,{attachments:[file.body.id]});assert.equal(generated.status,202);await f.waitJob(generated.body.jobId);
  const image=f.model.requests.at(-1).messages.find(m=>m.role==='user').content.find(p=>p.type==='image_url');assert.equal(image.image_url.url,`data:image/png;base64,${data}`);
  const raw=await fetch(f.url+`/api/attachments/${file.body.id}`,{headers:{Cookie:f.cookie}});assert.equal(raw.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await raw.arrayBuffer()).toString('base64'),data);
});
test('The API imports a current JSONL ZIP and rejects non-UTF-8 imports without writes',async t=>{
  const f=await fixture(t);
  const jsonl=JSON.stringify({type:'session',harness:'llama.cpp',id:'old',name:'ZIP conversation',currNode:'a'})+'\n'+JSON.stringify({type:'message',message:{id:'a',parent:null,role:'user',content:'Imported from ZIP.',timestamp:1700000000000}});
  const result=await f.api('/api/import','POST',{data:makeZip('session.jsonl',jsonl).toString('base64')});assert.equal(result.status,201);assert.equal(result.body.conversations,1);
  const saved=(await f.api(`/api/conversations/${result.body.conversationIds[0]}`)).body;assert.equal(saved.messages[0].content,'Imported from ZIP.');
  assert.equal((await f.api('/api/import','POST',{data:Buffer.from([0xff,0xfe]).toString('base64')})).status,400);
  assert.equal((await f.api('/api/conversations')).body.length,1);
});
