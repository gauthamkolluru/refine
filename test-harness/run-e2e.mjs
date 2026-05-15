// Headless end-to-end test for the Diplomat Comments Chrome extension.
// See setup.mjs for the shared scaffolding (LLM mock, backend boot,
// Chromium launch with extension, youtube.com interception).

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootStack,
  attachSignalHandlers,
  launchExtensionBrowser,
  getServiceWorker,
  seedSettings,
  interceptYouTube
} from "./setup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, ".user-data");
const RESULTS_DIR = path.join(__dirname, "results");

const results = [];
function record(name, ok, details) {
  results.push({ name, ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${details ? " — " + details : ""}`);
}

async function expect(name, fn, timeoutMs = 15_000) {
  try {
    await fn(timeoutMs);
    record(name, true);
  } catch (err) {
    record(name, false, err.message);
  }
}

async function main() {
  console.log("==> booting mock LLM + backend");
  const { port, shutdown } = await bootStack();
  attachSignalHandlers(shutdown, { hardTimeoutMs: 90_000 });

  console.log("==> sanity-checking backend ↔ mock LLM");
  const probe = await fetch(`http://localhost:${port.backend}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "you are an idiot and should shut up forever",
      threshold: 0.7,
      llmBaseUrl: `http://localhost:${port.mockLlm}`,
      llmModel: "mock-model"
    })
  });
  const probeBody = await probe.json();
  record(
    "backend returns toxic verdict for known-bad comment",
    probe.ok && probeBody.toxicity >= 0.7 && probeBody.rewrittenText.length > 0,
    JSON.stringify(probeBody)
  );

  // Chrome 117+ enforces Private Network Access. The extension only works
  // on modern Chrome if the backend preflight opts in via this header.
  const preflight = await fetch(`http://localhost:${port.backend}/analyze`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.youtube.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Private-Network": "true"
    }
  });
  const acapn = preflight.headers.get("access-control-allow-private-network");
  const acao = preflight.headers.get("access-control-allow-origin");
  record(
    "backend preflight allows Private Network Access from youtube.com",
    acapn === "true" && (acao === "*" || acao === "https://www.youtube.com"),
    `status=${preflight.status} ACAO=${acao} ACAPN=${acapn}`
  );

  console.log("==> launching Chromium with extension");
  const context = await launchExtensionBrowser({ userDataDir: USER_DATA_DIR });
  const serviceWorker = await getServiceWorker(context);
  record("extension service worker started", Boolean(serviceWorker));

  await seedSettings(serviceWorker, {
    enabled: true,
    toxicityThreshold: 0.7,
    maxComments: 50,
    backendUrl: `http://localhost:${port.backend}`,
    llmBaseUrl: `http://localhost:${port.mockLlm}`,
    llmModel: "mock-model",
    llmApiKey: ""
  });

  const page = await context.newPage();
  await interceptYouTube(page);
  page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (err) => console.log(`[page:error] ${err.message}`));

  console.log("==> navigating to fake YouTube page");
  await page.goto("https://www.youtube.com/watch?v=test", {
    waitUntil: "domcontentloaded"
  });

  console.log("==> waiting for content-script to settle");
  await expect("toggle injected above comments", (t) =>
    page.waitForSelector("#diplomat-toggle", { timeout: t }), 5_000);

  await expect("short positive comment gets positive badge", (t) =>
    page.waitForFunction(
      () => document.querySelector("#c-short-positive .diplomat-badge")?.dataset.badgeType === "positive",
      { timeout: t }
    ), 5_000);

  await expect("short neutral comment gets neutral badge", (t) =>
    page.waitForFunction(
      () => document.querySelector("#c-short-neutral .diplomat-badge")?.dataset.badgeType === "neutral",
      { timeout: t }
    ), 5_000);

  await expect("long clean comment classified neutral via backend", (t) =>
    page.waitForFunction(
      () => document.querySelector("#c-long-clean .diplomat-badge")?.dataset.badgeType === "neutral",
      { timeout: t }
    ));

  await expect("long toxic comment gets aggressive badge + blur + button", (t) =>
    page.waitForFunction(
      () => {
        const c = document.querySelector("#c-long-toxic");
        const badge = c?.querySelector(".diplomat-badge");
        const blurred = c?.querySelector("#content-text")?.classList.contains("diplomat-blur");
        const button = c?.querySelector(".diplomat-action");
        return badge?.dataset.badgeType === "toxic" && blurred && button && !button.disabled;
      },
      { timeout: t }
    ));

  await page.screenshot({ path: path.join(RESULTS_DIR, "01-classified.png"), fullPage: true });

  await page.click("#c-long-toxic .diplomat-action");
  await expect("clicking action swaps in rewritten text", (t) =>
    page.waitForFunction(
      () => {
        const c = document.querySelector("#c-long-toxic");
        const badge = c?.querySelector(".diplomat-badge");
        const text = c?.querySelector("#content-text")?.textContent || "";
        return badge?.dataset.badgeType === "rewritten" && text.toLowerCase().includes("video could be improved");
      },
      { timeout: t }
    ), 5_000);

  await page.screenshot({ path: path.join(RESULTS_DIR, "02-rewritten.png"), fullPage: true });

  await page.click("#diplomat-toggle input[type=checkbox]");
  await expect("toggling diplomat mode off restores original comment", (t) =>
    page.waitForFunction(
      () => {
        const text = document.querySelector("#c-long-toxic #content-text")?.textContent || "";
        const blurred = document.querySelector("#c-long-toxic #content-text")?.classList.contains("diplomat-blur");
        return text.toLowerCase().includes("worst video") && !blurred;
      },
      { timeout: t }
    ), 5_000);

  await page.screenshot({ path: path.join(RESULTS_DIR, "03-toggled-off.png"), fullPage: true });

  const dom = await page.evaluate(() => {
    const out = {};
    for (const c of document.querySelectorAll("ytd-comment-thread-renderer")) {
      const badge = c.querySelector(".diplomat-badge");
      const text = c.querySelector("#content-text");
      const button = c.querySelector(".diplomat-action");
      out[c.id] = {
        badgeType: badge?.dataset.badgeType || null,
        blurred: text?.classList.contains("diplomat-blur") || false,
        textPreview: (text?.textContent || "").slice(0, 80),
        buttonDisabled: button?.disabled ?? null
      };
    }
    return out;
  });
  console.log("==> final DOM snapshot:");
  console.log(JSON.stringify(dom, null, 2));
  console.log("==> screenshots saved to test-harness/results/{01-classified,02-rewritten,03-toggled-off}.png");

  await context.close();
  shutdown();

  console.log("\n=== summary ===");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}: ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
