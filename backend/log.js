// One-line structured logs. Each entry is a single JSON object on stdout so it
// parses cleanly in any log pipeline. Sensitive fields (API keys, full comment
// bodies) must never be passed in — callers should pass only metadata.

function write(level, message, context) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context || {})
  };
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

module.exports = {
  info: (message, context) => write("info", message, context),
  warn: (message, context) => write("warn", message, context),
  error: (message, context) => write("error", message, context)
};
