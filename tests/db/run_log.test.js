const mockQuery = jest.fn();
jest.mock("pg", () => ({
  Pool: jest.fn(() => ({ on: jest.fn(), query: (...args) => mockQuery(...args) })),
}));
jest.mock("../../src/telemetry/logger", () => ({ logger: { error: jest.fn() } }));
const mockContext = {};
jest.mock("../../src/telemetry/context", () => ({ getContext: () => mockContext }));
const runLog = require("../../src/db/run_log");

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  for (const key of Object.keys(mockContext)) delete mockContext[key];
});

describe("triggerFromEnv", () => {
  it.each([
    ["rumor-digest-bot-29863680", "schedule"],
    ["rumor-digest-bot-manual-1", "manual"],
  ])("reads %s as a %s run", (job, triggerType) => {
    expect(runLog.triggerFromEnv({ RUN_CRONJOB: "rumor-digest-bot", RUN_K8S_JOB: job })).toEqual({
      triggerType,
      trigger: { cronjob: "rumor-digest-bot", k8s_job: job },
    });
  });

  it("treats a run outside a CronJob as manual", () => {
    expect(runLog.triggerFromEnv({ HOSTNAME: "laptop" })).toEqual({
      triggerType: "manual",
      trigger: { host: "laptop" },
    });
  });
});

it("links to the run in the active context", async () => {
  mockContext.runId = "run-1";
  await runLog.link("raw_signal", [1, null, 2], "input");
  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO run_links"), [
    "run-1",
    "raw_signal",
    ["1", "2"],
    "input",
  ]);
});

it("does nothing outside a run", async () => {
  await runLog.link("raw_signal", [1], "input");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("finds the run that queued an action", async () => {
  mockQuery.mockResolvedValue({ rows: [{ run_id: "parent" }] });
  expect(await runLog.parentForAction("action-1")).toBe("parent");
  expect(await runLog.parentForAction(null)).toBeNull();
});

it("never throws when the audit log is unavailable", async () => {
  mockQuery.mockRejectedValue(new Error("db down"));
  mockContext.runId = "run-1";
  expect(await runLog.startRun({ jobName: "x", triggerType: "manual", trigger: {} })).toBeNull();
  await expect(runLog.finishRun("run-1", "success")).resolves.toBeUndefined();
  await expect(runLog.link("raw_signal", [1], "input")).resolves.toBeUndefined();
  expect(await runLog.parentForAction("action-1")).toBeNull();
});

it("collects summary fields on the active run", () => {
  mockContext.runSummary = {};
  runLog.addSummary({ written: 2 });
  expect(mockContext.runSummary).toEqual({ written: 2 });
});
