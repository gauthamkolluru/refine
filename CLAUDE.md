# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Diplomat Comments** is a Chrome extension (Manifest V3) that detects toxic YouTube comments and rewrites them into constructive feedback using any OpenAI-compatible LLM API.

## Running the Backend

```bash
export LLM_BASE_URL="http://localhost:1234"   # or https://api.openai.com/v1
export LLM_MODEL="your-model-name"
export LLM_API_KEY="sk-..."                   # optional for LM Studio
node backend/index.js
# Listens on http://localhost:8787
```

There are no tests, no build step, and no package manager — the backend is a single plain Node.js file with no dependencies.

## Loading the Extension

1. Go to `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked**, select the `extension/` folder
3. Configure settings via the service worker DevTools console:

```js
chrome.storage.sync.set({
  llmBaseUrl: "http://localhost:1234",
  llmModel: "your-model-name",
  llmApiKey: "",
  backendUrl: "http://localhost:8787"
});
```

## Architecture

The system has two independent parts that communicate over HTTP:

### Backend (`backend/index.js`)
A minimal Node.js HTTP server (no frameworks). Exposes one endpoint:

- `POST /analyze` — accepts `{ text, threshold, llmBaseUrl, llmModel, llmApiKey }`, proxies to the configured LLM's `/chat/completions`, and returns `{ toxicity: number, rewrittenText: string }`.

LLM config can come from the request body (per-user) or fall back to server-level env vars. The LLM is prompted to return raw JSON; `parseJsonFromContent()` extracts it even if wrapped in prose.

### Extension (`extension/`)

- **`manifest.json`** — MV3, `storage` permission, YouTube-only host permission, no popup.
- **`background.js`** — Service worker. Owns `chrome.storage.sync` as the settings store. Responds to `getSettings` and `setEnabled` messages from the content script.
- **`content-script.js`** — All UI logic. Runs at `document_idle` on YouTube pages.
  - Uses `requestAnimationFrame` polling (`waitForComments`) to detect when `#comments` appears.
  - Attaches a `MutationObserver` on `#comments` to catch lazily-loaded comments.
  - Maintains per-comment state in a `WeakMap` (keyed by DOM element) to avoid reprocessing.
  - Enforces `MAX_CONCURRENCY = 2` parallel `/analyze` requests via a simple queue.
  - Skip logic: comments shorter than 12 chars or short positive comments (matching `POSITIVE_HINTS`) are classified locally without a backend call.
  - Toxic comments (`toxicity >= threshold`) get a CSS blur + "View constructive version" button; clicking replaces text with the LLM rewrite in place.
- **`styles.css`** — Styles for `.diplomat-badge`, `.diplomat-blur`, `.diplomat-action`, and `#diplomat-toggle`.

### Data / Settings

All settings live in `chrome.storage.sync`. Defaults (defined identically in both `background.js` and `content-script.js`):

| Key | Default |
|---|---|
| `enabled` | `true` |
| `toxicityThreshold` | `0.7` |
| `maxComments` | `50` |
| `backendUrl` | `http://localhost:8787` |
| `llmBaseUrl` | `""` |
| `llmModel` | `""` |
| `llmApiKey` | `""` |
