const amqp = require("amqplib");
const { logger } = require("../telemetry/logger");
const { runWithContext, updateContext } = require("../telemetry/context");
const { shutdownTelemetry } = require("../telemetry/init");

// Load AMQP configuration topology safely from cluster-injected variables
const AMQP_URL =
  process.env.AMQP_URL ||
  "amqp://guest:guest@fantasy-broker.databases.svc.cluster.local:5672//";
const BROKER_OWNED_QUEUES = new Set([
  "lineup_updates",
  "waiver_actions",
  "draft_targets",
]);

// The AMQP URL carries the broker password, and the connect log line below ships to Loki on
// every attempt -- mask it. Regex rather than `new URL()` so a URL the parser rejects (an
// unescaped `@` in the password, a bad port) is still masked instead of logged raw. `[^/]*@` is
// greedy within the authority, so it runs to the last `@` before the host.
function redactAmqpUrl(url) {
  return String(url).replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^:/@]*:)[^/]*@/i,
    "$1***@",
  );
}

// Set once the worker decides to shut down on its own (idle exit), so the connection "close"
// handler can tell a deliberate close apart from the broker dropping us.
let intentionalShutdown = false;

async function ensureQueue(channel, queue) {
  if (BROKER_OWNED_QUEUES.has(queue)) {
    await channel.checkQueue(queue);
  } else {
    await channel.assertQueue(queue, { durable: true });
  }
}

async function connectWithRetry() {
  let attempts = 0;
  const maxAttempts = 10;
  const baseDelay = 2000; // 2 seconds base delay for exponential backoff

  while (attempts < maxAttempts) {
    try {
      logger.info(
        `[Queue Bridge] Attempting connection to broker cluster endpoint: ${redactAmqpUrl(AMQP_URL)} (Attempt ${attempts + 1}/${maxAttempts})`,
      );
      const connection = await amqp.connect(AMQP_URL);
      logger.info(
        "[Queue Bridge] Socket baseline established with RabbitMQ successfully.",
      );

      // Monitor socket lifecycle to handle automated recoveries
      connection.on("error", (err) => {
        logger.error(
          "[Queue Bridge] Underlying connection socket error occurred",
          { err },
        );
      });

      connection.on("close", async () => {
        if (intentionalShutdown) {
          return;
        }
        // Reconnecting here would only replace the raw AMQP connection — the channel and its
        // consumers (set up by initializeQueueConsumer, which this function has no access to)
        // would stay gone, leaving the process alive but silently processing nothing forever.
        // Exit and let the pod's restart policy bring up a fully re-initialized worker instead.
        logger.error(
          "[Queue Bridge] Connection closed by remote broker server pool. Exiting for a clean restart...",
        );
        try {
          // Flush any buffered spans before exiting -- see src/index.js's uncaughtException
          // handler for the same reasoning. shutdownTelemetry never rejects, so the `finally` is
          // belt-and-braces: process.exit(1) must run no matter what, or the pod stays alive with
          // its channel and consumers gone -- silently processing nothing forever instead of
          // restarting.
          await shutdownTelemetry();
        } finally {
          process.exit(1);
        }
      });

      return connection;
    } catch (err) {
      attempts++;
      const currentDelay = baseDelay * Math.pow(2, attempts - 1);
      logger.error(
        `[Queue Bridge] Connection failure: ${err.message}. Retrying in ${currentDelay}ms...`,
        { err },
      );
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }
  }
  throw new Error(
    "Unable to establish communication channels with cluster messaging broker.",
  );
}

// idleExitMs: when set, exit 0 after this long with no message in flight. This worker runs as
// a KEDA ScaledJob (one Job per queued message, see fantasy-infra's keda-scaledjob.yaml), and a
// Job is only "done" when its pod exits -- without this, every Job KEDA starts stays Running
// forever after the queue drains, each holding its CPU/memory request (21 of them once starved
// the node after a single 21-message waiver burst). Unset keeps the old run-forever daemon
// behavior, which the draft-day overlay relies on to hold a warm, logged-in browser open.
async function initializeQueueConsumer(
  messageProcessorCallback,
  { idleExitMs } = {},
) {
  const connection = await connectWithRetry();
  const channel = await connection.createChannel();

  let inFlight = 0;
  let draining = false;
  let idleTimer = null;

  async function exitIdle() {
    if (inFlight > 0 || draining) {
      return;
    }
    draining = true;
    intentionalShutdown = true;
    logger.info(
      `[Queue Bridge] No messages for ${idleExitMs}ms. Closing consumers and exiting so the Job completes...`,
    );
    try {
      // Closing the channel returns anything delivered-but-unacked (a message that raced the
      // drain flag) to the queue for the next worker.
      await channel.close();
      await connection.close();
    } catch (err) {
      logger.warn(
        "[Queue Bridge] Error while closing broker connection on idle exit",
        {
          err,
        },
      );
    }
    try {
      await shutdownTelemetry();
    } finally {
      process.exit(0);
    }
  }

  function armIdleTimer() {
    if (!idleExitMs) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(exitIdle, idleExitMs);
  }

  // 1. Enforce strict resource boundaries to limit processing to 1 message at a time
  // This safeguards our 1200MiB pod limits by blocking concurrent Chromium execution cycles.
  // `global: true` is required here — plain prefetch(1) applies per-consumer, and multiple
  // consumers get registered below (one per queue in targetQueues), which would allow that many
  // unacked messages (and that many concurrent Chromium instances) at once instead of 1.
  await channel.prefetch(1, true);
  logger.info(
    "[Queue Bridge] Resource concurrency limits locked successfully (Prefetch: 1, channel-wide).",
  );

  // 2. Declare and align standard system tracking exchange queues
  // trade_evaluations (added for #74) is a plain REST call, not a Chromium-driven job like the
  // other three — but it still shares this channel-wide prefetch(1), so a slow lineup/waiver/draft
  // job holding the single slot blocks a lightweight trade evaluation behind it for a memory
  // constraint that doesn't apply to it. Giving non-browser queues their own channel/prefetch is a
  // real improvement, just a bigger change than this fix; left as a follow-up.
  const targetQueues = [
    "lineup_updates",
    "waiver_actions",
    "draft_targets",
    "trade_evaluations",
    "trade_negotiations",
    "llm_requests",
  ];
  for (const queue of targetQueues) {
    await ensureQueue(channel, queue);
    logger.info(`[Queue Bridge] Ready to consume target queue: "${queue}"`);

    // 3. Register our persistent background worker consumers
    await channel.consume(
      queue,
      (msg) =>
        // Seed the MDC context here, at the earliest point with access to the queue name and
        // raw AMQP message, so even the pre-dispatch log lines below (JSON parse, ack/nack)
        // carry queueName -- closing the gap where queue-bridge lines previously had no
        // correlation id at all.
        runWithContext({ queueName: queue }, async () => {
          if (msg === null) {
            return;
          }
          if (draining) {
            // Shutting down: hand it straight back for another worker rather than starting work
            // this process is about to abandon.
            channel.nack(msg, false, true);
            return;
          }
          inFlight++;
          clearTimeout(idleTimer);
          try {
            const payloadString = msg.content.toString();
            logger.info(`Inbound message captured from queue "${queue}"`);

            // Malformed JSON can never succeed on retry — requeuing it would redeliver the same
            // unparseable message forever, permanently blocking this queue under prefetch(1).
            let parsedPayload;
            try {
              parsedPayload = JSON.parse(payloadString);
            } catch (parseError) {
              logger.error("Discarding unparseable message (not requeued)", {
                err: parseError,
              });
              channel.nack(msg, false, false);
              return;
            }

            // Optional chaining: a syntactically valid JSON body can still parse to `null` or a
            // non-object (a bare scalar, an array). Dereferencing .tracking_id directly would
            // throw here, before the try/catch below exists to classify/handle it -- and since
            // amqplib doesn't await this consume callback, that throw would leave the message
            // unacked forever under prefetch(1), stalling the whole queue. Let the invalid
            // payload flow into messageProcessorCallback's own existing error handling instead.
            updateContext({ trackingId: parsedPayload?.tracking_id });

            try {
              // Route data parameters to the application layer and wait for execution to complete
              await messageProcessorCallback(queue, parsedPayload);

              // Acknowledge transaction safely strictly AFTER execution finishes cleanly
              channel.ack(msg);
              logger.info(
                `Transaction acknowledged cleanly for message ID: ${msg.fields.deliveryTag}`,
              );
            } catch (error) {
              logger.error("Execution error encountered handling payload", {
                err: error,
              });

              // A permanent error can never succeed on redelivery, so requeuing it would redeliver the
              // same doomed message forever with no backoff — and because prefetch is channel-wide,
              // that starves every consumer on this channel, not just this queue. Drop it, exactly as
              // unparseable JSON is dropped above.
              if (error && error.permanent) {
                logger.error(
                  `Permanent failure on message ID ${msg.fields.deliveryTag} — ` +
                    "discarding (not requeued). Fix the payload or configuration and republish.",
                );
                channel.nack(msg, false, false);
                return;
              }

              // Duck-typed rather than importing any specific error class here (keeps this queue
              // layer generic) — an error can opt into a pause before its own redelivery by
              // setting retryDelayMs (e.g. SessionExpiredError, src/errors.js). Without this, a
              // plain immediate nack(requeue=true) hot-loops relaunching Chromium against a
              // credential that isn't coming back on its own, and — since prefetch is channel-wide
              // — blocks every consumer on this channel until someone intervenes (PR #42 review).
              if (
                typeof error?.retryDelayMs === "number" &&
                error.retryDelayMs > 0
              ) {
                logger.info(
                  `Delaying ${error.retryDelayMs}ms before re-queuing message ID ` +
                    `${msg.fields.deliveryTag} (${error.name || "Error"}) — avoids hot-looping ` +
                    "against a condition that a fixed backoff, not instant redelivery, should wait out.",
                );
                await new Promise((resolve) =>
                  setTimeout(resolve, error.retryDelayMs),
                );
              }

              // Re-queue message if processing fails due to unexpected transient errors
              logger.info(
                `Rejecting message ID ${msg.fields.deliveryTag}. Triggering cluster re-queue logic...`,
              );
              channel.nack(msg, false, true);
            }
          } finally {
            inFlight--;
            if (inFlight === 0) {
              armIdleTimer();
            }
          }
        }),
      { noAck: false },
    ); // Disable dangerous automatic acks to ensure data safety
  }

  // Started only once every consumer is registered, so the idle clock counts from "ready to
  // take work", not from process start.
  armIdleTimer();
}

// Lazily-created and memoized, independent of initializeQueueConsumer's own connection/channel --
// publishToQueue has to work even from a process that never calls initializeQueueConsumer (e.g.
// a one-off publisher), and a publish channel has no reason to share the consumer's prefetch(1).
let publishChannelPromise = null;

async function getPublishChannel() {
  if (!publishChannelPromise) {
    publishChannelPromise = connectWithRetry().then((connection) =>
      connection.createChannel(),
    );
  }
  return publishChannelPromise;
}

async function publishToQueue(queueName, payload) {
  const channel = await getPublishChannel();
  await ensureQueue(channel, queueName);
  channel.sendToQueue(queueName, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
  });
}

module.exports = {
  initializeQueueConsumer,
  publishToQueue,
  redactAmqpUrl,
};
