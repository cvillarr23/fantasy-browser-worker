const activity = require("./db/activity");
const MILLISECONDS_PER_SECOND = 1000;
const amqpConnectionManager = require("./queue/connection");
const { executeLineupAdjustments } = require("./bots/lineup_bot");
const { executeInstantWaiverClaim } = require("./bots/waiver_sniper");
const { executeAutomatedDraftSelection } = require("./bots/draft_clicker");
const {
  executeTradeEvaluation,
  negotiateTradeProposal,
} = require("./bots/trade_bot");
const { generateTradeProposal } = require("./bots/trade_proposal");
const { executeTradeSubmission } = require("./bots/trade_builder");
const { executeTradeResponse } = require("./bots/trade_response");
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

    case "trade_proposals":
      return generateTradeProposal(payload);

    case "trade_negotiations":
      logger.info("Invoking Trade Negotiation Engine...");
      return negotiateTradeProposal(payload);

    // Human-approved trade offers (#90). Without a matching approval, or with any of
    // trade_builder.js's other locks closed, this only dry-fills the form.
    case "trade_submissions":
      logger.info("Invoking Trade Submission Engine...");
      return executeTradeSubmission(payload);

    // Human-approved accept/decline of an incoming offer. With any of trade_response.js's
    // locks closed, this only records what it would have sent.
    case "trade_responses":
      logger.info("Invoking Trade Response Engine...");
      return executeTradeResponse(payload);

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
  // The Sleeper ingestor shares waiver_actions for injury alerts (Sleeper ids, no drop, any
  // league-rostered player). They are not claims, so ack them before an activity row exists.
  if (
    queueName === "waiver_actions" &&
    payload &&
    payload.event_type === "INJURY_STATUS_CHANGE"
  ) {
    logger.info(
      `Injury alert for ${payload.name || payload.player_id} is not a waiver claim; acking.`,
    );
    return true;
  }
  if (!(await activity.claim(queueName, payload))) return true;
  try {
  if (
    queueName === "draft_targets" &&
    payload.expires_at != null &&
    Date.now() / MILLISECONDS_PER_SECOND >= payload.expires_at
  ) {
    await activity.event("expired_before_execution", {}, "skipped", "expired", payload.tracking_id);
    return true;
  }
  await withInstrumentation(
    queueName,
    { queueName, trackingId: payload && payload.tracking_id },
    () => dispatch(queueName, payload),
  );
  return true;
  } finally { await activity.release(payload.tracking_id); }
}

async function bootDaemon() {
  logger.info(
    "[Worker Engine] Launching browser worker orchestrator background daemon...",
  );

  try {
    // Initialize our managed RabbitMQ connection framework loops
    // IDLE_EXIT_SECONDS: set by fantasy-infra's production ScaledJob so each Job completes once
    // the queues drain; unset/0 (draft-day overlay) keeps the worker running indefinitely. See
    // initializeQueueConsumer for why.
    const idleExitSeconds = Number(process.env.IDLE_EXIT_SECONDS) || 0;
    await amqpConnectionManager.initializeQueueConsumer(handleIncomingMessage, {
      idleExitMs: idleExitSeconds > 0 ? idleExitSeconds * 1000 : undefined,
    });
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
