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

afterEach(() => {
  for (const key of ["RUN_ID", "RUN_ATTEMPT", "RUN_TRIGGER", "RUN_PARENT_ID"]) delete process.env[key];
});

function launcherRun({ attempt } = {}) {
  process.env.RUN_ID = "launcher-run";
  process.env.RUN_TRIGGER = "schedule";
  process.env.RUN_PARENT_ID = "launcher-parent";
  if (attempt) process.env.RUN_ATTEMPT = attempt;
}

it("adopts a launcher run id and parent", async () => {
  launcherRun();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  const id = await runLog.startRun({ jobName: "trade_scan" });
  expect(id).toBe("launcher-run");
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("summary=summary || jsonb_build_object('entrypoint',$2::text)"),
    ["schedule", "trade_scan", "launcher-parent", "launcher-run", null],
  );
  const adoptionSql = mockQuery.mock.calls[0][0];
  expect(adoptionSql).not.toContain("job_name=");
  expect(adoptionSql).not.toContain("trigger=$");
  expect(process.env.RUN_PARENT_ID).toBe("launcher-run");
  await runLog.finishRun(id, "success");
  expect(process.env.RUN_PARENT_ID).toBe("launcher-parent");
});

it("adopts only a row still running at this attempt", async () => {
  launcherRun({ attempt: "2" });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  expect(await runLog.startRun({ jobName: "trade_scan" })).toBe("launcher-run");
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain("WHERE id=$4 AND status='running' AND attempt=COALESCE($5,attempt)");
  expect(params).toEqual(["schedule", "trade_scan", "launcher-parent", "launcher-run", 2]);
  await runLog.finishRun("launcher-run", "success");
  expect(mockQuery.mock.calls[1][1][4]).toBe(2);
});

it("fails startup for a stale attempt", async () => {
  launcherRun({ attempt: "1" });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  await expect(runLog.startRun({ jobName: "trade_scan" })).rejects.toThrow(
    "Run launcher-run attempt 1 is no longer current",
  );
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(process.env.RUN_ID).toBeUndefined();
  expect(process.env.RUN_PARENT_ID).toBe("launcher-parent");
});

it("fails startup for an unreadable attempt", async () => {
  launcherRun({ attempt: "two" });
  await expect(runLog.startRun({ jobName: "trade_scan" })).rejects.toThrow("invalid RUN_ATTEMPT");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("keeps running an adopted run when adoption hits a database error", async () => {
  launcherRun({ attempt: "2" });
  mockQuery.mockRejectedValueOnce(new Error("db down"));
  expect(await runLog.startRun({ jobName: "trade_scan" })).toBe("launcher-run");
});

it("finishes only an uncancelled row at the adopted attempt", async () => {
  launcherRun({ attempt: "3" });
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  await runLog.startRun({ jobName: "trade_scan" });
  // A newer attempt or a cancel since adoption leaves nothing for the finish to match.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  await runLog.finishRun("launcher-run", "failure", { error: "boom" });
  const [sql, params] = mockQuery.mock.calls[1];
  expect(sql).toContain("WHERE id=$1 AND status<>'cancelled' AND attempt=COALESCE($5,attempt)");
  expect(params).toEqual(["launcher-run", "failure", "boom", "{}", 3]);
  expect(process.env.RUN_PARENT_ID).toBe("launcher-parent");
});

it("never overwrites a cancelled run it did not adopt", async () => {
  const id = await runLog.startRun({ jobName: "x", triggerType: "manual", trigger: {} });
  await runLog.finishRun(id, "success");
  const [sql, params] = mockQuery.mock.calls[1];
  expect(sql).toContain("status<>'cancelled'");
  expect(params).toEqual([id, "success", null, "{}", null]);
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
