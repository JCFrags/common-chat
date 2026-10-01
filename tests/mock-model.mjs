import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export async function mockModel() {
  const requests = [], authHeaders = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ data: ['demo-model','slow','plain','truncated','error','tools','malformed','redirect'].map(id => ({ id })) })); return;
    }
    if (req.url === '/leak') { requests.push({ leaked: true }); res.end('leak'); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const pieces = []; for await (const b of req) pieces.push(b);
    const input = JSON.parse(Buffer.concat(pieces)); requests.push(input); authHeaders.push(req.headers.authorization);
    if (input.model === 'error') { res.writeHead(401); res.end('secret-provider-response'); return; }
    if (input.model === 'redirect') { res.writeHead(307, { Location:'/leak' }); res.end(); return; }
    if (input.model === 'plain' || input.stream === false) {
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content:'A non-streaming answer.', reasoning_content:'A short explanation.' }, finish_reason:'stop' }], usage: { completion_tokens: 5 } })); return;
    }
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' });
    const emit = json => { if (!res.destroyed) res.write(`data: ${JSON.stringify(json)}\r\n\r\n`); };
    if (input.model === 'malformed') { res.end('data: {invalid\n\n'); return; }
    if (input.model === 'tools') { emit({ choices:[{ delta:{ tool_calls:[{ id:'call1', function:{ name:'x' } }] } }] }); res.end(); return; }
    emit({ choices:[{ delta:{ reasoning_content:'Consider the request. ' } }] });
    const words = input.model === 'slow'
      ? ['This ', 'response ', 'continues ', 'after ', 'a ', 'browser ', 'disconnects. ', ...Array(25).fill('More ')]
      : ['Hello ', 'from ', 'the ', 'test ', 'model. ', '🌍'];
    for (const word of words) {
      if (res.destroyed) return;
      emit({ choices:[{ delta:{ content:word } }] });
      await delay(input.model === 'slow' ? 60 : 25);
    }
    if (input.model !== 'truncated') {
      emit({ choices:[{ delta:{}, finish_reason:'stop' }], usage:{ prompt_tokens:9, completion_tokens:words.length } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, authHeaders, url:`http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
