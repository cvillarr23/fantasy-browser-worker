jest.mock("../../src/bots/trade_proposal", () => ({
  generateTradeProposal: jest.fn(),
}));
jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const {
  resolvePeriod,
  runTradeScan,
  claimScan,
  main,
} = require("../../src/bots/trade_scan");
const state = { season_type: "regular", season: "2026", week: 4 };
const now = new Date("2026-10-04T12:00:00Z");
let deps;
beforeEach(() => {
  process.env.ESPN_LEAGUE_ID = "123";
  process.env.ESPN_TEAM_ID = "7";
  deps = {
    now,
    readState: jest.fn().mockResolvedValue(state),
    claim: jest.fn().mockResolvedValue(true),
    generate: jest.fn().mockResolvedValue({ status: "no_target" }),
    refreshInbox: jest.fn().mockResolvedValue({ status: "refreshed", openOfferTeamIds: [] }),
    pool: {},
  };
});
test("derives regular week and prior season in January", () => {
  expect(resolvePeriod(state, now)).toEqual({ season: 2026, week: 4 });
  expect(resolvePeriod({ ...state, week: 18 }, new Date("2027-01-06"))).toEqual(
    { season: 2026, week: 18 },
  );
});
test.each(["pre", "post", "off"])("quiet in %s season", async (season_type) => {
  deps.readState.mockResolvedValue({ ...state, season_type });
  expect(await runTradeScan({ stage: true }, deps)).toEqual({
    status: "off_season",
  });
  expect(deps.claim).not.toHaveBeenCalled();
  expect(deps.generate).not.toHaveBeenCalled();
});
test("quiet on week zero and stale spring state", () => {
  expect(resolvePeriod({ ...state, week: 0 }, now)).toBeNull();
  expect(resolvePeriod(state, new Date("2027-05-01"))).toBeNull();
});
test.each([
  null,
  {},
  { ...state, week: 19 },
  { ...state, week: "4" },
  { ...state, season: "2025" },
])("rejects malformed/stale state %j", (input) => {
  expect(() => resolvePeriod(input, now)).toThrow();
});
test("default manual check has no claims or generation", async () => {
  expect(await runTradeScan({}, deps)).toMatchObject({
    status: "check_only",
    season: 2026,
    week: 4,
  });
  expect(deps.claim).not.toHaveBeenCalled();
  expect(deps.generate).not.toHaveBeenCalled();
});
test("rejects unknown CLI flags before doing work", async () => {
  await expect(main(["--approved"])).rejects.toThrow("Usage");
});
test("state errors fail closed", async () => {
  deps.readState.mockRejectedValue(new Error("timeout"));
  await expect(runTradeScan({ stage: true }, deps)).rejects.toThrow("timeout");
  expect(deps.claim).not.toHaveBeenCalled();
});
test("missing ESPN config fails before claim", async () => {
  delete process.env.ESPN_TEAM_ID;
  await expect(runTradeScan({ stage: true }, deps)).rejects.toThrow(
    "positive ids",
  );
  expect(deps.claim).not.toHaveBeenCalled();
});
test("duplicate run never generates", async () => {
  deps.claim.mockResolvedValue(false);
  expect(await runTradeScan({ stage: true }, deps)).toMatchObject({
    status: "duplicate",
  });
  expect(deps.generate).not.toHaveBeenCalled();
});
test("claims once and forwards only period/tracking, never approval", async () => {
  await runTradeScan({ stage: true, trackingId: "scan", approved: true }, deps);
  expect(deps.claim).toHaveBeenCalledWith(
    deps.pool,
    "trade-scan:123:7:2026-10-04",
    "scan",
  );
  expect(deps.generate).toHaveBeenCalledWith({
    season: 2026,
    week: 4,
    tracking_id: "scan",
  });
});
test("claim failure prevents generation", async () => {
  deps.claim.mockRejectedValue(new Error("database unavailable"));
  await expect(runTradeScan({ stage: true }, deps)).rejects.toThrow(
    "database unavailable",
  );
  expect(deps.generate).not.toHaveBeenCalled();
});
test.each(["no_target", "no_offer"])("reports %s", async (status) => {
  deps.generate.mockResolvedValue({ status });
  expect(await runTradeScan({ stage: true }, deps)).toMatchObject({ status });
});
test("a no_offer reason is reported with the scan result", async () => {
  deps.generate.mockResolvedValue({ status: "no_offer", reason: "no_useful_offer", rejections: [] });
  expect(await runTradeScan({ stage: true }, deps)).toMatchObject({
    status: "no_offer",
    reason: "no_useful_offer",
  });
});
test("staging failure fails the job without retrying generation", async () => {
  deps.generate.mockResolvedValue({
    submission: { status: "fill_failed", error: "DOM" },
  });
  await expect(runTradeScan({ stage: true }, deps)).rejects.toThrow("DOM");
  expect(deps.generate).toHaveBeenCalledTimes(1);
  expect(deps.claim).toHaveBeenCalledTimes(1);
});
test("generation failure is not retried", async () => {
  deps.generate.mockRejectedValue(new Error("LLM"));
  await expect(runTradeScan({ stage: true }, deps)).rejects.toThrow("LLM");
  expect(deps.generate).toHaveBeenCalledTimes(1);
});
test.each([0, 1])(
  "transaction serializes durable claim; existing rows=%i",
  async (rowCount) => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    expect(await claimScan(pool, "key", "trace")).toBe(rowCount === 0);
    const sql = client.query.mock.calls.map(([q]) => q);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("SELECT 1 FROM execution_log");
    expect(sql.some((q) => q.startsWith("INSERT"))).toBe(rowCount === 0);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalled();
  },
);
test("claim rolls back and releases on DB errors", async () => {
  const client = {
    query: jest
      .fn()
      .mockResolvedValue({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("DB")),
    release: jest.fn(),
  };
  await expect(
    claimScan({ connect: async () => client }, "key", "trace"),
  ).rejects.toThrow("DB");
  expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalled();
});

test("CLI check emits structured status through the repository logger", async () => {
  const savedFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ season_type: "pre" }),
  });
  try {
    await main(["--check"]);
    expect(
      require("../../src/telemetry/logger").logger.info,
    ).toHaveBeenLastCalledWith(
      "[Trade Scan] Completed",
      expect.objectContaining({
        status: "off_season",
        trackingId: expect.any(String),
      }),
    );
  } finally {
    global.fetch = savedFetch;
  }
});

test("Wednesday and Friday run independently; same-day repeats are suppressed", async () => {
  const claims = new Set();
  deps.claim.mockImplementation(async (_pool, key) => {
    if (claims.has(key)) return false;
    claims.add(key);
    return true;
  });
  deps.now = new Date("2026-10-07T18:00:00Z");
  expect((await runTradeScan({ stage: true }, deps)).status).toBe("no_target");
  deps.now = new Date("2026-10-08T01:00:00Z"); // still Wednesday in Chicago
  expect((await runTradeScan({ stage: true }, deps)).status).toBe("duplicate");
  deps.now = new Date("2026-10-09T18:00:00Z");
  expect((await runTradeScan({ stage: true }, deps)).status).toBe("no_target");
  expect(deps.generate).toHaveBeenCalledTimes(2);
});
test.each([
  ["2026-10-08T04:59:59Z", "2026-10-07"],
  ["2026-10-08T05:00:00Z", "2026-10-08"],
  ["2026-11-05T05:59:59Z", "2026-11-04"],
  ["2026-11-05T06:00:00Z", "2026-11-05"],
])("claim date respects Chicago midnight and DST at %s", async (time, date) => {
  deps.now = new Date(time);
  expect((await runTradeScan({}, deps)).scanKey).toBe(
    `trade-scan:123:7:${date}`,
  );
});
test("NFL week metadata changes do not bypass the daily claim key", async () => {
  const first = await runTradeScan({}, deps);
  deps.readState.mockResolvedValue({ ...state, week: 5 });
  const second = await runTradeScan({}, deps);
  expect(second.scanKey).toBe(first.scanKey);
});
test("refreshes the inbox before generating and skips teams with an offer to us", async () => {
  deps.refreshInbox.mockResolvedValue({ status: "refreshed", openOfferTeamIds: ["3", "5"] });
  await runTradeScan({ stage: true, trackingId: "scan" }, deps);
  expect(deps.refreshInbox).toHaveBeenCalledWith({ persist: true });
  expect(deps.generate).toHaveBeenCalledWith({
    season: 2026,
    week: 4,
    tracking_id: "scan",
    exclude_team_ids: ["3", "5"],
  });
});
test("an inbox refresh failure does not stop the scan", async () => {
  deps.refreshInbox.mockRejectedValue(new Error("ESPN down"));
  await runTradeScan({ stage: true, trackingId: "scan" }, deps);
  expect(deps.generate).toHaveBeenCalledWith({ season: 2026, week: 4, tracking_id: "scan" });
});
test("a duplicate or check-only scan does not refresh the inbox", async () => {
  await runTradeScan({}, deps);
  deps.claim.mockResolvedValue(false);
  await runTradeScan({ stage: true }, deps);
  expect(deps.refreshInbox).not.toHaveBeenCalled();
});
