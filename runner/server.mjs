import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, lstat, chmod, readdir, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PodmanEngine } from './engine.mjs';
import { registryAccess } from './registry.mjs';
import { runnerFailure, packageConsole } from './errors.mjs';
import { limits, hash, reject, validateOperation, packageSpecs, filePath } from './policy.mjs';

async function readBody(req, maximum) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maximum) reject('Runner request exceeds its byte limit.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function socketAlive(path) {
  return new Promise(resolve => {
    const socket = net.connect(path); socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
  });
}
export async function createRunner({ socketPath, stateDir, image = 'localhost/common-chat-worker:1', podman = 'podman' }) {
  if (process.getuid?.() === 0) throw new Error('Run the broker as its dedicated non-root account.');
  socketPath = resolve(socketPath); stateDir = resolve(stateDir);
  if (Buffer.byteLength(socketPath) > 90 || /[,\n]/.test(socketPath + stateDir)) throw new Error('Use short, plain absolute runner paths.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, 'broker.pid');
  let oldPid;
  try { oldPid = Number(await readFile(lock, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (oldPid !== undefined) {
    if (!Number.isSafeInteger(oldPid) || oldPid < 1) throw new Error('Invalid broker lock. Operator inspection is required.');
    try { process.kill(oldPid, 0); throw new Error('Another broker process owns this state directory.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lock);
  }
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let server, engine, owner, ready = false, closing = false, busy = null;
  const operations = new Map(), blockedReasons = [];
  const ownerPath = join(stateDir, 'owner');
  try {
    try { owner = (await readFile(ownerPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; owner = randomUUID(); await writeFile(ownerPath, owner, { flag: 'wx', mode: 0o600 }); }
    if (!/^[a-f0-9-]{36}$/.test(owner)) throw new Error('Invalid runner owner identity.');
    engine = new PodmanEngine({ owner, image, binary: podman });
    try { await engine.initialize(); ready = true; } catch (error) { blockedReasons.push(runnerFailure(error)); }
    // No code or file data is retained in the restart ledger.
    await mkdir(join(stateDir, 'operations'), { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') { await unlink(lock).catch(() => {}); throw error; }
  }
  async function save(job) {
    const destination = join(stateDir, 'operations', `${job.id}.json`);
    await writeFile(`${destination}.new`, JSON.stringify({ id: job.id, fingerprint: job.fingerprint, status: job.status, updated: Date.now() }), { mode: 0o600 });
    await rename(`${destination}.new`, destination);
  }
  const old = await readdir(join(stateDir, 'operations'));
  if (old.length > 64) { await unlink(lock).catch(() => {}); throw new Error('Too many retained broker records. Operator inspection is required.'); }
  for (const name of old) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const row = JSON.parse(await readFile(join(stateDir, 'operations', name), 'utf8'));
    operations.set(row.id, { id: row.id, fingerprint: row.fingerprint, status: 'interrupted', updated: Date.now(), output: [],
      result: { status: 'interrupted', stdout: '', stderr: '', exitCode: null, files: [], error: 'Broker restarted. Execution was not replayed.' } });
  }
  function snapshot(job) {
    const terminal = !['preparing', 'running'].includes(job.status);
    return { id: job.id, operationId: job.id, status: job.status, ...(terminal ? job.result ?? {} : {}), files: terminal ? job.output?.map(({ bytes, ...file }) => file) ?? [] : [] };
  }
  async function cancel(job) {
    if (['complete','error','timed_out','cancelled','interrupted'].includes(job.status)) return;
    job.cancelled = true;
    await job.mirror?.close(); job.mirror = null;
    if (job.worker) await job.worker.stop();
    if (job.status === 'preparing') {
      job.status = 'cancelled'; job.inputs = [];
      job.result = { status: 'cancelled', error: 'Execution cancelled.', stdout: '', stderr: '', exitCode: null };
      if (busy === job.id) busy = null;
      await save(job);
    }
  }
  const check = job => { if (job.cancelled || closing) throw new Error('Execution cancelled.'); };
  async function run(job) {
    const hasPackages = job.request.packages.pip.length || job.request.packages.npm.length;
    try {
      check(job);
      const dependencies = [];
      if (hasPackages) {
        job.mirror = registryAccess();
        job.worker = await engine.start({ operationId: `${job.id}-fetch`, registry: job.mirror });
        check(job);
        job.install = await job.worker.call({ op: 'install', packages: job.request.packages }, limits.packageSeconds * 1000);
        job.install.stdout = packageConsole(job.install.stdout); job.install.stderr = packageConsole(job.install.stderr);
        await job.worker.sealRegistry(); job.mirror = null;
        await job.worker.call({ op: 'seal' }); check(job);
        const manifest = await job.worker.call({ op: 'dependencyManifest' });
        if (!Array.isArray(manifest) || manifest.length > 4096) throw new Error('Dependency file count exceeded.');
        let total = 0; const seen = new Set();
        for (const file of manifest) {
          filePath(file.path);
          if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256) || ![0o644, 0o755].includes(file.mode)) throw new Error('Invalid dependency file.');
          seen.add(file.path); total += file.size;
          if (total > limits.totalFileBytes) throw new Error('Additional dependencies exceed the 32 MiB transfer limit.');
          const chunks = []; let size = 0;
          while (size < file.size) {
            check(job);
            const chunk = await job.worker.call({ op: 'readDependency', path: file.path, offset: size });
            if (typeof chunk.data !== 'string' || chunk.data.length > 4 * limits.chunkBytes / 3 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) throw new Error('Invalid dependency chunk.');
            const bytes = Buffer.from(chunk.data, 'base64');
            if (!bytes.length || bytes.length > limits.chunkBytes || size + bytes.length > file.size) throw new Error('Dependency size changed.');
            chunks.push(bytes); size += bytes.length;
          }
          const bytes = Buffer.concat(chunks);
          if (hash(bytes) !== file.sha256) throw new Error('Dependency digest mismatch.');
          dependencies.push({ ...file, bytes });
        }
        // The fixed fetch container never receives user files/code. Destroy it
        // before creating a separately confined, network-capability-free worker.
        await job.worker.stop(); job.worker = null;
      } else job.install = { packages: { pip: [], npm: [] }, summary: 'No additional packages requested.' };
      job.install.packages = packageSpecs(job.install.packages);
      check(job);
      job.worker = await engine.start({ operationId: job.id });
      await job.worker.call({ op: 'seal' }); check(job);
      const inputs = [...dependencies.map(file => ({ ...file, dependency: true })), ...job.request.files.map((file, index) => ({ ...file, bytes: job.inputs[index] }))];
      for (const file of inputs) {
        await job.worker.call({ op: file.dependency ? 'beginDependency' : 'begin', path: file.path, size: file.size, sha256: file.sha256, mode: file.mode });
        for (let offset = 0; offset < file.bytes.length; offset += limits.chunkBytes) {
          check(job);
          await job.worker.call({ op: 'chunk', data: file.bytes.subarray(offset, offset + limits.chunkBytes).toString('base64') });
        }
        await job.worker.call({ op: 'end' });
      }
      job.inputs = [];
      let result;
      if (job.request.kind === 'install') result = { ...job.install, status: 'complete', stdout: job.install.stdout ?? '', stderr: job.install.stderr ?? '', exitCode: 0, files: [] };
      else if (['document', 'probe'].includes(job.request.kind)) {
        const file = job.request.files[0];
        const data = await job.worker.call({ op: job.request.kind, path: file.path, mime: file.mime }, 30000);
        result = { status: 'complete', stdout: '', stderr: '', exitCode: 0, data, files: [] };
      } else result = await job.worker.call({ op: 'execute', kind: job.request.kind, code: job.request.code }, 65000);
      check(job);
      if (!['complete','error','timed_out'].includes(result.status) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
          Buffer.byteLength(result.stdout + result.stderr) > limits.outputBytes * 3 || !Array.isArray(result.files) || result.files.length > limits.files) throw new Error('Invalid worker result.');
      let total = 0; const seen = new Set(); job.output = [];
      for (const file of result.files) {
        filePath(file.path);
        if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.mime !== 'string' || file.mime.length > 120) throw new Error('Invalid output manifest.');
        seen.add(file.path); total += file.size;
        if (total > limits.totalFileBytes) throw new Error('Output files exceed their byte limit.');
        const chunks = []; let size = 0;
        while (size < file.size) {
          check(job);
          const chunk = await job.worker.call({ op: 'read', path: file.path, offset: size });
          if (typeof chunk.data !== 'string' || chunk.data.length > 4 * limits.chunkBytes / 3 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) throw new Error('Invalid output chunk.');
          const bytes = Buffer.from(chunk.data, 'base64');
          if (!bytes.length || bytes.length > limits.chunkBytes || size + bytes.length > file.size) throw new Error('Output chunk exceeds its declared size.');
          chunks.push(bytes); size += bytes.length;
        }
        const bytes = Buffer.concat(chunks);
        if (hash(bytes) !== file.sha256) throw new Error('Output digest changed during collection.');
        job.output.push({ path: file.path, mime: file.mime, size: bytes.length, sha256: file.sha256, bytes });
      }
      result.files = undefined; job.result = result; job.terminalStatus = result.status;
    } catch (error) {
      job.terminalStatus = job.cancelled || closing ? 'cancelled' : /timed out/i.test(error.message) ? 'timed_out' : 'error';
      job.output = [];
      job.result = { status: job.terminalStatus,
        stdout: packageConsole(error.diagnostics?.stdout ?? job.install?.stdout),
        stderr: packageConsole(error.diagnostics?.stderr ?? job.install?.stderr),
        exitCode: error.diagnostics?.exitCode ?? null, error: runnerFailure(error) };
    } finally {
      try { await job.mirror?.close(); job.mirror = null; await job.worker?.stop(); }
      catch { ready = false; blockedReasons.push('Container cleanup failed. Operator inspection is required.'); job.terminalStatus = 'error'; job.result = { status: 'error', stdout: '', stderr: '', exitCode: null, error: 'Container cleanup could not be confirmed.' }; job.output = []; }
      if (job.cancelled && ready) { job.terminalStatus = 'cancelled'; job.result = { status: 'cancelled', stdout: '', stderr: '', exitCode: null, error: 'Execution cancelled.' }; job.output = []; }
      job.status = job.terminalStatus;
      job.inputs = []; job.worker = null; job.updated = Date.now();
      if (busy === job.id) busy = null;
      await save(job);
    }
  }
  function send(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://runner').pathname;
      if (path === '/v1/capabilities' && req.method === 'GET') {
        send(res, { enabled: true, ready, packages: ready, execution: ready, installs: ready, limits, blockedReasons, inventory: ready ? engine.inventory : null }); return;
      }
      if (closing) reject('Runner is stopping.', 503);
      if (path === '/v1/operations' && req.method === 'POST') {
        if (!ready) reject('Runner is unavailable. Check its capabilities.', 503);
        const request = validateOperation(JSON.parse((await readBody(req, 512 * 1024)).toString('utf8')));
        const fingerprint = hash(JSON.stringify(request));
        if (operations.has(request.requestId)) {
          const job = operations.get(request.requestId);
          if (job.fingerprint !== fingerprint) reject('Request ID reused with different content.', 409);
          send(res, snapshot(job)); return;
        }
        if (busy) reject('The isolated runner is busy. Retry after the current operation finishes.', 429);
        if (operations.size >= limits.retainedOperations) reject('Release or wait for retained runner results before starting another operation.', 429);
        const job = { id: request.requestId, request, fingerprint, inputs: [], output: [], status: 'preparing', updated: Date.now() };
        operations.set(job.id, job); busy = job.id; await save(job); send(res, snapshot(job), 201); return;
      }
      const match = /^\/v1\/operations\/([a-f0-9-]{36})(?:\/(start|cancel|inputs|outputs)(?:\/(\d+))?)?$/.exec(path);
      if (!match) reject('Runner route not found.', 404);
      const job = operations.get(match[1]); if (!job) reject('Operation not found or expired. Do not automatically replay code.', 404);
      const action = match[2], index = Number(match[3]);
      if (!action && req.method === 'GET') { send(res, snapshot(job)); return; }
      if (action === 'inputs' && req.method === 'PUT') {
        if (job.status !== 'preparing' || !Number.isSafeInteger(index) || !job.request.files[index]) reject('Input is not expected.', 409);
        const expected = job.request.files[index], bytes = await readBody(req, expected.size);
        if (job.status !== 'preparing') reject('Operation is no longer preparing.', 409);
        if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) reject('Input size or digest mismatch.');
        job.inputs[index] = bytes; job.updated = Date.now(); send(res, { accepted: true }); return;
      }
      if (action === 'start' && req.method === 'POST') {
        if (job.status !== 'preparing') { send(res, snapshot(job)); return; }
        if (job.request.files.some((_f, i) => !job.inputs[i])) reject('Upload all input files before starting.', 409);
        job.status = 'running'; await save(job); job.promise = run(job); send(res, snapshot(job), 202); return;
      }
      if (action === 'cancel' && req.method === 'POST') { await cancel(job); send(res, { status: job.status === 'running' ? 'cancelling' : job.status }); return; }
      if (action === 'outputs' && req.method === 'GET') {
        if (job.status !== 'complete' || !Number.isSafeInteger(index) || !job.output[index]) reject('Output is unavailable.', 404);
        const file = job.output[index]; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store' }); res.end(file.bytes); return;
      }
      if (!action && req.method === 'DELETE') {
        if (['preparing', 'running'].includes(job.status)) reject('Cancel the operation before releasing it.', 409);
        operations.delete(job.id); await unlink(join(stateDir, 'operations', `${job.id}.json`)); send(res, { released: true }); return;
      }
      reject('Runner route not found.', 404);
    } catch (error) { send(res, { error: error.status && error.status < 500 ? String(error.message).slice(0, 2500) : runnerFailure(error) }, error.status ?? (error instanceof SyntaxError ? 400 : 500)); }
  });
  server.maxHeadersCount = 30; server.headersTimeout = 10000; server.requestTimeout = 30000;
  const expiry = setInterval(() => {
    for (const job of operations.values()) {
      if (job.status === 'running' || Date.now() - job.updated < limits.retentionMs) continue;
      void (async () => { if (job.status === 'preparing') await cancel(job); operations.delete(job.id); await unlink(join(stateDir, 'operations', `${job.id}.json`)).catch(() => {}); })();
    }
  }, 30000).unref();
  try {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });
    let existing; try { existing = await lstat(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      const previous = await readFile(join(stateDir, 'socket-path'), 'utf8').catch(() => '');
      if (!existing.isSocket() || existing.uid !== process.getuid() || previous !== socketPath || await socketAlive(socketPath)) throw new Error('Socket path already exists. Operator inspection is required.');
      await unlink(socketPath);
    }
    await writeFile(join(stateDir, 'socket-path'), socketPath, { mode: 0o600 });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o660);
  } catch (error) { clearInterval(expiry); await unlink(lock).catch(() => {}); throw error; }
  return { socketPath, async close() {
    if (closing) return; closing = true; clearInterval(expiry);
    for (const job of operations.values()) await cancel(job);
    await Promise.allSettled([...operations.values()].map(job => job.promise));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await unlink(socketPath).catch(() => {}); await unlink(lock).catch(() => {});
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !process.env.RUNNER_STATE_DIR) throw new Error('Set XDG_RUNTIME_DIR and RUNNER_STATE_DIR for the dedicated runner account.');
  const app = await createRunner({ socketPath: process.env.RUNNER_SOCKET ?? join(runtime, 'common-chat-runner', 'api.sock'), stateDir: process.env.RUNNER_STATE_DIR,
    image: process.env.RUNNER_IMAGE ?? 'localhost/common-chat-worker:1' });
  console.log('Common Chat isolated runner is listening on its Unix socket.');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
