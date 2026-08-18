const amqp = require("amqplib");
const { logger } = require("../telemetry/logger");
const { runWithContext, updateContext } = require("../telemetry/context");
const { sdk } = require("../telemetry/init");

// Load AMQP configuration topology safely from cluster-injected variables
const AMQP_URL =
  process.env.AMQP_URL ||
  "amqp://guest:guest@fantasy-broker.databases.svc.cluster.local:5672//";

async function connectWithRetry() {
  let attempts = 0;
  const maxAttempts = 10;
  const baseDelay = 2000; // 2 seconds base delay for exponential backoff

  while (attempts < maxAttempts) {
    try {
      logger.info(
        `[Queue Bridge] Attempting connection to broker cluster endpoint: ${AMQP_URL} (Attempt ${attempts + 1}/${maxAttempts})`,
      );
      const connection = await amqp.connect(AMQP_URL);
      logger.info(
        "[Queue Bridge] Socket baseline established with RabbitMQ successfully.",
      );

      // Monitor socket lifecycle to handle automated recoveries
      connection.on("error", (err) => {
        logger.error(
          "[Queue Bridge] Underlying connection socket error occurred",
          { error: err.message },
        );
      });

      connection.on("close", async () => {
        // Reconnecting here would only replace the raw AMQP connection — the channel and its
        // consumers (set up by initializeQueueConsumer, which this function has no access to)
        // would stay gone, leaving the process alive but silently processing nothing forever.
        // Exit and let the pod's restart policy bring up a fully re-initialized worker instead.
        logger.error(
          "[Queue Bridge] Connection closed by remote broker server pool. Exiting for a clean restart...",
        );
        // Flush any buffered spans before exiting -- see src/index.js's uncaughtException
        // handler for the same reasoning.
        await sdk.shutdown();
        process.exit(1);
      });

      return connection;
    } catch (err) {
      attempts++;
      const currentDelay = baseDelay * Math.pow(2, attempts - 1);
      logger.error(
        `[Queue Bridge] Connection failure: ${err.message}. Retrying in ${currentDelay}ms...`,
        { error: err.message },
      );
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }
  }
  throw new Error(
    "Unable to establish communication channels with cluster messaging broker.",
  );
}

async function initializeQueueConsumer(messageProcessorCallback) {
  const connection = await connectWithRetry();
  const channel = await connection.createChannel();

  // 1. Enforce strict resource boundaries to limit processing to 1 message at a time
  // This safeguards our 1200MiB pod limits by blocking concurrent Chromium execution cycles.
  // `global: true` is required here — plain prefetch(1) applies per-consumer, and two consumers
  // get registered below (lineup_updates, waiver_actions), which would allow 2 unacked messages
  // (and 2 concurrent Chromium instances) at once instead of 1.
  await channel.prefetch(1, true);
  logger.info(
    "[Queue Bridge] Resource concurrency limits locked successfully (Prefetch: 1, channel-wide).",
  );

  // 2. Declare and align standard system tracking exchange queues
  const targetQueues = ["lineup_updates", "waiver_actions", "draft_targets"];
  for (const queue of targetQueues) {
    await channel.assertQueue(queue, { durable: true });
    logger.info(
      `[Queue Bridge] Bound tracking parameters for durable target queue: "${queue}"`,
    );

    // 3. Register our persistent background worker consumers
    await channel.consume(
      queue,
      (msg) =>
        // Seed the MDC context here, at the earliest point with access to the queue name and
        // raw AMQP message, so even the pre-dispatch log lines below (JSON parse, ack/nack)
        // carry queueName -- closing the gap where queue-bridge lines previously had no
        // correlation id at all.
        runWithContext({ queueName: queue }, async () => {
          if (msg !== null) {
            const payloadString = msg.content.toString();
            logger.info(
              `[Queue Bridge] Inbound message captured from queue "${queue}"`,
            );

            // Malformed JSON can never succeed on retry — requeuing it would redeliver the same
            // unparseable message forever, permanently blocking this queue under prefetch(1).
            let parsedPayload;
            try {
              parsedPayload = JSON.parse(payloadString);
            } catch (parseError) {
              logger.error(
                "[Queue Bridge] Discarding unparseable message (not requeued)",
                { error: parseError.message },
              );
              channel.nack(msg, false, false);
              return;
            }

            updateContext({ trackingId: parsedPayload.tracking_id });

            try {
              // Route data parameters to the application layer and wait for execution to complete
              await messageProcessorCallback(queue, parsedPayload);

              // Acknowledge transaction safely strictly AFTER execution finishes cleanly
              channel.ack(msg);
              logger.info(
                `[Queue Bridge] Transaction acknowledged cleanly for message ID: ${msg.fields.deliveryTag}`,
              );
            } catch (error) {
              logger.error(
                "[Queue Bridge] Execution error encountered handling payload",
                { error: error.message },
              );

              // A permanent error can never succeed on redelivery, so requeuing it would redeliver the
              // same doomed message forever with no backoff — and because prefetch is channel-wide,
              // that starves every consumer on this channel, not just this queue. Drop it, exactly as
              // unparseable JSON is dropped above.
              if (error && error.permanent) {
                logger.error(
                  `[Queue Bridge] Permanent failure on message ID ${msg.fields.deliveryTag} — ` +
                    "discarding (not requeued). Fix the payload or configuration and republish.",
                );
                channel.nack(msg, false, false);
                return;
              }

              // Re-queue message if processing fails due to unexpected transient errors
              logger.info(
                `[Queue Bridge] Rejecting message ID ${msg.fields.deliveryTag}. Triggering cluster re-queue logic...`,
              );
              channel.nack(msg, false, true);
            }
          }
        }),
      { noAck: false },
    ); // Disable dangerous automatic acks to ensure data safety
  }
}

module.exports = {
  initializeQueueConsumer,
};
