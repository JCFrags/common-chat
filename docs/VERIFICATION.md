# Release verification

STE-style, not verified for ASD-STE100 compliance.

## Result

| Check | Result | Evidence |
| --- | --- | --- |
| Node unit, HTTP integration, and operational tests | 38 passed. No failures or skipped tests. | `verification/node-tests.tap` |
| Native CLI startup | Passed fresh-data startup, six static assets, sign-in, conversation creation, health check, and shutdown. | `verification/cli-smoke.json` |
| JavaScript syntax | 24 modules passed `node --check`. | `verification/syntax-check.txt` |
| Offline browser UI checks | Seven passed across desktop and mobile fixtures. | `verification/ui-fixture-results.json` |
| Full HTTP browser acceptance | Blocked before the first page loaded. No acceptance pass is claimed. | Managed Chromium returned `net::ERR_BLOCKED_BY_ADMINISTRATOR`. |
| Live model servers | Not tested. | No actual model endpoint was supplied or configured. |
| Docker image and Compose deployment | Not tested. | Docker was unavailable. |
| HTTPS proxy deployment | Not tested. | The local test server used loopback HTTP. |
| Independent security audit | Not performed. | Security checks are implementation tests, not an audit. |

The tested runtime was Node.js 22.16.0 on Linux. Its SQLite engine reported version 3.49.1. Browser fixture tests used Playwright 1.57.0 with system Chromium.

## Executed backend checks

The Node suite uses real local HTTP connections to the application and a simulated model endpoint. It does not load model weights. Provider replies deliberately include streamed text, reasoning, Unicode, ordinary JSON, errors, redirects, malformed records, and truncated streams.

The tests verify shared history through separately authenticated clients. They disconnect an event stream while generation continues. They verify cancellation, idempotent retries, conflicting requests, branch edits, regeneration, attachment ownership, image payloads, and capability rejection.

The import tests exercise legacy JSON, current JSONL, and ZIP data. They verify native export and reimport, graph validation, rollback, source preservation, and invalid UTF-8 rejection. ZIP tests cover bounds and checksum validation.

The operational tests cover offline backup, restore, file checksums, encrypted keys, password hashes, and the data directory lock. A process test sends SIGKILL during generation. After restart, it verifies committed partial output, interrupted status, session persistence, and successful reuse of the encrypted provider key.

These checks do not establish compatibility with every OpenAI-compatible implementation. The renderer also lacks full upstream feature parity.

## Browser test distinction

`tests/browser_test.py` starts the application and a simulated model server. It then attempts to use real HTTP pages in desktop and mobile browser contexts. Managed Chromium policy blocked the initial loopback navigation in this environment. The browser policy was left unchanged.

`tests/ui_fixture_test.py` performs a separate offline test. It loads the actual interface, CSS, and JavaScript into a blank browser document. Fetch and event responses come from in-memory fixtures. It does not make local or external network requests.

The offline checks cover sign-in, model selection, message submission, response rendering, prompt clearing, settings, regeneration, editing, branch navigation, and connection controls. They also check desktop and mobile overflow and JavaScript errors.

The fixture screenshots are `previews/desktop.png` and `previews/mobile.png`. Their messages and model names are simulated content. They do not show a live model session.

The offline checks do not validate HTTP cookies, CSP enforcement, actual SSE reconnects in the browser, or real browser downloads. Backend HTTP tests cover some corresponding server behavior. The supplied full browser suite still needs execution in a permitted browser environment.

## Reproduce the Node tests

```sh
npm test
npm run check
```

## Reproduce browser tests

Python and Playwright are optional test dependencies. They are not application runtime requirements.

1. Install the optional test dependencies.

```sh
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

2. Run the full browser acceptance test in an environment that permits local HTTP navigation.

```sh
python tests/browser_test.py
```

3. Run the separate offline fixture test.

```sh
python tests/ui_fixture_test.py
```

`CHROMIUM_PATH` can specify an existing Chromium executable. `BROWSER_ARTIFACTS` can specify an output directory. Neither variable disables browser policy. The scripts use temporary server data and synthetic credentials.

## Release acceptance still required

A deployment should verify the supplied browser suite, the selected live model endpoint, and the chosen TLS or tunnel configuration. It should also verify backup restoration on its actual storage system. The supplied Docker files require a build and startup check on the deployment host.
