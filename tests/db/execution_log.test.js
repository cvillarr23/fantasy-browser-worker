jest.mock("../../src/db/activity", () => ({ event: jest.fn().mockResolvedValue(undefined) }));
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  })),
}));

const { Pool } = require("pg");
const {
  findTradeSubmission,
  claimTradeSubmission,
  finalizeTradeSubmission,
  recordTradeOfferFill,
} = require("../../src/db/execution_log");

// Captured at file-evaluation time: Pool is constructed once at module load, and clearMocks would
// wipe Pool.mock.results before any beforeEach could read it (same as llm_async_queue.test.js).
const pool = Pool.mock.results[0].value;

const OFFER_KEY = "a".repeat(64);
const ROW = {
  leagueId: "1248158344",
  season: 2026,
  source: "counter_offer",
  fromTeamId: "8",
  toTeamId: "3",
  incomingPlayerIds: ["4259545", "-16021"],
  outgoingPlayerIds: ["3139477"],
  approvedBy: "conor",
};

function fakeClient(responses) {
  const client = {
    query: jest.fn(async (sql) => {
      for (const [pattern, result] of responses) {
        if (pattern.test(sql)) {
          if (result instanceof Error) throw result;
          return result;
        }
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

const statements = (client) => client.query.mock.calls.map(([sql]) => sql.trim());

describe("claimTradeSubmission", () => {
  it("takes an advisory lock on the offer key and inserts a submitting row when none exists", async () => {
    const client = fakeClient([[/INSERT INTO execution_log/, { rows: [{ id: 11 }] }]]);

    await expect(claimTradeSubmission(OFFER_KEY, ROW)).resolves.toEqual({ claimed: true, id: 11 });

    const sqls = statements(client);
    expect(sqls).toHaveLength(5);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    expect(sqls[2]).toMatch(/^SELECT id, status/);
    expect(sqls[3]).toMatch(/^INSERT INTO execution_log/);
    expect(sqls[4]).toBe("COMMIT");
    expect(client.query.mock.calls[1][1]).toEqual([OFFER_KEY]);
    const [insertSql, insertParams] = client.query.mock.calls[3];
    expect(insertSql).toMatch(/'submitting'/);
    expect(JSON.parse(insertParams.find((p) => typeof p === "string" && p.startsWith("{")))).toMatchObject({
      offer_key: OFFER_KEY,
      source: "counter_offer",
      to_team_id: "3",
      incoming_player_ids: ["4259545", "-16021"],
      approved_by: "conor",
    });
    expect(client.release).toHaveBeenCalled();
  });

  it("returns the existing status instead of inserting when the key is already claimed", async () => {
    const client = fakeClient([[/SELECT id, status/, { rows: [{ id: 3, status: "submitted" }] }]]);

    await expect(claimTradeSubmission(OFFER_KEY, ROW)).resolves.toEqual({
      claimed: false,
      existing: "submitted",
    });
    expect(client.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });

  it("rolls back, releases, and THROWS on a DB error — unlike the best-effort writers", async () => {
    const client = fakeClient([[/INSERT INTO execution_log/, new Error("disk full")]]);

    await expect(claimTradeSubmission(OFFER_KEY, ROW)).rejects.toThrow(/disk full/);
    expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});

describe("findTradeSubmission", () => {
  it("returns the submitted row ahead of a submitting one for the same key", async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 5, status: "submitted" }] });

    await expect(findTradeSubmission(OFFER_KEY)).resolves.toEqual({ id: 5, status: "submitted" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/counter_offer->>'offer_key' = \$1/);
    expect(sql).toMatch(/status IN \('submitting', 'submitted'\)/);
    expect(params).toEqual([OFFER_KEY]);
  });

  it("returns null when there is no claim", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(findTradeSubmission(OFFER_KEY)).resolves.toBeNull();
  });

  it("throws on a DB error, so the caller fails closed instead of assuming no claim", async () => {
    pool.query.mockRejectedValue(new Error("connection refused"));
    await expect(findTradeSubmission(OFFER_KEY)).rejects.toThrow(/connection refused/);
  });
});

describe("finalizeTradeSubmission", () => {
  it("updates the claimed row by id", async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await finalizeTradeSubmission(11, "submitted");
    expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE execution_log/), [11, "submitted", null]);
  });

  it("never throws: a stale submitting row fails closed on redelivery anyway", async () => {
    pool.query.mockRejectedValue(new Error("boom"));
    await expect(finalizeTradeSubmission(11, "submitted")).resolves.toBeUndefined();
  });
});

describe("recordTradeOfferFill", () => {
  it("writes a best-effort trade_offer_submit row and never throws", async () => {
    pool.query.mockRejectedValue(new Error("boom"));
    await expect(
      recordTradeOfferFill({ ...ROW, offerKey: OFFER_KEY, status: "awaiting_approval", dryRun: true }),
    ).resolves.toBeUndefined();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO execution_log/);
    expect(params).toEqual(expect.arrayContaining(["trade_offer_submit", "trade_builder", "awaiting_approval", true]));
  });
});
