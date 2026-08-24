// Regression guard for the espn-session-healthcheck CronJob failing AFTER its check passed.
//
// Every shutdown path in this repo calls the flush from inside a `finally` block or a signal
// handler, where a rejection is unhandled and therefore fatal to the process. When the OTLP
// collector is unreachable (seen live as `connect EPERM 10.152.183.156:4317`), `sdk.shutdown()`
// rejects -- so a job that succeeded exited non-zero and alerted, purely because it could not
// report its own success. A dropped trace is acceptable; a dropped job is not.
const mockShutdown = jest.fn();

jest.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    shutdown: mockShutdown,
  })),
}));
jest.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
  OTLPTraceExporter: jest.fn(),
}));
jest.mock("@opentelemetry/instrumentation-amqplib", () => ({
  AmqplibInstrumentation: jest.fn(),
}));
jest.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: jest.fn(),
}));

const { logger } = require("../../src/telemetry/logger");
const { shutdownTelemetry } = require("../../src/telemetry/init");

describe("shutdownTelemetry", () => {
  beforeEach(() => {
    mockShutdown.mockReset();
    jest.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves when the exporter flushes cleanly", async () => {
    mockShutdown.mockResolvedValue(undefined);

    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves (never rejects) when the collector is unreachable", async () => {
    mockShutdown.mockRejectedValue(
      new Error("14 UNAVAILABLE: connect EPERM 10.152.183.156:4317"),
    );

    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connect EPERM"),
    );
  });

  it("resolves even if the failure logging itself throws", async () => {
    mockShutdown.mockRejectedValue(new Error("boom"));
    logger.warn.mockImplementation(() => {
      throw new Error("logger is also down");
    });

    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
