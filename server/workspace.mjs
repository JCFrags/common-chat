import { constants, mkdirSync, lstatSync, fstatSync, readdirSync, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fail, hash, id, now, object } from './validation.mjs';

const MiB = 1024 * 1024;
export const WORKSPACE_LIMITS = Object.freeze({
  textBytes: MiB, binaryBytes: 10 * MiB, paths: 128, revisionsPerPath: 64,
  conversationBytes: 128 * MiB, totalBytes: 1024 * MiB, totalBlobs: 8192,
  totalRevisions: 16384, extractedBytes: 2 * MiB, passages: 2048,
  passageBytes: 4096, pages: 1000, outputFiles: 32, outputBytes: 20 * MiB,
  searchResults: 50, concurrentWrites: 4, extractionTimeoutMs: 30000
});
const opaqueId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.html', '.htm', '.css', '.scss', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.sql', '.c', '.h', '.cpp', '.hpp', '.rs', '.go', '.java', '.rb', '.php', '.r', '.tex']);
const mimeByExtension = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** Validate a portable logical name. This value is never joined to a host directory. */
export function workspacePath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value !== value.normalize('NFC') || Buffer.byteLength(value) > 512 || /[\\<>:"|?*\p{C}]/u.test(value) || value.startsWith('~')) fail(400, 'Use a portable relative workspace path.');
  const segments = value.split('/');
  if (segments.length > 8 || segments.some(s => !s || s === '.' || s === '..' || s !== s.trim() || s.endsWith('.') || Buffer.byteLength(s) > 120 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) fail(400, 'Use a portable relative workspace path without empty, reserved, or traversal names.');
  return value;
}
function fields(value, allowed) {
  object(value, 'workspace request');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'Unknown workspace request field.');
  return value;
}
function revisionId(value) {
  if (typeof value !== 'string' || !opaqueId.test(value)) fail(400, 'Invalid workspace revision.');
  return value;
}
function precondition(value, sha256) {
  if (value !== undefined && value !== null) revisionId(value);
  if (sha256 !== undefined && sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))) fail(400, 'Invalid expected workspace hash.');
  return { revision: value ?? null, sha256 };
}
function utf8(bytes) {
  if (bytes.includes(0)) fail(400, 'Workspace text cannot contain NUL bytes.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(400, 'Workspace text must use valid UTF-8.'); }
}
function classify(path, mime) {
  const extension = extname(path).toLowerCase();
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime === mimeByExtension['.docx'] || extension === '.docx') return 'docx';
  if (mime.startsWith('text/') || /^(application\/(json|x-ndjson|xml|javascript|x-javascript|yaml|x-yaml|toml)|image\/svg\+xml)$/.test(mime) || /\+(json|xml)$/.test(mime) || textExtensions.has(extension)) return 'text';
  return 'binary';
}
function prepare(input) {
  fields(input, ['path', 'mime', 'text', 'data', 'expectedRevision', 'expectedSha256']);
  const path = workspacePath(input.path), extension = extname(path).toLowerCase();
  let mime = input.mime ?? mimeByExtension[extension] ?? (input.text !== undefined || textExtensions.has(extension) ? 'text/plain' : 'application/octet-stream');
  if (typeof mime !== 'string' || mime.length > 120 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=utf-8)?$/i.test(mime)) fail(400, 'Invalid workspace MIME type.');
  mime = mime.split(';')[0].toLowerCase();
  const kind = classify(path, mime), expected = precondition(input.expectedRevision, input.expectedSha256);
  if ((input.text !== undefined) === (input.data !== undefined)) fail(400, 'Supply exactly one of text or base64 data.');
  let bytes;
  if (input.text !== undefined) {
    if (kind !== 'text' || typeof input.text !== 'string' || !input.text.isWellFormed() || input.text.includes('\0')) fail(400, 'Use valid UTF-8 text, or base64 data for a binary document.');
    if (Buffer.byteLength(input.text) > WORKSPACE_LIMITS.textBytes) fail(413, 'Workspace text exceeds 1 MiB.');
    bytes = Buffer.from(input.text, 'utf8');
  } else {
    const data = input.data;
    if (typeof data !== 'string') fail(400, 'Workspace data must be base64.');
    if (data.length > Math.ceil(WORKSPACE_LIMITS.binaryBytes / 3) * 4) fail(413, 'A workspace file exceeds 10 MiB.');
    if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail(400, 'Invalid workspace base64 data.');
    bytes = Buffer.from(data, 'base64');
    if (bytes.length > WORKSPACE_LIMITS.binaryBytes) fail(413, 'A workspace file exceeds 10 MiB.');
    if (bytes.toString('base64') !== data) fail(400, 'Invalid workspace base64 data.');
  }
  let text;
  if (kind === 'text') {
    if (bytes.length > WORKSPACE_LIMITS.textBytes) fail(413, 'Workspace text exceeds 1 MiB.');
    text = utf8(bytes);
  }
  return { path, mime, kind, bytes, text, expected };
}
function extractionFailure(status, message) { return { status, error: message, passages: [], bytes: 0 }; }
function passagesFrom(parts) {
  const passages = [], locations = new Set(), counters = new Map();
  let sourceBytes = 0, indexBytes = 0;
  for (const item of parts) {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.isWellFormed() || item.text.includes('\0')) throw new Error('Invalid extracted text.');
    sourceBytes += Buffer.byteLength(item.text);
    if (sourceBytes > WORKSPACE_LIMITS.extractedBytes) throw new Error('Extraction limit.');
    const page = item.page ?? null;
    if (page !== null && (!Number.isSafeInteger(page) || page < 1 || page > WORKSPACE_LIMITS.pages)) throw new Error('Invalid extracted page.');
    const paragraphs = item.paragraph === undefined ? item.text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/) : [item.text];
    for (const paragraphText of paragraphs) {
      const value = paragraphText.trim();
      if (!value) continue;
      const paragraph = item.paragraph ?? (counters.get(page) ?? 0) + 1;
      if (!Number.isSafeInteger(paragraph) || paragraph < 1 || paragraph > 1000000) throw new Error('Invalid extracted paragraph.');
      counters.set(page, Math.max(counters.get(page) ?? 0, paragraph));
      const location = `${page}:${paragraph}`;
      if (locations.has(location)) throw new Error('Duplicate extracted paragraph.');
      locations.add(location);
      let chunk = '', size = 0, part = 1;
      const append = () => {
        const searchText = chunk.toLowerCase();
        indexBytes += Buffer.byteLength(chunk) + Buffer.byteLength(searchText);
        passages.push({ page, paragraph, part: part++, text: chunk, searchText });
        if (passages.length > WORKSPACE_LIMITS.passages) throw new Error('Extraction limit.');
        chunk = ''; size = 0;
      };
      for (const character of value) {
        const length = Buffer.byteLength(character);
        if (size + length > WORKSPACE_LIMITS.passageBytes) append();
        chunk += character; size += length;
      }
      if (chunk) append();
    }
  }
  return { status: passages.length ? 'indexed' : 'empty', error: null, passages, bytes: indexBytes };
}
function checkSignal(signal) {
  if (signal?.aborted) {
    const error = new Error('Workspace operation cancelled.');
    error.name = 'AbortError'; throw error;
  }
}
function citation(cid, row, passage) {
  const revision = row.id ?? row.revision_id;
  const params = new URLSearchParams({ path: row.path, revision });
  const location = `paragraph=${passage.paragraph}&part=${passage.part}${passage.page === null ? '' : `&page=${passage.page}`}`;
  return { id: `workspace:${encodeURIComponent(row.path)}@${revision}#${location}`, path: row.path, revision, sha256: row.sha256,
    page: passage.page, paragraph: passage.paragraph, part: passage.part,
    url: `/api/conversations/${encodeURIComponent(cid)}/workspace/files?${params}#${location}` };
}
function metadata(row) {
  return {
    path: row.path, revision: row.id, version: row.sequence, mime: row.mime, size: row.size,
    sha256: row.sha256, text: !!row.is_text, deleted: !!row.deleted, createdAt: row.created_at,
    restoredFrom: row.source_revision, index: { status: row.index_status, error: row.index_error, passages: row.passage_count }
  };
}

export class Workspace {
  #store;
  #directory;
  #extractDocument;
  #inflight = 0;
  constructor(store, { extractDocument } = {}) {
    if (extractDocument !== undefined && typeof extractDocument !== 'function') throw new TypeError('extractDocument must be a function.');
    this.#store = store;
    this.#extractDocument = extractDocument;
    const root = join(store.directory, 'workspace');
    this.#directory = join(root, 'blobs');
    for (const directory of [root, this.#directory]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workspace storage must use ordinary directories.');
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        path TEXT NOT NULL, path_key TEXT NOT NULL, head_revision TEXT,
        PRIMARY KEY(conversation_id,path), UNIQUE(conversation_id,path_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_revisions (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, path TEXT NOT NULL,
        sequence INTEGER NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT, is_text INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, source_revision TEXT,
        index_status TEXT NOT NULL, index_error TEXT, index_bytes INTEGER NOT NULL,
        passage_count INTEGER NOT NULL,
        FOREIGN KEY(conversation_id,path) REFERENCES workspace_files(conversation_id,path) ON DELETE CASCADE,
        UNIQUE(conversation_id,path,sequence)
      );
      CREATE INDEX IF NOT EXISTS workspace_revision_scope ON workspace_revisions(conversation_id,path);
      CREATE TABLE IF NOT EXISTS workspace_passages (
        revision_id TEXT NOT NULL REFERENCES workspace_revisions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, page INTEGER, paragraph INTEGER NOT NULL, part INTEGER NOT NULL,
        text TEXT NOT NULL, search_text TEXT NOT NULL, PRIMARY KEY(revision_id,ordinal)
      );
    `);
  }
  #scope(cid) {
    if (typeof cid !== 'string' || !cid || cid.length > 100) fail(404, 'Conversation not found.');
    this.#store.conversation(cid);
  }
  #head(cid, path) {
    return this.#store.get(`SELECT r.* FROM workspace_files f JOIN workspace_revisions r ON r.id=f.head_revision WHERE f.conversation_id=? AND f.path=?`, cid, path);
  }
  #assertHead(cid, path, expected) {
    const head = this.#head(cid, path);
    if ((head?.id ?? null) !== expected.revision || (expected.sha256 !== undefined && (head?.sha256 ?? null) !== expected.sha256)) fail(409, 'This workspace file changed. Read its current revision and try again.');
    return head;
  }
  #row(cid, path, revision) {
    this.#scope(cid); workspacePath(path);
    const row = revision === undefined ? this.#head(cid, path) : this.#store.get('SELECT * FROM workspace_revisions WHERE conversation_id=? AND path=? AND id=?', cid, path, revisionId(revision));
    if (!row || row.deleted) fail(404, 'Workspace file revision not found.');
    return row;
  }
  #blobPath(revision) { return join(this.#directory, revisionId(revision)); }
  #bytes(row) {
    let fd;
    try {
      fd = openSync(this.#blobPath(row.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== row.size || stat.size > WORKSPACE_LIMITS.binaryBytes) fail(500, 'Workspace revision failed its integrity check. Restore a verified backup.');
      const bytes = readFileSync(fd);
      if (bytes.length !== row.size || hash(bytes) !== row.sha256) fail(500, 'Workspace revision failed its integrity check. Restore a verified backup.');
      return bytes;
    } catch (error) {
      if (error?.status === 500) throw error;
      fail(500, 'Workspace revision bytes are unavailable. Restore a verified backup.');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  #usage(cid) {
    const usage = this.#store.get('SELECT count(*) AS revisions, coalesce(sum(size+index_bytes),0) AS bytes FROM workspace_revisions WHERE conversation_id=?', cid);
    return { ...usage, paths: this.#store.get('SELECT count(*) AS n FROM workspace_files WHERE conversation_id=?', cid).n };
  }
  list(cid) {
    this.#scope(cid);
    const files = this.#store.all('SELECT r.* FROM workspace_files f JOIN workspace_revisions r ON r.id=f.head_revision WHERE f.conversation_id=? ORDER BY f.path', cid).map(metadata);
    return { files, usage: this.#usage(cid), limits: WORKSPACE_LIMITS };
  }
  read(cid, path, options = {}) {
    const revision = typeof options === 'string' ? options : options.revision;
    const row = this.#row(cid, path, revision), bytes = this.#bytes(row);
    const result = { file: metadata(row), ...(row.is_text ? { text: utf8(bytes) } : { data: bytes.toString('base64') }) };
    if (['pdf', 'docx'].includes(classify(row.path, row.mime))) {
      result.passages = this.#store.all('SELECT page,paragraph,part,text FROM workspace_passages WHERE revision_id=? ORDER BY ordinal LIMIT ?', row.id, WORKSPACE_LIMITS.passages)
        .map(p => ({ ...p, citation: citation(cid, row, p) }));
    }
    return result;
  }
  snapshot(cid, { paths } = {}) {
    this.#scope(cid);
    const rows = this.#store.all('SELECT r.* FROM workspace_files f JOIN workspace_revisions r ON r.id=f.head_revision WHERE f.conversation_id=? ORDER BY f.path', cid);
    let selected = rows.filter(row => !row.deleted);
    if (paths !== undefined) {
      if (!Array.isArray(paths) || paths.length > WORKSPACE_LIMITS.paths) fail(400, 'Invalid workspace snapshot path list.');
      const names = new Set(paths.map(workspacePath));
      if (names.size !== paths.length) fail(400, 'Workspace snapshot paths must be unique.');
      selected = selected.filter(row => names.has(row.path));
      if (selected.length !== names.size) fail(404, 'Workspace snapshot file not found.');
    }
    if (selected.reduce((sum, row) => sum + row.size, 0) > WORKSPACE_LIMITS.outputBytes) fail(413, 'Workspace snapshot exceeds 20 MiB. Select fewer input files.');
    return {
      files: selected.map(row => ({ path: row.path, mime: row.mime, data: this.#bytes(row).toString('base64'), size: row.size, revision: row.id, sha256: row.sha256 })),
      revisions: Object.fromEntries(rows.map(row => [row.path, { revision: row.id, sha256: row.sha256, deleted: !!row.deleted }]))
    };
  }
  deleteConversation(cid) {
    this.#scope(cid);
    const rows = this.#store.all('SELECT id FROM workspace_revisions WHERE conversation_id=? AND deleted=0', cid);
    // Validate all selected objects before deleting any. Missing blobs can be retried safely.
    const files = [];
    for (const row of rows) {
      const path = this.#blobPath(row.id);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(500, 'Workspace cleanup found an unexpected storage object.');
        files.push(path);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        if (error?.status) throw error;
        fail(500, 'Workspace cleanup could not inspect its saved files.');
      }
    }
    for (const path of files) {
      try { unlinkSync(path); }
      catch (error) { if (error?.code !== 'ENOENT') fail(500, 'Workspace cleanup is incomplete. Retry conversation deletion.'); }
    }
    this.#store.run('DELETE FROM workspace_files WHERE conversation_id=?', cid);
    return { deleted: true, blobs: files.length };
  }
  download(cid, path, { revision } = {}) {
    const row = this.#row(cid, path, revision);
    return { file: metadata(row), bytes: this.#bytes(row) };
  }
  history(cid, path) {
    this.#scope(cid); workspacePath(path);
    const head = this.#head(cid, path);
    if (!head) fail(404, 'Workspace file not found.');
    return { path, currentRevision: head.id, revisions: this.#store.all('SELECT * FROM workspace_revisions WHERE conversation_id=? AND path=? ORDER BY sequence DESC', cid, path).map(metadata) };
  }
  async #index(file, signal) {
    checkSignal(signal);
    if (file.kind === 'binary') return extractionFailure('unsupported', 'This file type is stored but is not searchable.');
    if (file.kind === 'text') {
      try { return passagesFrom([{ text: file.text }]); }
      catch { return extractionFailure('error', 'Text indexing exceeded the passage limit. Split the document into smaller files.'); }
    }
    if (!this.#extractDocument) return extractionFailure('unavailable', 'Document extraction is not configured. The original file remains available.');
    const controller = new AbortController();
    let timer, onAbort;
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => {
          controller.abort();
          try { checkSignal(signal); } catch (error) { reject(error); }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      checkSignal(signal);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Extraction timed out.')); }, WORKSPACE_LIMITS.extractionTimeoutMs);
        timer.unref?.();
      });
      const extracted = await Promise.race([
        Promise.resolve().then(() => {
          checkSignal(signal);
          return this.#extractDocument({ path: file.path, mime: file.mime, bytes: Buffer.from(file.bytes), signal: controller.signal });
        }), timeout, cancelled
      ]);
      checkSignal(signal);
      if (extracted?.status === 'unsupported') return extractionFailure('unsupported', 'This document cannot be extracted. Scanned PDFs require OCR, which is not supported.');
      if (extracted?.error || ['error', 'failed', 'unavailable'].includes(extracted?.status)) throw new Error('Extraction failed.');
      let parts;
      if (Array.isArray(extracted?.pages) && extracted.pages.length <= WORKSPACE_LIMITS.pages) {
        parts = extracted.pages.map((p, i) => ({ text: p?.text, page: p?.page ?? i + 1 }));
        if (new Set(parts.map(p => p.page)).size !== parts.length) throw new Error('Duplicate extracted page.');
      } else if (Array.isArray(extracted?.passages) && extracted.passages.length <= WORKSPACE_LIMITS.passages) parts = extracted.passages;
      else throw new Error('Invalid extraction result.');
      const indexed = passagesFrom(parts);
      if (!indexed.passages.length) return extractionFailure('empty', file.kind === 'pdf' ? 'The PDF has no extractable text. Scanned PDFs require OCR, which is not supported.' : 'The document has no extractable text.');
      return indexed;
    } catch {
      checkSignal(signal);
      return extractionFailure('error', controller.signal.aborted ? 'Document extraction timed out. The original file remains available.' : 'Document extraction failed or exceeded its limits. The original file remains available.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  #physicalUsage() {
    let bytes = 0, count = 0;
    try {
      const names = readdirSync(this.#directory);
      if (names.length > WORKSPACE_LIMITS.totalBlobs) fail(413, 'Workspace storage has reached its blob limit.');
      for (const name of names) {
        if (!opaqueId.test(name)) fail(500, 'Workspace storage contains an unexpected entry.');
        const stat = lstatSync(join(this.#directory, name));
        if (!stat.isFile() || stat.isSymbolicLink()) fail(500, 'Workspace storage contains an unexpected entry.');
        bytes += stat.size; count++;
      }
    } catch (error) {
      if (error?.status) throw error;
      fail(500, 'Workspace storage is unavailable.');
    }
    return { bytes, count };
  }
  #commit(cid, files, signal) {
    checkSignal(signal);
    const written = [];
    try {
      return this.#store.transaction(() => {
        this.#scope(cid);
        const physical = this.#physicalUsage(), usage = this.#usage(cid);
        const total = this.#store.get('SELECT count(*) AS revisions, coalesce(sum(index_bytes),0) AS indexBytes FROM workspace_revisions');
        let newPaths = 0, addedBytes = 0, addedBlobs = 0;
        const known = this.#store.all('SELECT path,path_key FROM workspace_files WHERE conversation_id=?', cid);
        const live = new Set(this.#store.all('SELECT f.path_key FROM workspace_files f JOIN workspace_revisions r ON r.id=f.head_revision WHERE f.conversation_id=? AND r.deleted=0', cid).map(f => f.path_key));
        for (const file of files) {
          const head = this.#assertHead(cid, file.path, file.expected);
          if (file.deleted && (!head || head.deleted)) fail(404, 'Workspace file not found.');
          // Keep one final deletion possible when a file reaches its content-revision limit.
          if (head && head.sequence >= WORKSPACE_LIMITS.revisionsPerPath && !file.deleted) fail(413, 'This workspace file has reached its revision limit.');
          file.sequence = (head?.sequence ?? 0) + 1;
          const key = file.path.toLowerCase(), sameKey = known.find(f => f.path_key === key);
          if (sameKey && sameKey.path !== file.path) fail(409, 'Workspace paths must differ by more than letter case.');
          if (!sameKey) { newPaths++; known.push({ path: file.path, path_key: key }); }
          if (!file.deleted) {
            if ([...live].some(p => p !== key && (p.startsWith(`${key}/`) || key.startsWith(`${p}/`)))) fail(409, 'A workspace file conflicts with this folder path.');
            live.add(key); addedBlobs++;
          } else live.delete(key);
          addedBytes += file.bytes.length + file.index.bytes;
        }
        if (usage.paths + newPaths > WORKSPACE_LIMITS.paths) fail(413, 'This conversation has reached its workspace path limit. Deleted paths retain their history.');
        if (usage.bytes + addedBytes > WORKSPACE_LIMITS.conversationBytes) fail(413, 'This conversation has reached its retained workspace storage limit.');
        if (physical.bytes + total.indexBytes + addedBytes > WORKSPACE_LIMITS.totalBytes || physical.count + addedBlobs > WORKSPACE_LIMITS.totalBlobs || total.revisions + files.length > WORKSPACE_LIMITS.totalRevisions) fail(413, 'The workspace has reached its retained storage limit.');
        const result = [];
        for (const file of files) {
          const revision = id(), timestamp = now(), sha256 = file.deleted ? null : hash(file.bytes);
          if (!file.deleted) {
            const path = this.#blobPath(revision);
            let fd;
            try {
              fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              written.push(path); writeFileSync(fd, file.bytes); fsyncSync(fd);
            } catch { fail(500, 'Workspace revision could not be saved.'); }
            finally { if (fd !== undefined) closeSync(fd); }
          }
          this.#store.run('INSERT OR IGNORE INTO workspace_files(conversation_id,path,path_key) VALUES(?,?,?)', cid, file.path, file.path.toLowerCase());
          this.#store.run(`INSERT INTO workspace_revisions(id,conversation_id,path,sequence,mime,size,sha256,is_text,deleted,created_at,source_revision,index_status,index_error,index_bytes,passage_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            revision, cid, file.path, file.sequence, file.mime, file.bytes.length, sha256, file.kind === 'text' ? 1 : 0, file.deleted ? 1 : 0, timestamp, file.sourceRevision ?? null, file.index.status, file.index.error, file.index.bytes, file.index.passages.length);
          for (const [ordinal, p] of file.index.passages.entries()) this.#store.run('INSERT INTO workspace_passages(revision_id,ordinal,page,paragraph,part,text,search_text) VALUES(?,?,?,?,?,?,?)', revision, ordinal, p.page, p.paragraph, p.part, p.text, p.searchText);
          this.#store.run('UPDATE workspace_files SET head_revision=? WHERE conversation_id=? AND path=?', revision, cid, file.path);
          result.push(metadata(this.#head(cid, file.path)));
        }
        if (written.length) {
          let fd;
          try { fd = openSync(this.#directory, constants.O_RDONLY); fsyncSync(fd); }
          catch { fail(500, 'Workspace revision could not be saved.'); }
          finally { if (fd !== undefined) closeSync(fd); }
        }
        this.#store.touch(cid);
        return result;
      });
    } catch (error) {
      for (const path of written) { try { unlinkSync(path); } catch {} }
      throw error;
    }
  }
  async write(cid, input, { signal } = {}) {
    this.#scope(cid); checkSignal(signal);
    if (this.#inflight >= WORKSPACE_LIMITS.concurrentWrites) fail(429, 'Too many workspace writes are in progress.');
    const file = prepare(input);
    this.#assertHead(cid, file.path, file.expected);
    this.#inflight++;
    try { file.index = await this.#index(file, signal); return this.#commit(cid, [file], signal)[0]; }
    finally { this.#inflight--; }
  }
  remove(cid, path, expectedRevision, expectedSha256) {
    this.#scope(cid); workspacePath(path);
    const expected = precondition(expectedRevision, expectedSha256), head = this.#assertHead(cid, path, expected);
    if (!head || head.deleted) fail(404, 'Workspace file not found.');
    return this.#commit(cid, [{ path, mime: head.mime, kind: head.is_text ? 'text' : 'binary', bytes: Buffer.alloc(0), expected, deleted: true, index: extractionFailure('deleted', null) }])[0];
  }
  restore(cid, input) {
    fields(input, ['path', 'revision', 'expectedRevision', 'expectedSha256']);
    const row = this.#row(cid, input.path, input.revision === undefined ? '' : input.revision);
    const expected = precondition(input.expectedRevision, input.expectedSha256);
    this.#assertHead(cid, input.path, expected);
    const passages = this.#store.all('SELECT page,paragraph,part,text,search_text AS searchText FROM workspace_passages WHERE revision_id=? ORDER BY ordinal', row.id);
    return this.#commit(cid, [{ path: row.path, mime: row.mime, kind: row.is_text ? 'text' : 'binary', bytes: this.#bytes(row), expected, sourceRevision: row.id,
      index: { status: row.index_status, error: row.index_error, bytes: row.index_bytes, passages } }])[0];
  }
  async importOutputs(cid, files, { signal } = {}) {
    this.#scope(cid); checkSignal(signal);
    if (!Array.isArray(files) || !files.length || files.length > WORKSPACE_LIMITS.outputFiles) fail(400, 'Import between 1 and 32 workspace output files.');
    if (this.#inflight >= WORKSPACE_LIMITS.concurrentWrites) fail(429, 'Too many workspace writes are in progress.');
    const prepared = [];
    let bytes = 0;
    for (const input of files) {
      const file = prepare(input); bytes += file.bytes.length;
      if (bytes > WORKSPACE_LIMITS.outputBytes) fail(413, 'Workspace output files exceed 20 MiB.');
      prepared.push(file);
    }
    if (new Set(prepared.map(f => f.path.toLowerCase())).size !== prepared.length) fail(400, 'Workspace output paths must be unique.');
    for (const file of prepared) this.#assertHead(cid, file.path, file.expected);
    this.#inflight++;
    try {
      for (const file of prepared) file.index = await this.#index(file, signal);
      return { files: this.#commit(cid, prepared, signal) };
    } finally { this.#inflight--; }
  }
  search(cid, query, { limit = 10 } = {}) {
    this.#scope(cid);
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || !query.isWellFormed()) fail(400, 'Use a search query between 1 and 500 characters.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_LIMITS.searchResults) fail(400, 'Search limit must be between 1 and 50.');
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    if (!terms.length || terms.length > 16 || terms.some(t => t.length > 64)) fail(400, 'Use between 1 and 16 search words of at most 64 characters.');
    const score = terms.map(() => '(instr(p.search_text,?)>0)').join('+');
    const rows = this.#store.all(`SELECT p.*,r.path,r.sha256,r.mime,(${score}) AS score FROM workspace_passages p
      JOIN workspace_revisions r ON r.id=p.revision_id JOIN workspace_files f ON f.head_revision=r.id
      WHERE f.conversation_id=? AND r.deleted=0 AND (${score})>0 ORDER BY score DESC,r.path,p.ordinal LIMIT ?`, ...terms, cid, ...terms, limit);
    const results = rows.map(row => ({ path: row.path, revision: row.revision_id, sha256: row.sha256, mime: row.mime, text: row.text, score: row.score, citation: citation(cid, row, row) }));
    const indexing = this.#store.all("SELECT r.path,r.index_status AS status,r.index_error AS error FROM workspace_files f JOIN workspace_revisions r ON r.id=f.head_revision WHERE f.conversation_id=? AND r.deleted=0 AND r.index_status<>'indexed' ORDER BY r.path", cid);
    return { query, results, indexing };
  }
}
