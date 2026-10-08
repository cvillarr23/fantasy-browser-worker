jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  })),
}));
jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { Pool } = require("pg");
const { loadInbox, updateEntry, setTriage, claimOfferResponse, settleOfferResponse } = require("../../src/db/trade_inbox");
const { PermanentError } = require("../../src/errors");

const pool = Pool.mock.results[0].value;
const SCOPE = { leagueId: "1248158344", season: 2026 };
const NOW = new Date("2026-10-06T18:00:00Z");

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
const storedRow = (entry, status = "open") => ({
  rows: [{ id: 7, status, counter_offer: { espn_transaction_id: "tx-1", ...entry } }],
});

describe("loadInbox", () => {
  it("reads this league's inbox rows with the status column folded in", async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 7, status: "open", counter_offer: { espn_transaction_id: "tx-1", fingerprint: "fp" } }],
    });

    await expect(loadInbox(SCOPE)).resolves.toEqual([
      { ledger_id: 7, status: "open", espn_transaction_id: "tx-1", fingerprint: "fp" },
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/transaction_type = 'trade_inbox'/);
    expect(params).toEqual(["1248158344"]);
  });

  it("throws on a DB error so a refresh never works from a partial view", async () => {
    pool.query.mockRejectedValue(new Error("down"));
    await expect(loadInbox(SCOPE)).rejects.toThrow(/down/);
  });
});

describe("updateEntry", () => {
  it("round-trips full evaluation JSON and preserves it through triage", async () => {
    const evaluation = {
      version: "incoming-trade-evaluation-v1",
      request: { week: 5 },
      score: {
        horizon: {
          unscored_weeks: [{ week: 6, reasons: ["no_week_metrics"] }],
        },
      },
    };
    const client = fakeClient([[/FOR UPDATE/, storedRow({ evaluation })]]);
    await setTriage("tx-1", SCOPE, { state: "seen", by: "conor", now: NOW });
    const saved = JSON.parse(
      client.query.mock.calls.find(([sql]) => /^UPDATE/.test(sql))[1][2],
    );
    expect(saved.evaluation).toEqual(evaluation);
    pool.query.mockResolvedValue(storedRow(saved));
    const [loaded] = await loadInbox(SCOPE);
    expect(loaded.evaluation).toEqual(evaluation);
  });
  it("locks the offer, inserts a never-seen entry and keeps status in its column", async () => {
    const client = fakeClient([]);
    const mutate = jest.fn(() => ({ espn_transaction_id: "tx-1", status: "open", proposing_team_id: "3" }));

    await updateEntry("tx-1", SCOPE, mutate);

    const sqls = statements(client);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    expect(client.query.mock.calls[1][1]).toEqual(["trade-inbox:1248158344:tx-1"]);
    expect(sqls[2]).toMatch(/FOR UPDATE/);
    expect(mutate).toHaveBeenCalledWith(null);
    expect(sqls[3]).toMatch(/^INSERT INTO execution_log/);
    const params = client.query.mock.calls[3][1];
    expect(params).toEqual(["open", "1248158344", 2026, "3", expect.any(String)]);
    expect(JSON.parse(params[4])).toEqual({ espn_transaction_id: "tx-1", proposing_team_id: "3" });
    expect(sqls[4]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("hands the locked stored entry to mutate and updates that row", async () => {
    const client = fakeClient([[/FOR UPDATE/, storedRow({ triage: { state: "seen" } })]]);
    const mutate = jest.fn((stored) => ({ ...stored, status: "expired" }));

    await updateEntry("tx-1", SCOPE, mutate);

    expect(mutate).toHaveBeenCalledWith({
      ledger_id: 7,
      status: "open",
      espn_transaction_id: "tx-1",
      triage: { state: "seen" },
    });
    const [sql, params] = client.query.mock.calls[3];
    expect(sql).toMatch(/^\s*UPDATE execution_log/);
    expect(params[0]).toBe(7);
    expect(params[1]).toBe("expired");
    expect(JSON.parse(params[2])).toEqual({ espn_transaction_id: "tx-1", triage: { state: "seen" } });
  });

  it("writes nothing when mutate returns null", async () => {
    const client = fakeClient([[/FOR UPDATE/, storedRow({})]]);
    await updateEntry("tx-1", SCOPE, () => null);
    expect(statements(client).some((sql) => /INSERT|UPDATE execution_log/.test(sql))).toBe(false);
    expect(statements(client).at(-1)).toBe("COMMIT");
  });

  it("rolls back and throws on a DB error", async () => {
    const client = fakeClient([[/FOR UPDATE/, new Error("lock timeout")]]);
    await expect(updateEntry("tx-1", SCOPE, () => null)).rejects.toThrow(/lock timeout/);
    expect(statements(client)).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

describe("setTriage", () => {
  it("records who triaged and when, without touching the offer", async () => {
    const client = fakeClient([[/FOR UPDATE/, storedRow({ fingerprint: "fp", triage: { state: "new" } })]]);

    await setTriage("tx-1", SCOPE, { state: "dismissed", by: "conor", now: NOW });

    const written = JSON.parse(client.query.mock.calls[3][1][2]);
    expect(written).toEqual({
      espn_transaction_id: "tx-1",
      fingerprint: "fp",
      triage: { state: "dismissed", by: "conor", at: NOW.toISOString() },
    });
  });

  it("requires a future snooze time", async () => {
    fakeClient([[/FOR UPDATE/, storedRow({})]]);
    await expect(
      setTriage("tx-1", SCOPE, { state: "snoozed", by: "conor", snoozeUntil: "2026-10-06T00:00:00Z", now: NOW }),
    ).rejects.toThrow(/snooze_until must be in the future/);
    await setTriage("tx-1", SCOPE, { state: "snoozed", by: "conor", snoozeUntil: "2026-10-07T00:00:00Z", now: NOW });
  });

  it.each([
    ["an unknown state", { state: "accepted", by: "conor" }, /state must be one of/],
    ["no approver", { state: "seen", by: " " }, /by is required/],
  ])("rejects %s", async (_label, input, message) => {
    fakeClient([[/FOR UPDATE/, storedRow({})]]);
    await expect(setTriage("tx-1", SCOPE, { ...input, now: NOW })).rejects.toThrow(message);
  });

  it("fails for an offer that isn't in the inbox", async () => {
    fakeClient([]);
    await expect(setTriage("tx-9", SCOPE, { state: "seen", by: "conor", now: NOW })).rejects.toThrow(/not in the inbox/);
  });
});

describe("claimOfferResponse", () => {
  const KEY = "d".repeat(64);
  const OTHER_KEY = "e".repeat(64);
  const FP = "f".repeat(64);
  const ROW = { leagueId: "1248158344", season: 2026, transactionId: "tx-1", proposingTeamId: "3", action: "decline", comment: null, approvedBy: "conor" };
  const open = (overrides = {}) =>
    storedRow({ fingerprint: FP, parse_issues: [], proposing_team_id: "3", decision: null, ...overrides });
  const claim = (extra = {}) =>
    claimOfferResponse("tx-1", SCOPE, {
      decisionKey: KEY,
      expectedFingerprint: FP,
      row: ROW,
      decision: { decision_key: KEY, action: "decline", outcome: "pending" },
      now: NOW,
      ...extra,
    });
  const wrote = (client) => statements(client).some((sql) => /^INSERT|^UPDATE/.test(sql));

  it("takes the offer lock, then the key lock, then inserts the claim and marks the entry in one transaction", async () => {
    const evaluation = { version: "incoming-trade-evaluation-v1", score: { score: { final_score: 99 } } };
    const client = fakeClient([
      [/'trade_inbox'.*FOR UPDATE/s, open({ evaluation })],
      [/VALUES \(\$1, \$2, 'responding'/, { rows: [{ id: 21 }] }],
    ]);

    await expect(claim()).resolves.toEqual({ claimed: true, id: 21 });

    const sqls = statements(client);
    const calls = client.query.mock.calls;
    expect(sqls[0]).toBe("BEGIN");
    expect(calls[1][1]).toEqual(["trade-inbox:1248158344:tx-1"]);
    expect(sqls[2]).toMatch(/'trade_inbox'[\s\S]*FOR UPDATE/);
    expect(sqls[2]).not.toMatch(/LIMIT/);
    expect(calls[3][1]).toEqual([KEY]);
    expect(sqls[4]).toMatch(/'trade_response'[\s\S]*espn_transaction_id/);
    expect(calls[4][1]).toEqual(["1248158344", "tx-1", ["responded", "responding", "response_unknown", "rejected"]]);
    expect(JSON.parse(calls[5][1][5])).toEqual({
      decision_key: KEY,
      espn_transaction_id: "tx-1",
      action: "decline",
      comment: null,
      approved_by: "conor",
    });
    const [updateSql, params] = calls[6];
    expect(updateSql).toMatch(/SET status = \$2, counter_offer = \$3::jsonb, offering_team_id = \$4\s+WHERE id = \$1/);
    expect(updateSql).not.toMatch(/outcome_details/);
    expect(params[1]).toBe("responding");
    expect(JSON.parse(params[2])).toMatchObject({ decision: { decision_key: KEY, outcome: "pending" } });
    expect(JSON.parse(params[2])).not.toHaveProperty("outcome_details");
    expect(JSON.parse(params[2]).evaluation).toEqual(evaluation);
    expect(sqls[7]).toBe("COMMIT");
  });

  it("returns the existing claim for the same key and writes nothing", async () => {
    const client = fakeClient([
      [/'trade_inbox'.*FOR UPDATE/s, open({ status: "responding" })],
      [/'trade_response'/, { rows: [{ id: 4, status: "response_unknown", decision_key: KEY }] }],
    ]);
    await expect(claim()).resolves.toEqual({ claimed: false, existing: "response_unknown", id: 4 });
    expect(wrote(client)).toBe(false);
  });

  it.each(["responding", "responded", "response_unknown", "rejected"])(
    "refuses when another key's claim on the offer is %s",
    async (status) => {
      const client = fakeClient([
        [/'trade_inbox'.*FOR UPDATE/s, open()],
        [/'trade_response'/, { rows: [{ id: 4, status, decision_key: OTHER_KEY }] }],
      ]);
      await expect(claim()).rejects.toThrow(/already claimed or settled/);
      expect(wrote(client)).toBe(false);
      expect(statements(client)).toContain("ROLLBACK");
    },
  );

  it.each([
    ["missing from the inbox", { rows: [] }, /not in the inbox/],
    ["stored twice", { rows: [open().rows[0], { ...open().rows[0], id: 8 }] }, /more than once/],
    ["responding", storedRow({ fingerprint: FP, parse_issues: [] }, "responding"), /not open/],
    ["expired", storedRow({ fingerprint: FP, parse_issues: [] }, "expired"), /not open/],
    ["countered", storedRow({ fingerprint: FP, parse_issues: [] }, "countered"), /not open/],
    ["unparsed", storedRow({ fingerprint: FP, parse_issues: ["x"] }, "unparsed"), /not open/],
    ["changed by a refresh", open({ fingerprint: "0".repeat(64) }), /changed/],
  ])("fails closed for an offer %s", async (_label, inboxRows, message) => {
    const client = fakeClient([[/'trade_inbox'.*FOR UPDATE/s, inboxRows]]);
    const error = await claim().catch((e) => e);
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.message).toMatch(message);
    expect(wrote(client)).toBe(false);
    expect(statements(client)).toContain("ROLLBACK");
  });

  it("runs the caller's checks on the locked entry and fails closed when they throw", async () => {
    const client = fakeClient([[/'trade_inbox'.*FOR UPDATE/s, open({ score: { exceeds_roster_limit: true } })]]);
    const validate = jest.fn(() => {
      throw new PermanentError("over the roster limit");
    });
    await expect(claim({ validate })).rejects.toThrow(/roster limit/);
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ score: { exceeds_roster_limit: true } }));
    expect(wrote(client)).toBe(false);
  });

  describe("superseding a claim for a retry", () => {
    const supersedes = { id: 4, status: "response_unknown", trackingId: "retry-1", retriedBy: "conor", verifiedNotAnswered: true };

    it("marks the old claim superseded, guarded on its status, before the new claim", async () => {
      const client = fakeClient([
        [/'trade_inbox'.*FOR UPDATE/s, storedRow({ fingerprint: FP, parse_issues: [], decision: { decision_key: KEY } }, "responding")],
        [/'trade_response' AND league_id/, { rows: [{ id: 4, status: "response_unknown", decision_key: KEY }] }],
        [/'superseded'/, { rows: [{ id: 4 }] }],
        [/VALUES \(\$1, \$2, 'responding'/, { rows: [{ id: 22 }] }],
      ]);

      await expect(claim({ supersedes })).resolves.toEqual({ claimed: true, id: 22 });

      const supersede = client.query.mock.calls.find(([sql]) => /'superseded'/.test(sql));
      expect(supersede[0]).toMatch(/WHERE id = \$1 AND transaction_type = 'trade_response' AND status = \$2/);
      expect(supersede[0]).not.toMatch(/outcome_details/);
      expect(supersede[1].slice(0, 2)).toEqual([4, "response_unknown"]);
      expect(JSON.parse(supersede[1][2])).toEqual({
        superseded_by_tracking_id: "retry-1",
        retried_by: "conor",
        verified_not_answered: true,
        retried_at: NOW.toISOString(),
      });
    });

    it("refuses when the claim being retried has changed", async () => {
      const client = fakeClient([
        [/'trade_inbox'.*FOR UPDATE/s, open()],
        [/'trade_response' AND league_id/, { rows: [{ id: 9, status: "responding", decision_key: KEY }] }],
      ]);
      await expect(claim({ supersedes: { ...supersedes, status: "rejected" } })).rejects.toThrow(/retry/);
      expect(wrote(client)).toBe(false);
    });

    it("refuses when the guarded supersede updates nothing", async () => {
      const client = fakeClient([
        [/'trade_inbox'.*FOR UPDATE/s, open()],
        [/'trade_response' AND league_id/, { rows: [{ id: 4, status: "rejected", decision_key: KEY }] }],
      ]);
      await expect(claim({ supersedes: { ...supersedes, status: "rejected" } })).rejects.toThrow(/retry/);
      expect(statements(client)).toContain("ROLLBACK");
      expect(statements(client).some((sql) => /^INSERT/.test(sql))).toBe(false);
    });

    it("refuses a responding entry that belongs to another decision", async () => {
      const client = fakeClient([
        [/'trade_inbox'.*FOR UPDATE/s, storedRow({ fingerprint: FP, parse_issues: [], decision: { decision_key: OTHER_KEY } }, "responding")],
        [/'trade_response' AND league_id/, { rows: [{ id: 4, status: "response_unknown", decision_key: KEY }] }],
      ]);
      await expect(claim({ supersedes })).rejects.toThrow(/not open/);
      expect(wrote(client)).toBe(false);
    });
  });
});

describe("settleOfferResponse", () => {
  it("moves the claim and the entry together under the offer lock", async () => {
    const evaluation = { version: "incoming-trade-evaluation-v1", score: { score: { final_score: 99 } } };
    const client = fakeClient([
      [/status = ANY\(\$4\)/, { rows: [{ id: 21 }] }],
      [/'trade_inbox'.*FOR UPDATE/s, storedRow({ decision: { outcome: "pending" }, evaluation }, "responding")],
    ]);

    await expect(
      settleOfferResponse("tx-1", SCOPE, {
        claimId: 21,
        ledgerStatus: "responded",
        errorMessage: null,
        mutate: (current) => ({ ...current, status: "declined" }),
      }),
    ).resolves.toMatchObject({ settled: true });

    const calls = client.query.mock.calls;
    expect(calls[1][1]).toEqual(["trade-inbox:1248158344:tx-1"]);
    expect(calls[2][0]).toMatch(/SET status = \$2, error_message = \$3\s+WHERE id = \$1 AND transaction_type = 'trade_response' AND status = ANY\(\$4\)/);
    expect(calls[2][1]).toEqual([21, "responded", null, ["responding", "response_unknown"]]);
    const update = calls.find(([sql]) => /counter_offer = \$3::jsonb/.test(sql));
    expect(update[1][1]).toBe("declined");
    expect(update[0]).not.toMatch(/outcome_details/);
    expect(JSON.parse(update[1][2]).evaluation).toEqual(evaluation);
    expect(statements(client).at(-1)).toBe("COMMIT");
  });

  it.each([
    ["response_unknown", ["responding", "response_unknown"]],
    ["rejected", ["responding"]],
  ])("only moves a claim to %s from an unsettled state", async (status, from) => {
    const client = fakeClient([[/status = ANY\(\$4\)/, { rows: [{ id: 21 }] }]]);
    await settleOfferResponse("tx-1", SCOPE, { claimId: 21, ledgerStatus: status, errorMessage: "x", mutate: () => null });
    expect(client.query.mock.calls[2][1][3]).toEqual(from);
  });

  it("leaves the entry alone when the claim had already settled", async () => {
    const client = fakeClient([[/status = ANY\(\$4\)/, { rows: [] }]]);
    const mutate = jest.fn();
    await expect(
      settleOfferResponse("tx-1", SCOPE, { claimId: 21, ledgerStatus: "response_unknown", errorMessage: "x", mutate }),
    ).resolves.toEqual({ settled: false });
    expect(mutate).not.toHaveBeenCalled();
    expect(statements(client).some((sql) => /counter_offer = \$3/.test(sql))).toBe(false);
  });

  it("rolls back both writes and throws on a DB error", async () => {
    const client = fakeClient([
      [/status = ANY\(\$4\)/, { rows: [{ id: 21 }] }],
      [/'trade_inbox'.*FOR UPDATE/s, new Error("connection reset")],
    ]);
    await expect(
      settleOfferResponse("tx-1", SCOPE, { claimId: 21, ledgerStatus: "responded", errorMessage: null, mutate: (c) => c }),
    ).rejects.toThrow(/connection reset/);
    expect(statements(client)).toContain("ROLLBACK");
  });
});
