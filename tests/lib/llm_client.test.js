// pg is mocked so recordLlmCallMetric's best-effort insert never attempts a real connection --
// there's no DB_HOST in the test env, and unmocked it would eat connectionTimeoutMillis (5s) per
// attempt.
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockRejectedValue(new Error("no db in tests")),
    on: jest.fn(),
  })),
}));

// startOllama/isOllamaReady use node:http/node:https directly, same as callOllama (fetch drops
// the Host header the KEDA interceptor needs) -- global.fetch mocking below doesn't cover this.
jest.mock("node:http", () => ({ request: jest.fn() }));
jest.mock("node:https", () => ({ request: jest.fn() }));

const { EventEmitter } = require("events");
const http = require("node:http");
const {
  completeWithFallback,
  startOllama,
  isOllamaReady,
} = require("../../src/lib/llm_client");

// Builds a fake req/res pair matching what requestWithHostHeader expects from
// transport.request(options, callback): an EventEmitter req with write/end/destroy, and
// (unless `error` or `hang` is given) an EventEmitter res delivered to `callback` asynchronously.
function mockTransportRequest(transportMock, { statusCode, body = "", error, hang } = {}) {
  transportMock.request.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn();
    req.destroy = jest.fn((err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    });

    if (error) {
      process.nextTick(() => req.emit("error", error));
    } else if (!hang) {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        callback(res);
        res.emit("data", Buffer.from(body));
        res.emit("end");
      });
    }
    // hang: neither calls back nor errors -- the caller's own wall-clock timeout must fire and
    // destroy() the request itself, which is what actually produces the rejection.

    return req;
  });
}

describe("llm_client", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      GEMINI_API_KEY: "test-gemini-key",
      LLM_PROVIDER_PRIORITY: "gemini:gemini-3.1-flash-lite",
    };
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("uses gemini-3.1-flash-lite by default (DEFAULT_PROVIDER_PRIORITY)", async () => {
    delete process.env.LLM_PROVIDER_PRIORITY;
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
      }),
    });

    const result = await completeWithFallback("prompt", {
      callSite: "test",
    });

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-3.1-flash-lite");
  });

  it("requests native JSON output from Gemini", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
      }),
    });

    await completeWithFallback("prompt", { callSite: "test" });

    const [, requestInit] = global.fetch.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.generationConfig.response_mime_type).toBe("application/json");
  });

  describe("startOllama", () => {
    it("GETs /api/tags through the interceptor with the default Host header", async () => {
      mockTransportRequest(http, { statusCode: 200, body: "{}" });

      const result = await startOllama();

      expect(result).toEqual({ triggered: true });
      const [options] = http.request.mock.calls[0];
      expect(options.method).toBe("GET");
      expect(options.path).toBe("/api/tags");
      expect(options.headers.Host).toBe("ollama.default.svc.cluster.local");
    });

    it("still reports triggered when the interceptor holds the request until it times out", async () => {
      jest.useFakeTimers();
      mockTransportRequest(http, { hang: true });

      const resultPromise = startOllama();
      await jest.advanceTimersByTimeAsync(6000);

      await expect(resultPromise).resolves.toEqual({ triggered: true });
      jest.useRealTimers();
    });

    it("reports not triggered when the interceptor Service itself is unreachable", async () => {
      const connError = new Error("connect ECONNREFUSED");
      connError.code = "ECONNREFUSED";
      mockTransportRequest(http, { error: connError });

      const result = await startOllama();

      expect(result).toEqual({ triggered: false });
    });
  });

  describe("isOllamaReady", () => {
    it("returns true on a 200 from the direct Ollama Service, bypassing the interceptor", async () => {
      mockTransportRequest(http, { statusCode: 200, body: "{}" });

      const ready = await isOllamaReady();

      expect(ready).toBe(true);
      const [options] = http.request.mock.calls[0];
      expect(options.headers.Host).toBeUndefined();
    });

    it("returns false when the Ollama Service refuses the connection (scaled to zero)", async () => {
      const connError = new Error("connect ECONNREFUSED");
      connError.code = "ECONNREFUSED";
      mockTransportRequest(http, { error: connError });

      await expect(isOllamaReady()).resolves.toBe(false);
    });

    it("returns false within its short timeout rather than waiting on a cold pod", async () => {
      jest.useFakeTimers();
      mockTransportRequest(http, { hang: true });

      const readyPromise = isOllamaReady();
      await jest.advanceTimersByTimeAsync(2000);

      await expect(readyPromise).resolves.toBe(false);
      jest.useRealTimers();
    });
  });
});
