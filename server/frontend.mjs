import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'], ['.wasm', 'application/wasm'], ['.txt', 'text/plain; charset=utf-8']
]);

// Build a fixed route map. Requests never select an arbitrary filesystem path.
export function loadFrontend(directory) {
  if (!existsSync(join(directory, 'index.html'))) {
    return function serveBuildRequired(path, res) {
      if (!['/', '/index.html'].includes(path)) return false;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Common Chat build required</title><h1>Build the Common Chat frontend</h1><p>Install its build dependencies, then build the Svelte interface.</p><pre>npm --prefix ui ci --ignore-scripts\nnpm run build:ui</pre><p>Restart the server after the build.</p></html>');
      return true;
    };
  }
  const files = new Map();
  function visit(relative = '') {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && types.has(extname(entry.name))) {
        files.set(`/${name}`, { type: types.get(extname(entry.name)), bytes: readFileSync(join(directory, name)) });
      }
    }
  }
  visit();
  const index = files.get('/index.html');
  let identity = null;
  const identityFile = files.get('/frontend.json'), manifestFile = files.get('/frontend-manifest.json');
  if (identityFile && manifestFile) {
    const info = JSON.parse(identityFile.bytes.toString('utf8'));
    const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    const digest = createHash('sha256').update(manifestFile.bytes).digest('hex');
    if (info.manifestSha256 !== digest || info.sourceCommit !== manifest.sourceCommit || !Array.isArray(manifest.files)) {
      throw new Error('Frontend manifest does not match its build identity. Rebuild from the intended source.');
    }
    for (const entry of manifest.files) {
      const asset = files.get(`/${entry.path}`);
      if (!asset || asset.bytes.length !== entry.size || createHash('sha256').update(asset.bytes).digest('hex') !== entry.sha256) {
        throw new Error('Frontend assets do not match the build manifest. Rebuild from the intended source.');
      }
    }
    identity = { sourceCommit: info.sourceCommit, manifestSha256: digest };
  }
  const serveFrontend = function(path, res) {
    if (path === '/' || path === '/index.html') {
      const nonce = randomBytes(18).toString('base64');
      const html = index.bytes.toString('utf8')
        .replace('</head>', `<meta name="common-chat-csp-nonce" content="${nonce}"></head>`)
        .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`)
        .replace(/<style(?=[\s>])/g, `<style nonce="${nonce}"`);
      // Layout libraries use style attributes. Authored scripts still need an opaque sandbox.
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; script-src-elem 'self' 'nonce-${nonce}'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
      res.setHeader('Content-Type', index.type);
      res.end(html);
      return true;
    }
    const asset = files.get(path);
    if (!asset) return false;
    res.setHeader('Content-Type', asset.type);
    res.end(asset.bytes);
    return true;
  };
  serveFrontend.identity = identity;
  return serveFrontend;
}
