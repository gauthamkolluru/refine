// Phase B: visible end-to-end demo. Same scaffold as run-e2e.mjs (see
// setup.mjs) but with a visible window and pauses so a human can watch each
// high-signal moment: classify → rewrite → toggle-off.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import {
  bootStack,
  attachSignalHandlers,
  launchExtensionBrowser,
  getServiceWorker,
  seedSettings,
  interceptYouTube
} from "./setup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, ".user-data-visible");

const PAUSE = { afterClassify: 4000, afterRewrite: 4000, afterToggleOff: 3000 };

async function main() {
  console.log("==> booting mock LLM + backend");
  const { port, shutdown } = await bootStack();
  attachSignalHandlers(shutdown);

  console.log("==> launching visible Chromium with extension");
  const context = await launchExtensionBrowser({
    userDataDir: USER_DATA_DIR,
    headless: false,
    viewport: { width: 1100, height: 800 }
  });

  const serviceWorker = await getServiceWorker(context);
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

  console.log("==> navigating to fake YouTube page");
  await page.goto("https://www.youtube.com/watch?v=test", { waitUntil: "domcontentloaded" });

  console.log("==> demo step 1: waiting for classification");
  await page.waitForFunction(
    () => {
      const toxic = document.querySelector("#c-long-toxic .diplomat-badge");
      const clean = document.querySelector("#c-long-clean .diplomat-badge");
      return toxic?.dataset.badgeType === "toxic" && clean?.dataset.badgeType === "neutral";
    },
    { timeout: 15_000 }
  );
  console.log(`    → badges + blur visible; holding for ${PAUSE.afterClassify}ms`);
  await wait(PAUSE.afterClassify);

  console.log("==> demo step 2: clicking 'View constructive version'");
  await page.click("#c-long-toxic .diplomat-action");
  await page.waitForFunction(
    () => document.querySelector("#c-long-toxic .diplomat-badge")?.dataset.badgeType === "rewritten",
    { timeout: 5_000 }
  );
  console.log(`    → toxic comment replaced; holding for ${PAUSE.afterRewrite}ms`);
  await wait(PAUSE.afterRewrite);

  console.log("==> demo step 3: toggling Diplomat mode off");
  await page.click("#diplomat-toggle input[type=checkbox]");
  await page.waitForFunction(
    () => {
      const text = document.querySelector("#c-long-toxic #content-text")?.textContent || "";
      return text.toLowerCase().includes("worst video");
    },
    { timeout: 5_000 }
  );
  console.log(`    → original text restored, badges hidden; holding for ${PAUSE.afterToggleOff}ms`);
  await wait(PAUSE.afterToggleOff);

  await context.close();
  shutdown();
  console.log("\nvisible demo complete");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
