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

  it("prefers the launcher's explicit trigger", () => {
    expect(runLog.triggerFromEnv({ RUN_TRIGGER: "schedule", RUN_CRONJOB: "ignored" })).toEqual({
      triggerType: "schedule",
      trigger: {},
    });
  });
});

it("adopts a launcher run id and parent", async () => {
  process.env.RUN_ID = "launcher-run";
  process.env.RUN_TRIGGER = "schedule";
  process.env.RUN_PARENT_ID = "launcher-parent";
  const id = await runLog.startRun({ jobName: "trade_scan" });
  expect(id).toBe("launcher-run");
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("summary=summary || jsonb_build_object('entrypoint',$2::text)"),
    ["schedule", "trade_scan", "launcher-parent", "launcher-run"],
  );
  const adoptionSql = mockQuery.mock.calls[0][0];
  expect(adoptionSql).not.toContain("job_name=");
  expect(adoptionSql).not.toContain("trigger=$");
  expect(process.env.RUN_PARENT_ID).toBe("launcher-run");
  await runLog.finishRun(id, "success");
  expect(process.env.RUN_PARENT_ID).toBe("launcher-parent");
  delete process.env.RUN_ID;
  delete process.env.RUN_TRIGGER;
  delete process.env.RUN_PARENT_ID;
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
