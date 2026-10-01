import { inflateRawSync } from 'node:zlib';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { id, now, fail, object, text, settings, attachmentData, decodeBase64 } from './validation.mjs';

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read ordinary ZIP exports without extracting untrusted paths to disk. */
export function zipEntries(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail(400, 'Invalid ZIP archive.');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count > 1000 || count === 65535 || start + size > end) fail(400, 'Split archives, ZIP64 archives, and large archives are not supported.');
  const result = []; let pos = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > start + size || bytes.readUInt32LE(pos) !== 0x02014b50) fail(400, 'Invalid ZIP directory.');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10), crc = bytes.readUInt32LE(pos + 16);
    const compressed = bytes.readUInt32LE(pos + 20), uncompressed = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28), extraLength = bytes.readUInt16LE(pos + 30), commentLength = bytes.readUInt16LE(pos + 32);
    const offset = bytes.readUInt32LE(pos + 42), next = pos + 46 + nameLength + extraLength + commentLength;
    if (next > start + size || flags & 1 || ![0, 8].includes(method)) fail(400, 'The ZIP archive is encrypted or uses an unsupported method.');
    const name = bytes.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'); pos = next;
    total += uncompressed;
    if (total > 32 * 1024 * 1024 || offset + 30 > start) fail(413, 'The expanded archive is too large or has an invalid entry.');
    if (bytes.readUInt32LE(offset) !== 0x04034b50) fail(400, 'Invalid ZIP entry header.');
    const localNameLength = bytes.readUInt16LE(offset + 26);
    const begin = offset + 30 + localNameLength + bytes.readUInt16LE(offset + 28);
    if (bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt16LE(offset + 6) !== flags ||
      !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(Buffer.from(name))) fail(400, 'Inconsistent ZIP entry headers.');
    if (begin + compressed > start || begin > start) fail(400, 'Invalid ZIP entry bounds.');
    const source = bytes.subarray(begin, begin + compressed);
    let data;
    try { data = method === 0 ? source : inflateRawSync(source, { maxOutputLength: Math.max(1, uncompressed) }); }
    catch { fail(400, 'The ZIP entry cannot be decompressed safely.'); }
    if (data.length !== uncompressed || crc32(data) !== crc) fail(400, 'The ZIP entry checksum is invalid.');
    result.push({ name, data });
  }
  return result;
}
export function parseText(input) {
  const value = input.replace(/^\uFEFF/, '').trim();
  if (!value) fail(400, 'The import file is empty.');
  let parsed;
  try { parsed = JSON.parse(value); } catch {}
  if (parsed?.format === 'common-chat') {
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) fail(400, 'Unsupported Common Chat export version.');
    return parsed.conversations.map(x => ({ conv: x.conversation, messages: x.messages, native: true }));
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.conv && Array.isArray(parsed.messages)) return [parsed];
  const sessions = []; let current;
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record; try { record = JSON.parse(line); } catch { fail(400, `Invalid JSON on line ${index + 1}.`); }
    const type = String(record.type ?? '').toLowerCase();
    if (type === 'session') {
      const { type: _t, harness: _h, ...conv } = record;
      current = { conv, messages: [] }; sessions.push(current);
    } else if (type === 'message' && current) current.messages.push(record.message);
    else fail(400, `Unsupported record or missing session header on line ${index + 1}. No records were imported.`);
  }
  if (!sessions.length) fail(400, 'Use a Common Chat export or a llama.cpp JSON, JSONL, or ZIP export.');
  return sessions;
}
function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(400, 'The import file must contain valid UTF-8 text.'); }
}
function parseInput(input) {
  object(input, 'import request');
  if (typeof input.text === 'string') return parseText(text(input.text, 'import text', 32 * 1024 * 1024));
  const bytes = decodeBase64(input.data, 24 * 1024 * 1024);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    const entries = zipEntries(bytes), sessions = [];
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      if (!/\.(json|jsonl)$/i.test(entry.name)) fail(400, `Unsupported ZIP entry: ${entry.name}. Import only conversation export files.`);
      sessions.push(...parseText(decodeUtf8(entry.data)));
    }
    return sessions;
  }
  return parseText(decodeUtf8(bytes));
}
function graph(messages, native) {
  const rows = new Map();
  for (const m of messages) {
    object(m, 'message'); text(m.id, 'message ID', 200);
    if (rows.has(m.id)) fail(400, 'Duplicate message ID in an imported conversation.');
    rows.set(m.id, m);
  }
  const complete = new Set();
  for (const key of rows.keys()) {
    const visiting = new Set(); let current = key;
    while (current && !complete.has(current)) {
      if (!rows.has(current)) fail(400, 'An imported branch has a missing parent. No records were imported.');
      if (visiting.has(current)) fail(400, 'An imported branch contains a cycle. No records were imported.');
      visiting.add(current);
      const m = rows.get(current); current = native ? m.parentId : m.parent;
      if (current !== null && current !== undefined && typeof current !== 'string') fail(400, 'Invalid imported parent ID.');
    }
    for (const item of visiting) complete.add(item);
  }
  return rows;
}
function importAttachments(m, native, warnings) {
  if (native) {
    if (!Array.isArray(m.attachments ?? [])) fail(400, 'Invalid attachment list.');
    return { files: (m.attachments ?? []).map(attachmentData), unsupported: m.metadata?.unsupportedAttachments ?? [] };
  }
  const files = [], unsupported = [];
  if (!Array.isArray(m.extra ?? [])) fail(400, 'Invalid imported attachment list.');
  for (const [i, a] of (m.extra ?? []).entries()) {
    object(a, 'legacy attachment');
    const name = typeof a.name === 'string' && a.name ? a.name : `attachment-${i + 1}`;
    if (typeof a.base64Url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(a.base64Url)) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(a.base64Url);
      files.push(attachmentData({ name, mime: match[1], data: match[2] }));
    } else if (typeof a.content === 'string' && !a.base64Data && !a.processedAsImages && !a.images?.length) {
      files.push(attachmentData({ name, mime: 'text/plain', data: Buffer.from(a.content).toString('base64') }));
    } else {
      unsupported.push(name);
      warnings.push(`Archived attachment "${name}" is retained in source metadata but cannot be sent to a model.`);
    }
  }
  return { files, unsupported };
}
export function importConversations(store, input) {
  const sessions = parseInput(input);
  if (!sessions.length || sessions.length > 1000) fail(400, 'Import between 1 and 1000 conversations.');
  const warnings = [], prepared = []; let count = 0;
  for (const session of sessions) {
    object(session, 'session'); const conv = object(session.conv, 'conversation');
    if (!Array.isArray(session.messages)) fail(400, 'A conversation must have a message array.');
    count += session.messages.length; if (count > 10000) fail(413, 'Import at most 10,000 messages at once.');
    const native = session.native === true, rows = graph(session.messages, native), cid = id();
    const mapping = new Map(session.messages.map(m => [m.id, id()]));
    const requestedLeaf = native ? conv.activeLeaf : conv.currNode;
    if (requestedLeaf != null && !rows.has(requestedLeaf)) fail(400, 'The imported active branch does not exist.');
    const nodes = session.messages.map(m => {
      const role = m.role || (m.type === 'root' ? 'system' : '');
      if (!['user', 'assistant', 'system', 'tool'].includes(role)) fail(400, 'Unsupported imported message role.');
      const content = text(m.content ?? '', 'message content', 2 * 1024 * 1024, true);
      const reasoning = text(m.reasoning ?? m.reasoningContent ?? m.thinking ?? '', 'reasoning', 2 * 1024 * 1024, true);
      const attachments = importAttachments(m, native, warnings);
      if (role === 'tool' || m.toolCalls) warnings.push('Imported tool records are preserved. This version does not continue branches with tool calls.');
      const timestamp = native ? m.createdAt : m.timestamp;
      const metadata = native ? object(m.metadata ?? {}, 'metadata') : { source: m };
      if (attachments.unsupported.length) metadata.unsupportedAttachments = attachments.unsupported;
      return { id: mapping.get(m.id), conversationId: cid, parentId: mapping.get(native ? m.parentId : m.parent) ?? null,
        role, content, reasoning, status: native && ['complete','cancelled','interrupted','error'].includes(m.status) ? m.status : 'complete',
        providerName: native ? m.providerName ?? null : null, model: typeof m.model === 'string' ? m.model : null,
        settings: native ? settings(m.settings ?? {}) : {}, metadata,
        createdAt: Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : now(), files: attachments.files };
    });
    const lastNode = nodes.toSorted((a, b) => a.createdAt - b.createdAt).at(-1)?.id ?? null;
    const title = text(conv.title ?? conv.name ?? 'Imported chat', 'conversation title', 500, true) || 'Imported chat';
    prepared.push({ cid, title, nodes, leaf: mapping.get(requestedLeaf) ?? lastNode, settings: native ? settings(conv.settings ?? {}) : {},
      source: native ? conv.source ?? {} : conv,
      createdAt: native && Number.isSafeInteger(conv.createdAt) ? conv.createdAt : Math.min(now(), ...nodes.map(n => n.createdAt)) });
  }
  const createdFiles = [];
  try {
    store.transaction(() => {
      for (const c of prepared) {
        store.run('INSERT INTO conversations(id,title,created_at,updated_at,active_leaf,settings,source) VALUES(?,?,?,?,?,?,?)',
          c.cid, c.title, c.createdAt, now(), c.leaf, JSON.stringify(c.settings), JSON.stringify(c.source));
        for (const m of c.nodes) {
          store.addMessage(m);
          for (const f of m.files) createdFiles.push(store.addAttachment(c.cid, f, m.id).id);
        }
      }
    });
  } catch (e) {
    for (const aid of createdFiles) { try { unlinkSync(join(store.files, aid)); } catch {} }
    throw e;
  }
  return { conversationIds: prepared.map(c => c.cid), conversations: prepared.length, messages: count, warnings: [...new Set(warnings)] };
}
export function exportConversations(store, cid = null) {
  const rows = cid ? [store.conversation(cid)] : store.all('SELECT * FROM conversations ORDER BY created_at');
  let total = 0;
  const conversations = rows.map(c => {
    const messages = store.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id', c.id).map(row => {
      const m = store.message(row);
      // Native export retains the original upstream record, including unsupported fields.
      m.metadata = JSON.parse(row.metadata);
      total += Buffer.byteLength(row.content) + Buffer.byteLength(row.reasoning) + Buffer.byteLength(row.metadata);
      m.attachments = m.attachments.map(a => {
        total += Math.ceil(a.size * 4 / 3);
        if (total > 48 * 1024 * 1024) fail(413, 'This export exceeds 48 MiB. Export individual conversations or use an offline backup.');
        return { ...a, data: store.readAttachment(a).toString('base64') };
      });
      if (total > 48 * 1024 * 1024) fail(413, 'This export exceeds 48 MiB. Use an offline backup.');
      return m;
    });
    return { conversation: { id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at,
      activeLeaf: c.active_leaf, settings: JSON.parse(c.settings), source: JSON.parse(c.source) }, messages };
  });
  const result = { format: 'common-chat', version: 1, exportedAt: new Date().toISOString(), conversations };
  if (Buffer.byteLength(JSON.stringify(result)) > 24 * 1024 * 1024) fail(413, 'This export exceeds the 24 MiB import limit. Export individual conversations or use an offline backup.');
  return result;
}
