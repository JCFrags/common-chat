import { id, now, fail, object, text } from './validation.mjs';
import { archivedToolWarning } from './store.mjs';

function fields(input, allowed) {
  object(input);
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(400, `Unknown conversation action field: ${key}.`);
}
function guard(store, executions, cid, expectedVersion) {
  const conversation = store.conversation(cid);
  store.assertVersion(conversation, expectedVersion);
  store.assertIdle(cid); executions?.assertIdle(cid);
  return conversation;
}
function message(store, cid, messageId) {
  text(messageId, 'messageId', 100);
  const row = store.get('SELECT * FROM messages WHERE id=? AND conversation_id=?', messageId, cid);
  if (!row) fail(404, 'Message not found in this conversation.');
  return row;
}
function messageText(content, reasoning) {
  text(content, 'content', 2 * 1024 * 1024, true);
  text(reasoning, 'reasoning', 2 * 1024 * 1024, true);
  if (content.length + reasoning.length > 2 * 1024 * 1024) fail(400, 'Message text and reasoning exceed the 2 MiB limit.');
}
function attachments(store, cid, ids = []) {
  if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) fail(400, 'Use at most ten distinct attachments.');
  const files = ids.map(aid => {
    text(aid, 'attachment ID', 100);
    const row = store.get('SELECT * FROM attachments WHERE id=? AND conversation_id=?', aid, cid);
    if (!row) fail(400, 'An attachment does not belong to this conversation.');
    return row;
  });
  if (files.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) fail(400, 'Message attachments exceed the 30 MiB limit.');
  return files;
}
function archiveToolContext(row, reason) {
  const metadata = JSON.parse(row.metadata);
  if (metadata.toolTranscript !== undefined || metadata.toolPermissions !== undefined) {
    metadata.archivedToolContext = {
      ...(metadata.archivedToolContext ? { previous: metadata.archivedToolContext } : {}),
      transcript: metadata.toolTranscript ?? null, permissions: metadata.toolPermissions ?? null,
      originalContent: row.content, originalReasoning: row.reasoning, reason
    };
    delete metadata.toolTranscript; delete metadata.toolPermissions;
  }
  if (metadata.archivedToolContext || row.role === 'tool' || metadata.source?.toolCalls) metadata.contextWarning = archivedToolWarning;
  return metadata;
}

/** These actions never accept jobs, provider provenance, tool grants, or client metadata. */
export function createMessage(store, executions, cid, input) {
  fields(input, ['expectedVersion', 'parentId', 'role', 'content', 'reasoning', 'attachments']);
  guard(store, executions, cid, input.expectedVersion);
  const parentId = input.parentId ?? null;
  if (parentId !== null) { text(parentId, 'parentId', 100); store.path(cid, parentId); }
  if (!['system', 'user', 'assistant'].includes(input.role)) fail(400, 'Manual message role must be system, user, or assistant.');
  const content = input.content ?? '', reasoning = input.reasoning ?? '';
  messageText(content, reasoning);
  const files = attachments(store, cid, input.attachments), messageId = id();
  // Empty system nodes are valid roots in the upstream UI.
  if (input.role !== 'system' && !content.trim() && !reasoning.trim() && !files.length) fail(400, 'Enter message content, reasoning, or an attachment.');
  store.attachmentTransaction(copyAttachment => {
    guard(store, executions, cid, input.expectedVersion);
    store.addMessage({ id: messageId, conversationId: cid, parentId, role: input.role, content, reasoning });
    for (const file of files) {
      if (file.message_id) copyAttachment(cid, { ...file, bytes: store.readAttachment(file) }, messageId);
      else store.run('UPDATE attachments SET message_id=? WHERE id=?', messageId, file.id);
    }
    store.run('UPDATE conversations SET active_leaf=? WHERE id=?', messageId, cid); store.touch(cid);
  });
  return store.snapshot(cid);
}

export function editMessage(store, executions, cid, messageId, input) {
  fields(input, ['expectedVersion', 'content', 'reasoning']);
  guard(store, executions, cid, input.expectedVersion);
  const row = message(store, cid, messageId);
  if (!Object.hasOwn(input, 'content') && !Object.hasOwn(input, 'reasoning')) fail(400, 'Supply content or reasoning to edit.');
  const content = input.content === undefined ? row.content : input.content;
  const reasoning = input.reasoning === undefined ? row.reasoning : input.reasoning;
  messageText(content, reasoning);
  if (content !== row.content || reasoning !== row.reasoning) {
    const metadata = { ...archiveToolContext(row, 'edited'), editedAt: now() };
    store.transaction(() => {
      guard(store, executions, cid, input.expectedVersion);
      store.run('UPDATE messages SET content=?,reasoning=?,metadata=?,updated_at=? WHERE id=? AND conversation_id=?',
        content, reasoning, JSON.stringify(metadata), now(), messageId, cid);
      store.touch(cid);
    });
  }
  return store.snapshot(cid);
}

export function deleteMessage(store, executions, cid, messageId, input) {
  fields(input, ['expectedVersion']);
  const conversation = guard(store, executions, cid, input.expectedVersion), row = message(store, cid, messageId);
  const rows = store.all('SELECT id,parent_id FROM messages WHERE conversation_id=?', cid), children = new Map();
  for (const node of rows) {
    if (!children.has(node.parent_id)) children.set(node.parent_id, []);
    children.get(node.parent_id).push(node.id);
  }
  const removed = new Set(), pending = [messageId];
  for (let i = 0; i < pending.length; i++) {
    const current = pending[i];
    if (removed.has(current)) continue;
    removed.add(current); pending.push(...(children.get(current) ?? []));
  }
  const files = store.all('SELECT id,message_id FROM attachments WHERE conversation_id=?', cid).filter(file => removed.has(file.message_id));
  const leaf = removed.has(conversation.active_leaf) ? row.parent_id : conversation.active_leaf;
  if (leaf !== null) store.path(cid, leaf);
  store.transaction(() => {
    guard(store, executions, cid, input.expectedVersion);
    for (const mid of removed) store.run('DELETE FROM messages WHERE id=? AND conversation_id=?', mid, cid);
    store.run('UPDATE conversations SET active_leaf=? WHERE id=?', leaf, cid); store.touch(cid);
  });
  // Jobs and attachment rows cascade. Retain request receipts to prevent submission replay.
  store.removeAttachmentFiles(files.map(file => file.id));
  return store.snapshot(cid);
}

export function forkConversation(store, executions, cid, input) {
  fields(input, ['expectedVersion', 'messageId', 'title']);
  const conversation = guard(store, executions, cid, input.expectedVersion);
  text(input.messageId, 'messageId', 100);
  const path = store.path(cid, input.messageId);
  if (path.length > 10000) fail(400, 'Fork at most 10,000 messages.');
  const title = text(input.title ?? conversation.title, 'title', 500);
  const mapping = new Map(path.map(row => [row.id, id()]));
  const files = new Map(path.map(row => [row.id, store.all('SELECT * FROM attachments WHERE message_id=? ORDER BY created_at,id', row.id)]));
  const total = [...files.values()].flat().reduce((sum, file) => sum + file.size, 0);
  if (total > 30 * 1024 * 1024) fail(400, 'Fork attachments exceed the 30 MiB limit. Select a shorter path.');
  let forkId;
  store.attachmentTransaction(copyAttachment => {
    guard(store, executions, cid, input.expectedVersion);
    const source = store.sourceWithUi(JSON.parse(conversation.source), { forkedFromConversationId: cid });
    source.commonChatFork = { ...(source.commonChatFork ? { previous: source.commonChatFork } : {}),
      conversationId: cid, messageId: input.messageId, files: 'attachments-only' };
    forkId = store.createConversation(title, JSON.parse(conversation.settings), source);
    for (const row of path) {
      const mid = mapping.get(row.id), metadata = archiveToolContext(row, 'forked');
      metadata.forkedFrom = { ...(metadata.forkedFrom ? { previous: metadata.forkedFrom } : {}), conversationId: cid, messageId: row.id };
      store.addMessage({ id: mid, conversationId: forkId, parentId: mapping.get(row.parent_id) ?? null, role: row.role,
        content: row.content, reasoning: row.reasoning, status: row.status, providerId: row.provider_id,
        providerName: row.provider_name, model: row.model, settings: JSON.parse(row.settings), metadata,
        createdAt: row.created_at, updatedAt: row.updated_at });
      for (const file of files.get(row.id)) copyAttachment(forkId, { ...file, bytes: store.readAttachment(file) }, mid);
    }
    // No jobs, requests, executions, package grants, or workspace state are copied.
    store.run('UPDATE conversations SET active_leaf=? WHERE id=?', mapping.get(input.messageId), forkId);
  });
  return store.snapshot(forkId);
}
