const mockPino = jest.fn();
const mockTrace = { getActiveSpan: jest.fn() };
const mockGetContext = jest.fn();

jest.mock("pino", () => mockPino);
jest.mock("@opentelemetry/api", () => ({ trace: mockTrace }));
jest.mock("../../src/telemetry/context", () => ({ getContext: mockGetContext }));

describe("logger output format", () => {
  let options;

  beforeEach(() => {
    jest.resetModules();
    mockPino.mockReset();
    mockTrace.getActiveSpan.mockReset();
    mockGetContext.mockReset();
    mockPino.stdSerializers = { err: "error serializer" };
    mockPino.mockImplementation((config) => {
      options = config;
      return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    });
  });

  it("formats pino levels as strings without an inline timestamp", () => {
    require("../../src/telemetry/logger");

    expect(options.formatters.level("info", 30)).toEqual({ level: "info" });
    expect(options.formatters.level("warn", 40)).toEqual({ level: "warn" });
    expect(options.timestamp).toBe(false);
  });

  it("emits active trace identifiers as snake_case fields", () => {
    mockGetContext.mockReturnValue({ botName: "trade_inbox" });
    mockTrace.getActiveSpan.mockReturnValue({
      spanContext: () => ({ traceId: "trace-1", spanId: "span-1" }),
    });

    require("../../src/telemetry/logger");

    expect(options.mixin()).toEqual({
      botName: "trade_inbox",
      trace_id: "trace-1",
      span_id: "span-1",
    });
  });
});
