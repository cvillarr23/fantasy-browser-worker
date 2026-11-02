/**
 * Publishes facts to core's `job_events` topic exchange, which the launcher consumes to start
 * jobs subscribed through the catalog. The message shape is core's JobEvent contract
 * (docs/asyncapi.yaml); the routing key is the event key.
 *
 * Best-effort, like core's emit_event: a broker problem is logged and swallowed, because a retry
 * of the job would not emit again and every subscriber has a schedule to fall back on.
 */
const { randomUUID } = require("crypto");
const amqp = require("amqplib");
const { context, propagation } = require("@opentelemetry/api");
const { logger } = require("../telemetry/logger");
const { getContext } = require("../telemetry/context");
const { redactAmqpUrl, AMQP_URL } = require("./connection");

const JOB_EVENTS_EXCHANGE = "job_events";
// One connect, one confirmed publish: well under the bots' own runtime deadlines, so a down
// broker costs seconds, not a retry ladder.
const EVENT_PUBLISH_TIMEOUT_MS = 10_000;

function jobEventBody({ key, subject, payload }) {
  return {
    event_id: randomUUID(),
    key,
    subject,
    payload,
    emitted_by_run_id: getContext().runId ?? null,
    at: new Date().toISOString(),
  };
}

/** W3C trace context for the message headers; empty when no span is active. */
function traceHeaders() {
  const headers = {};
  propagation.inject(context.active(), headers);
  return headers.traceparent ? { traceparent: headers.traceparent } : {};
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function publishConfirmed(body, headers) {
  const connection = await amqp.connect(AMQP_URL);
  try {
    const channel = await connection.createConfirmChannel();
    // Checked, never asserted: the exchange belongs to core, and declaring it with different
    // arguments would be refused or, worse, change it.
    await channel.checkExchange(JOB_EVENTS_EXCHANGE);
    await new Promise((resolve, reject) => {
      channel.publish(
        JOB_EVENTS_EXCHANGE,
        body.key,
        Buffer.from(JSON.stringify(body)),
        { persistent: true, contentType: "application/json", headers },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } finally {
    await connection.close().catch(() => {});
  }
}

/** Returns the event_id, or null when the broker did not take the event. Never throws. */
async function publishJobEvent(event) {
  const body = jobEventBody(event);
  try {
    await withTimeout(publishConfirmed(body, traceHeaders()), EVENT_PUBLISH_TIMEOUT_MS);
    return body.event_id;
  } catch (error) {
    logger.warn(
      `[Job Events] Could not publish ${body.key} to ${redactAmqpUrl(AMQP_URL)}: ${error.message}`,
    );
    return null;
  }
}

module.exports = { publishJobEvent, JOB_EVENTS_EXCHANGE, EVENT_PUBLISH_TIMEOUT_MS };
