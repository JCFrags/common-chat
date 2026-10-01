import { createApp } from './app.mjs';
const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
if (!['127.0.0.1','localhost','::1'].includes(host) && !process.env.PUBLIC_URL) {
  throw new Error('Set PUBLIC_URL before listening on a non-loopback address.');
}
const app = await createApp();
await app.listen(port, host);
console.log(`Common Chat is listening at ${process.env.PUBLIC_URL ?? `http://localhost:${port}`}`);
if (app.bootstrapPassword) console.log(`Initial owner password: ${app.bootstrapPassword}\nSave this password. It is displayed only on first startup.`);
let exiting = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
  if (exiting) return; exiting = true;
  await app.close(); process.exit(0);
});
