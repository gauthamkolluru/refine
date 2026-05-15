# Codebase Index — Diplomat Comments

Glossary / appendix for fast lookup. Keep entries terse. Update on every change
(add / delete / rename / move / signature / responsibility).

## Entry points

- **Extension service worker** — `extension/background.js:1` (`importScripts` shared module, then registers `onInstalled` + `onMessage` handlers).
- **Extension content script** — `extension/content-script.js` (consumes `globalThis.DIPLOMAT`; bottom block sends `getSettings`, hydrates `settings`, calls `waitForComments()`).
- **Backend HTTP server** — `backend/index.js` (`http.createServer` → listens on `PORT`, default `8787`).
- **Test harness — headless** — `test-harness/run-e2e.mjs` (`main()`).
- **Test harness — visible** — `test-harness/run-visible.mjs` (`main()`).

## Modules

### `extension/` — MV3 extension (no build step)

- **`extension/manifest.json`** — MV3 manifest. Permissions: `storage`. Hosts: `https://www.youtube.com/*`, `http://localhost/*`, `http://127.0.0.1/*` (loopback entries let the service worker proxy fetches to the backend). Content scripts load `shared/constants.js` + `shared/log.js` before `content-script.js` so the script gets `globalThis.DIPLOMAT` for free.
- **`extension/shared/constants.js`** — single source of truth for `DIPLOMAT.DEFAULT_SETTINGS` (`enabled`, `toxicityThreshold`, `maxComments`, `backendUrl`, `llmBaseUrl`, `llmModel`, `llmApiKey`). Shared via `importScripts` in the service worker and via the `content_scripts.js` array in the content script.
- **`extension/shared/log.js`** — `DIPLOMAT.log = { info, warn, error }`. One-line `[diplomat:level]` console output with optional structured context. Used by both `background.js` and `content-script.js`.
- **`extension/background.js`** — settings store + message router + `/analyze` proxy. Single `handlers` map keyed by `message.type`:
  - `getSettings` — returns merged storage settings.
  - `setEnabled` — persists `enabled` flag.
  - `analyze` — proxies `POST ${backendUrl}/analyze` from the extension's privileged context (sidesteps Chrome LNA). Returns `{ ok, body }` or `{ ok: false, error }`.
- **`extension/content-script.js`** — on-page DOM + analysis driving.
  - Constants — `POSITIVE_HINTS`, `MIN_COMMENT_LENGTH` (12), `SHORT_POSITIVE_LENGTH` (80), `MAX_CONCURRENCY` (2), `BADGE_LABELS`.
  - State — `settings`, `queue`, `inFlight`, `observer`, `commentState: WeakMap`.
  - `getCommentTextNode(commentEl)` / `hasPositiveHint(text)` — DOM/text helpers.
  - `classifyShort(text)` — returns `"positive" | "neutral" | null`. `null` ⇒ caller must enqueue for backend analysis.
  - `setBadge(commentEl, type)` — idempotent badge on `#header-author`. `type ∈ {positive, neutral, rewritten, toxic, error}`.
  - `ensureActionButton(commentEl, onClick)` — idempotent "View constructive version" button.
  - `applyEnabledState(enabled)` — flips `document.documentElement.dataset.diplomatEnabled`; restores original text when disabled.
  - `enqueueComment(commentEl)` — short-circuits via `classifyShort` or enqueues for backend.
  - `processQueue()` / `analyzeComment(commentEl)` — bounded-concurrency drain. `analyzeComment` sends `{type: "analyze", backendUrl, payload}` to the service worker.
  - `rewriteComment(commentEl)` — swaps `#content-text` to rewritten text, sets `rewritten` badge.
  - `processExistingComments` / `setupObserver` / `injectToggle` / `waitForComments` — bootstrap.
- **`extension/styles.css`** — `#diplomat-toggle`, `.diplomat-toggle-label`, `.diplomat-badge[data-badge-type=...]` (per-status colors), `.diplomat-action`, `.diplomat-blur`. Critically: `html[data-diplomat-enabled="false"] .diplomat-badge, .diplomat-action { display: none }` — that's how the "off" state hides UI without recomputing per-comment state.

### `backend/` — local Node HTTP proxy (no deps; built-ins only)

- **`backend/log.js`** — `{ info, warn, error }`. Emits one JSON object per line (ISO `ts`, `level`, `message`, ...context). `error` goes to stderr, everything else to stdout. Never call with secret material; pass metadata (lengths, IDs) only.
- **`backend/index.js`**
  - `PORT`, `DEFAULT_LLM_*` — env fallbacks; request-body values win over env.
  - `SYSTEM_PROMPT` — diplomat-editor persona for the LLM.
  - `BASE_CORS` / `PREFLIGHT_CORS` — single source of truth for CORS headers. `PREFLIGHT_CORS` adds `Access-Control-Allow-Methods` and `Access-Control-Allow-Private-Network: true` (Chrome 117+ PNA).
  - `sendJson(res, status, payload)` — JSON response with `BASE_CORS`.
  - `readJson(req)` — async-iterates body chunks.
  - `normalizeBaseUrl(baseUrl)` / `parseJsonFromContent(content)` — small helpers.
  - `analyzeAndRewrite({text, threshold, llmConfig})` — calls `${baseUrl}/chat/completions`; expects `{toxicity, rewrittenText}` JSON in the assistant message.
  - `handleAnalyze(req, res)` — body parsing + 400 on missing text + happy path.
  - HTTP server — `OPTIONS` returns `PREFLIGHT_CORS`; `POST /analyze` → `handleAnalyze`; 404 otherwise. Errors logged via `log.error`.

### `test-harness/` — ephemeral E2E (not committed: `node_modules/`, `.user-data*/`, `results/`)

- **`test-harness/package.json`** — Playwright devDep only; `npm test` → `node run-e2e.mjs`.
- **`test-harness/mock-llm.js`** — OpenAI-compatible Chat Completions stub on `MOCK_LLM_PORT` (default `1234`).
  - `TOXIC_KEYWORDS` — words that flip a comment to `toxicity: 0.95`. Anything else returns `0.15`. Edit here if you need different test cases.
  - `classify(userPrompt)` — pulls the comment out of the prompt and returns `{toxicity, rewrittenText}`.
- **`test-harness/fixtures/youtube-fake.html`** — minimal DOM (`#comments` + four `ytd-comment-thread-renderer` cases: short-positive, short-neutral, long-clean, long-toxic) mimicking what `content-script.js` selects.
- **`test-harness/setup.mjs`** — shared scaffolding (no asserts, no UI):
  - clears `PLAYWRIGHT_BROWSERS_PATH` (Cursor sandbox cache); dynamic-imports `playwright`.
  - `bootStack({mockLlmPort, backendPort})` — spawns mock LLM + real backend, waits for them, returns `{children, port, shutdown}`.
  - `attachSignalHandlers(shutdown, { hardTimeoutMs })` — wires `exit`/`SIGINT`/`SIGTERM` and optional hard-timeout.
  - `launchExtensionBrowser({userDataDir, headless, viewport})` — persistent-context Chromium with the unpacked extension loaded; `headless` toggles `--headless=new`.
  - `getServiceWorker(context)` — returns the extension SW (immediate or via `waitForEvent`).
  - `seedSettings(serviceWorker, settings)` — seeds `chrome.storage.sync` via the SW.
  - `interceptYouTube(page)` — `page.route("https://www.youtube.com/**", ...)` serves the fixture HTML for `/watch`, 204s for everything else.
- **`test-harness/run-e2e.mjs`** — headless orchestrator. Boots stack, sanity-probes backend, asserts PNA preflight contract, launches extension, intercepts YouTube, asserts toggle / classification / rewrite / toggle-off, captures three screenshots, prints summary.
- **`test-harness/run-visible.mjs`** — visible demo. Same shared scaffold but `headless: false`, no asserts, deliberate pauses between classify → rewrite → toggle-off for a human watcher.

## Data flow

```
YouTube page DOM
   │  (content-script.js)
   ├── classifyShort(text) → local "positive" | "neutral" badge
   └── chrome.runtime.sendMessage({type: "analyze", ...})
                            │
                            ▼
                  background.js service worker
                            │  POST {text, threshold, llmConfig}
                            ▼
                      backend /analyze
                            │  POST {messages}
                            ▼
              OpenAI-compatible /chat/completions
              (LM Studio in prod, mock-llm.js in tests)
   ↑
   └── chrome.runtime.sendMessage({type: "getSettings" | "setEnabled"})
                  → background.js → chrome.storage.sync
```

## Commands

- **Run backend** — `LLM_BASE_URL=… LLM_MODEL=… node backend/index.js`
- **Load extension** — `chrome://extensions` → Developer mode → Load unpacked → `extension/`
- **Run E2E test** — `cd test-harness && npm install && npx playwright install chromium && node run-e2e.mjs`
- **Run visible demo** — `cd test-harness && node run-visible.mjs`

## Conventions

- **Single source of truth**: `DEFAULT_SETTINGS` lives in `extension/shared/constants.js`. CORS headers live in `BASE_CORS` / `PREFLIGHT_CORS` in `backend/index.js`. Test scaffolding lives in `test-harness/setup.mjs`.
- **Status vocabulary** (`commentState.status`): `pending`, `positive`, `neutral`, `toxic`, `rewritten`, `error`. Matches keys in `BADGE_LABELS`.
- **Threshold** is 0–1, default `0.7`. Comments < `MIN_COMMENT_LENGTH` (12) or short + positive-hinted (< `SHORT_POSITIVE_LENGTH` = 80) are not sent to the backend.
- **Manifest scope**: content-script only loads on `https://www.youtube.com/*`. Test harness intercepts that origin instead of widening the manifest.
- **Logging**: backend uses `backend/log.js` (JSON per line). Extension uses `DIPLOMAT.log` (`[diplomat:level]` console). Never log secrets or full comment text — pass `textLength` / counts instead.

## Environment notes (test runs)

- Cursor's macOS sandbox blocks Chromium's own sandbox; Playwright launches must run with `required_permissions: ["all"]` (outside the Cursor sandbox).
- Cursor sets `PLAYWRIGHT_BROWSERS_PATH` to a sandbox-private cache that holds an x64 build. Outside the sandbox the machine is arm64; `setup.mjs` clears that env var so Playwright resolves to `~/Library/Caches/ms-playwright/` (arm64 build installed via `npx playwright install chromium`).
