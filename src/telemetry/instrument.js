const activity = require("../db/activity");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { runWithContext, updateContext } = require("./context");
const { recordExecution } = require("../db/execution_log");
const runLog = require("../db/run_log");

const tracer = trace.getTracer("fantasy-browser-worker");
// A bot's return value is its outcome on the run's page; keep it small enough for a summary.
const MAX_RUN_RESULT_CHARS = 4000;

function boundedResult(result) {
  if (result === undefined || result === null) return null;
  const encoded = JSON.stringify(activity.redact(result));
  return encoded.length > MAX_RUN_RESULT_CHARS
    ? { preview: encoded.slice(0, MAX_RUN_RESULT_CHARS), truncated: true }
    : JSON.parse(encoded);
}

// The one wrapper every bot/entrypoint needs: seeds the MDC context, opens a span, times
// execution, classifies success/failure (respecting PermanentError via error.permanent), and
// writes the execution_log row -- all in one place instead of each bot/entrypoint hand-rolling
// its own try/catch + logging + recordExecution call.
async function withInstrumentation(botName, contextFields, handler) {
  if (!contextFields.queueName) {
    const trackingId = await activity.observe(botName, contextFields.trackingId);
    contextFields = { ...contextFields, trackingId: trackingId || contextFields.trackingId };
  }
  // A queue message's run is a child of the run that queued its action; a standalone job's
  // trigger (scheduled vs manual) comes from its CronJob env.
  const { triggerType, trigger } = contextFields.queueName
    ? {
        triggerType: "queue",
        trigger: { queue: contextFields.queueName, tracking_id: contextFields.trackingId },
      }
    : runLog.triggerFromEnv();
  const parentRunId = contextFields.queueName
    ? await runLog.parentForAction(contextFields.trackingId)
    : process.env.RUN_PARENT_ID || null;
  const runSummary = {};
  return runWithContext({ botName, ...contextFields, runSummary }, () =>
    tracer.startActiveSpan(`bot.${botName}`, async (span) => {
      const startedAt = Date.now();
      const runId = await runLog.startRun({
        jobName: botName,
        triggerType,
        trigger,
        parentRunId,
        traceId: span.spanContext().traceId,
      });
      updateContext({ runId });
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
        await activity.event("worker_finished", { result: result || null }, "finished");
        await runLog.finishRun(runId, "success", {
          summary: { result: boundedResult(result), ...runSummary },
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
        await activity.event(
          "worker_error",
          { message: error.message, permanent: Boolean(error.permanent) },
          "failed",
        );
        await runLog.finishRun(runId, "failure", { error: error.message, summary: runSummary });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

module.exports = { withInstrumentation };
