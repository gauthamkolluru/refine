const DEFAULT_SETTINGS = {
  enabled: true,
  toxicityThreshold: 0.7,
  maxComments: 50,
  backendUrl: "http://localhost:8787"
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
});
