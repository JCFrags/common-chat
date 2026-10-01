import { readFileSync } from 'node:fs';

// This policy applies only to the preview document, never to the chat interface.
export const SANDBOX_FLAGS = 'allow-scripts allow-forms allow-modals allow-downloads allow-popups';
export function sandboxPolicy(origin, external = false) {
  const network = external ? ' http: https:' : '';
  return `default-src 'none'; sandbox ${SANDBOX_FLAGS}; script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${origin}/sandbox-mermaid.js${network}; style-src 'unsafe-inline' blob: data:${network}; img-src blob: data:${network}; font-src blob: data:${network}; media-src blob: data:${network}; connect-src ${external ? 'http: https: ws: wss:' : "'none'"}; frame-src blob: data:${network}; worker-src blob: data:; object-src 'none'; base-uri 'none'; form-action ${external ? 'http: https:' : "'none'"}; frame-ancestors ${origin}`;
}
export function sandboxDocument() {
  const bootstrap = readFileSync(new URL('../public/sandbox-runner.js', import.meta.url), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Code preview sandbox</title></head><body><script>${bootstrap}</script></body></html>`;
}
