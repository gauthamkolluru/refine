const DEFAULT_SETTINGS = {
  enabled: true,
  toxicityThreshold: 0.7,
  maxComments: 50,
  backendUrl: "http://localhost:8787",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKey: ""
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    chrome.storage.sync.set(items);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getSettings") {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      sendResponse({ ok: true, settings: items });
    });
    return true;
  }

  if (message?.type === "setEnabled") {
    chrome.storage.sync.set({ enabled: message.enabled }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // Proxy the /analyze fetch through the service worker so it runs from the
  // extension's privileged context. Content-script fetches from public origins
  // (youtube.com) to loopback are blocked by Chrome's Local Network Access
  // checks regardless of host_permissions; service-worker fetches are not.
  if (message?.type === "analyze") {
    (async () => {
      try {
        const response = await fetch(`${message.backendUrl}/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload)
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          sendResponse({
            ok: false,
            error: body?.error || `HTTP ${response.status}`
          });
          return;
        }
        sendResponse({ ok: true, body });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || "fetch failed" });
      }
    })();
    return true;
  }
});
