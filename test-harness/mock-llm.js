// Tiny OpenAI-compatible Chat Completions stub used by the test harness.
// Decides "toxicity" by keyword match so the test is deterministic.

const http = require("http");

const PORT = Number(process.env.MOCK_LLM_PORT || 1234);
const TOXIC_KEYWORDS = [
  "stupid",
  "idiot",
  "dumb",
  "trash",
  "shut up",
  "worst",
  "garbage",
  "hate"
];

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function classify(userPrompt) {
  const match = userPrompt.match(/Comment:\s*([\s\S]*?)\nToxicity threshold:/);
  const comment = (match?.[1] || "").toLowerCase();
  const hit = TOXIC_KEYWORDS.some((kw) => comment.includes(kw));
  if (hit) {
    return {
      toxicity: 0.95,
      rewrittenText:
        "I think the video could be improved by tightening the pacing in the middle section."
    };
  }
  return { toxicity: 0.15, rewrittenText: "" };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  try {
    const body = await readJson(req);
    const userMsg = body?.messages?.find((m) => m.role === "user")?.content || "";
    const verdict = classify(userMsg);
    const payload = {
      id: "mock-cmpl-1",
      object: "chat.completion",
      model: body.model || "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(verdict) },
          finish_reason: "stop"
        }
      ]
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err?.message || err) } }));
  }
});

server.listen(PORT, () => {
  console.log(`[mock-llm] listening on http://localhost:${PORT}`);
});
