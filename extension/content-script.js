const { DEFAULT_SETTINGS, log } = globalThis.DIPLOMAT;

const POSITIVE_HINTS = ["great", "love", "awesome", "thanks", "thank you", "nice", "cool"];
const MIN_COMMENT_LENGTH = 12;
const SHORT_POSITIVE_LENGTH = 80;
const MAX_CONCURRENCY = 2;

const BADGE_LABELS = {
  positive: "✓ Constructive",
  neutral: "🛠 Neutral",
  rewritten: "✨ Rewritten",
  toxic: "⚠ Aggressive",
  error: "⚠ Error"
};

let settings = { ...DEFAULT_SETTINGS };
const queue = [];
let inFlight = 0;
let observer = null;
const commentState = new WeakMap();

function getCommentTextNode(commentEl) {
  return commentEl.querySelector("#content-text");
}

function hasPositiveHint(text) {
  const lower = text.toLowerCase();
  return POSITIVE_HINTS.some((word) => lower.includes(word));
}

// Returns "positive" | "neutral" if we can decide without the backend,
// else null (caller must enqueue for analysis).
function classifyShort(text) {
  if (text.length < MIN_COMMENT_LENGTH) {
    return hasPositiveHint(text) ? "positive" : "neutral";
  }
  if (text.length < SHORT_POSITIVE_LENGTH && hasPositiveHint(text)) {
    return "positive";
  }
  return null;
}

function setBadge(commentEl, type) {
  const header = commentEl.querySelector("#header-author");
  if (!header) return;
  let badge = header.querySelector(".diplomat-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "diplomat-badge";
    header.appendChild(badge);
  }
  badge.dataset.badgeType = type;
  badge.textContent = BADGE_LABELS[type] || BADGE_LABELS.neutral;
}

function ensureActionButton(commentEl, onClick) {
  let button = commentEl.querySelector(".diplomat-action");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "diplomat-action";
    button.textContent = "View constructive version";
    commentEl.appendChild(button);
  }
  button.onclick = onClick;
  return button;
}

function applyEnabledState(enabled) {
  document.documentElement.dataset.diplomatEnabled = enabled ? "true" : "false";
  for (const commentEl of document.querySelectorAll("ytd-comment-thread-renderer")) {
    const state = commentState.get(commentEl);
    const textNode = state ? getCommentTextNode(commentEl) : null;
    if (!textNode) continue;
    if (enabled && state.status === "rewritten" && state.rewrittenText) {
      textNode.textContent = state.rewrittenText;
    } else if (!enabled) {
      textNode.textContent = state.originalText;
      textNode.classList.remove("diplomat-blur");
      const button = commentEl.querySelector(".diplomat-action");
      if (button) button.disabled = false;
    }
  }
}

function enqueueComment(commentEl) {
  if (!settings.enabled || commentState.has(commentEl)) return;
  const text = getCommentTextNode(commentEl)?.textContent?.trim();
  if (!text) return;

  const shortStatus = classifyShort(text);
  if (shortStatus) {
    commentState.set(commentEl, { originalText: text, rewrittenText: "", status: shortStatus });
    setBadge(commentEl, shortStatus);
    return;
  }

  commentState.set(commentEl, { originalText: text, rewrittenText: "", status: "pending" });
  queue.push(commentEl);
  processQueue();
}

function processQueue() {
  if (!settings.enabled) return;
  while (inFlight < MAX_CONCURRENCY && queue.length) {
    analyzeComment(queue.shift());
  }
}

async function analyzeComment(commentEl) {
  const state = commentState.get(commentEl);
  const textNode = state ? getCommentTextNode(commentEl) : null;
  if (!textNode) return;

  inFlight += 1;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "analyze",
      backendUrl: settings.backendUrl,
      payload: {
        text: state.originalText,
        threshold: settings.toxicityThreshold,
        llmBaseUrl: settings.llmBaseUrl,
        llmModel: settings.llmModel,
        llmApiKey: settings.llmApiKey
      }
    });
    if (!result?.ok) throw new Error(result?.error || "Analysis failed");

    const { toxicity = 0, rewrittenText = "" } = result.body || {};
    state.rewrittenText = rewrittenText;
    if (Number(toxicity) >= settings.toxicityThreshold) {
      state.status = "toxic";
      textNode.classList.add("diplomat-blur");
      setBadge(commentEl, "toxic");
      ensureActionButton(commentEl, () => rewriteComment(commentEl)).disabled = false;
    } else {
      state.status = hasPositiveHint(state.originalText) ? "positive" : "neutral";
      setBadge(commentEl, state.status);
    }
  } catch (error) {
    state.status = "error";
    setBadge(commentEl, "error");
    log.error("analyze comment failed", { error: error?.message });
  } finally {
    inFlight -= 1;
    processQueue();
  }
}

function rewriteComment(commentEl) {
  const state = commentState.get(commentEl);
  const textNode = state ? getCommentTextNode(commentEl) : null;
  if (!textNode || state.status === "rewritten") return;

  const rewrittenText = state.rewrittenText?.trim() || "Non-constructive criticism.";
  state.rewrittenText = rewrittenText;
  state.status = "rewritten";
  textNode.textContent = rewrittenText;
  textNode.classList.remove("diplomat-blur");
  setBadge(commentEl, "rewritten");

  const button = commentEl.querySelector(".diplomat-action");
  if (button) {
    button.disabled = true;
    button.textContent = "Constructive version shown";
  }
}

function processExistingComments() {
  const comments = Array.from(document.querySelectorAll("ytd-comment-thread-renderer"));
  for (const commentEl of comments.slice(0, settings.maxComments)) {
    enqueueComment(commentEl);
  }
}

function setupObserver() {
  if (observer) return;
  const commentsRoot = document.querySelector("#comments");
  if (!commentsRoot) return;

  observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.("ytd-comment-thread-renderer")) {
          enqueueComment(node);
        } else {
          node.querySelectorAll?.("ytd-comment-thread-renderer").forEach(enqueueComment);
        }
      }
    }
  });

  observer.observe(commentsRoot, { childList: true, subtree: true });
}

function injectToggle() {
  const commentsRoot = document.querySelector("#comments");
  if (!commentsRoot || document.querySelector("#diplomat-toggle")) return;

  const container = document.createElement("div");
  container.id = "diplomat-toggle";

  const label = document.createElement("label");
  label.className = "diplomat-toggle-label";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = settings.enabled;
  checkbox.addEventListener("change", () => {
    settings.enabled = checkbox.checked;
    chrome.runtime.sendMessage({ type: "setEnabled", enabled: settings.enabled });
    applyEnabledState(settings.enabled);
    if (settings.enabled) processExistingComments();
  });

  const text = document.createElement("span");
  text.textContent = "Diplomat mode";

  label.append(checkbox, text);
  container.append(label);
  commentsRoot.prepend(container);
}

function waitForComments() {
  const tick = () => {
    if (!document.querySelector("#comments")) {
      requestAnimationFrame(tick);
      return;
    }
    injectToggle();
    setupObserver();
    processExistingComments();
  };
  tick();
}

chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
  settings = { ...DEFAULT_SETTINGS, ...(response?.settings || {}) };
  applyEnabledState(settings.enabled);
  waitForComments();
});
