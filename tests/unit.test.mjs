import test from 'node:test';
import assert from 'node:assert/strict';
import { sseRecords, deltaText, usageStats, timingStats, promptProgressStats } from '../server/provider.mjs';
import { settings, providerConfig, attachmentData, decodeBase64 } from '../server/validation.mjs';
import { markdown } from '../public/markdown.js';
import { parseText, crc32, zipEntries } from '../server/transfer.mjs';
import { makeZip } from './zip-fixture.mjs';

async function* bytes(value, step = 1) { const b = Buffer.from(value); for(let i=0;i<b.length;i+=step) yield b.subarray(i,i+step); }
test('SSE parsing handles byte-split UTF-8, CRLF, comments, multiple data lines, and EOF', async () => {
  const input = ': comment\r\nevent: chunk\r\ndata: {"text":"🌍"}\r\n\r\ndata: first\ndata: second\n\ndata: [DONE]';
  assert.deepEqual(await Array.fromAsync(sseRecords(bytes(input))), ['{"text":"🌍"}', 'first\nsecond', '[DONE]']);
});
test('SSE parser rejects oversized events', async () => {
  await assert.rejects(async () => { for await (const _ of sseRecords(bytes('data: '+'x'.repeat(2*1024*1024+1),65536))) {} }, /too large/);
});
test('Content arrays retain text only', () => { assert.equal(deltaText([{type:'text',text:'one'},{text:'two'}]), 'onetwo'); });
test('Response statistics retain recognized bounded numbers without coercion or arbitrary fields', () => {
  assert.deepEqual(usageStats({ prompt_tokens:0, completion_tokens:6, total_tokens:6,
    completion_tokens_details:{ reasoning_tokens:2, audio_tokens:'3', private_text:'omit' }, private_text:'omit' }),
  { prompt_tokens:0, completion_tokens:6, total_tokens:6, completion_tokens_details:{ reasoning_tokens:2 } });
  assert.deepEqual(timingStats({ prompt_n:7, prompt_ms:0, prompt_per_second:350.5, predicted_n:6, predicted_ms:60,
    predicted_per_second:100, draft_n:10, draft_n_accepted:4, unknown:'omit' }),
  { prompt_n:7, predicted_n:6, draft_n:10, draft_n_accepted:4, prompt_ms:0, prompt_per_second:350.5, predicted_ms:60, predicted_per_second:100 });
  for (const n of [-1, NaN, Infinity, '42', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(usageStats({ prompt_tokens:n, completion_tokens_details:{ reasoning_tokens:n } }), null);
    assert.equal(timingStats({ prompt_n:n, predicted_per_second:n }), null);
  }
  assert.equal(usageStats({ completion_tokens:1.5 }), null);
  assert.equal(timingStats({ draft_n:1.5 }), null);
  assert.deepEqual(promptProgressStats({ total:9, cache:2, processed:5, time_ms:20.5, unknown:'omit' }),
    { total:9, cache:2, processed:5, time_ms:20.5 });
  for (const invalid of [
    { total:9, cache:6, processed:5, time_ms:20 }, { total:9, cache:2, processed:10, time_ms:20 },
    { total:9, cache:2, processed:5 }, { total:9, cache:2, processed:5.5, time_ms:20 },
    { total:9, cache:2, processed:5, time_ms:Infinity }, { total:'9', cache:2, processed:5, time_ms:20 }
  ]) assert.equal(promptProgressStats(invalid), null);
  for (const value of [null, undefined, [], 'bad', {}]) {
    assert.equal(usageStats(value), null); assert.equal(timingStats(value), null); assert.equal(promptProgressStats(value), null);
  }
});
test('Settings preserve explicit zero and reject unsupported names and invalid numbers', () => {
  assert.deepEqual(settings({temperature:0,topP:0,maxTokens:1}), {temperature:0,topP:0,maxTokens:1});
  for (const input of [{temperature:NaN},{temperature:3},{topP:-1},{maxTokens:0},{maxTokens:1.5},{seed:1}]) assert.throws(()=>settings(input));
});
test('Provider validation rejects credential URLs and non-HTTP schemes', () => {
  for (const baseUrl of ['file:///etc/passwd','http://user:key@host/v1','https://host/v1?key=x','https://host/#fragment']) assert.throws(()=>providerConfig({name:'Test',baseUrl}));
  const p=providerConfig({name:'Test',baseUrl:'http://127.0.0.1:8000/v1/',models:['a','a']});
  assert.equal(p.baseUrl,'http://127.0.0.1:8000/v1'); assert.deepEqual(p.models,['a']); assert.equal(p.capabilities.vision,false);
  assert.equal(p.capabilities.llamaCppTimings,false);
  assert.equal(providerConfig({name:'Test',baseUrl:'http://model.example/v1',capabilities:{llamaCppTimings:true}}).capabilities.llamaCppTimings,true);
  assert.throws(()=>providerConfig({name:'Test',baseUrl:'http://model.example/v1',capabilities:{llamaCppTimings:'true'}}));
});
test('Attachments reject HTML-as-image, invalid UTF-8, NULs, bad base64, and unsupported binary files', () => {
  for (const input of [
    {name:'x.png',mime:'image/png',data:Buffer.from('<script>alert(1)</script>').toString('base64')},
    {name:'x.txt',mime:'text/plain',data:Buffer.from([0xff,0xfe]).toString('base64')},
    {name:'x.txt',mime:'text/plain',data:Buffer.from([0]).toString('base64')},
    {name:'x.pdf',mime:'application/pdf',data:Buffer.from('%PDF').toString('base64')}
  ]) assert.throws(()=>attachmentData(input));
  assert.throws(()=>decodeBase64('not base64!'));
  assert.equal(attachmentData({name:'../../readme.txt',mime:'text/plain',data:Buffer.from('text').toString('base64')}).name,'.._.._readme.txt');
});
test('Markdown escapes raw HTML and blocks script links and remote images', () => {
  const result=markdown('<script>alert(1)</script>\n\n[x](javascript:alert)\n\n![track](https://tracker.example/pixel)\n\n`<img onerror=x>`\n\n[x](https://example.com)');
  assert(!result.includes('<script')); assert(!result.includes('<img')); assert(!result.includes('href="javascript:'));
  assert(result.includes('&lt;script&gt;')); assert(result.includes('rel="noopener noreferrer"'));
});
test('Markdown renders fences, headings, lists, and tables', () => {
  const result=markdown('# Title\n\n- first\n- second\n\n```js\n<script>\n```\n\n| A | B |\n| --- | --- |\n| one | two |');
  assert(result.includes('<h1>Title</h1>')); assert(result.includes('<ul>')); assert(result.includes('<pre><code>&lt;script&gt;</code></pre>')); assert(result.includes('<table>'));
});
test('Legacy JSON and current JSONL import parsing', () => {
  const legacy={conv:{id:'c',name:'Saved',currNode:'m'},messages:[{id:'m',role:'user',content:'Hello',parent:null}]};
  assert.equal(parseText(JSON.stringify(legacy))[0].conv.name,'Saved');
  const jsonl=JSON.stringify({type:'session',harness:'llama.cpp',id:'c',name:'Saved',currNode:'m'})+'\n'+JSON.stringify({type:'message',message:legacy.messages[0]});
  assert.equal(parseText(jsonl)[0].messages[0].content,'Hello');
  assert.throws(()=>parseText('{"type":"message","message":{}}'), /Unsupported/);
});
test('ZIP importer validates bounds and checksum without filesystem extraction', () => {
  const zip=makeZip('../session.jsonl','hello');
  const entries=zipEntries(zip);assert.equal(entries[0].name,'../session.jsonl');assert.equal(entries[0].data.toString(),'hello');
  const bad=Buffer.from(zip);bad[35]^=4;assert.throws(()=>zipEntries(bad));
  assert.throws(()=>zipEntries(Buffer.from('bad')));
});
