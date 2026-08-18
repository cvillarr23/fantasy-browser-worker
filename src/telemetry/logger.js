const { trace } = require("@opentelemetry/api");
const { getContext } = require("./context");

// Structured JSON lines, always -- MDC context fields and the active OTel trace/span id are
// merged in automatically so every line is correlatable in Grafana without callers doing
// anything extra. traceId is what wires up Tempo<->Loki correlation (see homelab-deployment's
// tracesToLogsV2 datasource config, which keys off this field name).
function emit(level, message, extra) {
  const ctx = getContext();
  const span = trace.getActiveSpan();
  const spanCtx = span && span.spanContext();
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...ctx,
    ...(spanCtx ? { traceId: spanCtx.traceId, spanId: spanCtx.spanId } : {}),
    ...extra,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const logger = {
  info: (message, extra) => emit("info", message, extra),
  warn: (message, extra) => emit("warn", message, extra),
  error: (message, extra) => emit("error", message, extra),
};

module.exports = { logger };
