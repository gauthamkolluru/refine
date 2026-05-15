// Phase B: visible end-to-end demo for the Diplomat Comments extension.
//
// Same scaffold as run-e2e.mjs (mock LLM + real backend + intercepted fake
// YouTube page) but with the browser window visible and built-in pauses so a
// human can watch the high-signal moments:
//   1. four comments classified  → badges + blur appear
//   2. clicking the rewrite button → original toxic text replaced by LLM rewrite
//   3. toggling Diplomat mode off → original text restored, badges hidden
//
// Run with:
//   PLAYWRIGHT_BROWSERS_PATH= node test-harness/run-visible.mjs
// (the script clears that env var internally too, but the explicit form helps
// when running inside Cursor's shell.)

delete process.env.PLAYWRIGHT_BROWSERS_PATH;

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import("playwright");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
const USER_DATA_DIR = path.join(__dirname, ".user-data-visible");

const MOCK_LLM_PORT = 1234;
const BACKEND_PORT = 8787;

// pause lengths chosen so the user can read each state without it dragging
const PAUSE = {
  afterClassify: 4000,
  afterRewrite: 4000,
  afterToggleOff: 3000
};

const children = [];
function spawnLogged(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${name}!] ${b}`));
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
  }, 1500).unref();
}
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

async function waitForHttp(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "OPTIONS" });
      if (res.ok || res.status === 204 || res.status === 404) return;
    } catch {}
    await wait(150);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function main() {
  console.log("==> booting mock LLM");
  spawnLogged(
    "mock-llm",
    process.execPath,
    [path.join(__dirname, "mock-llm.js")],
    { MOCK_LLM_PORT: String(MOCK_LLM_PORT) }
  );
  await waitForHttp(`http://localhost:${MOCK_LLM_PORT}/chat/completions`);

  console.log("==> booting diplomat backend");
  spawnLogged(
    "backend",
    process.execPath,
    [path.join(REPO_ROOT, "backend", "index.js")],
    {
      PORT: String(BACKEND_PORT),
      LLM_BASE_URL: `http://localhost:${MOCK_LLM_PORT}`,
      LLM_MODEL: "mock-model",
      LLM_API_KEY: ""
    }
  );
  await waitForHttp(`http://localhost:${BACKEND_PORT}/analyze`);

  console.log("==> launching visible Chromium with extension");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    viewport: { width: 1100, height: 800 }
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", {
      timeout: 10_000
    });
  }

  await serviceWorker.evaluate(
    async ({ backendUrl, llmBaseUrl, llmModel }) => {
      await new Promise((resolve) =>
        chrome.storage.sync.set(
          {
            enabled: true,
            toxicityThreshold: 0.7,
            maxComments: 50,
            backendUrl,
            llmBaseUrl,
            llmModel,
            llmApiKey: ""
          },
          () => resolve()
        )
      );
    },
    {
      backendUrl: `http://localhost:${BACKEND_PORT}`,
      llmBaseUrl: `http://localhost:${MOCK_LLM_PORT}`,
      llmModel: "mock-model"
    }
  );

  const fakeHtml = await readFile(
    path.join(__dirname, "fixtures", "youtube-fake.html"),
    "utf8"
  );

  const page = await context.newPage();
  await page.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/watch")) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fakeHtml
      });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });

  console.log("==> navigating to fake YouTube page");
  await page.goto("https://www.youtube.com/watch?v=test", {
    waitUntil: "domcontentloaded"
  });

  console.log("==> demo step 1: waiting for classification");
  await page.waitForFunction(
    () => {
      const toxic = document.querySelector("#c-long-toxic .diplomat-badge");
      const clean = document.querySelector("#c-long-clean .diplomat-badge");
      return (
        toxic?.dataset.badgeType === "toxic" &&
        clean?.dataset.badgeType === "neutral"
      );
    },
    { timeout: 15_000 }
  );
  console.log(`    → badges + blur visible; holding for ${PAUSE.afterClassify}ms`);
  await wait(PAUSE.afterClassify);

  console.log("==> demo step 2: clicking 'View constructive version'");
  await page.click("#c-long-toxic .diplomat-action");
  await page.waitForFunction(
    () => {
      const badge = document.querySelector("#c-long-toxic .diplomat-badge");
      return badge?.dataset.badgeType === "rewritten";
    },
    { timeout: 5_000 }
  );
  console.log(`    → toxic comment replaced; holding for ${PAUSE.afterRewrite}ms`);
  await wait(PAUSE.afterRewrite);

  console.log("==> demo step 3: toggling Diplomat mode off");
  await page.click("#diplomat-toggle input[type=checkbox]");
  await page.waitForFunction(
    () => {
      const text =
        document.querySelector("#c-long-toxic #content-text")?.textContent ||
        "";
      return text.toLowerCase().includes("worst video");
    },
    { timeout: 5_000 }
  );
  console.log(
    `    → original text restored, badges hidden; holding for ${PAUSE.afterToggleOff}ms`
  );
  await wait(PAUSE.afterToggleOff);

  await context.close();
  shutdown();
  console.log("\nvisible demo complete");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  shutdown();
  process.exit(1);
});
