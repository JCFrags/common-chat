import { createHash } from 'node:crypto';

export const limits = Object.freeze({
  concurrency: 1, files: 128, fileBytes: 16 * 1024 * 1024, totalFileBytes: 32 * 1024 * 1024,
  codeBytes: 128 * 1024, outputBytes: 2 * 1024 * 1024, chunkBytes: 192 * 1024,
  executionSeconds: 60, packageSeconds: 240, containerSeconds: 360,
  memoryBytes: 1536 * 1024 * 1024, workspaceBytes: 128 * 1024 * 1024, pids: 128, cpus: 1,
  retainedOperations: 4, retentionMs: 5 * 60 * 1000
});
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function reject(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Expected an object.');
  if (Object.keys(value).some(key => !allowed.includes(key))) reject('Unknown runner field.');
  return value;
}
export function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f\x7f\\]/.test(value) ||
      value.startsWith('/') || value.split('/').length > 12 || value.split('/').some(part => !part || part === '.' || part === '..')) reject('Use a bounded relative file path without links or traversal.');
  return value;
}
export function packageSpecs(value = {}) {
  record(value, ['pip', 'npm']);
  const result = { pip: [], npm: [] };
  for (const manager of ['pip', 'npm']) {
    const items = value[manager] ?? [];
    if (!Array.isArray(items) || items.length > 32) reject('Use at most 32 packages in total.');
    for (const spec of items) {
      const pattern = manager === 'pip'
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:==[0-9][A-Za-z0-9.+_-]{0,59})?$/
        : /^(?:@[a-z0-9][a-z0-9._-]{0,79}\/)?[a-z0-9][a-z0-9._-]{0,99}(?:@[0-9][A-Za-z0-9.+_-]{0,59})?$/;
      if (typeof spec !== 'string' || spec.length > 200 || !pattern.test(spec)) reject(`Invalid ${manager} package. Use a registry name and optional exact version, not a URL, path, Git source, flag, or range.`);
      result[manager].push(spec);
    }
    result[manager] = [...new Set(result[manager])];
  }
  if (result.pip.length + result.npm.length > 32) reject('Use at most 32 packages in total.');
  return result;
}
export function validateOperation(input) {
  record(input, ['requestId', 'workspaceId', 'kind', 'code', 'packages', 'files']);
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) reject('Invalid request ID.');
  if (typeof input.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.workspaceId)) reject('Invalid workspace ID.');
  if (!['python', 'shell', 'install', 'document', 'probe'].includes(input.kind)) reject('Unsupported runner operation.');
  const code = input.code ?? '';
  if (typeof code !== 'string' || Buffer.byteLength(code) > limits.codeBytes || (!['python', 'shell'].includes(input.kind) && code)) reject('Invalid or oversized code.');
  const packages = packageSpecs(input.packages);
  if (['document', 'probe'].includes(input.kind) && (packages.pip.length || packages.npm.length)) reject('Document and probe operations use only the fixed image toolchain.');
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > limits.files || (input.kind === 'install' && files.length) || (['document', 'probe'].includes(input.kind) && files.length !== 1)) reject('Invalid input file count.');
  const seen = new Set(); let total = 0;
  for (const f of files) {
    record(f, ['path', 'mime', 'size', 'sha256']); filePath(f.path);
    if (seen.has(f.path)) reject('Duplicate input path.'); seen.add(f.path);
    if (typeof f.mime !== 'string' || f.mime.length > 120 || /[\r\n]/.test(f.mime)) reject('Invalid MIME type.');
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > limits.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256)) reject('Invalid input size or digest.');
    total += f.size;
  }
  if (total > limits.totalFileBytes) reject('Input files exceed the 32 MiB operation limit.');
  if (input.kind === 'document' && !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(files[0].mime)) reject('Document extraction supports PDF and DOCX only.');
  return { ...input, code, packages, files };
}
