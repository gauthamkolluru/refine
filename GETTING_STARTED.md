# Getting Started

This project uses a single LLM provider for both toxicity scoring and rewriting.
Each user must supply their own provider settings. For LM Studio local usage,
auth can be disabled and no API key is required.

## Prerequisites

- Node.js 18+ (for the backend).
- A Chrome browser.
- An LLM model available in LM Studio (or an API key for a hosted provider).

## Configure your LLM provider

The backend expects an OpenAI-compatible Chat Completions API. Examples:

- LM Studio local: `http://localhost:1234`
- OpenAI: `https://api.openai.com/v1`
- Compatible gateways: your provider's OpenAI-compatible base URL

You will need:
- `llmBaseUrl` (API base URL, e.g. `http://localhost:1234`)
- `llmModel` (model name as shown in LM Studio)
- `llmApiKey` (optional for LM Studio; required for hosted providers)

## Run the backend (local)

```bash
export LLM_BASE_URL="http://localhost:1234"
export LLM_MODEL="your-local-model-name"
node backend/index.js
```

The backend listens on `http://localhost:8787`.

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

## Set extension settings

Open the extension’s service worker console:

1. Go to `chrome://extensions`
2. Find **Diplomat Comments**
3. Click **Service worker** (inspect)
4. Run:

```js
chrome.storage.sync.set({
  llmBaseUrl: "http://localhost:1234",
  llmModel: "your-local-model-name",
  llmApiKey: "",
  backendUrl: "http://localhost:8787"
});
```

## Security notes

- Do not hardcode API keys in source code.
- Store keys locally in Chrome storage or in environment variables if you run your own backend.
- If you host a shared backend, add authentication and do not accept raw keys from untrusted clients.
