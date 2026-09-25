// pg is mocked so recordLlmCallMetric's best-effort insert never attempts a real connection --
// there's no DB_HOST in the test env, and unmocked it would eat connectionTimeoutMillis (5s) per
// attempt.
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockRejectedValue(new Error("no db in tests")),
    on: jest.fn(),
  })),
}));

const { completeWithFallback } = require("../../src/lib/llm_client");

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
});
