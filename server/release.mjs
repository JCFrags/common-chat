import { readFileSync, existsSync } from 'node:fs';

const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = new URL('../release.json', import.meta.url);
const info = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
const channel = process.env.CHAT_UPDATE_CHANNEL ?? info.channel ?? 'preview';
if (!['preview', 'stable'].includes(channel)) throw new Error('CHAT_UPDATE_CHANNEL must be preview or stable.');
export const release = Object.freeze({
  version: typeof info.version === 'string' ? info.version : packageInfo.version,
  channel,
  commit: /^[a-f0-9]{40}$/.test(info.commit ?? '') ? info.commit : 'development'
});
