// Runs only in the response-header sandbox at /sandbox. No chat APIs are exposed.
(() => {
  const chatOrigin = new URL(location.href).origin;
  function initialize(event) {
    if (event.source !== parent || event.origin !== chatOrigin || event.data?.type !== 'common-chat-preview' || !event.ports[0]) return;
    const { html = '', css = '', js = '', mermaid = '' } = event.data;
    if (![html, css, js, mermaid].every(value => typeof value === 'string' && value.length <= 128 * 1024)) return;
    removeEventListener('message', initialize);
    const port = event.ports[0];
    let count = 0;
    const report = (level, text) => {
      if (count++ < 100) port.postMessage({ level, text: String(text).slice(0, 2000) });
    };
    const printable = value => {
      try { return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
      catch { return '[Unserializable value]'; }
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level].bind(console);
      console[level] = (...args) => { report(level, args.map(printable).join(' ')); original(...args); };
    }
    const errors = () => {
      addEventListener('error', event => report('error', event.message || 'Script or resource error.'));
      addEventListener('unhandledrejection', event => report('error', printable(event.reason)));
    };
    // A response-header CSP and sandbox remain in force across document.write.
    // Keep arbitrary source out of the trusted parent document and script strings.
    document.open();
    errors();
    document.write(html || (mermaid ? '<!doctype html><html><body></body></html>' : '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app"><h1>Preview</h1><p>Edit HTML to build your example.</p></main></body></html>'));
    document.close();
    const head = document.head || document.documentElement;
    if (css) { const style = document.createElement('style'); style.textContent = css; head.append(style); }
    if (js) { const script = document.createElement('script'); if (event.data.module === true) script.type = 'module'; script.textContent = js; (document.body || head).append(script); }
    if (mermaid) {
      const container = document.createElement('div'); document.body.append(container);
      // Input styling and callbacks are allowed only inside this opaque sandbox.
      import(`${chatOrigin}/sandbox-mermaid.js`).then(async ({ default: api }) => {
        api.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: true, maxTextSize: 128 * 1024 });
        const result = await api.render('sandbox-diagram', mermaid);
        container.innerHTML = result.svg; result.bindFunctions?.(container);
        report('status', 'Mermaid rendered in the sandbox.');
      }).catch(error => report('error', String(error.message || error)));
    }
    report('status', 'Preview started.');
  }
  addEventListener('message', initialize);
})();
