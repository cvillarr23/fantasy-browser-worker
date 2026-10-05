const mockQuery = jest.fn();
const mockClient = { query: mockQuery, release: jest.fn() };
jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn(async () => mockClient),
    query: (...args) => mockQuery(...args),
  })),
}));
jest.mock("../src/telemetry/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("../src/telemetry/context", () => ({ getContext: () => ({ trackingId: "action-1" }) }));
const activity = require("../src/db/activity");
beforeEach(() => mockQuery.mockReset());
function mockState(state, acquired = true) {
  mockQuery.mockImplementation(async sql => ({rows: sql.includes("pg_try_advisory_lock") ? [{acquired}] : sql.startsWith("SELECT execution") ? [state] : []}));
}
afterEach(async () => { await activity.release("action-1"); });
it("defers concurrent delivery without acknowledging it as complete", async () => {
  mockState({execution: "running"}, false);
  await expect(activity.claim("waiver_actions", {tracking_id:"action-1"})).rejects.toMatchObject({retryDelayMs:1000});
});
it.each(["queued", "delivered", "failed", "running"])("can resume %s when no worker owns the action", async execution => {
  mockState({execution, attempts:1, evidence:{}});
  expect(await activity.claim("waiver_actions", {tracking_id:"action-1",season:2026})).toBe(true);
  expect(mockQuery.mock.calls.some(([sql]) => sql.includes("attempts=attempts+1"))).toBe(true);
});
it("does not replay an uncertain pending waiver", async () => {
  mockState({execution:"failed", attempts:1,evidence:{external_write_started:true}});
  await expect(activity.claim("waiver_actions", {tracking_id:"action-1"})).rejects.toMatchObject({permanent:true});
  expect(mockQuery.mock.calls.some(([sql]) => sql.includes("manual_verification_required"))).toBe(true);
});
it("does not replay a submitted action", async () => {
  mockState({execution:"submitted",attempts:1,evidence:{}});
  expect(await activity.claim("waiver_actions", {tracking_id:"action-1"})).toBe(false);
});
it("caps repeated failures", async () => {
  mockState({execution:"failed",attempts:5,evidence:{}});
  await expect(activity.claim("waiver_actions",{tracking_id:"action-1"})).rejects.toMatchObject({permanent:true});
});
it("outcome recording failure never triggers a second external write", async () => {
  mockQuery.mockRejectedValue(new Error("db unavailable"));
  await expect(
    activity.event("submitted", {}, "submitted", "awaiting_processing"),
  ).resolves.toBeUndefined();
});
it("redacts nested credentials and bearer tokens", () => {
  expect(activity.redact({ authorization: "abc", nested: ["Bearer abcdefg"] })).toEqual({
    authorization: "[REDACTED]",
    nested: ["Bearer [REDACTED]"],
  });
});

it("background LLM content is metadata by default", () => {
  delete process.env.LLM_HISTORY_CAPTURE_CONTENT;
  const result = activity.historyContent({user:"private league data"});
  expect(result.content_sha256).toHaveLength(64);
  expect(JSON.stringify(result)).not.toContain("private league data");
});

it.each([null, [], "invalid"])("rejects malformed payloads without a retry loop", async payload => {
  await expect(activity.claim("waiver_actions",payload)).rejects.toMatchObject({permanent:true});
  expect(mockQuery).not.toHaveBeenCalled();
});
