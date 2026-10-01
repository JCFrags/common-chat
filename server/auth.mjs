import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hash, now, fail, text } from './validation.mjs';
const scrypt = promisify(scryptCallback);
export async function passwordHash(password) {
  text(password, 'password', 1024);
  if (password.length < 12) fail(400, 'Use a password with at least 12 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password, saved) {
  const [salt, hex] = saved.split(':');
  const key = await scrypt(password, salt, 64);
  return timingSafeEqual(Buffer.from(hex, 'hex'), key);
}
export class Auth {
  constructor(store, secure) { this.store = store; this.secure = secure; this.failures = new Map(); }
  async initialize(password) {
    if (this.store.get('SELECT id FROM account WHERE id=1')) return null;
    const generated = !password;
    password ||= randomBytes(24).toString('base64url');
    this.store.run('INSERT INTO account(id,password) VALUES(1,?)', await passwordHash(password));
    return generated ? password : null;
  }
  token(req) {
    const found = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith('chat_session='));
    return found?.slice('chat_session='.length) ?? '';
  }
  require(req) {
    const token = this.token(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'Sign in to continue.');
    const session = this.store.get('SELECT expires FROM sessions WHERE token_hash=?', hash(token));
    if (!session || session.expires <= now()) fail(401, 'Your session expired. Sign in again.');
    return hash(token);
  }
  cookie(token, age = 7 * 86400) {
    return `chat_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? '; Secure' : ''}`;
  }
  async login(req, password) {
    text(password, 'password', 1024);
    const ip = req.socket.remoteAddress ?? 'unknown', time = now();
    for (const [k, v] of this.failures) if (v.until < time) this.failures.delete(k);
    if (this.failures.size >= 1000 && !this.failures.has(ip)) fail(429, 'Too many sign-in attempts. Try again later.');
    const state = this.failures.get(ip) ?? { count: 0, until: time + 15 * 60000 };
    if (state.count >= 10) fail(429, 'Too many sign-in attempts. Try again after 15 minutes.');
    state.count++; this.failures.set(ip, state);
    const account = this.store.get('SELECT password FROM account WHERE id=1');
    if (!await passwordMatches(password, account.password)) fail(401, 'Incorrect password.');
    this.failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    this.store.run('DELETE FROM sessions WHERE expires <= ?', time);
    this.store.run('INSERT INTO sessions(token_hash,expires) VALUES(?,?)', hash(token), time + 7 * 86400000);
    return token;
  }
}
