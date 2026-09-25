const amqpConnectionManager = require("./queue/connection");
const { executeLineupAdjustments } = require("./bots/lineup_bot");
const { executeInstantWaiverClaim } = require("./bots/waiver_sniper");
const { executeAutomatedDraftSelection } = require("./bots/draft_clicker");
const { executeTradeEvaluation, negotiateTradeProposal } = require("./bots/trade_bot");
const { processAsyncLlmRequest } = require("./lib/llm_async_queue");
const { withInstrumentation } = require("./telemetry/instrument");
const { logger } = require("./telemetry/logger");
const { shutdownTelemetry } = require("./telemetry/init");

// Routes a parsed queue payload to its automation target. Split out from handleIncomingMessage
// so withInstrumentation wraps the whole dispatch (span + MDC context + execution_log write) in
// one place instead of every bot needing its own try/catch + recordExecution call.
async function dispatch(queueName, payload) {
  switch (queueName) {
    case "lineup_updates":
      logger.info("Invoking Lineup Adjustment Engine...");
      return executeLineupAdjustments(payload);

    case "waiver_actions":
      logger.info("Invoking Waiver Sniping Target Engine...");
      return executeInstantWaiverClaim(payload);

    case "draft_targets":
      logger.info("Invoking Draft Selection Engine...");
      return executeAutomatedDraftSelection(payload);

    case "trade_evaluations":
      logger.info("Invoking Trade Evaluation Engine...");
      return executeTradeEvaluation(payload);

    case "trade_negotiations":
      logger.info("Invoking Trade Negotiation Engine...");
      return negotiateTradeProposal(payload);

    case "llm_requests":
      logger.info("Invoking async LLM request handler...");
      return processAsyncLlmRequest(payload);

    default:
      logger.warn(
        `Intercepted unsupported message format signature: ${queueName}`,
      );
      return undefined;
  }
}

// Centralized transaction dispatcher mapping queue events straight to automation targets
async function handleIncomingMessage(queueName, payload) {
  logger.info(`Routing task parameters for queue event: "${queueName}"`);
  await withInstrumentation(
    queueName,
    { queueName, trackingId: payload && payload.tracking_id },
    () => dispatch(queueName, payload),
  );
  return true; // Return true on successful completion code run
}

async function bootDaemon() {
  logger.info(
    "[Worker Engine] Launching browser worker orchestrator background daemon...",
  );

  try {
    // Initialize our managed RabbitMQ connection framework loops
    await amqpConnectionManager.initializeQueueConsumer(handleIncomingMessage);
    logger.info(
      "[Worker Engine] Background listener threads fully initialized. Standing by...",
    );
  } catch (error) {
    logger.error("[Worker Engine] Critical cluster initialization failure", {
      err: error,
    });
    try {
      // shutdownTelemetry never rejects, so the `finally` is belt-and-braces: process.exit(1)
      // must run no matter what, or the pod stays alive with no queue consumer running.
      await shutdownTelemetry();
    } finally {
      process.exit(1);
    }
  }
}

// Global process monitoring to prevent memory-leak crashes from corrupting cluster states
process.on("unhandledRejection", (reason) => {
  logger.error("[Fatal Worker Event] Unhandled rejection intercepted", {
    reason: reason && reason.message ? reason.message : reason,
  });
});

process.on("uncaughtException", async (error) => {
  logger.error("[Fatal Worker Event] Uncaught system execution exception", {
    err: error,
  });
  try {
    // Flush any buffered spans before exiting -- this is exactly the crash-path trace you'd
    // most want, and NodeSDK batches/flushes on an interval that a process.exit() would cut
    // short. shutdownTelemetry never rejects, so the `finally` is belt-and-braces: process.exit(1)
    // must run no matter what, or the pod stays alive after an uncaught exception.
    await shutdownTelemetry();
  } finally {
    process.exit(1);
  }
});

bootDaemon();
