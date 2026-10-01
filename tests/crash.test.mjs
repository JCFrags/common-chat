import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mockModel } from './mock-model.mjs';

async function launch(dir) {
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'crash-server.mjs')], {
    env: { ...process.env, TEST_DATA_DIR: dir, PUBLIC_URL: '' }, stdio: ['ignore','pipe','pipe']
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const url = await Promise.race([
    once(lines, 'line').then(([line]) => JSON.parse(line).url),
    once(child, 'exit').then(([code]) => { throw new Error(`Test server exited ${code}: ${stderr}`); })
  ]);
  return { child, url, async stop(signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill(signal); await ended;
  } };
}

test('SIGKILL recovery retains committed partial output, sessions, and encrypted keys', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'common-chat-crash-')), model = await mockModel();
  let instance = await launch(dir);
  t.after(async () => { await instance.stop(); await model.close(); rmSync(dir, { recursive: true, force: true }); });
  let cookie = '';
  async function request(path, method = 'GET', data) {
    const res = await fetch(instance.url + path, { method,
      headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type':'application/json', 'X-Chat-Request':'1' }) },
      ...(method === 'GET' ? {} : { body:JSON.stringify(data ?? {}) }) });
    return { status:res.status, headers:res.headers, body:await res.json() };
  }
  const login = await request('/api/login', 'POST', { password:'crash-test-password-42' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const provider = await request('/api/providers','POST', { name:'Crash model',baseUrl:model.url,apiKey:'crash-provider-key',capabilities:{streaming:true} });
  const conv = (await request('/api/conversations','POST',{})).body;
  const job = (await request(`/api/conversations/${conv.id}/generate`,'POST',{
    requestId:randomUUID(),expectedVersion:conv.version,providerId:provider.body.id,model:'slow',parentId:null,content:'Keep the partial output.',settings:{}
  })).body;
  let committed = '';
  for (let i = 0; i < 50; i++) {
    const snapshot = (await request(`/api/conversations/${conv.id}`)).body;
    committed = snapshot.messages.find(m => m.role === 'assistant')?.content ?? '';
    if (committed.length > 20) break;
    await delay(25);
  }
  assert(committed.length > 20, 'Expected a committed partial response before the crash.');
  await instance.stop('SIGKILL');
  instance = await launch(dir);
  const recovered = await request(`/api/conversations/${conv.id}`);
  assert.equal(recovered.status,200,'The saved session must remain valid.');
  const answer = recovered.body.messages.find(m => m.role === 'assistant');
  assert(answer.content.startsWith(committed)); assert.equal(answer.status,'interrupted');
  assert.equal((await request(`/api/jobs/${job.jobId}`)).body.status,'interrupted');
  assert.equal((await request(`/api/providers/${provider.body.id}/models`)).status,200);
  const retry = await request(`/api/conversations/${conv.id}/generate`,'POST',{
    requestId:randomUUID(),expectedVersion:recovered.body.version,providerId:provider.body.id,model:'demo-model',parentId:recovered.body.activeLeaf,content:'Continue.',settings:{}
  });
  assert.equal(retry.status,202);
  for(let i=0;i<50;i++){if((await request(`/api/jobs/${retry.body.jobId}`)).body.status!=='running')break;await delay(25);}
  assert.equal(model.authHeaders.at(-1),'Bearer crash-provider-key');
});
