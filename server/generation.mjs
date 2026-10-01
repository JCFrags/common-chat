import { id, now, fail, hash, object, text, settings as validateSettings } from './validation.mjs';
import { sseRecords, headers, errorText, responseError, limitedText, deltaText, usageStats, timingStats } from './provider.mjs';

export class Generations {
  constructor(store, emit, options = {}) {
    this.store = store; this.emit = emit; this.active = new Map(); this.closing = false;
    this.timeoutMs = options.timeoutMs ?? 15 * 60000;
    this.maxCharacters = options.maxCharacters ?? 2 * 1024 * 1024;
  }
  validateCapabilities(p, settings, rows, attachments) {
    for (const key of ['temperature', 'topP', 'maxTokens']) {
      if (settings[key] !== undefined && !p.capabilities[key]) fail(400, `The selected connection does not enable ${key}. Remove that setting or edit its capabilities.`);
    }
    if (settings.systemPrompt && !p.capabilities.systemPrompt) fail(400, 'The selected connection does not enable system prompts.');
    for (const row of rows) {
      const meta = JSON.parse(row.metadata);
      if (row.role === 'tool' || meta.source?.toolCalls || meta.unsupportedAttachments?.length) {
        fail(400, 'This imported branch contains tools or archived attachments that cannot be sent. Start a new chat with the supported context.');
      }
      if (row.role === 'system' && row.content && !p.capabilities.systemPrompt) fail(400, 'This branch contains a system message, but the connection does not support system prompts.');
    }
    if (attachments.some(a => a.kind === 'image') && !p.capabilities.vision) fail(400, 'This branch contains images. Select a connection with vision enabled.');
  }
  requestMessages(cid, parentId, user, settings) {
    const rows = this.store.path(cid, parentId), messages = [];
    if (settings.systemPrompt) messages.push({ role: 'system', content: settings.systemPrompt });
    let total = settings.systemPrompt?.length ?? 0;
    for (const row of [...rows, ...(user ? [user] : [])]) {
      const attachments = row.attachments ?? this.store.all('SELECT * FROM attachments WHERE message_id=? ORDER BY created_at,id', row.id);
      let content = row.content;
      const images = [];
      for (const a of attachments) {
        const bytes = this.store.readAttachment(a);
        if (a.kind === 'image') images.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${bytes.toString('base64')}` } });
        else content += `\n\nAttached file: ${a.name}\n\n${bytes.toString('utf8')}\n\nEnd of attached file.`;
      }
      if (!content && !images.length) continue;
      total += content.length;
      if (total > 2 * 1024 * 1024) fail(400, 'This branch exceeds the 2 MiB text context limit. Start a shorter conversation.');
      messages.push({ role: row.role, content: images.length ? [{ type: 'text', text: content }, ...images] : content });
    }
    return messages;
  }
  submit(cid, input) {
    if (this.closing) fail(503, 'The server is stopping.');
    object(input); text(input.requestId, 'requestId', 100);
    const fingerprint = hash(JSON.stringify(input));
    const old = this.store.get('SELECT * FROM requests WHERE id=?', input.requestId);
    if (old) {
      if (old.conversation_id !== cid || old.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different submission.');
      return JSON.parse(old.response);
    }
    const conversation = this.store.conversation(cid);
    this.store.assertVersion(conversation, input.expectedVersion);
    this.store.assertIdle(cid);
    if (this.active.size >= 8) fail(429, 'Eight generations are already active. Wait for one to finish.');
    const p = this.store.provider(text(input.providerId, 'providerId', 100));
    const model = text(input.model, 'model', 300);
    if (p.models.length && !p.models.includes(model)) fail(400, 'This model is not in the configured model list.');
    const settings = validateSettings(input.settings ?? JSON.parse(conversation.settings));
    const parentId = input.parentId ?? null;
    if (parentId !== null) text(parentId, 'parentId', 100);
    const path = this.store.path(cid, parentId);
    const regenerate = input.regenerate === true;
    let content = '', uploaded = [];
    if (regenerate) {
      if (!path.length || path.at(-1).role !== 'user') fail(400, 'Regeneration requires a user message as its parent.');
      if (input.content || input.attachments?.length) fail(400, 'Regeneration cannot add a user message or attachments.');
    } else {
      content = text(input.content ?? '', 'content', 1000000, true);
      const attachmentIds = input.attachments ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) fail(400, 'Use at most ten distinct attachments.');
      uploaded = attachmentIds.map(aid => {
        text(aid, 'attachment ID', 100);
        const a = this.store.get('SELECT * FROM attachments WHERE id=? AND conversation_id=?', aid, cid);
        if (!a) fail(400, 'An attachment does not belong to this conversation.');
        return a;
      });
      if (!content.trim() && !uploaded.length) fail(400, 'Enter a message or attach a file.');
    }
    const previousFiles = path.flatMap(m => this.store.all('SELECT * FROM attachments WHERE message_id=?', m.id));
    if ([...previousFiles, ...uploaded].reduce((sum, a) => sum + a.size, 0) > 30 * 1024 * 1024) fail(400, 'This branch exceeds the 30 MiB attachment context limit.');
    this.validateCapabilities(p, settings, path, [...previousFiles, ...uploaded]);
    const userId = regenerate ? parentId : id(), assistantId = id(), jobId = id();
    // Construct and validate the exact request before changing durable state.
    const messages = this.requestMessages(cid, parentId, regenerate ? null : { id: userId, role: 'user', content, attachments: uploaded }, settings);
    const payload = { model, messages, stream: p.capabilities.streaming };
    if (payload.stream) payload.stream_options = { include_usage: true };
    if (settings.temperature !== undefined) payload.temperature = settings.temperature;
    if (settings.topP !== undefined) payload.top_p = settings.topP;
    if (settings.maxTokens !== undefined) payload[p.capabilities.tokenParameter] = settings.maxTokens;
    const response = { jobId, messageId: assistantId, conversationId: cid };
    this.store.transaction(() => {
      if (!regenerate) {
        this.store.addMessage({ id: userId, conversationId: cid, parentId, role: 'user', content });
        for (const a of uploaded) {
          if (a.message_id) this.store.addAttachment(cid, { ...a, bytes: this.store.readAttachment(a) }, userId);
          else this.store.run('UPDATE attachments SET message_id=? WHERE id=?', userId, a.id);
        }
      }
      this.store.addMessage({ id: assistantId, conversationId: cid, parentId: userId, role: 'assistant', status: 'streaming',
        providerId: p.id, providerName: p.name, model, settings });
      this.store.run('INSERT INTO jobs(id,conversation_id,message_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)', jobId, cid, assistantId, 'running', now(), now());
      this.store.run('UPDATE conversations SET active_leaf=?,settings=?,title=CASE WHEN title=\'New chat\' AND ?!=\'\' THEN ? ELSE title END WHERE id=?',
        assistantId, JSON.stringify(settings), content.trim(), content.trim().slice(0, 80), cid);
      this.store.touch(cid);
      this.store.run('INSERT INTO requests(id,conversation_id,fingerprint,response) VALUES(?,?,?,?)', input.requestId, cid, fingerprint, JSON.stringify(response));
    });
    const state = { controller: new AbortController(), cid, assistantId, reason: null };
    this.active.set(jobId, state);
    state.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(jobId, state, p, payload));
    this.emit({ type: 'changed', conversationId: cid });
    return response;
  }
  async run(jobId, state, provider, payload) {
    const { cid, assistantId, controller } = state;
    let content = '', reasoning = '', finishReason = null, usage = null, timings = null, status = 'complete', failure = null;
    let dirty = false, lastFlush = 0, completed = false, firstTextMs = null, responseMode = null;
    // These observations include upstream queue and transport time, unlike model timings.
    const started = performance.now();
    const flush = (force = false) => {
      if (!force && (!dirty || now() - lastFlush < 100)) return;
      this.store.transaction(() => {
        this.store.run('UPDATE messages SET content=?,reasoning=?,updated_at=? WHERE id=?', content, reasoning, now(), assistantId);
        this.store.touch(cid);
      });
      lastFlush = now(); dirty = false;
      const row = this.store.get('SELECT * FROM messages WHERE id=?', assistantId);
      this.emit({ type: 'delta', conversationId: cid, version: this.store.conversation(cid).version, message: this.store.message(row) });
    };
    const timer = setInterval(() => { if (dirty) flush(); }, 100);
    const consume = json => {
      if (json.error) throw new Error('The model server reported an error. Check its logs.');
      const nextUsage = usageStats(json.usage), nextTimings = timingStats(json.timings);
      if (nextUsage) usage = { ...usage, ...nextUsage };
      if (nextTimings) timings = { ...timings, ...nextTimings };
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? choice.message ?? {};
      if (delta.tool_calls?.length || delta.function_call) throw new Error('The model returned tool calls. This version does not execute tools.');
      const textDelta = deltaText(delta.content), reasoningDelta = deltaText(delta.reasoning_content ?? delta.reasoning);
      if (responseMode === 'streaming' && firstTextMs === null && (textDelta || reasoningDelta)) firstTextMs = performance.now() - started;
      content += textDelta;
      reasoning += reasoningDelta;
      if (content.length + reasoning.length > this.maxCharacters) throw new Error('The generated output exceeds the 2 MiB limit.');
      if (choice.finish_reason) { finishReason = choice.finish_reason; completed = true; }
      dirty = true; flush();
    };
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
      signal.throwIfAborted();
      const response = await fetch(`${provider.base_url}/chat/completions`, { method: 'POST', headers: headers(provider),
        body: JSON.stringify(payload), redirect: 'error', signal });
      if (!response.ok) await responseError(response, provider);
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        responseMode = 'non-streaming';
        const json = JSON.parse(await limitedText(response, 8 * 1024 * 1024));
        if (!json.choices?.length) throw new Error('The model server returned no choices.');
        consume(json); completed = true;
      } else {
        responseMode = 'streaming';
        for await (const data of sseRecords(response.body)) {
          if (data.trim() === '[DONE]') { completed = true; break; }
          let parsed; try { parsed = JSON.parse(data); } catch { throw new Error('The model server returned malformed stream data.'); }
          consume(parsed);
        }
      }
      if (!completed) { status = 'interrupted'; failure = 'The connection ended without a completion marker. The partial response is saved.'; }
    } catch (error) {
      if (state.reason === 'cancelled') { status = 'cancelled'; failure = 'Generation stopped by the user.'; }
      else if (state.reason === 'shutdown') { status = 'interrupted'; failure = 'The chat server stopped. The partial response is saved.'; }
      else { status = 'error'; failure = errorText(error, provider.apiKey); }
    } finally {
      const observed = { durationMs: performance.now() - started, firstTextMs, responseMode };
      clearInterval(timer);
      // Every successful generation and every failure ends in a durable terminal state.
      this.store.transaction(() => {
        this.store.run('UPDATE messages SET content=?,reasoning=?,status=?,metadata=?,updated_at=? WHERE id=?',
          content, reasoning, status, JSON.stringify({ finishReason, usage, timings, observed, error: failure }), now(), assistantId);
        this.store.run('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?', status, failure, now(), jobId);
        this.store.touch(cid);
      });
      this.active.delete(jobId);
      this.emit({ type: 'changed', conversationId: cid });
    }
  }
  cancel(jobId) {
    const job = this.store.get('SELECT * FROM jobs WHERE id=?', jobId);
    if (!job) fail(404, 'Generation not found.');
    const state = this.active.get(jobId);
    if (state) { state.reason = 'cancelled'; state.controller.abort(); }
    return { status: state ? 'cancelling' : job.status };
  }
  async stop() {
    this.closing = true;
    const active = [...this.active.values()];
    for (const state of active) { state.reason = 'shutdown'; state.controller.abort(); }
    await Promise.allSettled(active.map(s => s.promise));
  }
}
