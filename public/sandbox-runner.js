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
      const diagramOnly = !html && !css && !js;
      if (diagramOnly) {
        // Style only the diagram canvas, not arbitrary HTML examples.
        const style = document.createElement('style');
        style.textContent = 'html, body { margin: 0; background: transparent; } .sandbox-diagram { display: grid; place-items: center; padding: 8px; } .sandbox-diagram > svg { display: block; max-width: 100%; height: auto; }';
        head.append(style); container.className = 'sandbox-diagram';
      }
      let layouts = 0, lastHeight = 0;
      if (diagramOnly) {
        // Emit a small number of numeric size updates, never parent commands.
        const observer = new ResizeObserver(() => {
          const height = Math.ceil(container.getBoundingClientRect().height);
          if (!Number.isFinite(height) || height <= 0 || height === lastHeight) return;
          if (layouts >= 16) { observer.disconnect(); return; }
          lastHeight = height; layouts++;
          port.postMessage({ type: 'common-chat-mermaid-layout', height });
        });
        observer.observe(container);
      }
      let dark = event.data.dark === true, api, rendering = false, version = 0;
      // Input styles and configuration still take priority over these defaults.
      async function renderDiagram() {
        if (!api || rendering) return;
        rendering = true;
        try {
          let renderedDark;
          do {
            renderedDark = dark;
            api.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: true, maxTextSize: 128 * 1024,
              theme: 'base', fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              themeVariables: { darkMode: dark, background: dark ? '#161616' : '#ffffff', primaryColor: dark ? '#303030' : '#eeeeee', primaryTextColor: dark ? '#fafafa' : '#0a0a0a', primaryBorderColor: dark ? '#b5b5b5' : '#707070', lineColor: dark ? '#b5b5b5' : '#707070', secondaryColor: dark ? '#404040' : '#f5f5f5', tertiaryColor: dark ? '#383838' : '#fafafa' },
            });
            const result = await api.render(`sandbox-diagram-${++version}`, mermaid);
            container.innerHTML = result.svg; result.bindFunctions?.(container);
          } while (renderedDark !== dark);
          report('status', 'Mermaid rendered in the sandbox.');
        } catch (error) { report('error', String(error.message || error)); }
        finally { rendering = false; }
      }
      port.onmessage = event => {
        if (event.data?.type !== 'common-chat-theme' || typeof event.data.dark !== 'boolean' || event.data.dark === dark) return;
        dark = event.data.dark; renderDiagram();
      };
      // Input styling and callbacks are allowed only inside this opaque sandbox.
      import(`${chatOrigin}/sandbox-mermaid.js`).then(({ default: loaded }) => { api = loaded; renderDiagram(); }).catch(error => report('error', String(error.message || error)));
    }
    report('status', 'Preview started.');
  }
  addEventListener('message', initialize);
})();
