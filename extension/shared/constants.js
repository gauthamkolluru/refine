// Shared between the service worker (background.js, via importScripts) and
// the content script (loaded ahead of content-script.js in manifest
// content_scripts.js). Single source of truth for runtime defaults.

globalThis.DIPLOMAT = globalThis.DIPLOMAT || {};

globalThis.DIPLOMAT.DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  toxicityThreshold: 0.7,
  maxComments: 50,
  backendUrl: "http://localhost:8787",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKey: ""
});
