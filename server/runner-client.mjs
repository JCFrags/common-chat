import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { filePath, hash, limits, packageSpecs } from '../runner/policy.mjs';

export class RunnerClient {
  constructor({ socketPath } = {}) { this.socketPath = socketPath; }
  async request(path, { method = 'GET', json, bytes, signal, maximum = 16 * 1024 * 1024 } = {}) {
    if (!this.socketPath) throw new Error('The isolated runner is not configured.');
    signal?.throwIfAborted();
    const body = bytes ?? (json !== undefined ? Buffer.from(JSON.stringify(json)) : null);
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, path, method, signal,
        headers: { Host: 'runner', ...(body ? { 'Content-Type': bytes ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maximum) { req.destroy(new Error('Runner response exceeded its bound.')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const bytes = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let message = 'Runner request failed.'; try { message = JSON.parse(bytes).error ?? message; } catch {}
              throw Object.assign(new Error(String(message).slice(0, 2500)), { status: res.statusCode });
            }
            resolve((res.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(bytes) : bytes);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error('Runner connection timed out.')));
      req.on('error', reject); req.end(body);
    });
  }
  async capabilities() {
    if (!this.socketPath) return { enabled: false, ready: false, packages: false, limits, blockedReasons: ['The isolated runner is not configured.'] };
    try {
      const result = await this.request('/v1/capabilities', { maximum: 65536 });
      return { ...result, enabled: true, ready: result.ready === true, packages: result.packages === true };
    } catch (error) { return { enabled: true, ready: false, packages: false, limits, blockedReasons: [error.message] }; }
  }
  async operation({ workspaceId, kind, code = '', files = [], packages = {}, signal }) {
    if (!Array.isArray(files) || files.length > limits.files) throw new Error('Too many runner input files.');
    const manifest = files.map(file => {
      filePath(file.path);
      if (!Buffer.isBuffer(file.bytes) || file.bytes.length > limits.fileBytes) throw new Error('Runner input must be a bounded Buffer.');
      return { path: file.path, mime: file.mime ?? 'application/octet-stream', size: file.bytes.length, sha256: hash(file.bytes) };
    });
    if (manifest.reduce((n, f) => n + f.size, 0) > limits.totalFileBytes) throw new Error('Runner input exceeds 32 MiB.');
    const selected = packageSpecs(packages);
    const id = randomUUID(), base = `/v1/operations/${id}`;
    const timeout = AbortSignal.timeout(['document', 'probe'].includes(kind) ? 30000 : kind === 'install' ? 300000 : 380000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let terminal = false;
    try {
      await this.request('/v1/operations', { method: 'POST', signal: bounded,
        json: { requestId: id, workspaceId, kind, code, packages: selected, files: manifest } });
      for (let i = 0; i < files.length; i++) await this.request(`${base}/inputs/${i}`, { method: 'PUT', bytes: files[i].bytes, signal: bounded });
      await this.request(`${base}/start`, { method: 'POST', signal: bounded });
      let result;
      for (;;) {
        result = await this.request(base, { signal: bounded });
        if (!['preparing', 'running'].includes(result.status)) break;
        await delay(150, undefined, { signal: bounded });
      }
      terminal = true;
      if (!['complete','error','cancelled','timed_out','interrupted'].includes(result.status)) throw new Error('Unknown runner terminal status.');
      const outputs = [];
      if (!Array.isArray(result.files) || result.files.length > limits.files) throw new Error('Invalid runner output manifest.');
      let total = 0; const seen = new Set();
      for (let i = 0; i < result.files.length; i++) {
        const file = result.files[i]; filePath(file.path);
        if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.fileBytes) throw new Error('Invalid runner output size/path.');
        seen.add(file.path); total += file.size;
        if (total > limits.totalFileBytes) throw new Error('Runner outputs exceed 32 MiB.');
        const bytes = await this.request(`${base}/outputs/${i}`, { signal: bounded, maximum: file.size });
        if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('Runner output digest mismatch.');
        outputs.push({ path: file.path, mime: file.mime, bytes });
      }
      bounded.throwIfAborted();
      return { ...result, files: outputs };
    } finally {
      // Cancellation never uses the already-aborted signal. The broker must stop
      // the actual container even after the caller has closed its HTTP request.
      if (!terminal) await this.request(`${base}/cancel`, { method: 'POST', signal: AbortSignal.timeout(20000) }).catch(() => {});
      await this.request(base, { method: 'DELETE', signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
  }
  async execute(input) {
    if (!['python', 'shell'].includes(input.kind)) throw new Error('Execution kind must be python or shell.');
    const result = await this.operation(input);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? null, error: result.error ?? null, files: result.files };
  }
  async install({ workspaceId, packages, signal }) {
    const result = await this.operation({ workspaceId, kind: 'install', packages, signal });
    if (result.status !== 'complete') throw new Error(result.error ?? 'Package installation failed.');
    return { packages: packageSpecs(result.packages), summary: String(result.summary ?? 'Packages installed in isolated scratch.').slice(0, 1000) };
  }
  async extractDocument({ path, mime, bytes, signal }) {
    const result = await this.operation({ workspaceId: `document-${randomUUID()}`, kind: 'document', files: [{ path, mime, bytes }], signal });
    if (result.status !== 'complete') throw new Error(result.error ?? 'Document extraction failed.');
    const passages = result.data?.passages;
    if (!Array.isArray(passages) || passages.length > 10000 || passages.some(p => typeof p.text !== 'string' ||
        (p.page !== undefined && (!Number.isSafeInteger(p.page) || p.page < 1 || p.page > 200)) ||
        (p.paragraph !== undefined && (!Number.isSafeInteger(p.paragraph) || p.paragraph < 1 || p.paragraph > 10000))) ||
        passages.reduce((n, p) => n + p.text.length, 0) > 250000) throw new Error('Invalid extracted document result.');
    return { passages: passages.map(p => ({ text: p.text, ...(p.page ? { page: p.page } : {}), ...(p.paragraph ? { paragraph: p.paragraph } : {}) })) };
  }
  async mediaProbe({ name, mime, bytes, signal }) {
    // Display names are not paths. Use one fixed path inside the isolated worker.
    const result = await this.operation({ workspaceId: `probe-${randomUUID()}`, kind: 'probe', files: [{ path: 'media-input', mime, bytes }], signal });
    if (result.status !== 'complete') throw new Error(result.error ?? 'Media inspection failed.');
    const data = result.data;
    if (!data || !Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0 || typeof data.hasAudio !== 'boolean' || typeof data.hasVideo !== 'boolean') throw new Error('Media duration or streams are unknown.');
    const value = { durationSeconds: data.durationSeconds, hasAudio: data.hasAudio, hasVideo: data.hasVideo };
    for (const key of ['width', 'height']) if (data[key] !== undefined) {
      if (!Number.isSafeInteger(data[key]) || data[key] < 1 || data[key] > 100000) throw new Error('Invalid media dimensions.'); value[key] = data[key];
    }
    for (const key of ['audioCodec', 'videoCodec']) if (data[key] !== undefined) {
      if (typeof data[key] !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(data[key])) throw new Error('Invalid media codec.'); value[key] = data[key];
    }
    return value;
  }
}
