const DEFAULT_SETTINGS = {
  enabled: true,
  toxicityThreshold: 0.7,
  maxComments: 50,
  backendUrl: "http://localhost:8787",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKey: ""
};

const POSITIVE_HINTS = ["great", "love", "awesome", "thanks", "thank you", "nice", "cool"];
const MIN_COMMENT_LENGTH = 12;
const MAX_CONCURRENCY = 2;

let settings = { ...DEFAULT_SETTINGS };
let queue = [];
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

function createBadge(commentEl, type) {
  const header = commentEl.querySelector("#header-author");
  if (!header) return;

  let badge = header.querySelector(".diplomat-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "diplomat-badge";
    header.appendChild(badge);
  }
  badge.dataset.badgeType = type;

  const labelMap = {
    positive: "✓ Constructive",
    neutral: "🛠 Neutral",
    rewritten: "✨ Rewritten",
    toxic: "⚠ Aggressive",
    error: "⚠ Error"
  };
  badge.textContent = labelMap[type] || "🛠 Neutral";
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

  const comments = document.querySelectorAll("ytd-comment-thread-renderer");
  comments.forEach((commentEl) => {
    const state = commentState.get(commentEl);
    if (!state) return;

    const textNode = getCommentTextNode(commentEl);
    if (!textNode) return;

    if (enabled) {
      if (state.rewrittenText && state.status === "rewritten") {
        textNode.textContent = state.rewrittenText;
      }
    } else {
      textNode.textContent = state.originalText;
      textNode.classList.remove("diplomat-blur");
      const button = commentEl.querySelector(".diplomat-action");
      if (button) button.disabled = false;
    }
  });
}

function shouldSkipComment(text) {
  if (text.length < MIN_COMMENT_LENGTH) return true;
  if (hasPositiveHint(text) && text.length < 80) return true;
  return false;
}

function enqueueComment(commentEl) {
  if (!settings.enabled) return;
  if (commentState.has(commentEl)) return;

  const textNode = getCommentTextNode(commentEl);
  if (!textNode) return;

  const text = textNode.textContent?.trim();
  if (!text) return;

  if (shouldSkipComment(text)) {
    commentState.set(commentEl, {
      originalText: text,
      rewrittenText: "",
      status: hasPositiveHint(text) ? "positive" : "neutral"
    });
    createBadge(commentEl, hasPositiveHint(text) ? "positive" : "neutral");
    return;
  }

  commentState.set(commentEl, {
    originalText: text,
    rewrittenText: "",
    status: "pending"
  });

  queue.push(commentEl);
  processQueue();
}

function processQueue() {
  if (!settings.enabled) return;
  while (inFlight < MAX_CONCURRENCY && queue.length) {
    const commentEl = queue.shift();
    analyzeComment(commentEl);
  }
}

async function analyzeComment(commentEl) {
  const state = commentState.get(commentEl);
  if (!state) return;
  const textNode = getCommentTextNode(commentEl);
  if (!textNode) return;

  inFlight += 1;
  try {
    const response = await fetch(`${settings.backendUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: state.originalText,
        threshold: settings.toxicityThreshold,
        llmBaseUrl: settings.llmBaseUrl,
        llmModel: settings.llmModel,
        llmApiKey: settings.llmApiKey
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload?.error || "Analysis failed");
    }

    const toxicity = Number(payload.toxicity ?? 0);
    state.rewrittenText = payload.rewrittenText || "";
    if (toxicity >= settings.toxicityThreshold) {
      state.status = "toxic";
      textNode.classList.add("diplomat-blur");
      createBadge(commentEl, "toxic");
      const button = ensureActionButton(commentEl, () =>
        rewriteComment(commentEl)
      );
      button.disabled = false;
    } else {
      state.status = hasPositiveHint(state.originalText) ? "positive" : "neutral";
      createBadge(commentEl, state.status);
    }
  } catch (error) {
    state.status = "error";
    createBadge(commentEl, "error");
  } finally {
    inFlight -= 1;
    processQueue();
  }
}

function rewriteComment(commentEl) {
  const state = commentState.get(commentEl);
  if (!state || state.status === "rewritten") return;
  const textNode = getCommentTextNode(commentEl);
  if (!textNode) return;

  const button = commentEl.querySelector(".diplomat-action");
  if (button) {
    button.disabled = true;
    button.textContent = "Showing rewrite...";
  }

  const rewrittenText =
    state.rewrittenText?.trim() || "Non-constructive criticism.";
  state.rewrittenText = rewrittenText;
  state.status = "rewritten";
  textNode.textContent = rewrittenText;
  textNode.classList.remove("diplomat-blur");
  createBadge(commentEl, "rewritten");
  if (button) {
    button.textContent = "Constructive version shown";
  }
}

function processExistingComments(limit = settings.maxComments) {
  const comments = Array.from(
    document.querySelectorAll("ytd-comment-thread-renderer")
  ).slice(0, limit);
  comments.forEach((commentEl) => enqueueComment(commentEl));
}

function setupObserver() {
  if (observer) return;

  const commentsRoot = document.querySelector("#comments");
  if (!commentsRoot) return;

  observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches?.("ytd-comment-thread-renderer")) {
          enqueueComment(node);
        } else {
          const newComments = node.querySelectorAll?.(
            "ytd-comment-thread-renderer"
          );
          newComments?.forEach((commentEl) => enqueueComment(commentEl));
        }
      });
    });
  });

  observer.observe(commentsRoot, {
    childList: true,
    subtree: true
  });
}

function injectToggle() {
  const commentsRoot = document.querySelector("#comments");
  if (!commentsRoot) return;

  if (document.querySelector("#diplomat-toggle")) return;

  const container = document.createElement("div");
  container.id = "diplomat-toggle";

  const label = document.createElement("label");
  label.className = "diplomat-toggle-label";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = settings.enabled;
  checkbox.addEventListener("change", () => {
    settings.enabled = checkbox.checked;
    chrome.runtime.sendMessage({
      type: "setEnabled",
      enabled: settings.enabled
    });
    applyEnabledState(settings.enabled);
    if (settings.enabled) {
      processExistingComments();
    }
  });

  const text = document.createElement("span");
  text.textContent = "Diplomat mode";

  label.appendChild(checkbox);
  label.appendChild(text);
  container.appendChild(label);

  commentsRoot.prepend(container);
}

function waitForComments() {
  const check = () => {
    const commentsRoot = document.querySelector("#comments");
    if (commentsRoot) {
      injectToggle();
      setupObserver();
      processExistingComments();
      return;
    }
    requestAnimationFrame(check);
  };
  check();
}

chrome.runtime.sendMessage({ type: "getSettings" }, (response) => {
  settings = { ...DEFAULT_SETTINGS, ...(response?.settings || {}) };
  applyEnabledState(settings.enabled);
  waitForComments();
});
