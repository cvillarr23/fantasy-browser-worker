jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    on: jest.fn(),
  })),
}));

jest.mock("../../src/queue/connection", () => ({
  publishToQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/lib/llm_client", () => ({
  completeWithFallback: jest.fn(),
}));

const { Pool } = require("pg");
const { publishToQueue } = require("../../src/queue/connection");
const { completeWithFallback } = require("../../src/lib/llm_client");
const { PermanentError } = require("../../src/errors");
const {
  requestLlmAsync,
  getLlmRequestResult,
  waitForLlmResult,
  processAsyncLlmRequest,
} = require("../../src/lib/llm_async_queue");

// Capture here, at file-evaluation time -- Pool is constructed once at module load, and
// clearMocks/restoreMocks (jest.config, run before every test) would wipe Pool.mock.results
// by the time a beforeEach hook ran.
const pool = Pool.mock.results[0].value;

describe("llm_async_queue", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  describe("requestLlmAsync", () => {
    it("inserts a pending row before publishing, then returns the request_id", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const result = await requestLlmAsync("what should I start", {
        callSite: "test",
      });

      expect(result.request_id).toEqual(expect.any(String));

      const [insertSql, insertParams] = pool.query.mock.calls[0];
      expect(insertSql).toMatch(/INSERT INTO llm_async_requests/);
      expect(insertSql).toMatch(/'pending'/);
      expect(insertParams).toContain(result.request_id);
      expect(insertParams).toContain("what should I start");

      expect(publishToQueue).toHaveBeenCalledWith("llm_requests", {
        request_id: result.request_id,
        prompt: "what should I start",
        opts: { callSite: "test" },
      });

      expect(pool.query.mock.invocationCallOrder[0]).toBeLessThan(
        publishToQueue.mock.invocationCallOrder[0],
      );
    });
  });

  describe("getLlmRequestResult", () => {
    it("returns the row for a known request_id", async () => {
      const row = { status: "succeeded", result_text: "go start Player X" };
      pool.query.mockResolvedValue({ rows: [row] });

      const result = await getLlmRequestResult("abc-123");

      expect(result).toEqual(row);
      expect(pool.query.mock.calls[0][1]).toEqual(["abc-123"]);
    });

    it("returns null for an unknown request_id", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const result = await getLlmRequestResult("does-not-exist");

      expect(result).toBeNull();
    });
  });

  describe("waitForLlmResult", () => {
    it("resolves once a poll sees a non-pending status", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ status: "pending" }] })
        .mockResolvedValueOnce({
          rows: [{ status: "succeeded", result_text: "done" }],
        });

      const result = await waitForLlmResult("abc-123", {
        timeoutMs: 5000,
        pollIntervalMs: 5,
      });

      expect(result).toEqual({ status: "succeeded", result_text: "done" });
    });

    it("rejects with a plain Error once timeoutMs elapses while still pending", async () => {
      pool.query.mockResolvedValue({ rows: [{ status: "pending" }] });

      await expect(
        waitForLlmResult("abc-123", { timeoutMs: 20, pollIntervalMs: 5 }),
      ).rejects.toThrow(/timed out/i);
    });
  });

  describe("processAsyncLlmRequest", () => {
    it("calls completeWithFallback and marks the row succeeded", async () => {
      completeWithFallback.mockResolvedValue({
        text: "start Player X",
        provider: "groq",
        model: "llama",
      });
      pool.query.mockResolvedValue({ rows: [] });

      await processAsyncLlmRequest({
        request_id: "abc-123",
        prompt: "who should I start",
        opts: { callSite: "test" },
      });

      expect(completeWithFallback).toHaveBeenCalledWith("who should I start", {
        callSite: "test",
      });
      const [updateSql, updateParams] = pool.query.mock.calls[0];
      expect(updateSql).toMatch(/UPDATE llm_async_requests/);
      expect(updateSql).toMatch(/'succeeded'/);
      expect(updateParams).toContain("abc-123");
      expect(updateParams).toContain("start Player X");
    });

    it("marks the row failed and rethrows a plain Error when every provider fails", async () => {
      completeWithFallback.mockRejectedValue(
        new Error("all providers exhausted"),
      );
      pool.query.mockResolvedValue({ rows: [] });

      await expect(
        processAsyncLlmRequest({ request_id: "abc-123", prompt: "hi" }),
      ).rejects.toThrow(/all providers exhausted/);

      const [updateSql, updateParams] = pool.query.mock.calls[0];
      expect(updateSql).toMatch(/'failed'/);
      expect(updateParams).toContain("abc-123");
    });

    it("throws PermanentError on a missing request_id without calling the LLM", async () => {
      await expect(
        processAsyncLlmRequest({ prompt: "hi" }),
      ).rejects.toBeInstanceOf(PermanentError);

      expect(completeWithFallback).not.toHaveBeenCalled();
    });

    it("throws PermanentError on a missing prompt without calling the LLM", async () => {
      await expect(
        processAsyncLlmRequest({ request_id: "abc-123" }),
      ).rejects.toBeInstanceOf(PermanentError);

      expect(completeWithFallback).not.toHaveBeenCalled();
    });
  });
});
