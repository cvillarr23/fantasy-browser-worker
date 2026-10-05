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
it("does not execute a redelivered running waiver", async () => {
  mockQuery.mockImplementation(async (sql) => ({
    rows: sql.startsWith("SELECT") ? [{ execution: "running" }] : [],
  }));
  expect(await activity.claim("waiver_actions", { tracking_id: "action-1", team_id: "8" })).toBe(
    false,
  );
  expect(mockQuery.mock.calls.some(([sql]) => sql.includes("attempts=attempts+1"))).toBe(false);
});
it("takes ownership atomically before dispatch", async () => {
  mockQuery.mockImplementation(async (sql) => ({
    rows: sql.startsWith("SELECT") ? [{ execution: "queued" }] : [],
  }));
  expect(await activity.claim("waiver_actions", { tracking_id: "action-1" })).toBe(true);
  expect(mockQuery.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
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
