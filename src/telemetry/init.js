// Loaded via NODE_OPTIONS=--require in the Dockerfile (see Dockerfile comment) rather than a
// per-file require() -- k8s Jobs/CronJobs override the container's command to run bot files
// directly (bypassing src/index.js entirely), so bootstrap needs to happen for *any* `node
// <file>.js` invocation of this image, not just the ones that remember to require this module.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-grpc");
const { Resource } = require("@opentelemetry/resources");
const {
  SemanticResourceAttributes,
} = require("@opentelemetry/semantic-conventions");
const {
  AmqplibInstrumentation,
} = require("@opentelemetry/instrumentation-amqplib");
const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg");

const sdk = new NodeSDK({
  resource: new Resource({
    // Single shared service name across every bot/entrypoint -- matches the "one deployable
    // image" model. Bot identity is carried per-span as the worker.bot_name attribute instead
    // (see telemetry/instrument.js), not as a separate OTel service. Defers to OTEL_SERVICE_NAME
    // when set -- fantasy-infra's INFRA-10 already provisions it ("browser-worker") on every
    // browser-worker workload manifest; a hardcoded literal here would silently diverge from
    // that and misreport the service name in Tempo/Grafana.
    [SemanticResourceAttributes.SERVICE_NAME]:
      process.env.OTEL_SERVICE_NAME || "fantasy-browser-worker",
  }),
  traceExporter: new OTLPTraceExporter({
    // e.g. http://tempo.default.svc.cluster.local:4317 -- must be http://, not grpc:// or bare
    // host:port: this exporter's credential resolution keys off an http:// prefix specifically
    // to select plaintext gRPC channel credentials, otherwise it falls through to TLS credentials
    // and fails against Tempo's unencrypted in-cluster OTLP receiver. Unset locally is fine, the
    // exporter just logs benign export failures rather than crashing the process.
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: [new AmqplibInstrumentation(), new PgInstrumentation()],
});

sdk.start();

/**
 * Flushes buffered spans, and NEVER rejects.
 *
 * Every caller of this is a shutdown path — a `finally` block draining a short-lived Job's event
 * loop, or a signal handler. `sdk.shutdown()` rejects when the exporter cannot reach the
 * collector, and in a `finally` that rejection is unhandled, which Node turns into a fatal
 * uncaught exception. The result is a job that did its work correctly, logged success, and then
 * died while trying to report that success — the observability layer manufacturing the very
 * failure it exists to detect.
 *
 * Seen in production: espn-session-healthcheck logged "ESPN session is healthy", then crashed on
 * `connect EPERM 10.152.183.156:4317` and reported the CronJob as Failed.
 *
 * src/index.js's process.on("unhandledRejection") handler does not save these: k8s Jobs/CronJobs
 * override the container command to run a bot file directly, bypassing src/index.js entirely (the
 * same reason this module is bootstrapped via NODE_OPTIONS=--require). So the bots that most need
 * the guard are exactly the ones running without it -- it has to live here.
 *
 * A dropped trace is an acceptable loss. A dropped job is not.
 */
async function shutdownTelemetry() {
  try {
    await sdk.shutdown();
  } catch (err) {
    // Read the message defensively: a promise can reject with anything, including null, and this
    // warning is the ONLY evidence that a flush failed. Reading `err.message` off a null rejection
    // throws, and while the try/catch below would swallow that, the result is a flush failure that
    // leaves no trace at all -- the silent-failure mode this helper exists to avoid.
    const detail = (err && err.message) || String(err);
    // logger is required lazily: this module is loaded via NODE_OPTIONS=--require before
    // anything else, and a top-level require of the logger would invert that bootstrap order.
    try {
      require("./logger").logger.warn(
        `[Telemetry] Could not flush spans on shutdown: ${detail}. Traces for this run may be missing.`,
      );
    } catch {
      // Logging the logging failure is where this stops.
    }
  }
}

module.exports = { sdk, shutdownTelemetry };
