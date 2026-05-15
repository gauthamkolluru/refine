// Lightweight structured-log facade shared between service worker and content
// script. Each call emits a single console line tagged "[diplomat]" with a
// level and an optional context object — enough to filter and reason about
// failures in DevTools without dragging in a logging library.

globalThis.DIPLOMAT = globalThis.DIPLOMAT || {};

function emit(level, message, context) {
  const fn = level === "error" ? console.error
    : level === "warn" ? console.warn
    : console.log;
  if (context && Object.keys(context).length) {
    fn(`[diplomat:${level}] ${message}`, context);
  } else {
    fn(`[diplomat:${level}] ${message}`);
  }
}

globalThis.DIPLOMAT.log = {
  info: (message, context) => emit("info", message, context),
  warn: (message, context) => emit("warn", message, context),
  error: (message, context) => emit("error", message, context)
};
