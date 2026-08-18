const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { runWithContext } = require("./context");
const { recordExecution } = require("../db/execution_log");

const tracer = trace.getTracer("fantasy-browser-worker");

// The one wrapper every bot/entrypoint needs: seeds the MDC context, opens a span, times
// execution, classifies success/failure (respecting PermanentError via error.permanent), and
// writes the execution_log row -- all in one place instead of each bot/entrypoint hand-rolling
// its own try/catch + logging + recordExecution call.
async function withInstrumentation(botName, contextFields, handler) {
  return runWithContext({ botName, ...contextFields }, () =>
    tracer.startActiveSpan(`bot.${botName}`, async (span) => {
      const startedAt = Date.now();
      span.setAttributes({
        "worker.bot_name": botName,
        ...(contextFields.trackingId && {
          "worker.tracking_id": contextFields.trackingId,
        }),
        ...(contextFields.queueName && {
          "messaging.destination": contextFields.queueName,
        }),
      });
      try {
        const result = await handler();
        span.setStatus({ code: SpanStatusCode.OK });
        await recordExecution({
          transactionType: contextFields.queueName || botName,
          botName,
          status: "success",
          durationMs: Date.now() - startedAt,
          traceId: span.spanContext().traceId,
        });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.setAttribute("worker.permanent_error", Boolean(error.permanent));
        await recordExecution({
          transactionType: contextFields.queueName || botName,
          botName,
          status: "failure",
          durationMs: Date.now() - startedAt,
          errorMessage: error.message,
          traceId: span.spanContext().traceId,
        });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

module.exports = { withInstrumentation };
