jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/db/trade_inbox", () => ({
  loadInbox: jest.fn(),
  updateEntry: jest.fn(),
  setTriage: jest.fn(),
}));
jest.mock("../../src/bots/auth", () => ({
  createSessionFromStoredState: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));

const { refreshTradeInbox, postTradeScore, parseArgs, main } = require("../../src/bots/trade_inbox");
const { STATUS, toInboxEntry, mergeEntry } = require("../../src/lib/trade_inbox");
const inboxDb = require("../../src/db/trade_inbox");

const NOW = new Date("2026-10-06T18:00:00Z");
const EXPIRES = Date.parse("2026-10-07T18:00:00Z");
const STATE = { season_type: "regular", season: "2026", week: 5 };

function trade(overrides = {}) {
  return {
    id: "tx-1",
    type: "TRADE_PROPOSAL",
    status: "PENDING",
    proposingTeamId: "3",
    proposedDate: Date.parse("2026-10-06T12:00:00Z"),
    expirationDate: EXPIRES,
    items: [
      { playerId: "-16021", playerName: "Eagles D/ST", type: "TRADE", fromTeamId: "3", toTeamId: "8" },
      { playerId: "4429795", playerName: "Bijan Robinson", type: "TRADE", fromTeamId: "8", toTeamId: "3" },
    ],
    ...overrides,
  };
}

function scoreBody(finalScore = 3) {
  return {
    scoring_version: "trade-score-v1",
    as_of_week: 5,
    send: [{ espn_id: "4429795", player_id: "9509", name: "Bijan Robinson" }],
    receive: [{ espn_id: "-16021", player_id: "PHI", name: "Eagles D/ST" }],
    raw_vorp: { delta_vorp: 1 },
    horizon: { complete_horizon: true },
    roster_impact: { us: { exceeds_roster_limit: false } },
    score: { final_score: finalScore, final_score_unavailable_reasons: [] },
    coverage: { unmapped_traded_espn_ids: [] },
  };
}

// An in-memory stand-in for src/db/trade_inbox.js that applies mutate like the real lock does.
function memoryStore(initial = []) {
  const rows = new Map(initial.map((e) => [e.espn_transaction_id, e]));
  return {
    rows,
    load: jest.fn(async () => [...rows.values()]),
    update: jest.fn(async (id, _scope, mutate) => {
      const next = mutate(rows.get(id) ?? null);
      if (next) rows.set(id, next);
      return next;
    }),
  };
}

let deps;
let browser;
beforeEach(() => {
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.ESPN_TEAM_ID = "8";
  delete process.env.TRADE_INBOX_SHADOW_ACCEPT_MIN_SCORE;
  delete process.env.TRADE_INBOX_SHADOW_DECLINE_MAX_SCORE;
  browser = { close: jest.fn() };
  deps = {
    now: NOW,
    readState: jest.fn().mockResolvedValue(STATE),
    openSession: jest.fn().mockResolvedValue({ context: {}, browser }),
    readPending: jest.fn().mockResolvedValue({ trades: [trade()] }),
    readHistory: jest.fn().mockResolvedValue([]),
    score: jest.fn().mockResolvedValue({ ok: true, body: scoreBody() }),
    store: memoryStore(),
  };
});

describe("refreshTradeInbox", () => {
  it("is quiet off-season and opens no session", async () => {
    deps.readState.mockResolvedValue({ ...STATE, season_type: "off" });
    await expect(refreshTradeInbox({ persist: true }, deps)).resolves.toEqual({ status: "off_season" });
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("stores a new offer with core's score and closes the browser", async () => {
    const result = await refreshTradeInbox({ persist: true }, deps);

    expect(deps.readPending).toHaveBeenCalledWith({}, { leagueId: "1248158344", seasonId: "2026", teamId: "8" });
    expect(deps.score).toHaveBeenCalledWith(
      expect.objectContaining({ send_espn_ids: ["4429795"], receive_espn_ids: ["-16021"], week: 5 }),
    );
    const stored = deps.store.rows.get("tx-1");
    expect(stored).toMatchObject({
      status: STATUS.OPEN,
      triage: { state: "new" },
      score: { state: "scored", final_score: 3 },
      shadow_policy: { would: "none", reason: "no thresholds configured" },
    });
    expect(result).toMatchObject({ status: "refreshed", season: 2026, week: 5, scoreCalls: 1, openOfferTeamIds: ["3"] });
    expect(result.ranked.map((r) => r.espn_transaction_id)).toEqual(["tx-1"]);
    expect(browser.close).toHaveBeenCalled();
  });

  it("changes nothing when the pending read fails", async () => {
    deps.readPending.mockRejectedValue(new Error("ESPN down"));
    await expect(refreshTradeInbox({ persist: true }, deps)).rejects.toThrow(/ESPN down/);
    expect(deps.store.update).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it("does not rescore an offer whose score is current", async () => {
    await refreshTradeInbox({ persist: true }, deps);
    deps.score.mockClear();
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.score).not.toHaveBeenCalled();
  });

  it("caps score calls per refresh, soonest expiry first", async () => {
    const trades = Array.from({ length: 12 }, (_, i) =>
      trade({ id: `tx-${i}`, expirationDate: EXPIRES + (12 - i) }),
    );
    deps.readPending.mockResolvedValue({ trades });

    const result = await refreshTradeInbox({ persist: true }, deps);

    expect(result.scoreCalls).toBe(10);
    expect(deps.store.rows.get("tx-11").score).not.toBeNull();
    expect(deps.store.rows.get("tx-0").score).toBeNull();
  });

  it("keeps a stale score when core is down and retries it next time", async () => {
    await refreshTradeInbox({ persist: true }, deps);
    deps.score.mockResolvedValue({ ok: false, status: 503, message: "context unavailable" });
    deps.store.rows.get("tx-1").score.retry = true;

    await refreshTradeInbox({ persist: true }, deps);

    expect(deps.store.rows.get("tx-1").score).toMatchObject({ final_score: 3, stale: true, retry: true });
  });

  it("scores nothing it can't: a one-sided offer is unscorable without a call", async () => {
    deps.readPending.mockResolvedValue({ trades: [trade({ items: [trade().items[0]] })] });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.score).not.toHaveBeenCalled();
    expect(deps.store.rows.get("tx-1").score).toMatchObject({ state: "unscorable", unavailable_reasons: ["one_sided_trade"] });
  });

  it("records the shadow verdict from configured thresholds without acting on it", async () => {
    process.env.TRADE_INBOX_SHADOW_ACCEPT_MIN_SCORE = "2";
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").shadow_policy).toMatchObject({ would: "accept" });
  });

  it("retires a vanished offer from the history, and only from a successful read", async () => {
    const stored = { ...mergeEntry(null, toInboxEntry(trade({ id: "gone" }), "8"), NOW) };
    deps.store = memoryStore([stored]);
    deps.readHistory.mockResolvedValue([{ id: "d", type: "TRADE_DECLINE", status: "EXECUTED", relatedTransactionId: "gone" }]);

    const result = await refreshTradeInbox({ persist: true }, deps);

    expect(deps.store.rows.get("gone").status).toBe(STATUS.DECLINED);
    expect(result.exits).toEqual([{ id: "gone", status: STATUS.DECLINED }]);
  });

  it("promotes a processing accept once the history shows it executed", async () => {
    const processing = {
      ...mergeEntry(null, toInboxEntry(trade({ id: "acc-1" }), "8"), NOW),
      status: STATUS.ACCEPTED_PENDING_PROCESSING,
    };
    deps.store = memoryStore([processing]);
    deps.readPending.mockResolvedValue({ trades: [] });
    deps.readHistory.mockResolvedValue([
      { id: "a", type: "TRADE_ACCEPT", status: "EXECUTED", isPending: false, relatedTransactionId: "acc-1" },
    ]);

    await refreshTradeInbox({ persist: true }, deps);

    expect(deps.store.rows.get("acc-1").status).toBe(STATUS.ACCEPTED);
  });

  it("leaves finished offers and offers being responded to alone", async () => {
    deps.store = memoryStore([
      { ...mergeEntry(null, toInboxEntry(trade({ id: "done" }), "8"), NOW), status: STATUS.DECLINED },
      { ...mergeEntry(null, toInboxEntry(trade({ id: "busy" }), "8"), NOW), status: STATUS.RESPONDING },
    ]);
    deps.readPending.mockResolvedValue({ trades: [] });

    await refreshTradeInbox({ persist: true }, deps);

    expect(deps.readHistory).not.toHaveBeenCalled();
    expect(deps.store.update).not.toHaveBeenCalled();
  });

  it("keeps a still-pending offer's responding status and decision through a refresh", async () => {
    const decision = { decision_key: "k".repeat(64), outcome: "pending" };
    deps.store = memoryStore([
      { ...mergeEntry(null, toInboxEntry(trade(), "8"), NOW), status: STATUS.RESPONDING, decision },
    ]);
    deps.readPending.mockResolvedValue({
      trades: [trade(), trade({ id: "acc", type: "TRADE_ACCEPT", proposingTeamId: "8", relatedTransactionId: "tx-1" })],
    });

    await refreshTradeInbox({ persist: true }, deps);

    expect(deps.store.rows.get("tx-1")).toMatchObject({ status: STATUS.RESPONDING, decision });
  });

  it("skips retiring offers when the history read fails", async () => {
    const stored = mergeEntry(null, toInboxEntry(trade({ id: "gone" }), "8"), NOW);
    deps.store = memoryStore([stored]);
    deps.readHistory.mockRejectedValue(new Error("history down"));

    await refreshTradeInbox({ persist: true }, deps);

    expect(deps.store.rows.get("gone")).toMatchObject({ status: STATUS.OPEN, missed_reads: 0 });
  });

  it("marks an offer accepted-pending when a pending accept points at it", async () => {
    deps.readPending.mockResolvedValue({
      trades: [trade(), trade({ id: "acc", type: "TRADE_ACCEPT", proposingTeamId: "8", relatedTransactionId: "tx-1" })],
    });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").status).toBe(STATUS.ACCEPTED_PENDING_PROCESSING);
  });

  it("threads a counter to the root of the offer it answers", async () => {
    const root = { ...mergeEntry(null, toInboxEntry(trade({ id: "root" }), "8"), NOW), status: STATUS.COUNTERED };
    deps.store = memoryStore([root]);
    deps.readPending.mockResolvedValue({ trades: [trade({ id: "counter", relatedTransactionId: "root" })] });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("counter").thread_root_id).toBe("root");
  });

  it("in check mode reads and scores but never touches the database", async () => {
    const result = await refreshTradeInbox({ persist: false }, deps);
    expect(deps.store.load).not.toHaveBeenCalled();
    expect(deps.store.update).not.toHaveBeenCalled();
    expect(deps.readHistory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "checked" });
    expect(result.ranked[0].score.final_score).toBe(3);
  });

  it("rejects non-numeric league/team ids", async () => {
    process.env.ESPN_TEAM_ID = "abc";
    await expect(refreshTradeInbox({ persist: false }, deps)).rejects.toThrow(/positive ids/);
  });
});

describe("postTradeScore", () => {
  afterEach(() => {
    delete global.fetch;
  });

  it("returns the body on 200", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ a: 1 }) });
    await expect(postTradeScore({ league_id: "1" })).resolves.toEqual({ ok: true, body: { a: 1 } });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/v1\/trade\/score$/);
    expect(init.method).toBe("POST");
  });

  it("reports an HTTP failure with core's detail", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '{"detail":"moved"}' });
    await expect(postTradeScore({})).resolves.toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/moved/) });
  });

  it("reports a network failure or a non-JSON body without a status", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(postTradeScore({})).resolves.toMatchObject({ ok: false, status: undefined, message: expect.stringMatching(/ECONNREFUSED/) });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } });
    await expect(postTradeScore({})).resolves.toMatchObject({ ok: false, status: undefined });
  });
});

describe("CLI", () => {
  it.each([
    [[], { mode: "check" }],
    [["--check"], { mode: "check" }],
    [["--refresh"], { mode: "refresh" }],
    [["--list"], { mode: "list", all: false }],
    [["--list", "--all"], { mode: "list", all: true }],
    [["--triage", "tx-1", "snoozed", "conor", "2026-10-07T00:00:00Z"], { mode: "triage", id: "tx-1", state: "snoozed", by: "conor", snoozeUntil: "2026-10-07T00:00:00Z" }],
    [["--counter-payload", "tx-1"], { mode: "counter-payload", id: "tx-1" }],
  ])("parses %j", (args, expected) => {
    expect(parseArgs(args)).toEqual(expected);
  });

  it.each([[["--stage"]], [["--triage", "tx-1"]], [["--list", "--bogus"]], [["--counter-payload"]]])("rejects %j", (args) => {
    expect(() => parseArgs(args)).toThrow(/Usage/);
  });

  it("triages through the inbox store", async () => {
    inboxDb.setTriage.mockResolvedValue({});
    await main(["--triage", "tx-1", "dismissed", "conor"]);
    expect(inboxDb.setTriage).toHaveBeenCalledWith(
      "tx-1",
      { leagueId: "1248158344" },
      expect.objectContaining({ state: "dismissed", by: "conor" }),
    );
  });
});
