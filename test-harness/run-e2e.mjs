// End-to-end test for the Diplomat Comments Chrome extension.
//
// Flow:
//   1. boot a mock OpenAI-compatible LLM
//   2. boot the project's real backend pointed at the mock LLM
//   3. launch Chromium (persistent context) with the unpacked extension loaded
//   4. intercept https://www.youtube.com/* to serve a fake comments DOM
//      (the extension's manifest only injects on youtube.com)
//   5. wait for the content-script to classify each comment, assert badges +
//      blur + rewrite button behave as expected

// Cursor's shell sets PLAYWRIGHT_BROWSERS_PATH to a sandbox-private cache,
// but Chromium can't launch inside that sandbox (Chrome's own sandbox needs
// syscalls macOS denies). Clear it BEFORE we resolve playwright's binary path
// so the cached binary at ~/Library/Caches/ms-playwright is used instead.
// ESM imports are hoisted, so we must import playwright dynamically below.
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
const USER_DATA_DIR = path.join(__dirname, ".user-data");
const RESULTS_DIR = path.join(__dirname, "results");

const MOCK_LLM_PORT = 1234;
const BACKEND_PORT = 8787;

const children = [];
function spawnLogged(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${name}!] ${b}`));
  child.on("exit", (code) =>
    console.log(`[${name}] exited with code ${code}`)
  );
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  // SIGKILL as a backstop in case SIGTERM is ignored
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
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

// hard ceiling — never let this test silently burn time
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS || 90_000);
setTimeout(() => {
  console.error(`[runner] hard timeout after ${HARD_TIMEOUT_MS}ms, exiting`);
  shutdown();
  process.exit(2);
}, HARD_TIMEOUT_MS).unref();

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

const results = [];
function record(name, ok, details) {
  results.push({ name, ok, details });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}${details ? " — " + details : ""}`);
}

async function main() {
  console.log("==> booting mock LLM");
  spawnLogged("mock-llm", process.execPath, [path.join(__dirname, "mock-llm.js")], {
    MOCK_LLM_PORT: String(MOCK_LLM_PORT)
  });
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

  console.log("==> sanity-checking backend ↔ mock LLM");
  const probe = await fetch(`http://localhost:${BACKEND_PORT}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "you are an idiot and should shut up forever",
      threshold: 0.7,
      llmBaseUrl: `http://localhost:${MOCK_LLM_PORT}`,
      llmModel: "mock-model"
    })
  });
  const probeBody = await probe.json();
  record(
    "backend returns toxic verdict for known-bad comment",
    probe.ok && probeBody.toxicity >= 0.7 && probeBody.rewrittenText.length > 0,
    JSON.stringify(probeBody)
  );

  // Chrome 117+ enforces Private Network Access (PNA). Fetches from
  // https://www.youtube.com → http://localhost:8787 require the preflight to
  // include `Access-Control-Allow-Private-Network: true` and the right CORS
  // headers. If this fails, the extension is broken on modern Chrome even
  // though the in-browser test bypasses PNA via a flag.
  const preflight = await fetch(`http://localhost:${BACKEND_PORT}/analyze`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.youtube.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Private-Network": "true"
    }
  });
  const pnaAllowed = preflight.headers.get(
    "access-control-allow-private-network"
  );
  const corsOrigin = preflight.headers.get("access-control-allow-origin");
  record(
    "backend preflight allows Private Network Access from youtube.com",
    pnaAllowed === "true" && (corsOrigin === "*" || corsOrigin === "https://www.youtube.com"),
    `status=${preflight.status} ACAO=${corsOrigin} ACAPN=${pnaAllowed}`
  );

  console.log("==> launching Chromium with extension");
  // MV3 extensions don't load under Playwright's old headless mode, but they
  // do under Chrome's new headless. We tell Playwright headless:false so it
  // doesn't add --headless=old, then pass --headless=new explicitly.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    viewport: { width: 1280, height: 900 }
  });

  // wait for the extension's service worker so chrome.storage.sync is wired up
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  record("extension service worker started", Boolean(serviceWorker));

  // configure extension settings inside the service worker
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
  // intercept requests to youtube.com so the extension actually injects
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

  page.on("console", (msg) =>
    console.log(`[page:${msg.type()}] ${msg.text()}`)
  );
  page.on("pageerror", (err) =>
    console.log(`[page:error] ${err.message}`)
  );

  console.log("==> navigating to fake YouTube page");
  await page.goto("https://www.youtube.com/watch?v=test", {
    waitUntil: "domcontentloaded"
  });

  // give the content-script time to send getSettings + classify
  console.log("==> waiting for content-script to settle");
  try {
    await page.waitForSelector("#diplomat-toggle", { timeout: 5_000 });
    record("toggle injected above comments", true);
  } catch (err) {
    record("toggle injected above comments", false, err.message);
  }

  // short-positive should get the "positive" badge synchronously
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          "#c-short-positive .diplomat-badge"
        );
        return el && el.dataset.badgeType === "positive";
      },
      { timeout: 5_000 }
    );
    record("short positive comment gets positive badge", true);
  } catch (err) {
    record("short positive comment gets positive badge", false, err.message);
  }

  // short neutral should get the "neutral" badge synchronously
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          "#c-short-neutral .diplomat-badge"
        );
        return el && el.dataset.badgeType === "neutral";
      },
      { timeout: 5_000 }
    );
    record("short neutral comment gets neutral badge", true);
  } catch (err) {
    record("short neutral comment gets neutral badge", false, err.message);
  }

  // long clean should round-trip through backend and end up neutral
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#c-long-clean .diplomat-badge");
        return el && el.dataset.badgeType === "neutral";
      },
      { timeout: 15_000 }
    );
    record("long clean comment classified neutral via backend", true);
  } catch (err) {
    record(
      "long clean comment classified neutral via backend",
      false,
      err.message
    );
  }

  // long toxic should end up blurred + aggressive + have a rewrite button
  try {
    await page.waitForFunction(
      () => {
        const c = document.querySelector("#c-long-toxic");
        if (!c) return false;
        const badge = c.querySelector(".diplomat-badge");
        const blurred = c
          .querySelector("#content-text")
          ?.classList.contains("diplomat-blur");
        const button = c.querySelector(".diplomat-action");
        return (
          badge?.dataset.badgeType === "toxic" &&
          blurred &&
          button &&
          !button.disabled
        );
      },
      { timeout: 15_000 }
    );
    record("long toxic comment gets aggressive badge + blur + button", true);
  } catch (err) {
    record(
      "long toxic comment gets aggressive badge + blur + button",
      false,
      err.message
    );
  }

  await page.screenshot({
    path: path.join(RESULTS_DIR, "01-classified.png"),
    fullPage: true
  });

  // clicking the action button should swap in the rewritten text
  try {
    await page.click("#c-long-toxic .diplomat-action");
    await page.waitForFunction(
      () => {
        const c = document.querySelector("#c-long-toxic");
        const badge = c?.querySelector(".diplomat-badge");
        const text = c?.querySelector("#content-text")?.textContent || "";
        return (
          badge?.dataset.badgeType === "rewritten" &&
          text.toLowerCase().includes("video could be improved")
        );
      },
      { timeout: 5_000 }
    );
    record("clicking action swaps in rewritten text", true);
  } catch (err) {
    record("clicking action swaps in rewritten text", false, err.message);
  }

  await page.screenshot({
    path: path.join(RESULTS_DIR, "02-rewritten.png"),
    fullPage: true
  });

  // toggle off should restore original text + clear blur
  try {
    await page.click("#diplomat-toggle input[type=checkbox]");
    await page.waitForFunction(
      () => {
        const c = document.querySelector("#c-long-toxic");
        const text = c?.querySelector("#content-text")?.textContent || "";
        const blurred = c
          ?.querySelector("#content-text")
          ?.classList.contains("diplomat-blur");
        return text.toLowerCase().includes("worst video") && !blurred;
      },
      { timeout: 5_000 }
    );
    record("toggling diplomat mode off restores original comment", true);
  } catch (err) {
    record(
      "toggling diplomat mode off restores original comment",
      false,
      err.message
    );
  }

  // dump the post-test DOM state of each comment for debugging
  const dom = await page.evaluate(() => {
    const out = {};
    for (const c of document.querySelectorAll("ytd-comment-thread-renderer")) {
      const id = c.id;
      const badge = c.querySelector(".diplomat-badge");
      const text = c.querySelector("#content-text");
      const button = c.querySelector(".diplomat-action");
      out[id] = {
        badgeType: badge?.dataset.badgeType || null,
        badgeText: badge?.textContent || null,
        blurred: text?.classList.contains("diplomat-blur") || false,
        textPreview: (text?.textContent || "").slice(0, 80),
        buttonText: button?.textContent || null,
        buttonDisabled: button?.disabled ?? null
      };
    }
    return out;
  });
  console.log("==> final DOM snapshot:");
  console.log(JSON.stringify(dom, null, 2));

  await page.screenshot({
    path: path.join(RESULTS_DIR, "03-toggled-off.png"),
    fullPage: true
  });
  console.log(
    "==> screenshots saved to test-harness/results/{01-classified,02-rewritten,03-toggled-off}.png"
  );

  await context.close();
  shutdown();

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== summary ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  shutdown();
  process.exit(1);
});
