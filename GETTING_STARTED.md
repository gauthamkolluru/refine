# Getting Started

This project uses a single LLM provider for both toxicity scoring and rewriting.
Each user must supply their own provider settings. For LM Studio local usage,
auth can be disabled and no API key is required.

## Quickstart

Minimum steps to go from zero to a working extension in your browser:

1. **Start the backend**
   ```bash
   export LLM_BASE_URL="http://localhost:1234"
   export LLM_MODEL="your-model-name"
   node backend/index.js
   ```
   You should see: `Diplomat backend running on http://localhost:8787`

2. **Load the extension**
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `extension/` folder
   - The blue **D** icon appears in your toolbar

3. **Configure settings**
   - Click the **D** toolbar icon
   - Fill in **LLM Base URL** and **LLM Model** (Backend URL defaults to `http://localhost:8787`)
   - Click **Save Settings**

4. **Test it**
   - Open any YouTube video with comments
   - Scroll to the comments section
   - Each comment gets a badge: ✓ Constructive, 🛠 Neutral, or ⚠ Aggressive

---

## Quicktest

Verify each layer works independently before testing end-to-end:

### 1. Test the backend directly
```bash
curl -s -X POST http://localhost:8787/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This video is absolute garbage and you should be ashamed",
    "threshold": 0.7,
    "llmBaseUrl": "http://localhost:1234",
    "llmModel": "your-model-name"
  }' | cat
```
Expected response shape:
```json
{"toxicity": 0.9, "rewrittenText": "This video did not meet my expectations..."}
```

### 2. Test the extension popup
- Click the **D** toolbar icon — the settings form should open
- Verify your saved values appear on re-open

### 3. Test comment analysis
- Navigate to a YouTube video
- If LLM settings are missing: comments show **⚙ Configure** badges
- If backend is running and settings are correct: comments show analysis badges within a few seconds
- For a toxic comment: a blur + **View constructive version** button appears; clicking it replaces the text with the LLM rewrite

### 4. Test the toggle
- The **Diplomat mode** checkbox above the comments section enables/disables the extension in real time
- Unchecking it restores all original comment text and hides badges

---

## Prerequisites

- Node.js 18+ (for the backend).
- A Chromium-based browser (Chrome, Edge, Brave, etc.).
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

The backend listens on `http://localhost:8787`. If `LLM_BASE_URL` or `LLM_MODEL`
are not set, a warning is printed at startup — the extension can still supply
these values per-request via the settings popup.

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

## Set extension settings

Click the **D** icon in the browser toolbar to open the settings popup.
Fill in your LLM Base URL, LLM Model, and (if required) API Key, then click **Save Settings**.

## Security notes

- Do not hardcode API keys in source code.
- Store keys locally in Chrome storage or in environment variables if you run your own backend.
- If you host a shared backend, add authentication and do not accept raw keys from untrusted clients.
