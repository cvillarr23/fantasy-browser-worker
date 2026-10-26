const pino = require("pino");
const { trace } = require("@opentelemetry/api");
const { getContext } = require("./context");

// mixin() runs on every log call and its return value is merged into the line -- this is how
// MDC context (seeded via AsyncLocalStorage, see context.js) and the active OTel trace/span id
// reach every log line without every call site threading them through explicitly. trace_id is
// what wires up Tempo<->Loki correlation (see homelab-deployment's tracesToLogsV2 datasource
// config, which keys off this field name). The container runtime supplies the timestamp.
const base = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: { level: (label) => ({ level: label }) },
  timestamp: false,
  serializers: { err: pino.stdSerializers.err },
  mixin() {
    const ctx = getContext();
    const span = trace.getActiveSpan();
    const spanCtx = span && span.spanContext();
    return {
      ...ctx,
      ...(spanCtx ? { trace_id: spanCtx.traceId, span_id: spanCtx.spanId } : {}),
    };
  },
});

// Preserves the (message, extraFields) call signature already used across every call site in
// this codebase -- pino's own native signature is the reverse, (mergingObject, message). Pass
// the actual Error object under extraFields.err (not err.message) to get a real stack trace out
// of pino's err serializer above.
function wrap(level) {
  return (message, extra) => base[level](extra || {}, message);
}

const logger = {
  debug: wrap("debug"),
  info: wrap("info"),
  warn: wrap("warn"),
  error: wrap("error"),
};

module.exports = { logger };
