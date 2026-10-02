import { fail, object, text, integer } from './validation.mjs';
import { executionCode, packageSpecs, fileLink } from './executions.mjs';

export const TOOL_LIMITS = Object.freeze({ rounds: 8, calls: 16, argumentBytes: 128 * 1024,
  totalArgumentBytes: 256 * 1024, resultBytes: 64 * 1024, transcriptBytes: 1024 * 1024 });
const own = (value, keys, label) => {
  object(value, label);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(400, `Unknown ${label} field.`);
};
export function toolPermissions(value = {}) {
  own(value, ['workspace', 'execute', 'packages'], 'tool permissions');
  const permissions = {};
  for (const key of ['workspace', 'execute', 'packages']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(400, `Tool permission ${key} must be a boolean.`);
    permissions[key] = value[key] === true;
  }
  return Object.freeze(permissions);
}
// A portable subset is checked before dispatch. Workspace applies its full path policy again.
function pathArgument(value) {
  text(value, 'workspace path', 512);
  if (!value.isWellFormed() || value !== value.normalize('NFC') || Buffer.byteLength(value) > 512 || /[\\<>:"|?*\p{C}]/u.test(value) || value.startsWith('~')) fail(400, 'Use a portable relative workspace path.');
  const parts = value.split('/');
  if (parts.length > 8 || parts.some(p => !p || p === '.' || p === '..' || p !== p.trim() || p.endsWith('.') || Buffer.byteLength(p) > 120 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail(400, 'Use a portable relative workspace path.');
  return value;
}
const revisionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const callIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
function clip(value, bytes) {
  if (Buffer.byteLength(value) <= bytes) return value;
  // The decoder drops an incomplete final UTF-8 sequence rather than inventing text.
  return new TextDecoder('utf-8').decode(Buffer.from(value).subarray(0, bytes), { stream: true });
}
const string = (description, maxLength) => ({ type: 'string', description, maxLength });
const number = (maximum, minimum = 0) => ({ type: 'integer', minimum, maximum });
function schema(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const schemas = [
  ['workspace', schema('list_workspace', 'List current workspace file revisions. Deleted files retain a head revision. Paths are relative to this conversation, not the host.', { offset: number(128), limit: number(50, 1) })],
  ['workspace', schema('read_workspace', 'Read bounded text or extracted PDF/DOCX passages from this conversation workspace. Read a revision before editing it. Binary bytes are not decoded as text.', { path: string('Relative workspace path.', 512), offset: number(1048576), limit: number(8192, 1) }, ['path'])],
  ['workspace', schema('write_workspace', 'Create or revise one UTF-8 text file. Use the exact current revision, including a deleted head, or null for a new path. Create DOCX/PDF with runner libraries instead.', { path: string('Relative workspace path.', 512), text: string('Complete replacement UTF-8 text, at most 64 KiB.', 65536), expectedRevision: { type: ['string', 'null'], description: 'Current revision from list/read, or null for a new path.' }, expectedSha256: { type: ['string', 'null'], description: 'Optional current SHA-256.' } }, ['path', 'text', 'expectedRevision'])],
  ['workspace', schema('search_workspace', 'Search indexed current workspace text and extracted PDF/DOCX passages. Results include revision-specific citations. Unindexed files are reported separately.', { query: string('One to sixteen search words.', 500), limit: number(10, 1) }, ['query'])],
  ['execute', schema('run_python', 'Run Python in the isolated runner with a copied snapshot of this conversation workspace. Save outputs to relative workspace paths. DOCX/PDF and plots can use installed runner libraries. No host access or general network. Saved package restoration needs user package permission.', { code: string('Python source, at most 64 KiB.', 65536) }, ['code'])],
  ['execute', schema('run_shell', 'Run POSIX shell in the isolated runner with a copied snapshot of this conversation workspace. Node can be invoked here. No host access or general network. Only successful bounded outputs become new file revisions.', { code: string('Shell source, at most 64 KiB.', 65536) }, ['code'])],
  ['packages', schema('install_packages', 'Replace and verify the conversation package specifications. Supply the entire desired set. Only registry names and optional exact versions are allowed. Dependencies do not become workspace files.', { pip: { type: 'array', maxItems: 32, items: string('PyPI name or name==version.', 200) }, npm: { type: 'array', maxItems: 32, items: string('npm name or @scope/name, optionally followed by @exact.version.', 200) } }, ['pip', 'npm'])]
];

/** Assemble protocol fragments only. Nothing runs until finish_reason is tool_calls. */
export class ToolCallAccumulator {
  constructor() { this.calls = new Map(); this.argumentBytes = 0; }
  add(fragments, streaming) {
    if (!Array.isArray(fragments) || fragments.length > TOOL_LIMITS.calls) throw new Error('The model returned an invalid tool call list.');
    for (const [position, fragment] of fragments.entries()) {
      own(fragment, ['index', 'id', 'type', 'function'], 'tool call fragment');
      const index = fragment.index ?? (streaming ? undefined : position);
      if (!Number.isSafeInteger(index) || index < 0 || index >= TOOL_LIMITS.calls) throw new Error('The model returned an invalid tool call index.');
      let call = this.calls.get(index);
      if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; this.calls.set(index, call); }
      if (fragment.type !== undefined && fragment.type !== 'function') throw new Error('Only function tool calls are supported.');
      if (fragment.id !== undefined) {
        if (typeof fragment.id !== 'string' || !fragment.id || !callIdPattern.test(fragment.id)) throw new Error('The model returned an invalid tool call ID.');
        call.id += fragment.id;
        if (call.id.length > 128) throw new Error('The model returned an oversized tool call ID.');
      }
      if (fragment.function !== undefined) {
        own(fragment.function, ['name', 'arguments'], 'tool function fragment');
        for (const key of ['name', 'arguments']) {
          if (fragment.function[key] === undefined) continue;
          if (typeof fragment.function[key] !== 'string') throw new Error('The model returned an invalid tool function fragment.');
          call.function[key] += fragment.function[key];
          if (key === 'arguments') this.argumentBytes += Buffer.byteLength(fragment.function[key]);
        }
        if (call.function.name.length > 64 || Buffer.byteLength(call.function.arguments) > TOOL_LIMITS.argumentBytes || this.argumentBytes > TOOL_LIMITS.totalArgumentBytes) throw new Error('The model exceeded the tool argument limit.');
      }
    }
  }
  finish(reason, usedIds) {
    if (!this.calls.size || reason !== 'tool_calls') throw new Error('Tool calls were not explicitly completed. No calls from this response were executed.');
    const result = [...this.calls.entries()].sort((a, b) => a[0] - b[0]);
    const ids = new Set(usedIds);
    for (const [position, [index, call]] of result.entries()) {
      if (position !== index || !callIdPattern.test(call.id) || ids.has(call.id) || !/^[a-z][a-z0-9_]{0,63}$/.test(call.function.name) || !call.function.arguments) throw new Error('The model returned incomplete or duplicate tool calls. No calls from this response were executed.');
      ids.add(call.id);
    }
    return result.map(([, call]) => call);
  }
}

/** Validate stored protocol before resending it. Call only after checking local job ownership. */
export function toolTranscript(value) {
  if (!Array.isArray(value) || value.length > TOOL_LIMITS.calls + TOOL_LIMITS.rounds || Buffer.byteLength(JSON.stringify(value)) > TOOL_LIMITS.transcriptBytes) fail(400, 'The saved tool transcript is invalid or too large.');
  const result = [], ids = new Set(); let pending = [];
  for (const row of value) {
    if (row?.role === 'assistant' && !pending.length) {
      own(row, ['role', 'content', 'tool_calls'], 'saved assistant tool record');
      if (row.content !== null) text(row.content, 'saved tool content', 2 * 1024 * 1024, true);
      const calls = new ToolCallAccumulator(); calls.add(row.tool_calls, false);
      const completed = calls.finish('tool_calls', ids);
      if (ids.size + completed.length > TOOL_LIMITS.calls) fail(400, 'The saved tool transcript has too many calls.');
      completed.forEach(call => ids.add(call.id)); pending = completed.map(call => call.id);
      result.push({ role: 'assistant', content: row.content, tool_calls: completed });
    } else if (row?.role === 'tool' && pending.length) {
      own(row, ['role', 'tool_call_id', 'content'], 'saved tool result');
      if (row.tool_call_id !== pending.shift()) fail(400, 'The saved tool transcript has mismatched results.');
      text(row.content, 'saved tool result', TOOL_LIMITS.resultBytes, true);
      if (Buffer.byteLength(row.content) > TOOL_LIMITS.resultBytes) fail(400, 'The saved tool result is too large.');
      result.push({ role: 'tool', tool_call_id: row.tool_call_id, content: row.content });
    } else fail(400, 'The saved tool transcript has an invalid message order.');
  }
  if (pending.length) fail(400, 'The saved tool transcript is incomplete.');
  return result;
}

export class Tools {
  constructor(workspace, executions) { this.workspace = workspace; this.executions = executions; }
  assertIdle(cid) { this.executions?.assertIdle(cid); }
  async prepare(permissions, { signal } = {}) {
    if (permissions.workspace && !this.workspace) fail(503, 'Conversation workspaces are not configured.');
    if (permissions.execute || permissions.packages) {
      if (!this.executions) fail(503, 'Isolated execution is not configured.');
      const runtime = await this.executions.runtime({ signal });
      if (!runtime.ready) fail(503, runtime.blockedReasons[0]);
      if (permissions.packages && !runtime.packages) fail(503, 'Package installation is not available in the isolated runner.');
    }
    signal?.throwIfAborted();
    return schemas.filter(([permission]) => permissions[permission]).map(([, definition]) => definition);
  }
  validate(call, permissions) {
    const name = call.function.name, definition = schemas.find(([, s]) => s.function.name === name);
    if (!definition || !permissions[definition[0]]) fail(403, 'The model requested a tool that this request does not permit.');
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { fail(400, 'The model returned invalid JSON tool arguments.'); }
    const properties = definition[1].function.parameters;
    own(args, Object.keys(properties.properties), 'tool argument');
    for (const key of properties.required) if (!Object.hasOwn(args, key)) fail(400, `Missing tool argument: ${key}.`);
    if ('path' in args) pathArgument(args.path);
    if ('offset' in args) integer(args.offset, 'offset', 0, name === 'list_workspace' ? 128 : 1048576);
    if ('limit' in args) integer(args.limit, 'limit', 1, name === 'list_workspace' ? 50 : name === 'search_workspace' ? 10 : 8192);
    if (name === 'write_workspace') {
      text(args.text, 'workspace text', 65536, true);
      if (!args.text.isWellFormed() || args.text.includes('\0') || Buffer.byteLength(args.text) > 65536) fail(400, 'Tool workspace writes must be valid UTF-8 and at most 64 KiB.');
      if (args.expectedRevision !== null && (typeof args.expectedRevision !== 'string' || !revisionPattern.test(args.expectedRevision))) fail(400, 'Invalid expected workspace revision.');
      if (args.expectedSha256 !== undefined && args.expectedSha256 !== null && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) fail(400, 'Invalid expected workspace SHA-256.');
    }
    if (name === 'search_workspace') {
      text(args.query, 'workspace query', 500);
      const words = [...new Set(args.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
      if (!args.query.isWellFormed() || !words.length || words.length > 16 || words.some(word => word.length > 64)) fail(400, 'Use one to sixteen search words of at most 64 characters.');
    }
    if (name === 'run_python' || name === 'run_shell') executionCode(args.code);
    if (name === 'install_packages') args = packageSpecs(args);
    return { call, args };
  }
  async run({ cid, jobId, permissions, signal }, { call, args }) {
    signal.throwIfAborted();
    let result, summary, files = [], executionId;
    switch (call.function.name) {
      case 'list_workspace': {
        const listed = this.workspace.list(cid), offset = args.offset ?? 0;
        const selected = listed.files.slice(offset, offset + (args.limit ?? 25));
        result = { files: selected, total: listed.files.length, nextOffset: offset + selected.length < listed.files.length ? offset + selected.length : null };
        summary = `Listed ${selected.length} workspace files.`; break;
      }
      case 'read_workspace': {
        const read = this.workspace.read(cid, args.path), offset = args.offset ?? 0;
        if (typeof read.text === 'string') {
          const part = read.text.slice(offset, offset + (args.limit ?? 8192));
          result = { file: read.file, text: part, offset, nextOffset: offset + part.length < read.text.length ? offset + part.length : null };
        } else {
          const passages = (read.passages ?? []).slice(offset, offset + Math.min(args.limit ?? 8, 8));
          result = { file: read.file, passages, offset, nextOffset: offset + passages.length < (read.passages?.length ?? 0) ? offset + passages.length : null,
            note: 'Binary bytes are not text. Use extracted passages, search, or an isolated runner library.' };
        }
        files = [fileLink(cid, read.file)]; summary = `Read ${args.path}.`; break;
      }
      case 'write_workspace': {
        const written = await this.workspace.importOutputs(cid, [args], { signal });
        files = written.files.map(file => fileLink(cid, file));
        result = { files }; summary = `Saved ${args.path}.`; break;
      }
      case 'search_workspace':
        result = this.workspace.search(cid, args.query, { limit: args.limit ?? 8 });
        summary = `Found ${result.results.length} workspace passages.`; break;
      case 'run_python': case 'run_shell':
        result = await this.executions.execute(cid, { kind: call.function.name === 'run_python' ? 'python' : 'shell', code: args.code, allowPackages: permissions.packages }, { jobId, signal });
        executionId = result.id; files = result.files;
        result = { ...result, files: files.slice(0, 8), totalFiles: files.length,
          stdout: clip(result.stdout, 8000), stderr: clip(result.stderr, 8000),
          outputTruncated: Buffer.byteLength(result.stdout) > 8000 || Buffer.byteLength(result.stderr) > 8000 };
        summary = result.status === 'complete' ? 'Isolated execution completed.' : `Isolated execution ended with status ${result.status}.`; break;
      case 'install_packages':
        result = await this.executions.setPackages(cid, { ...args, allowPackages: permissions.packages }, { jobId, signal });
        summary = `Saved ${result.pip.length} pip and ${result.npm.length} npm package specifications.`; break;
      default: throw new Error('Unsupported tool.');
    }
    const content = JSON.stringify(result);
    if (Buffer.byteLength(content) > TOOL_LIMITS.resultBytes) throw new Error('The tool result exceeds its context limit. Request a smaller page.');
    return { content, activity: { status: result.status && result.status !== 'complete' ? result.status : 'complete', summary, files,
      ...(executionId ? { executionId, stdout: clip(result.stdout, 2000), stderr: clip(result.stderr, 2000), exitCode: result.exitCode } : {}) } };
  }
}
