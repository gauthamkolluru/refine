const DEFAULT_SETTINGS = {
  enabled: true,
  toxicityThreshold: 0.7,
  maxComments: 50,
  backendUrl: "http://localhost:8787",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKey: ""
};

const FIELDS = [
  "backendUrl",
  "llmBaseUrl",
  "llmModel",
  "llmApiKey",
  "toxicityThreshold",
  "maxComments"
];

function showStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.style.color = isError ? "#a21414" : "#1f7a3e";
  if (!isError) {
    setTimeout(() => { el.textContent = ""; }, 2000);
  }
}

chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
  FIELDS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) el.value = items[key] ?? DEFAULT_SETTINGS[key];
  });
});

document.getElementById("save-btn").addEventListener("click", () => {
  const backendUrl = document.getElementById("backendUrl").value.trim();
  if (!backendUrl) {
    showStatus("Backend URL is required.", true);
    return;
  }

  const updates = {
    backendUrl,
    llmBaseUrl: document.getElementById("llmBaseUrl").value.trim(),
    llmModel:   document.getElementById("llmModel").value.trim(),
    llmApiKey:  document.getElementById("llmApiKey").value.trim(),
    toxicityThreshold: Math.min(1, Math.max(0, Number(document.getElementById("toxicityThreshold").value) || 0.7)),
    maxComments: Math.max(1, parseInt(document.getElementById("maxComments").value, 10) || 50)
  };

  chrome.storage.sync.set(updates, () => {
    if (chrome.runtime.lastError) {
      showStatus("Save failed: " + chrome.runtime.lastError.message, true);
      return;
    }
    showStatus("Saved!");
  });
});
