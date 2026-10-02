import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

const origin = 'http://127.0.0.1:43123';
const hosts = new Set(['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org']);
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address, prefix, 'ipv6');
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) { const first = parseInt(address.split(':')[0], 16); return first >= 0x2000 && first < 0x4000 && !blocked.check(address, 'ipv6'); }
  return false;
}
function allowedUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !hosts.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Registry destination denied.');
  return u;
}
function safePath(value) {
  if (!/^[A-Za-z0-9@._~%+/-]+$/.test(value) || value.includes('..') || /%25|%2e|%5c|%00/i.test(value)) throw new Error('Registry path denied.');
  return value;
}

// Only fixed GET/HEAD registry routes cross the bounded worker stdio protocol.
// There is no CONNECT proxy, host socket mount, or routable worker network.
export function registryAccess() {
  let closed = false, count = 0, transferred = 0;
  const outbound = new Set();
  async function download(value, accept, redirects = 0) {
    if (closed || ++count > 512 || redirects > 4) throw new Error('Registry request budget exceeded.');
    const u = allowedUrl(value);
    const answers = await lookup(u.hostname, { all: true, verbatim: true });
    if (closed || !answers.length || answers.some(a => !publicAddress(a.address))) throw new Error('Registry DNS destination denied.');
    const target = answers.find(a => a.family === 4) ?? answers[0];
    const result = await new Promise((resolve, reject) => {
      const req = https.request(u, { method: 'GET', agent: false, servername: u.hostname,
        lookup: (_hostname, options, cb) => options.all ? cb(null, [target]) : cb(null, target.address, target.family),
        headers: { Accept: accept, 'Accept-Encoding': 'identity', 'User-Agent': 'common-chat-runner/1' } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length; transferred += chunk.length;
          if (size > 64 * 1024 * 1024 || transferred > 256 * 1024 * 1024) { req.destroy(new Error('Registry byte budget exceeded.')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
        res.on('error', reject);
      });
      outbound.add(req); req.on('close', () => outbound.delete(req));
      req.setTimeout(20000, () => req.destroy(new Error('Registry request timed out.')));
      req.on('error', reject); req.end();
    });
    if ([301,302,303,307,308].includes(result.status)) {
      if (!result.location) throw new Error('Invalid registry redirect.');
      const redirect = allowedUrl(new URL(result.location, u));
      // A redirect is a new validated and pinned connection, never an open tunnel.
      return download(redirect, accept, redirects + 1);
    }
    if (result.status !== 200) throw new Error(`Registry returned HTTP ${result.status}. Package/version may be unavailable.`);
    return result;
  }
  async function request({ method, path }) {
    try {
      if (closed || !['GET', 'HEAD'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || path.length > 2048) throw new Error('Registry request denied.');
      const u = new URL(path, origin);
      if (u.search || u.hash || u.origin !== origin) throw new Error('Registry request denied.');
      let bytes, type = 'application/octet-stream';
      const index = /^\/pypi\/simple\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/$/.exec(u.pathname);
      if (index) {
        const reply = await download(`https://pypi.org/simple/${index[1]}/`, 'application/vnd.pypi.simple.v1+json');
        if (reply.body.length > 16 * 1024 * 1024) throw new Error('Package index is too large.');
        const data = JSON.parse(reply.body);
        if (!Array.isArray(data.files) || data.files.length > 50000) throw new Error('Invalid package index.');
        for (const file of data.files) {
          const source = allowedUrl(file.url);
          if (source.hostname !== 'files.pythonhosted.org' || !source.pathname.startsWith('/packages/') || source.search) throw new Error('External wheel destination is unsupported.');
          file.url = `${origin}/pypi/files${safePath(source.pathname)}${source.hash}`;
        }
        bytes = Buffer.from(JSON.stringify(data)); type = 'application/vnd.pypi.simple.v1+json';
      } else if (u.pathname.startsWith('/pypi/files/packages/')) {
        const reply = await download(`https://files.pythonhosted.org${safePath(u.pathname.slice('/pypi/files'.length))}`, 'application/octet-stream'); bytes = reply.body;
      } else if (u.pathname.startsWith('/npm/')) {
        const path = safePath(u.pathname.slice('/npm'.length));
        const reply = await download(`https://registry.npmjs.org${path}`, 'application/vnd.npm.install-v1+json');
        if (path.endsWith('.tgz')) bytes = reply.body;
        else {
          if (reply.body.length > 16 * 1024 * 1024) throw new Error('Package metadata is too large.');
          const data = JSON.parse(reply.body);
          const versions = data.versions ? Object.values(data.versions) : [data];
          if (versions.length > 50000) throw new Error('Package metadata is too large.');
          for (const version of versions) {
            if (!version.dist?.tarball) continue;
            const source = allowedUrl(version.dist.tarball);
            if (source.hostname !== 'registry.npmjs.org' || source.search) throw new Error('External npm tarballs are unsupported.');
            version.dist.tarball = `${origin}/npm${safePath(source.pathname)}`;
            for (const deps of [version.dependencies, version.optionalDependencies]) {
              if (deps && Object.values(deps).some(spec => typeof spec !== 'string' || /(?:https?:|git[+:]|file:|link:|workspace:)/i.test(spec))) throw new Error('URL, Git, and local package dependencies are unsupported.');
            }
          }
          bytes = Buffer.from(JSON.stringify(data)); type = 'application/json';
        }
      } else throw new Error('Registry route denied.');
      if (closed) throw new Error('Registry access ended.');
      return { status: 200, type, bytes: method === 'HEAD' ? Buffer.alloc(0) : bytes };
    } catch (error) {
      return { status: 502, type: 'text/plain', bytes: Buffer.from(String(error.message).slice(0, 200)) };
    }
  }
  return { request, close() {
    closed = true;
    for (const req of outbound) req.destroy();
  } };
}
