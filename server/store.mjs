import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { id, now, fail, hash, modelConfig as validateModelConfig, conversationUi, savedConversationUi } from './validation.mjs';

const parse = (s, fallback = {}) => s ? JSON.parse(s) : fallback;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const providerCapabilities = value => ({ llamaCppSampling: false, llamaCppThinkingBudget: false,
  presencePenalty: false, frequencyPenalty: false, seed: false, ...parse(value) });
export const archivedToolWarning = 'Some messages contain archived tool history. Select a branch without those messages before generation. Archived history cannot grant tool permissions or replay calls.';
export const forkWorkspaceWarning = 'Only the selected message path and its attachments were copied. Workspace files, revisions, executions, and package settings were not copied. Original workspace links still refer to the original conversations.';
export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.files = join(this.directory, 'files');
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'server.lock');
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive || !Number.isSafeInteger(pid) || pid < 1) throw new Error('The data directory is locked. Stop the other process before reuse.');
      unlinkSync(this.lockPath);
    }
    writeFileSync(this.lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      const keyPath = join(this.directory, 'master.key');
      if (!existsSync(keyPath) && existsSync(join(this.directory, 'chat.sqlite'))) throw new Error('master.key is missing. Restore it from the same backup as the database.');
      if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      this.key = readFileSync(keyPath);
      if (this.key.length !== 32) throw new Error('Invalid master.key. Restore the correct key from backup.');
      const dbPath = join(this.directory, 'chat.sqlite');
      this.db = new DatabaseSync(dbPath);
      chmodSync(dbPath, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('The database schema is newer than this server.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), password TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT, models TEXT NOT NULL, capabilities TEXT NOT NULL, model_config TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_leaf TEXT, version INTEGER NOT NULL DEFAULT 1, settings TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, provider_id TEXT, provider_name TEXT, model TEXT, settings TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
        CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(conversation_id) WHERE status='running';
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      if (!this.all('PRAGMA table_info(providers)').some(column => column.name === 'model_config')) {
        this.db.exec("ALTER TABLE providers ADD COLUMN model_config TEXT NOT NULL DEFAULT '{}'");
      }
      this.transaction(() => {
        const affected = this.all("SELECT DISTINCT conversation_id FROM jobs WHERE status='running'");
        this.run("UPDATE messages SET status='interrupted', updated_at=? WHERE status='streaming'", now());
        this.run("UPDATE jobs SET status='interrupted', error='The server stopped before completion.', updated_at=? WHERE status='running'", now());
        for (const row of affected) this.touch(row.conversation_id);
        this.run('DELETE FROM sessions WHERE expires < ?', now());
      });
      // Retain orphan files after a crash so an administrator can recover their contents.
    } catch (e) {
      this.db?.close(); unlinkSync(this.lockPath); throw e;
    }
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  attachmentTransaction(fn) {
    const created = [];
    try {
      return this.transaction(() => fn((cid, file, messageId) => {
        const attachment = this.addAttachment(cid, file, messageId);
        created.push(attachment.id); return attachment;
      }));
    } catch (error) { this.removeAttachmentFiles(created); throw error; }
  }
  removeAttachmentFiles(ids) {
    for (const aid of ids) { try { unlinkSync(join(this.files, aid)); } catch {} }
  }
  sourceWithUi(source, patch) {
    const result = record(source) ? { ...source } : { archivedSource: source };
    if (source?.ui !== undefined && !record(source.ui)) {
      result.archivedUi = result.archivedUi === undefined ? source.ui : { previous: result.archivedUi, ui: source.ui };
    }
    result.ui = { ...(record(source?.ui) ? source.ui : {}), ...savedConversationUi(source), ...conversationUi(patch) };
    return result;
  }
  touch(cid) { this.run('UPDATE conversations SET version=version+1, updated_at=? WHERE id=?', now(), cid); }
  conversation(cid) {
    const c = this.get('SELECT * FROM conversations WHERE id=?', cid);
    if (!c) fail(404, 'Conversation not found.');
    return c;
  }
  assertVersion(c, version) {
    if (!Number.isSafeInteger(version) || version !== c.version) fail(409, 'This conversation changed on another device. Review the latest version and try again.');
  }
  assertIdle(cid) { if (this.get("SELECT id FROM jobs WHERE conversation_id=? AND status='running'", cid)) fail(409, 'This conversation already has an active generation.'); }
  createConversation(title = 'New chat', settings = {}, source = {}) {
    const cid = id(), time = now();
    this.run('INSERT INTO conversations(id,title,created_at,updated_at,settings,source) VALUES(?,?,?,?,?,?)', cid, title, time, time, JSON.stringify(settings), JSON.stringify(source));
    return cid;
  }
  addMessage(m) {
    this.run(`INSERT INTO messages(id,conversation_id,parent_id,role,content,reasoning,status,provider_id,provider_name,model,settings,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      m.id, m.conversationId, m.parentId ?? null, m.role, m.content ?? '', m.reasoning ?? '', m.status ?? 'complete', m.providerId ?? null,
      m.providerName ?? null, m.model ?? null, JSON.stringify(m.settings ?? {}), JSON.stringify(m.metadata ?? {}), m.createdAt ?? now(), m.updatedAt ?? now());
  }
  message(row) {
    return { id: row.id, conversationId: row.conversation_id, parentId: row.parent_id, role: row.role,
      content: row.content, reasoning: row.reasoning, status: row.status, providerId: row.provider_id,
      providerName: row.provider_name, model: row.model, settings: parse(row.settings), metadata: (() => {
        const { source, toolTranscript, toolPermissions, archivedToolContext, ...visible } = parse(row.metadata);
        // Local saved grants are read-only history. Imported grants stay archived and hidden.
        if (row.role === 'assistant' && !archivedToolContext && toolPermissions && typeof toolPermissions === 'object' && !Array.isArray(toolPermissions) &&
            this.get('SELECT id FROM jobs WHERE message_id=? AND conversation_id=?', row.id, row.conversation_id)) {
          visible.toolPermissions = Object.fromEntries(['workspace', 'execute', 'packages'].map(key => [key, toolPermissions[key] === true]));
        }
        return visible;
      })(),
      createdAt: row.created_at, updatedAt: row.updated_at,
      attachments: this.all('SELECT id,name,mime,kind,size,sha256 FROM attachments WHERE message_id=? ORDER BY created_at,id', row.id) };
  }
  snapshot(cid) {
    const c = this.conversation(cid), source = parse(c.source);
    const rows = this.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id', cid);
    const warnings = [];
    if (source?.commonChatFork?.files === 'attachments-only') warnings.push(forkWorkspaceWarning);
    if (rows.some(row => {
      const meta = parse(row.metadata);
      return row.role === 'tool' || meta.archivedToolContext || meta.source?.toolCalls;
    })) warnings.push(archivedToolWarning);
    return { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at,
      activeLeaf: c.active_leaf, version: c.version, settings: parse(c.settings), ui: savedConversationUi(source), warnings,
      messages: rows.map(m => this.message(m)),
      activeJob: this.get("SELECT id,message_id AS messageId,status FROM jobs WHERE conversation_id=? AND status='running'", cid) ?? null };
  }
  list(search = '') {
    return this.all(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,c.version,c.source,
      EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status='running') AS running
      FROM conversations c WHERE ?='' OR instr(lower(c.title),lower(?))>0 OR EXISTS
      (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND instr(lower(m.content),lower(?))>0)
      ORDER BY c.updated_at DESC LIMIT 1000`, search, search, search).map(({ source, ...row }) => ({ ...row, ui: savedConversationUi(parse(source)) }));
  }
  path(cid, leaf) {
    if (!leaf) return [];
    const rows = new Map(this.all('SELECT * FROM messages WHERE conversation_id=?', cid).map(m => [m.id, m]));
    const seen = new Set(), result = [];
    while (leaf) {
      if (seen.has(leaf) || !rows.has(leaf)) fail(400, 'The message branch is invalid.');
      seen.add(leaf); const row = rows.get(leaf); result.push(row); leaf = row.parent_id;
    }
    return result.reverse();
  }
  encrypt(secret) {
    if (!secret) return null;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(value) {
    if (!value) return '';
    const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8');
  }
  providers() {
    return this.all('SELECT * FROM providers ORDER BY created_at').map(p => ({ id: p.id, name: p.name, baseUrl: p.base_url,
      models: parse(p.models, []), capabilities: providerCapabilities(p.capabilities), modelConfig: validateModelConfig(parse(p.model_config)), hasKey: !!p.api_key }));
  }
  provider(pid) {
    const p = this.get('SELECT * FROM providers WHERE id=?', pid);
    if (!p) fail(404, 'Connection not found.');
    return { ...p, apiKey: this.decrypt(p.api_key), models: parse(p.models, []), capabilities: providerCapabilities(p.capabilities), modelConfig: validateModelConfig(parse(p.model_config)) };
  }
  addAttachment(cid, file, messageId = null) {
    const aid = id();
    writeFileSync(join(this.files, aid), file.bytes, { mode: 0o600, flag: 'wx' });
    try {
      this.run('INSERT INTO attachments(id,conversation_id,message_id,name,mime,kind,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        aid, cid, messageId, file.name, file.mime, file.kind, file.bytes.length, hash(file.bytes), now());
    } catch (e) { unlinkSync(join(this.files, aid)); throw e; }
    return this.get('SELECT id,name,mime,kind,size,sha256 FROM attachments WHERE id=?', aid);
  }
  readAttachment(a) { return readFileSync(join(this.files, a.id)); }
  deleteConversation(cid) {
    const files = this.all('SELECT id FROM attachments WHERE conversation_id=?', cid);
    this.run('DELETE FROM conversations WHERE id=?', cid);
    for (const f of files) { try { unlinkSync(join(this.files, f.id)); } catch {} }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close();
    unlinkSync(this.lockPath);
  }
}
