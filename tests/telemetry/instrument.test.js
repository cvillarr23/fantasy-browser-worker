jest.mock("../../src/db/activity", () => ({
  observe: jest.fn(async (bot, id) => id),
  event: jest.fn(),
  redact: (value) => value,
}));
jest.mock("../../src/db/execution_log", () => ({ recordExecution: jest.fn() }));
jest.mock("../../src/db/run_log", () => ({
  triggerFromEnv: jest.fn(() => ({ triggerType: "schedule", trigger: { cronjob: "rumor-digest-bot" } })),
  parentForAction: jest.fn(async () => "queueing-run"),
  startRun: jest.fn(async () => "run-1"),
  finishRun: jest.fn(),
  addSummary: jest.requireActual("../../src/db/run_log").addSummary,
}));
jest.mock("../../src/lib/notify", () => ({
  ...jest.requireActual("../../src/lib/notify"),
  notify: jest.fn(async () => "sent"),
}));
const runLog = require("../../src/db/run_log");
const { notify } = require("../../src/lib/notify");
const { getContext } = require("../../src/telemetry/context");
const { withInstrumentation } = require("../../src/telemetry/instrument");

it("records a queue run as a child of the run that queued the action", async () => {
  await withInstrumentation("lineup_bot", { queueName: "lineup_updates", trackingId: "action-1" }, async () => {
    expect(getContext().runId).toBe("run-1");
    runLog.addSummary({ swaps: 2 });
    return { submitted: true };
  });
  expect(runLog.parentForAction).toHaveBeenCalledWith("action-1");
  expect(runLog.startRun).toHaveBeenCalledWith(
    expect.objectContaining({
      jobName: "lineup_bot",
      triggerType: "queue",
      trigger: { queue: "lineup_updates", tracking_id: "action-1" },
      parentRunId: "queueing-run",
    }),
  );
  expect(runLog.finishRun).toHaveBeenCalledWith("run-1", "success", {
    summary: { result: { submitted: true }, swaps: 2 },
  });
});

it("records a scheduled job's failure and still rethrows", async () => {
  await expect(
    withInstrumentation("rumor_digest_bot", { trackingId: "t" }, async () => {
      throw new Error("LLM down");
    }),
  ).rejects.toThrow("LLM down");
  expect(runLog.parentForAction).not.toHaveBeenCalled();
  expect(runLog.startRun).toHaveBeenCalledWith(expect.objectContaining({ triggerType: "schedule" }));
  expect(runLog.finishRun).toHaveBeenCalledWith("run-1", "failure", { error: "LLM down", summary: {} });
});

it("sends one run-failed notification linked to the failed run", async () => {
  await expect(
    withInstrumentation("lineup_bot", { trackingId: "t" }, async () => {
      throw new Error("roster table missing");
    }),
  ).rejects.toThrow("roster table missing");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "lineup_bot failed", path: "/activity/runs/run-1" }),
  );
});

it("sends the ESPN session alert instead of a generic failure", async () => {
  await expect(
    withInstrumentation("check_espn_session", { trackingId: "t" }, async () => {
      throw new Error("not logged in");
    }),
  ).rejects.toThrow("not logged in");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "ESPN session expired" }));
});

it("sends nothing when the run succeeds", async () => {
  await withInstrumentation("lineup_bot", { trackingId: "t" }, async () => ({ ok: true }));
  expect(notify).not.toHaveBeenCalled();
});

it("rejects without running the bot when the adopted attempt is stale", async () => {
  runLog.startRun.mockRejectedValueOnce(new Error("Run r attempt 1 is no longer current"));
  const handler = jest.fn();
  await expect(withInstrumentation("lineup_bot", { trackingId: "t" }, handler)).rejects.toThrow(
    "no longer current",
  );
  expect(handler).not.toHaveBeenCalled();
  expect(runLog.finishRun).not.toHaveBeenCalled();
});
