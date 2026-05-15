const http = require("http");
const log = require("./log");

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_LLM_BASE_URL = process.env.LLM_BASE_URL;
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL;
const DEFAULT_LLM_API_KEY = process.env.LLM_API_KEY;

const SYSTEM_PROMPT =
  "You are a diplomatic editor. Assess toxicity and, if needed, rewrite " +
  "the comment to preserve the original feedback while removing insults, " +
  "profanity, and aggressive tone.";

// Permissive CORS suits a local dev tool. Chrome 117+ also enforces Private
// Network Access for public-origin → loopback calls; `Allow-Private-Network`
// on the preflight is what lets the extension's service worker reach us.
const BASE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type"
};
const PREFLIGHT_CORS = {
  ...BASE_CORS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Private-Network": "true"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { ...BASE_CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

// LLMs sometimes wrap JSON in code fences or prose; pull out the first {...}.
function parseJsonFromContent(content) {
  if (!content) throw new Error("Empty LLM response");
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("LLM response was not valid JSON");
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function analyzeAndRewrite({ text, threshold, llmConfig }) {
  const baseUrl = normalizeBaseUrl(llmConfig?.baseUrl || DEFAULT_LLM_BASE_URL);
  const model = llmConfig?.model || DEFAULT_LLM_MODEL;
  const apiKey = llmConfig?.apiKey || DEFAULT_LLM_API_KEY;

  if (!baseUrl) throw new Error("Missing LLM_BASE_URL");
  if (!model) throw new Error("Missing LLM_MODEL");

  const userPrompt =
    `Comment: ${text}\n` +
    `Toxicity threshold: ${threshold}\n` +
    "Return only valid JSON with this shape:\n" +
    '{ "toxicity": number, "rewrittenText": string }\n' +
    "If toxicity is below the threshold, return rewrittenText as an empty string. " +
    "If the comment is only an insult with no feedback, set rewrittenText to " +
    '"Non-constructive criticism."';

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || "LLM request failed");
  }

  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonFromContent(content);
  const toxicity = Number(parsed?.toxicity);
  const rewrittenText = String(parsed?.rewrittenText || "").trim();
  if (Number.isNaN(toxicity)) throw new Error("LLM response missing toxicity score");

  return { toxicity, rewrittenText };
}

async function handleAnalyze(req, res) {
  const body = await readJson(req);
  const text = String(body.text || "").trim();
  if (!text) {
    sendJson(res, 400, { error: "Missing text" });
    return;
  }
  const threshold = Number(body.threshold ?? 0.7);
  const llmConfig = {
    baseUrl: body.llmBaseUrl,
    model: body.llmModel,
    apiKey: body.llmApiKey
  };
  const result = await analyzeAndRewrite({ text, threshold, llmConfig });
  log.info("analyze ok", { textLength: text.length, toxicity: result.toxicity });
  sendJson(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, PREFLIGHT_CORS);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/analyze") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    await handleAnalyze(req, res);
  } catch (error) {
    log.error("analyze failed", { error: error?.message });
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  log.info("backend listening", { port: PORT });
});
