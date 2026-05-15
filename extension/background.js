importScripts("shared/constants.js", "shared/log.js");

const { DEFAULT_SETTINGS, log } = globalThis.DIPLOMAT;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    chrome.storage.sync.set(items, () => {
      log.info("settings backfilled", { keys: Object.keys(items) });
    });
  });
});

const handlers = {
  getSettings: (_message, sendResponse) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
      sendResponse({ ok: true, settings });
    });
  },

  setEnabled: (message, sendResponse) => {
    chrome.storage.sync.set({ enabled: message.enabled }, () => {
      sendResponse({ ok: true });
    });
  },

  // Proxy the /analyze fetch through the service worker so it runs from the
  // extension's privileged context. Content-script fetches from public origins
  // (youtube.com) to loopback are blocked by Chrome's Local Network Access
  // checks regardless of host_permissions; service-worker fetches are not.
  analyze: async (message, sendResponse) => {
    try {
      const response = await fetch(`${message.backendUrl}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = body?.error || `HTTP ${response.status}`;
        log.warn("analyze backend error", { status: response.status, error });
        sendResponse({ ok: false, error });
        return;
      }
      sendResponse({ ok: true, body });
    } catch (err) {
      const error = err?.message || "fetch failed";
      log.error("analyze fetch failed", { error });
      sendResponse({ ok: false, error });
    }
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sendResponse);
  return true;
});
