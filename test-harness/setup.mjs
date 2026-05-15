// Shared scaffolding for both Playwright runners.
//
// Owns the gnarly bits that have no business being duplicated:
//   - clearing PLAYWRIGHT_BROWSERS_PATH (Cursor sets it to a sandbox cache)
//   - dynamic-importing playwright so the env var is honored
//   - booting mock LLM + real backend as child processes
//   - launching Chromium with the unpacked extension loaded
//   - intercepting youtube.com to serve the fixture
//
// Runners stay thin: they orchestrate assertions and pacing.

delete process.env.PLAYWRIGHT_BROWSERS_PATH;

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import("playwright");
export { chromium };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const EXTENSION_DIR = path.join(REPO_ROOT, "extension");
export const FIXTURE_PATH = path.join(__dirname, "fixtures", "youtube-fake.html");

const DEFAULT_PORTS = { mockLlm: 1234, backend: 8787 };

function spawnLogged(name, cmd, args, env, sink) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${name}!] ${b}`));
  sink.push(child);
  return child;
}

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

export async function bootStack(overrides = {}) {
  const port = { ...DEFAULT_PORTS, ...overrides };
  const children = [];

  spawnLogged(
    "mock-llm",
    process.execPath,
    [path.join(__dirname, "mock-llm.js")],
    { MOCK_LLM_PORT: String(port.mockLlm) },
    children
  );
  await waitForHttp(`http://localhost:${port.mockLlm}/chat/completions`);

  spawnLogged(
    "backend",
    process.execPath,
    [path.join(REPO_ROOT, "backend", "index.js")],
    {
      PORT: String(port.backend),
      LLM_BASE_URL: `http://localhost:${port.mockLlm}`,
      LLM_MODEL: "mock-model",
      LLM_API_KEY: ""
    },
    children
  );
  await waitForHttp(`http://localhost:${port.backend}/analyze`);

  const shutdown = () => {
    for (const c of children) try { c.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      for (const c of children) try { c.kill("SIGKILL"); } catch {}
    }, 1500).unref();
  };

  return { children, port, shutdown };
}

export function attachSignalHandlers(shutdown, { hardTimeoutMs } = {}) {
  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(130); });
  process.on("SIGTERM", () => { shutdown(); process.exit(143); });
  if (hardTimeoutMs) {
    setTimeout(() => {
      console.error(`[runner] hard timeout after ${hardTimeoutMs}ms, exiting`);
      shutdown();
      process.exit(2);
    }, hardTimeoutMs).unref();
  }
}

export async function launchExtensionBrowser({
  userDataDir,
  headless = true,
  viewport
}) {
  const args = [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (headless) {
    // MV3 extensions don't load under Playwright's old headless mode, but
    // they do under Chrome's new headless. We tell Playwright headless:false
    // so it doesn't add --headless=old, then pass --headless=new ourselves.
    args.unshift("--headless=new", "--disable-dev-shm-usage", "--disable-gpu");
  }
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
    viewport: viewport || { width: 1280, height: 900 }
  });
}

export async function getServiceWorker(context, timeoutMs = 10_000) {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: timeoutMs });
}

export async function seedSettings(serviceWorker, settings) {
  await serviceWorker.evaluate(async (s) => {
    await new Promise((resolve) =>
      chrome.storage.sync.set(s, () => resolve())
    );
  }, settings);
}

export async function interceptYouTube(page) {
  const fakeHtml = await readFile(FIXTURE_PATH, "utf8");
  await page.route("https://www.youtube.com/**", async (route) => {
    if (route.request().url().includes("/watch")) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fakeHtml
      });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });
}
