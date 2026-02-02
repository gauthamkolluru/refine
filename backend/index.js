const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";

const SYSTEM_PROMPT =
  "You are a diplomatic editor. Rewrite the following comment to maintain " +
  "the original criticism or feedback but remove insults, profanity, and " +
  "aggressive tone. If the comment has no feedback and is just an insult, " +
  "summarize it as 'Non-constructive criticism.' Output only the rewritten text.";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

async function analyzeToxicity(text) {
  if (!PERSPECTIVE_API_KEY) {
    throw new Error("Missing PERSPECTIVE_API_KEY");
  }

  const response = await fetch(
    `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${PERSPECTIVE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comment: { text },
        requestedAttributes: { TOXICITY: {} }
      })
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message || "Perspective API request failed";
    throw new Error(errorMessage);
  }

  return (
    payload?.attributeScores?.TOXICITY?.summaryScore?.value ??
    0
  );
}

async function rewriteComment(text) {
  if (!LLM_API_KEY) {
    throw new Error("Missing LLM_API_KEY");
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text }
      ],
      temperature: 0.2
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    const errorMessage =
      payload?.error?.message || "LLM request failed";
    throw new Error(errorMessage);
  }

  return payload?.choices?.[0]?.message?.content?.trim() || "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    });
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/analyze") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    const body = await readJson(req);
    const text = String(body.text || "").trim();
    if (!text) {
      sendJson(res, 400, { error: "Missing text" });
      return;
    }

    const toxicity = await analyzeToxicity(text);
    let rewrittenText = "";

    if (body.rewrite) {
      rewrittenText = await rewriteComment(text);
    }

    sendJson(res, 200, { toxicity, rewrittenText });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Diplomat backend running on http://localhost:${PORT}`);
});
