import { fail, hash, id, now, object, text } from './validation.mjs';

const MiB = 1024 * 1024;
export const EXECUTION_LIMITS = Object.freeze({
  codeBytes: 64 * 1024, outputBytes: 2 * MiB, snapshotBytes: 20 * MiB,
  fileBytes: 10 * MiB, outputFiles: 32, inputFiles: 128, transferBytes: 32 * MiB,
  packages: 32, executionMs: 60000, installMs: 300000, packageExecutionMs: 380000, capabilityMs: 15000, active: 8
});
const statuses = new Set(['complete', 'error', 'cancelled', 'timed_out', 'interrupted']);
function fields(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, `Unknown ${label} field.`);
}
export function executionCode(value) {
  text(value, 'code', EXECUTION_LIMITS.codeBytes);
  if (!value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > EXECUTION_LIMITS.codeBytes) fail(400, 'Code must be valid UTF-8 and at most 64 KiB.');
  return value;
}
export function packageSpecs(value) {
  fields(value, ['pip', 'npm'], 'package specifications');
  const result = { pip: [], npm: [] };
  for (const type of ['pip', 'npm']) {
    const specs = value[type] ?? [];
    if (!Array.isArray(specs) || specs.length > EXECUTION_LIMITS.packages) fail(400, 'Use at most 32 package specifications.');
    const names = new Set();
    for (const spec of specs) {
      if (typeof spec !== 'string' || spec.length > 200) fail(400, 'Invalid package specification.');
      // No flags, ranges, URLs, local paths, extras, Git sources, or registry settings.
      const match = type === 'pip'
        ? /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:==([0-9][A-Za-z0-9.!+_-]*))?$/.exec(spec)
        : /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?))?$/.exec(spec);
      if (!match) fail(400, 'Use registry package names with optional exact versions, not URLs, paths, flags, or version ranges.');
      const name = type === 'pip' ? match[1].toLowerCase().replace(/[-_.]+/g, '-') : match[1];
      if (names.has(name)) fail(400, 'Package names must be unique.');
      names.add(name); result[type].push(spec);
    }
  }
  if (result.pip.length + result.npm.length > EXECUTION_LIMITS.packages) fail(400, 'Use at most 32 package specifications in total.');
  return result;
}
export function fileLink(cid, file) {
  return { path: file.path, revision: file.revision, mime: file.mime, size: file.size, sha256: file.sha256,
    url: `/api/conversations/${encodeURIComponent(cid)}/workspace/download?${new URLSearchParams({ path: file.path, revision: file.revision })}` };
}
function safeOutput(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('Invalid runner output.');
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
function safeFailure(error) {
  // App validation errors are fixed messages. Never expose a broker/engine stack or host path.
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
    ? String(error.message).slice(0, 1000) : 'The isolated runner failed. Check its status and administrator logs.';
}
function executionInput(value) {
  fields(value, ['kind', 'code', 'allowPackages'], 'execution');
  if (!['python', 'shell'].includes(value.kind)) fail(400, 'Execution kind must be python or shell.');
  if (value.allowPackages !== undefined && typeof value.allowPackages !== 'boolean') fail(400, 'allowPackages must be a boolean.');
  return { kind: value.kind, code: executionCode(value.code), allowPackages: value.allowPackages === true };
}

/** Coordinates app records and copied workspace bytes. This class never runs host code. */
export class Executions {
  constructor(store, workspace, runner, emit = () => {}, options = {}) {
    this.store = store; this.workspace = workspace; this.runner = runner; this.emit = emit;
    this.enabled = options.enabled ?? !!runner;
    this.active = new Map(); this.closing = false;
    this.executionMs = Math.min(options.executionMs ?? EXECUTION_LIMITS.executionMs, EXECUTION_LIMITS.executionMs);
    this.installMs = Math.min(options.installMs ?? EXECUTION_LIMITS.installMs, EXECUTION_LIMITS.installMs);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
        exit_code INTEGER, files TEXT NOT NULL DEFAULT '[]', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_conversation ON executions(conversation_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution ON executions(conversation_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS workspace_packages (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        specs TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    store.transaction(() => {
      const rows = store.all("SELECT DISTINCT conversation_id FROM executions WHERE status='running'");
      store.run("UPDATE executions SET status='interrupted',error='The server stopped before completion. The operation was not replayed.',updated_at=? WHERE status='running'", now());
      for (const row of rows) store.touch(row.conversation_id);
    });
  }
  async runtime({ signal } = {}) {
    const unavailable = reason => ({ enabled: !!this.enabled, ready: false, packages: false, limits: EXECUTION_LIMITS, blockedReasons: [reason] });
    if (!this.enabled || !this.runner) return unavailable('Isolated execution is not configured.');
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EXECUTION_LIMITS.capabilityMs)]);
    let abort;
    try {
      bounded.throwIfAborted();
      const interrupted = new Promise((_, reject) => {
        abort = () => reject(bounded.reason); bounded.addEventListener('abort', abort, { once: true });
      });
      const caps = await Promise.race([Promise.resolve().then(() => this.runner.capabilities({ signal: bounded })), interrupted]);
      bounded.throwIfAborted();
      const enabled = caps?.enabled !== false;
      const ready = enabled && caps?.ready === true && caps.execution !== false;
      const runnerLimits = {};
      for (const key of ['concurrency', 'files', 'fileBytes', 'totalFileBytes', 'codeBytes', 'outputBytes', 'executionSeconds', 'packageSeconds', 'containerSeconds', 'memoryBytes', 'workspaceBytes', 'pids', 'cpus']) {
        const value = caps?.limits?.[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER) runnerLimits[key] = value;
      }
      return { enabled, ready, packages: ready && (caps.installs === true || caps.packages === true),
        limits: { ...EXECUTION_LIMITS, runner: runnerLimits }, blockedReasons: ready ? [] : ['The isolated runner is not ready. Check its installation and administrator logs.'] };
    } catch {
      signal?.throwIfAborted();
      return unavailable('The isolated runner is unavailable or its capability check timed out.');
    } finally { if (abort) bounded.removeEventListener('abort', abort); }
  }
  assertIdle(cid) {
    if ([...this.active.values()].some(state => state.cid === cid) || this.store.get("SELECT id FROM executions WHERE conversation_id=? AND status='running'", cid)) fail(409, 'This conversation already has an active execution or package operation.');
  }
  #available(cid, jobId) {
    if (this.closing) fail(503, 'The execution service is stopping.');
    this.store.conversation(cid); this.assertIdle(cid);
    const job = this.store.get("SELECT id FROM jobs WHERE conversation_id=? AND status='running'", cid);
    if (job && job.id !== jobId) fail(409, 'Stop the active generation before starting an execution.');
    if (jobId && job?.id !== jobId) fail(409, 'The owning generation is no longer active.');
    if (this.active.size >= EXECUTION_LIMITS.active) fail(429, 'Too many executions are active. Wait for one to finish.');
  }
  getPackages(cid) {
    this.store.conversation(cid);
    return packageSpecs(JSON.parse(this.store.get('SELECT specs FROM workspace_packages WHERE conversation_id=?', cid)?.specs ?? '{"pip":[],"npm":[]}'));
  }
  list(cid) {
    this.store.conversation(cid);
    return { executions: this.store.all('SELECT id,kind,status,exit_code AS exitCode,error,created_at AS createdAt,updated_at AS updatedAt FROM executions WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 20', cid) };
  }
  get(cid, executionId) {
    this.store.conversation(cid);
    const row = this.store.get('SELECT * FROM executions WHERE id=? AND conversation_id=?', executionId, cid);
    if (!row) fail(404, 'Execution not found.');
    return { id: row.id, kind: row.kind, status: row.status, stdout: row.stdout, stderr: row.stderr,
      exitCode: row.exit_code, files: JSON.parse(row.files), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async #start(cid, input, { jobId, signal } = {}) {
    signal?.throwIfAborted(); this.#available(cid, jobId);
    const runtime = await this.runtime({ signal });
    signal?.throwIfAborted(); this.#available(cid, jobId);
    if (!runtime.ready) fail(503, runtime.blockedReasons[0]);
    const packages = input.kind === 'packages' ? input.packages : this.getPackages(cid);
    const hasPackages = packages.pip.length + packages.npm.length > 0;
    if ((input.kind === 'packages' || hasPackages) && !input.allowPackages) fail(403, 'Package restoration or installation requires explicit permission for this request.');
    if (hasPackages && !runtime.packages) fail(503, 'Package installation is not available in the isolated runner.');
    const executionId = id(), controller = new AbortController();
    const state = { id: executionId, cid, controller, reason: null, jobId, input: { ...input, packages } };
    // There is no await between the final busy check, durable reservation, and in-memory reservation.
    this.store.transaction(() => {
      this.#available(cid, jobId);
      this.store.run('INSERT INTO executions(id,conversation_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?)', executionId, cid, input.kind, 'running', now(), now());
      this.store.touch(cid);
    });
    this.active.set(executionId, state);
    state.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.#run(state, signal));
    this.emit({ type: 'changed', conversationId: cid });
    return state;
  }
  async submit(cid, input) {
    const state = await this.#start(cid, executionInput(input));
    return { id: state.id, status: 'running' };
  }
  async execute(cid, input, context = {}) {
    const state = await this.#start(cid, executionInput(input), context);
    await state.promise;
    return this.get(cid, state.id);
  }
  async setPackages(cid, input, context = {}) {
    fields(input, ['pip', 'npm', 'allowPackages'], 'package request');
    if (input.allowPackages !== true) fail(403, 'Package installation requires allowPackages: true.');
    const packages = packageSpecs({ pip: input.pip, npm: input.npm });
    const state = await this.#start(cid, { kind: 'packages', packages, allowPackages: true }, context);
    await state.promise;
    const result = this.get(cid, state.id);
    if (result.status !== 'complete') fail(result.status === 'cancelled' ? 409 : 502, result.error ?? 'Package installation did not complete.');
    return this.getPackages(cid);
  }
  async #run(state, parentSignal) {
    const { id: executionId, cid, controller, input } = state;
    const hasPackages = input.packages.pip.length + input.packages.npm.length > 0;
    const duration = input.kind === 'packages' ? this.installMs : hasPackages
      ? Math.min(this.installMs + this.executionMs + 20000, EXECUTION_LIMITS.packageExecutionMs) : this.executionMs;
    const timeout = AbortSignal.timeout(duration);
    const signal = AbortSignal.any([controller.signal, timeout, ...(parentSignal ? [parentSignal] : [])]);
    let status = 'error', stdout = '', stderr = '', exitCode = null, files = [], error = null;
    try {
      signal.throwIfAborted();
      if (input.kind === 'packages') {
        const installed = await this.runner.install({ workspaceId: cid, packages: input.packages, signal });
        signal.throwIfAborted();
        const resolved = packageSpecs(installed?.packages ?? installed);
        this.store.transaction(() => {
          this.store.conversation(cid); signal.throwIfAborted();
          this.store.run('INSERT INTO workspace_packages(conversation_id,specs,updated_at) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET specs=excluded.specs,updated_at=excluded.updated_at', cid, JSON.stringify(resolved), now());
        });
        status = 'complete'; exitCode = 0;
        stdout = `Saved ${resolved.pip.length} pip and ${resolved.npm.length} npm package specifications.`;
      } else {
        const snapshot = await this.workspace.snapshot(cid);
        signal.throwIfAborted();
        if (!Array.isArray(snapshot.files) || snapshot.files.length > EXECUTION_LIMITS.inputFiles) throw new Error('Invalid workspace snapshot.');
        let size = 0;
        const inputs = snapshot.files.map(file => {
          const bytes = Buffer.from(file.data, 'base64'); size += bytes.length;
          if (bytes.length > EXECUTION_LIMITS.fileBytes || size > EXECUTION_LIMITS.snapshotBytes || bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('Invalid or oversized workspace snapshot.');
          return { path: file.path, mime: file.mime, bytes };
        });
        const result = await this.runner.execute({ workspaceId: cid, kind: input.kind, code: input.code, files: inputs, packages: input.packages, signal });
        signal.throwIfAborted();
        if (!statuses.has(result?.status)) throw new Error('Invalid runner status.');
        if (typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) > EXECUTION_LIMITS.outputBytes || typeof result.stderr === 'string' && Buffer.byteLength(result.stderr) > EXECUTION_LIMITS.outputBytes) throw new Error('Runner output exceeded its limit.');
        const nextStdout = safeOutput(result.stdout), nextStderr = safeOutput(result.stderr);
        if (Buffer.byteLength(nextStdout) + Buffer.byteLength(nextStderr) > EXECUTION_LIMITS.outputBytes) throw new Error('Runner output exceeded its limit.');
        stdout = nextStdout; stderr = nextStderr;
        exitCode = Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : null;
        status = result.status;
        if (status === 'complete' && exitCode !== 0) status = 'error';
        if (status === 'complete') {
          if (!Array.isArray(result.files) || result.files.length > EXECUTION_LIMITS.inputFiles) throw new Error('Invalid runner file output.');
          let bytes = 0, changedBytes = 0;
          const paths = new Set(), changed = [];
          for (const file of result.files) {
            if (!file || typeof file.path !== 'string' || typeof file.mime !== 'string' || !Buffer.isBuffer(file.bytes)) throw new Error('Invalid runner output file.');
            bytes += file.bytes.length;
            if (file.bytes.length > EXECUTION_LIMITS.fileBytes || bytes > EXECUTION_LIMITS.transferBytes || paths.has(file.path.toLowerCase())) throw new Error('Runner file output exceeded its limit or contains duplicates.');
            paths.add(file.path.toLowerCase());
            const previous = Object.hasOwn(snapshot.revisions, file.path) ? snapshot.revisions[file.path] : null;
            if (!previous?.deleted && previous?.sha256 === hash(file.bytes)) continue;
            changedBytes += file.bytes.length;
            if (changed.length >= EXECUTION_LIMITS.outputFiles || changedBytes > EXECUTION_LIMITS.snapshotBytes) throw new Error('Changed runner files exceed the workspace import limit.');
            changed.push({ path: file.path, mime: file.mime, data: file.bytes.toString('base64'),
              expectedRevision: previous?.revision ?? null, expectedSha256: previous?.sha256 ?? null });
          }
          signal.throwIfAborted();
          if (changed.length) {
            const imported = await this.workspace.importOutputs(cid, changed, { signal });
            files = imported.files.map(file => fileLink(cid, file));
          }
        } else error = status === 'cancelled' ? 'Execution was cancelled. Workspace files were not changed.'
          : status === 'timed_out' ? 'Execution exceeded its deadline. Workspace files were not changed.'
          : status === 'interrupted' ? 'Execution was interrupted. Workspace files were not changed.'
          : 'Execution failed. Workspace files were not changed. See the bounded stdout and stderr.';
      }
    } catch (cause) {
      if (state.reason === 'shutdown') { status = 'interrupted'; error = 'The server stopped. The operation was not replayed.'; }
      else if (state.reason === 'cancelled' || parentSignal?.aborted && parentSignal.reason?.name !== 'TimeoutError') { status = 'cancelled'; error = 'Execution was cancelled. Workspace files were not changed.'; }
      else if (timeout.aborted || parentSignal?.aborted && parentSignal.reason?.name === 'TimeoutError') { status = 'timed_out'; error = 'Execution exceeded its deadline. Workspace files were not changed.'; }
      else { status = 'error'; error = safeFailure(cause); }
    } finally {
      this.store.transaction(() => {
        this.store.run('UPDATE executions SET status=?,stdout=?,stderr=?,exit_code=?,files=?,error=?,updated_at=? WHERE id=?', status, stdout, stderr, exitCode, JSON.stringify(files), error, now(), executionId);
        this.store.touch(cid);
      });
      this.active.delete(executionId);
      this.emit({ type: 'changed', conversationId: cid });
    }
  }
  cancel(cid, executionId) {
    const saved = this.get(cid, executionId), state = this.active.get(executionId);
    if (state) { state.reason = 'cancelled'; state.controller.abort(); }
    return { id: executionId, status: state ? 'cancelling' : saved.status };
  }
  async stop() {
    this.closing = true;
    const active = [...this.active.values()];
    for (const state of active) { state.reason = 'shutdown'; state.controller.abort(); }
    await Promise.allSettled(active.map(state => state.promise));
  }
}
