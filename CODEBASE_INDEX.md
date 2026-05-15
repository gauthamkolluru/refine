# Codebase Index — Diplomat Comments

Glossary / appendix for fast lookup. Keep entries terse. Update on every change
(add / delete / rename / move / signature / responsibility).

## Entry points

- **Extension service worker** — `extension/background.js:11` (`chrome.runtime.onInstalled`) primes `chrome.storage.sync` with `DEFAULT_SETTINGS`.
- **Extension content script** — `extension/content-script.js:293` IIFE-ish bottom block: sends `getSettings`, hydrates `settings`, then `waitForComments()`.
- **Backend HTTP server** — `backend/index.js:107` `http.createServer` → listens on `PORT` (default `8787`).
- **Test harness runner** — `test-harness/run-e2e.mjs:62` `main()` orchestrates mock-LLM, backend, Chromium-with-extension.

## Modules

### `extension/` — MV3 extension (no build step)

- **`extension/manifest.json`** — MV3 manifest. Permissions: `storage`. Hosts: `https://www.youtube.com/*`, `http://localhost/*`, `http://127.0.0.1/*` (loopback entries are required for the service worker proxy fetch to the backend — see `background.js` `analyze` handler). Registers `background.js` service worker and injects `content-script.js` + `styles.css` at `document_idle`.
- **`extension/background.js`** — settings store + message router + `/analyze` proxy.
  - `DEFAULT_SETTINGS` *(const, L1)* — single source of truth for default config (`enabled`, `toxicityThreshold`, `maxComments`, `backendUrl`, `llmBaseUrl`, `llmModel`, `llmApiKey`). Duplicated in `content-script.js` (see DRY note below).
  - `chrome.runtime.onInstalled` *(L11)* — backfills missing keys in `chrome.storage.sync`.
  - `chrome.runtime.onMessage` *(L17)* — message router.
    - `type: "getSettings"` → returns merged storage settings.
    - `type: "setEnabled"` → persists `enabled` flag.
    - `type: "analyze"` → proxies `POST ${backendUrl}/analyze` from the extension's privileged context (sidesteps Chrome LNA on the content-script side). Returns `{ ok, body }` or `{ ok: false, error }`.
- **`extension/content-script.js`** — all on-page UI + analysis-driving logic.
  - `DEFAULT_SETTINGS` *(L1)* — local copy; merged with response from service worker.
  - `POSITIVE_HINTS`, `MIN_COMMENT_LENGTH`, `MAX_CONCURRENCY` *(L11-13)* — skip / queue heuristics.
  - `commentState: WeakMap<HTMLElement, {originalText, rewrittenText, status}>` *(L20)* — per-comment state machine: `pending → toxic | positive | neutral | rewritten | error`.
  - `getCommentTextNode(commentEl)` *(L22)* — resolves `#content-text` inside a `ytd-comment-thread-renderer`.
  - `hasPositiveHint(text)` *(L26)* — true if text contains any `POSITIVE_HINTS` word.
  - `createBadge(commentEl, type)` *(L31)* — idempotent badge attached to `#header-author`. `type ∈ {positive, neutral, rewritten, toxic, error}`.
  - `ensureActionButton(commentEl, onClick)` *(L53)* — idempotent "View constructive version" button.
  - `applyEnabledState(enabled)` *(L66)* — flips `document.documentElement.dataset.diplomatEnabled`; restores original text when disabled.
  - `shouldSkipComment(text)` *(L90)* — skip heuristic (too short, or short + positive hint).
  - `enqueueComment(commentEl)` *(L96)* — classifies short comments locally; queues the rest.
  - `processQueue()` *(L126)* — drains queue up to `MAX_CONCURRENCY`.
  - `analyzeComment(commentEl)` *(L134)* — sends `{type: "analyze", backendUrl, payload}` via `chrome.runtime.sendMessage` to the service worker, which performs the actual `POST ${backendUrl}/analyze`. Mutates state + DOM with the verdict.
  - `rewriteComment(commentEl)` *(L182)* — swaps `#content-text` to `state.rewrittenText`, sets `rewritten` badge.
  - `processExistingComments(limit)` *(L206)* — initial pass over `ytd-comment-thread-renderer` nodes.
  - `setupObserver()` *(L213)* — `MutationObserver` on `#comments` for lazy-loaded comments.
  - `injectToggle()` *(L242)* — prepends `#diplomat-toggle` inside `#comments`; click toggles `enabled` via `setEnabled` message.
  - `waitForComments()` *(L279)* — rAF poll until `#comments` exists, then `injectToggle + setupObserver + processExistingComments`.
- **`extension/styles.css`** — `#diplomat-toggle`, `.diplomat-toggle-label`, `.diplomat-badge[data-badge-type=...]`, `.diplomat-action`, `.diplomat-blur`, and global hide via `html[data-diplomat-enabled="false"]`.

### `backend/` — local Node HTTP proxy (no deps; built-ins only)

- **`backend/index.js`**
  - `PORT`, `DEFAULT_LLM_*` *(L3-6)* — env fallbacks; request body wins over env (see `analyzeAndRewrite`).
  - `SYSTEM_PROMPT` *(L8)* — diplomat-editor persona for the LLM.
  - `sendJson(res, status, payload)` *(L13)* — JSON response with permissive CORS.
  - `readJson(req)` *(L23)* — async-iterates body chunks.
  - `normalizeBaseUrl(baseUrl)` *(L31)* — trim + strip trailing slashes.
  - `parseJsonFromContent(content)` *(L35)* — tolerant JSON extractor for LLM output (handles fenced / wrapped JSON).
  - `analyzeAndRewrite({text, threshold, llmConfig})` *(L49)* — calls `${baseUrl}/chat/completions` with system + user prompt; expects `{toxicity, rewrittenText}` JSON in the assistant message.
  - HTTP server *(L107)* — CORS preflight on `OPTIONS` (includes `Access-Control-Allow-Private-Network: true` for Chrome 117+ PNA); only route is `POST /analyze`; 404 otherwise.

### `test-harness/` — ephemeral E2E (not committed)

- **`test-harness/package.json`** — Playwright devDep only; `npm test` → `node run-e2e.mjs`.
- **`test-harness/mock-llm.js`** — OpenAI-compatible Chat Completions stub on `MOCK_LLM_PORT` (default `1234`). Keyword-based classifier (`TOXIC_KEYWORDS`) returns deterministic `{toxicity, rewrittenText}` JSON inside the assistant message.
- **`test-harness/fixtures/youtube-fake.html`** — minimal DOM (`#comments` + four `ytd-comment-thread-renderer` cases: short-positive, short-neutral, long-clean, long-toxic) mimicking what `content-script.js` selects.
- **`test-harness/run-visible.mjs`** — visible demo (Phase B). Same scaffold as `run-e2e.mjs` but `headless: false`, fewer asserts, deliberate pauses between classify → rewrite → toggle-off so a human can watch each state.
- **`test-harness/run-e2e.mjs`** — headless orchestrator.
  - clears `PLAYWRIGHT_BROWSERS_PATH` (set by Cursor sandbox) and dynamic-imports `playwright` so the locally-installed arm64 Chromium is used.
  - hard timeout (`HARD_TIMEOUT_MS`, default 90s) + SIGKILL backstop on shutdown so a hung Chromium never burns time.
  - boots `mock-llm.js` + `backend/index.js` as child processes.
  - asserts backend ↔ mock LLM happy path AND that the backend preflight includes `Access-Control-Allow-Private-Network: true`.
  - launches `chromium.launchPersistentContext` headless via `--headless=new` with `--load-extension=extension/` (no PNA/LNA feature flags — the extension proxies fetches through the service worker so the browser's LNA checks on the page no longer apply).
  - seeds `chrome.storage.sync` via the extension's service worker.
  - intercepts `https://www.youtube.com/**` via `page.route` to serve the fixture (manifest only injects on YouTube).
  - asserts: toggle injected, positive / neutral / toxic / rewrite-on-click flows, toggle-off restoration.
  - screenshots at three phases: `results/01-classified.png`, `results/02-rewritten.png`, `results/03-toggled-off.png`.

## Data flow

```
YouTube page DOM
   │  (content-script.js)
   ├── short-circuit heuristics (length / positive hints) → local badge
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

## Conventions / known constraints

- **DRY note**: `DEFAULT_SETTINGS` is duplicated between `extension/background.js:1` and `extension/content-script.js:1`. Keep them in sync until a shared module is introduced.
- **Status vocabulary** (`commentState.status`): `pending`, `positive`, `neutral`, `toxic`, `rewritten`, `error`. Match in `createBadge` label map.
- **Threshold** is 0–1, default `0.7`. Comments < `MIN_COMMENT_LENGTH` (12) or short + positive-hinted (< 80 chars) are not sent to the backend.
- **CORS**: backend returns `Access-Control-Allow-Origin: *` so content-script fetches (origin = `youtube.com`) work.
- **Manifest scope**: content-script only loads on `https://www.youtube.com/*`. Test harness intercepts that origin instead of widening the manifest.
- **Logging**: backend currently has only one `console.log` (boot). Per `agent-logging-standards.mdc`, structured logging should be introduced when the project grows beyond single-file modules; defer until an actual feature needs it (YAGNI).

## Environment notes (test runs)

- Cursor's macOS sandbox blocks Chromium's own sandbox; Playwright launches must run with `required_permissions: ["all"]` (outside the Cursor sandbox).
- Cursor sets `PLAYWRIGHT_BROWSERS_PATH` to a sandbox-private cache that holds an x64 build. Outside the sandbox the machine is arm64; `run-e2e.mjs` clears that env var so Playwright resolves to `~/Library/Caches/ms-playwright/` (arm64 build installed via `npx playwright install chromium`).
