import { id, now, fail, hash, object, text, settings as validateSettings } from './validation.mjs';
import { sseRecords, headers, errorText, responseError, limitedText, deltaText, usageStats, timingStats, promptProgressStats, thinkingPayload, samplingPayload } from './provider.mjs';
import { toolPermissions, toolTranscript, ToolCallAccumulator, TOOL_LIMITS } from './tools.mjs';
import { modelDiscoveryMode, getThinkingCapabilities } from './model-catalog.mjs';

export class Generations {
  constructor(store, emit, options = {}) {
    this.store = store; this.emit = emit; this.active = new Map(); this.closing = false;
    this.timeoutMs = options.timeoutMs ?? 15 * 60000;
    this.maxCharacters = options.maxCharacters ?? 2 * 1024 * 1024;
    this.tools = options.tools; this.media = options.media; this.resolveThinking = options.resolveThinking;
    this.shutdown = new AbortController(); this.preparing = new Set();
    // Store already interrupts orphan jobs. Finish their display state without replaying calls.
    this.store.transaction(() => {
      for (const row of this.store.all("SELECT m.id,m.conversation_id,m.metadata FROM messages m JOIN jobs j ON j.message_id=m.id WHERE m.status='interrupted' AND j.status='interrupted'")) {
        const metadata = JSON.parse(row.metadata);
        if (!Array.isArray(metadata.toolActivity) || !metadata.toolActivity.some(item => ['pending', 'running'].includes(item?.status))) continue;
        for (const item of metadata.toolActivity) if (['pending', 'running'].includes(item?.status)) {
          item.status = 'interrupted'; item.summary = 'The server stopped before a completed result was saved. Inspect current state before retrying.';
        }
        this.store.run('UPDATE messages SET metadata=? WHERE id=?', JSON.stringify(metadata), row.id);
        this.store.touch(row.conversation_id);
      }
    });
  }
  validateCapabilities(p, settings, rows, attachments, model, deferThinking = false) {
    samplingPayload(p, settings);
    if (settings.thinking_budget_tokens >= 0 && p.capabilities.llamaCppThinkingBudget !== true) fail(400, 'The selected connection does not enable llamaCppThinkingBudget.');
    if (!deferThinking) thinkingPayload(p, settings, model);
    if (settings.systemPrompt && !p.capabilities.systemPrompt) fail(400, 'The selected connection does not enable system prompts.');
    for (const row of rows) {
      const meta = JSON.parse(row.metadata);
      if (row.role === 'tool' || meta.source?.toolCalls || meta.archivedToolContext || meta.unsupportedAttachments?.length ||
        (meta.toolTranscript && !this.store.get('SELECT id FROM jobs WHERE message_id=? AND conversation_id=?', row.id, row.conversation_id))) {
        fail(400, 'This imported branch contains tools or archived attachments that cannot be sent. Start a new chat with the supported context.');
      }
      if (meta.toolTranscript?.length && p.capabilities.tools !== true) fail(400, 'This branch contains saved tool results. Select a connection with tools enabled.');
      if (row.role === 'system' && row.content && !p.capabilities.systemPrompt) fail(400, 'This branch contains a system message, but the connection does not support system prompts.');
    }
    if (attachments.some(a => a.kind === 'image') && !p.capabilities.vision) fail(400, 'This branch contains images. Select a connection with vision enabled.');
  }
  requestMessages(cid, parentId, user, settings, provider) {
    const rows = this.store.path(cid, parentId), messages = [];
    if (settings.systemPrompt) messages.push({ role: 'system', content: settings.systemPrompt });
    let total = settings.systemPrompt?.length ?? 0;
    for (const row of [...rows, ...(user ? [user] : [])]) {
      const attachments = row.attachments ?? this.store.all('SELECT * FROM attachments WHERE message_id=? ORDER BY created_at,id', row.id);
      let content = row.content;
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      if (meta.toolTranscript?.length) {
        // Only this server's jobs establish provenance. Imports get new message IDs and no jobs.
        if (row.role !== 'assistant' || !this.store.get('SELECT id FROM jobs WHERE message_id=? AND conversation_id=?', row.id, cid)) fail(400, 'Archived tool transcripts cannot be used as live tool context.');
        const transcript = toolTranscript(meta.toolTranscript);
        const prefix = transcript.filter(m => m.role === 'assistant').map(m => m.content ?? '').join('');
        if (!content.startsWith(prefix)) fail(400, 'The saved tool transcript does not match the message.');
        content = content.slice(prefix.length);
        total += JSON.stringify(transcript).length; messages.push(...transcript);
      }
      const parts = [];
      for (const a of attachments) {
        const bytes = this.store.readAttachment(a);
        if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${bytes.toString('base64')}` } });
        else if (a.kind === 'text') {
          let decoded;
          try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, 'A text attachment is not valid UTF-8.'); }
          if (decoded.includes('\0')) fail(400, 'Text attachments cannot contain NUL bytes.');
          content += `\n\nAttached file: ${a.name}\n\n${decoded}\n\nEnd of attached file.`;
        } else if (['audio', 'video'].includes(a.kind) && this.media?.contentPart) {
          const part = this.media.contentPart(a, bytes, provider);
          if (!part || typeof part !== 'object' || Array.isArray(part) || part.then) fail(400, 'The media adapter returned an invalid content part.');
          parts.push(part);
        } else fail(400, 'This branch contains unsupported binary attachments. They cannot be decoded as text.');
      }
      total += content.length;
      if (total > 2 * 1024 * 1024) fail(400, 'This branch exceeds the 2 MiB text context limit. Start a shorter conversation.');
      if (content || parts.length) messages.push({ role: row.role, content: parts.length ? [{ type: 'text', text: content }, ...parts] : content });
    }
    return messages;
  }
  submit(cid, input) {
    if (this.closing) fail(503, 'The server is stopping.');
    object(input); text(input.requestId, 'requestId', 100);
    const serialized = JSON.stringify(input), fingerprint = hash(serialized);
    // Freeze the submitted values across asynchronous capability/media checks.
    input = JSON.parse(serialized);
    const permissions = toolPermissions(input.tools);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const validationSignal = AbortSignal.any([this.shutdown.signal, deadline]);
    const old = this.store.get('SELECT * FROM requests WHERE id=?', input.requestId);
    if (old) {
      if (old.conversation_id !== cid || old.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different submission.');
      return JSON.parse(old.response);
    }
    const conversation = this.store.conversation(cid);
    this.store.assertVersion(conversation, input.expectedVersion);
    this.store.assertIdle(cid); this.tools?.assertIdle(cid);
    if (this.active.size >= 8) fail(429, 'Eight generations are already active. Wait for one to finish.');
    const p = this.store.provider(text(input.providerId, 'providerId', 100));
    const model = text(input.model, 'model', 300);
    if (modelDiscoveryMode(p) === 'manual' && p.models.length && !p.models.includes(model)) fail(400, 'This model is not in the configured model list.');
    const settings = validateSettings(input.settings ?? JSON.parse(conversation.settings));
    const parentId = input.parentId ?? null;
    if (parentId !== null) text(parentId, 'parentId', 100);
    const path = this.store.path(cid, parentId);
    const regenerate = input.regenerate === true, continuing = input.continue === true;
    if (input.continue !== undefined && typeof input.continue !== 'boolean') fail(400, 'continue must be a boolean.');
    if (regenerate && continuing) fail(400, 'Choose regeneration or continuation, not both.');
    let content = '', uploaded = [];
    if (regenerate || continuing) {
      if (regenerate && (!path.length || path.at(-1).role !== 'user')) fail(400, 'Regeneration requires a user message as its parent.');
      if (continuing && (!path.length || path.at(-1).role !== 'assistant' || path.at(-1).status !== 'complete')) fail(400, 'Continuation requires a complete assistant message as its parent.');
      if (text(input.content ?? '', 'content', 1000000, true).length ||
        input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length)) fail(400, 'Regeneration and continuation cannot add a user message or attachments.');
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
    const attachments = [...previousFiles, ...uploaded];
    const needsThinkingResolution = () => (settings.thinking !== undefined || settings.thinking_budget_tokens >= 0) && typeof this.resolveThinking === 'function' && getThinkingCapabilities(p, model).protocol === 'unknown';
    this.validateCapabilities(p, settings, path, attachments, model, needsThinkingResolution());
    const wantsTools = Object.values(permissions).some(Boolean);
    if (wantsTools && p.capabilities.tools !== true) fail(400, 'The selected connection does not enable tools.');
    if (wantsTools && !this.tools) fail(503, 'Model tools are not configured.');
    if (attachments.some(a => ['audio', 'video'].includes(a.kind)) && !this.media?.validateBranch) fail(400, 'Media input is not configured.');
    const commit = definitions => {
    // Every await before this boundary must recheck idempotency, version, and all busy state.
    const existing = this.store.get('SELECT * FROM requests WHERE id=?', input.requestId);
    if (existing) {
      if (existing.conversation_id !== cid || existing.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different submission.');
      return JSON.parse(existing.response);
    }
    if (this.closing) fail(503, 'The server is stopping.');
    validationSignal.throwIfAborted();
    this.store.assertVersion(this.store.conversation(cid), input.expectedVersion);
    this.store.assertIdle(cid); this.tools?.assertIdle(cid);
    if (this.active.size >= 8) fail(429, 'Eight generations are already active. Wait for one to finish.');
    const latestProvider = this.store.provider(p.id);
    if (latestProvider.base_url !== p.base_url || latestProvider.api_key !== p.api_key || latestProvider.name !== p.name ||
      JSON.stringify(latestProvider.capabilities) !== JSON.stringify(p.capabilities) || JSON.stringify(latestProvider.models) !== JSON.stringify(p.models) ||
      JSON.stringify(latestProvider.modelConfig) !== JSON.stringify(p.modelConfig)) fail(409, 'The connection changed during validation. Review its settings and try again.');
    for (const attachment of attachments) {
      if (!this.store.get('SELECT id FROM attachments WHERE id=? AND conversation_id=?', attachment.id, cid)) fail(409, 'An attachment changed during validation. Review the conversation and try again.');
    }
    const userId = regenerate || continuing ? parentId : id(), assistantId = id(), jobId = id();
    // Construct and validate the exact request before changing durable state.
    const messages = this.requestMessages(cid, parentId, regenerate || continuing ? null : { id: userId, role: 'user', content, attachments: uploaded }, settings, p);
    if (p.capabilities.systemPrompt) {
      const guide = 'Common Chat rendering: For a runnable webpage or browser artifact, use a fenced html preview block with a complete HTML document, or javascript run/css preview for browser snippets. Mermaid diagrams render by default. For explanatory code that should be read rather than run, add example after the fence language, including html example or mermaid example. Prefer self-contained artifacts. Use JavaScript, CSS and Mermaid fences for separate parts of the same artifact. Do not mark shell, Python, Node.js or other non-browser code as browser-run artifacts.';
      if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') messages[0].content += `\n\n${guide}`;
      else messages.unshift({ role: 'system', content: guide });
    }
    const payload = { model, messages, stream: p.capabilities.streaming, ...samplingPayload(p, settings), ...thinkingPayload(p, settings, model) };
    if (definitions.length) payload.tools = definitions;
    if (payload.stream) {
      payload.stream_options = { include_usage: true };
      // These extensions are llama.cpp-specific. Never send them to an arbitrary provider.
      if (p.capabilities.llamaCppTimings) {
        payload.timings_per_token = true;
        payload.return_progress = true;
      }
    }
    const response = { jobId, messageId: assistantId, conversationId: cid };
    this.store.attachmentTransaction(copyAttachment => {
      if (!regenerate && !continuing) {
        this.store.addMessage({ id: userId, conversationId: cid, parentId, role: 'user', content });
        for (const a of uploaded) {
          if (a.message_id) copyAttachment(cid, { ...a, bytes: this.store.readAttachment(a) }, userId);
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
    const state = { controller: new AbortController(), cid, assistantId, reason: null, permissions, deadline,
      budgets: { callLimit: settings.toolCalls ?? null, roundLimit: settings.toolRounds ?? null } };
    this.active.set(jobId, state);
    state.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.run(jobId, state, p, payload));
    this.emit({ type: 'changed', conversationId: cid });
    return response;
    };
    // Keep the no-hook path synchronous for embedded callers. App routes must always await submit.
    if (!wantsTools && !this.media?.validateBranch && !needsThinkingResolution()) return commit([]);
    const prepare = async () => {
      if (this.media?.validateBranch) await this.media.validateBranch(p, attachments, { signal: validationSignal });
      const definitions = wantsTools ? await this.tools.prepare(permissions, { signal: validationSignal }) : [];
      validationSignal.throwIfAborted();
      // The hook refreshes server-owned metadata. Its return value cannot bypass payload validation.
      if (needsThinkingResolution()) await this.resolveThinking(p, model, { signal: validationSignal });
      validationSignal.throwIfAborted();
      return commit(definitions);
    };
    const pending = prepare(); this.preparing.add(pending);
    return pending.finally(() => this.preparing.delete(pending));
  }
  async run(jobId, state, provider, payload) {
    const { cid, assistantId, controller, permissions } = state;
    let content = '', reasoning = '', finishReason = null, usage = null, timings = null, promptProgress = null, status = 'complete', failure = null;
    let dirty = false, lastFlush = 0, firstTextMs = null, responseMode = null, totalArguments = 0;
    const transcript = [], activity = [], usedIds = new Set();
    const budgets = state.budgets ?? { callLimit: null, roundLimit: null };
    let executedCalls = 0, executedRounds = 0, budgetStop = null, finalOnly = false;
    const requestFinal = reason => {
      budgetStop = reason; finalOnly = true;
      delete payload.tools;
      payload.messages.push({ role: 'user', content: `${reason} No further tools are available for this turn. Use only the saved tool results to give a final answer. Include actual saved file links and unfinished work. Do not claim that blocked calls ran, replay actions, or invent files.` });
    };
    // These observations include upstream queue and transport time, unlike model timings.
    const started = performance.now();
    const metadata = () => ({ finishReason, usage, timings, promptProgress,
      observed: { durationMs: performance.now() - started, firstTextMs, responseMode }, error: failure,
      ...(Object.values(permissions).some(Boolean) ? { toolPermissions: permissions, toolActivity: activity, toolTranscript: transcript,
        toolBudget: { callLimit: budgets.callLimit, roundLimit: budgets.roundLimit, executedCalls, executedRounds, stopReason: budgetStop } } : {}) });
    const flush = (force = false) => {
      if (!force && (!dirty || now() - lastFlush < 100)) return;
      this.store.transaction(() => {
        this.store.run('UPDATE messages SET content=?,reasoning=?,metadata=?,updated_at=? WHERE id=?', content, reasoning, JSON.stringify(metadata()), now(), assistantId);
        this.store.touch(cid);
      });
      lastFlush = now(); dirty = false;
      const row = this.store.get('SELECT * FROM messages WHERE id=?', assistantId);
      this.emit({ type: 'delta', conversationId: cid, version: this.store.conversation(cid).version, message: this.store.message(row) });
    };
    const timer = setInterval(() => {
      // Keep elapsed time live during quiet processing, including runner jobs.
      if (now() - lastFlush >= 1000) dirty = true;
      if (dirty) flush();
    }, 100);
    try {
      const signal = AbortSignal.any([controller.signal, state.deadline]);
      for (;;) {
        signal.throwIfAborted();
        let completed = false, roundFinish = null, roundContent = '';
        const calls = new ToolCallAccumulator();
        const consume = json => {
          if (!json || typeof json !== 'object' || json.error) throw new Error('The model server reported an error. Check its logs.');
          const nextUsage = usageStats(json.usage), nextTimings = timingStats(json.timings), nextProgress = promptProgressStats(json.prompt_progress);
          if (nextUsage) {
            const merged = { ...usage, ...nextUsage };
            for (const key of ['prompt_tokens_details', 'completion_tokens_details']) {
              if (nextUsage[key]) merged[key] = { ...usage?.[key], ...nextUsage[key] };
            }
            usage = merged;
          }
          if (nextTimings) timings = { ...timings, ...nextTimings };
          if (nextProgress) promptProgress = nextProgress;
          if (nextUsage || nextTimings || nextProgress) dirty = true;
          const choice = json.choices?.[0];
          if (!choice) { flush(); return; }
          if (choice.index !== undefined && choice.index !== 0) throw new Error('The model returned an unexpected choice index.');
          const delta = choice.delta ?? choice.message ?? {};
          if (delta.function_call) throw new Error('Legacy function_call responses are not supported. Use completed tool_calls.');
          if (delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length)) {
            if (finalOnly) throw new Error('The model requested tools during the final-answer request. No further calls were executed.');
            if (provider.capabilities.tools !== true || !payload.tools?.length || !this.tools) throw new Error('The model returned tool calls without permission for this request.');
            if (roundFinish) throw new Error('The model sent tool fragments after completing the response.');
            calls.add(delta.tool_calls, responseMode === 'streaming');
          }
          const textDelta = deltaText(delta.content), reasoningDelta = deltaText(delta.reasoning_content ?? delta.reasoning);
          if (responseMode === 'streaming' && firstTextMs === null && (textDelta || reasoningDelta)) firstTextMs = performance.now() - started;
          content += textDelta; roundContent += textDelta; reasoning += reasoningDelta;
          if (content.length + reasoning.length > this.maxCharacters) throw new Error('The generated output exceeds the 2 MiB limit.');
          if (choice.finish_reason) {
            if (typeof choice.finish_reason !== 'string' || choice.finish_reason.length > 100 || roundFinish && roundFinish !== choice.finish_reason) throw new Error('The model returned an invalid completion reason.');
            finishReason = roundFinish = choice.finish_reason; completed = true;
          }
          dirty = true; flush();
        };
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
        signal.throwIfAborted();
        if (!completed) { status = 'interrupted'; failure = 'The connection ended without a completion marker. The partial response is saved.'; break; }
        if (!calls.calls.size && roundFinish !== 'tool_calls') break;
        const completedCalls = calls.finish(roundFinish, usedIds);
        if (finalOnly) throw new Error('The model requested tools during the final-answer request. No further calls were executed.');
        totalArguments += calls.argumentBytes;
        if (totalArguments > TOOL_LIMITS.totalArgumentBytes) throw new Error('The model reached the total tool argument limit.');
        const remaining = budgets.roundLimit !== null && executedRounds >= budgets.roundLimit ? 0
          : budgets.callLimit === null ? completedCalls.length : Math.max(0, budgets.callLimit - executedCalls);
        const allowedCount = Math.min(completedCalls.length, remaining);
        const blockedReason = allowedCount < completedCalls.length ? 'The optional tool work budget was reached. This call was not executed.' : null;
        // Validate the whole batch before any side effect. Budget-blocked calls never dispatch.
        const validated = completedCalls.map(call => this.tools.validate(call, permissions)).slice(0, allowedCount);
        const assistant = { role: 'assistant', content: roundContent || null, tool_calls: completedCalls };
        const results = completedCalls.map(call => ({ role: 'tool', tool_call_id: call.id,
          content: JSON.stringify({ error: 'This call did not finish, or its result was not saved. Inspect current state before retrying.' }) }));
        // Reserve the maximum result size before executing so persistence cannot overflow later.
        for (let index = allowedCount; index < results.length; index++) results[index].content = JSON.stringify({ status: 'blocked', error: blockedReason });
        if (Buffer.byteLength(JSON.stringify([...transcript, assistant, ...results])) + allowedCount * (2 * TOOL_LIMITS.resultBytes + 256) > TOOL_LIMITS.transcriptBytes) throw new Error('The tool transcript reached its context limit.');
        transcript.push(assistant, ...results);
        const offset = activity.length;
        for (const [index, call] of completedCalls.entries()) {
          usedIds.add(call.id); activity.push({ id: call.id, name: call.function.name,
            status: index < allowedCount ? 'pending' : 'blocked', summary: index < allowedCount ? 'Waiting for execution.' : blockedReason, files: [] });
        }
        // Pending result placeholders keep crash recovery protocol-valid without replaying anything.
        flush(true);
        for (const [index, validatedCall] of validated.entries()) {
          signal.throwIfAborted();
          const item = activity[offset + index]; item.status = 'running'; item.summary = 'Tool is running.';
          if (index === 0) executedRounds++;
          executedCalls++; flush(true);
          try {
            const result = await this.tools.run({ cid, jobId, permissions, signal }, validatedCall);
            results[index].content = result.content; Object.assign(item, result.activity);
          } catch (error) {
            signal.throwIfAborted();
            const message = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
              ? errorText(error, provider.apiKey) : 'The tool failed. Check the workspace or isolated runner status before retrying.';
            results[index].content = JSON.stringify({ error: message });
            Object.assign(item, { status: 'error', summary: message, files: [] });
          }
          flush(true);
        }
        signal.throwIfAborted();
        payload.messages.push(assistant, ...results);
        if (blockedReason || budgets.callLimit !== null && executedCalls >= budgets.callLimit || budgets.roundLimit !== null && executedRounds >= budgets.roundLimit) {
          requestFinal('The optional tool work budget was reached. Completed work and files are preserved.'); flush(true);
        }
      }
    } catch (error) {
      if (state.reason === 'cancelled') { status = 'cancelled'; failure = 'Generation stopped by the user.'; }
      else if (state.reason === 'shutdown') { status = 'interrupted'; failure = 'The chat server stopped. The partial response is saved.'; }
      else { status = 'error'; failure = errorText(error, provider.apiKey); }
    } finally {
      clearInterval(timer);
      for (const item of activity) if (['pending', 'running'].includes(item.status)) {
        item.status = status === 'cancelled' ? 'cancelled' : 'interrupted';
        item.summary = 'No completed result was saved. Inspect current state before retrying.';
      }
      const finalMetadata = metadata();
      // Every successful generation and every failure ends in a durable terminal state.
      this.store.transaction(() => {
        this.store.run('UPDATE messages SET content=?,reasoning=?,status=?,metadata=?,updated_at=? WHERE id=?',
          content, reasoning, status, JSON.stringify(finalMetadata), now(), assistantId);
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
    this.closing = true; this.shutdown.abort();
    const active = [...this.active.values()];
    for (const state of active) { state.reason = 'shutdown'; state.controller.abort(); }
    await Promise.allSettled([...this.preparing, ...active.map(s => s.promise)]);
  }
}
