import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { limits } from './policy.mjs';

const label = 'org.common-chat.runner.owner';
function environment() {
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' };
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export class PodmanEngine {
  constructor({ owner, image, binary = 'podman' }) { this.owner = owner; this.image = image; this.binary = binary; }
  async command(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', size = 0;
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Podman command timed out.')); }, timeout);
      const consume = (key, chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { proc.kill('SIGKILL'); reject(new Error('Podman output exceeded its limit.')); return; }
        if (key === 'stdout') stdout += chunk; else stderr += chunk;
      };
      proc.stdout.on('data', chunk => consume('stdout', chunk)); proc.stderr.on('data', chunk => consume('stderr', chunk));
      proc.on('error', error => { clearTimeout(timer); reject(error); });
      proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Podman failed: ${stderr.slice(-1500) || code}`)); });
    });
  }
  async initialize() {
    const info = JSON.parse(await this.command(['info', '--format', 'json']));
    const host = info.host;
    if (!host?.security?.rootless || host.cgroupVersion !== 'v2' || !host.security.seccompEnabled || !['cpu', 'memory', 'pids'].every(c => host.cgroupControllers?.includes(c))) throw new Error('Runner requires rootless Podman, seccomp, and delegated cgroup v2 cpu/memory/pids.');
    const images = JSON.parse(await this.command(['image', 'inspect', this.image]));
    if (images[0]?.Config?.Labels?.['org.common-chat.runner.protocol'] !== '1' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(images[0]?.Id)) throw new Error('Build the documented Common Chat worker image first.');
    this.imageId = images[0].Id;
    const owned = (await this.command(['ps', '--all', '--filter', `label=${label}=${this.owner}`, '--format', '{{.ID}}'])).trim().split('\n').filter(Boolean);
    if (owned.length > 64) throw new Error('Too many abandoned runner containers. Operator inspection is required.');
    for (const id of owned) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid owned container identity.');
      await this.command(['rm', '--force', id]);
    }
  }
  async start({ operationId, registry }) {
    if (!this.imageId) throw new Error('Runner image is not ready.');
    const name = `common-chat-${this.owner.slice(0, 8)}-${operationId}`;
    const tmpfs = (path, size, executable = false) => ['--tmpfs', `${path}:rw,${executable ? 'exec' : 'noexec'},nosuid,nodev,size=${size},mode=1777`];
    const args = ['run', '--name', name, '--pull', 'never', '-i', '--log-driver', 'none',
      '--label', `${label}=${this.owner}`, '--label', `org.common-chat.runner.operation=${operationId}`,
      '--userns', 'keep-id:uid=1000,gid=1000', '--user', '1000:1000', '--hostname', 'worker',
      '--network', 'none', '--no-hosts', '--ipc', 'private', '--read-only', '--read-only-tmpfs=false',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1',
      '--memory', String(limits.memoryBytes), '--memory-swap', String(limits.memoryBytes), '--pids-limit', String(limits.pids),
      '--ulimit', 'nofile=256:256', '--ulimit', 'core=0:0', '--timeout', String(limits.containerSeconds), '--stop-timeout', '1',
      ...tmpfs('/workspace', limits.workspaceBytes, true), ...tmpfs('/deps', 512 * 1024 * 1024, true),
      ...tmpfs('/scratch', 256 * 1024 * 1024, true), ...tmpfs('/tmp', 128 * 1024 * 1024, true),
      ...tmpfs('/run', 16 * 1024 * 1024), '--shm-size', '16m'];
    args.push(this.imageId);
    const proc = spawn(this.binary, args, { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const worker = new Worker(this, proc, name, registry);
    try {
      const result = await worker.call({ op: 'hello' }, 20000);
      const cpu = result.cpu?.split(/\s+/).map(Number);
      if (result.uid !== 1000 || result.pid !== 1 || !result.noNewPrivileges || !result.seccomp || result.capabilities !== '0000000000000000' ||
          result.memory !== String(limits.memoryBytes) || result.swap !== '0' || result.pids !== String(limits.pids) || cpu?.length !== 2 || cpu[0] !== cpu[1] || !cpu[0]) throw new Error('Worker isolation or cgroup limit verification failed.');
      worker.isolation = result;
      return worker;
    } catch (error) { await worker.stop(); throw error; }
  }
}
class Worker {
  constructor(engine, proc, name, registry) {
    this.engine = engine; this.proc = proc; this.name = name; this.pending = new Map(); this.stderr = ''; this.buffer = ''; this.bytes = 0;
    this.registry = registry; this.registryTasks = new Set(); this.registryQueue = Promise.resolve();
    proc.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes).slice(-4000); });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      this.bytes += Buffer.byteLength(chunk); this.buffer += chunk;
      if (this.bytes > 96 * 1024 * 1024 || this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Worker protocol output exceeded its bound.')); void this.stop(); return; }
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const response = JSON.parse(line);
          if (response.event === 'registry') { this.registryRequest(response); continue; }
          const pending = this.pending.get(response.id);
          if (!pending) throw new Error('Unexpected worker response.');
          this.pending.delete(response.id); clearTimeout(pending.timer);
          response.ok ? pending.resolve(response.value) : pending.reject(new Error(String(response.error).slice(0, 2500)));
        } catch (error) { this.fail(error); void this.stop(); }
      }
    });
    proc.on('error', error => this.fail(error));
    proc.on('close', code => { this.closed = true; this.fail(new Error(`Worker exited (${code ?? 'signal'}). ${this.stderr}`)); });
    proc.stdin.on('error', error => this.fail(error));
  }
  async writeFrame(value) {
    if (this.proc.stdin.destroyed) throw new Error('Worker input is closed.');
    if (!this.proc.stdin.write(JSON.stringify(value) + '\n')) await once(this.proc.stdin, 'drain');
  }
  registryRequest(message) {
    if (!this.registry || this.registryTasks.size >= 16 || !/^[a-f0-9-]{36}$/.test(message.registryId)) throw new Error('Registry access is unavailable in this worker.');
    const access = this.registry;
    const task = this.registryQueue.then(async () => {
      const reply = await access.request({ method: message.method, path: message.path });
      const frame = { op: 'registry-response', registryId: message.registryId };
      await this.writeFrame({ ...frame, stage: 'start', status: reply.status, type: reply.type, size: reply.bytes.length });
      for (let offset = 0; offset < reply.bytes.length; offset += limits.chunkBytes) {
        await this.writeFrame({ ...frame, stage: 'chunk', data: reply.bytes.subarray(offset, offset + limits.chunkBytes).toString('base64') });
      }
      await this.writeFrame({ ...frame, stage: 'end' });
    });
    this.registryTasks.add(task);
    this.registryQueue = task.catch(() => {});
    void task.catch(error => { this.fail(error); void this.stop().catch(() => {}); }).finally(() => this.registryTasks.delete(task));
  }
  async sealRegistry() {
    this.registry?.close(); this.registry = null;
    await Promise.allSettled([...this.registryTasks]);
  }
  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  call(message, timeout = 10000) {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('Worker is closed.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Worker operation timed out.')); void this.stop(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...message, id }) + '\n');
    });
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.fail(new Error('Worker stopped.'));
      this.registry?.close(); this.registry = null;
      // rm --force kills the container/cgroup, including detached children.
      await this.engine.command(['rm', '--force', '--ignore', this.name], 15000);
      this.proc.stdin.destroy();
      if (!this.closed) this.proc.kill('SIGTERM');
    })();
    return this.stopping;
  }
}
