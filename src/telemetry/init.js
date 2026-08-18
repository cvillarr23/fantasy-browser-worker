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
const { AmqplibInstrumentation } = require("@opentelemetry/instrumentation-amqplib");
const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg");

const sdk = new NodeSDK({
  resource: new Resource({
    // Single shared service name across every bot/entrypoint -- matches the "one deployable
    // image" model. Bot identity is carried per-span as the worker.bot_name attribute instead
    // (see telemetry/instrument.js), not as a separate OTel service.
    [SemanticResourceAttributes.SERVICE_NAME]: "fantasy-browser-worker",
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

module.exports = { sdk };
