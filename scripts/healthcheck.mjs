import { get } from 'node:http';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host : `127.0.0.1:${port}`;
const request = get({ hostname: '127.0.0.1', port, path: '/healthz', headers: { Host: host }, timeout: 4000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('Health check timeout.')));
request.on('error', () => { process.exitCode = 1; });
