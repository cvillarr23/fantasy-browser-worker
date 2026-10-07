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
const { loadInbox, updateEntry, setTriage } = require("../../src/db/trade_inbox");

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
