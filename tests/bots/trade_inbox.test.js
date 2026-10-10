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
const { STATUS, toInboxEntry, mergeEntry, toCounterRecord } = require("../../src/lib/trade_inbox");
const inboxDb = require("../../src/db/trade_inbox");
const { makeScore } = require("../fixtures/trade_score");

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
  process.env.ESPN_LEAGUE_ID = "1234567890";
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
  function fullScore(final = 3) {
    return makeScore({
      counterpartyTeamId: "3",
      send: [
        {
          espn_id: "4429795",
          player_id: "9509",
          name: "Bijan Robinson",
          position: "RB",
          nfl_team: "ATL",
        },
      ],
      receive: [
        {
          espn_id: "-16021",
          player_id: "PHI",
          name: "Eagles D/ST",
          position: "D/ST",
          nfl_team: "PHI",
        },
      ],
      score: { final_score: final },
    });
  }

  async function refreshWithEvidence(final = 3) {
    const body = {
      ...fullScore(final),
      league_id: "1234567890",
      our_team: { team_id: "8", name: "Us" },
    };
    deps.score.mockResolvedValue({ ok: true, body });
    await refreshTradeInbox({ persist: true }, deps);
    return body;
  }

  it("stores full advisory evidence on a scored refresh and preserves it on a current refresh", async () => {
    const body = await refreshWithEvidence();
    const saved = deps.store.rows.get("tx-1");
    expect(saved.evaluation).toEqual({
      version: "incoming-trade-evaluation-v1",
      evaluated_at: NOW.toISOString(),
      scored_fingerprint: saved.fingerprint,
      request: deps.score.mock.calls[0][0],
      score: body,
    });
    deps.score.mockClear();
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.score).not.toHaveBeenCalled();
    expect(deps.store.rows.get("tx-1").evaluation).toEqual(saved.evaluation);
  });

  it("keeps evidence and its original timestamp with a same-offer stale numeric score", async () => {
    await refreshWithEvidence();
    const original = deps.store.rows.get("tx-1").evaluation;
    deps.now = new Date("2026-10-06T20:00:00Z");
    deps.store.rows.get("tx-1").score.retry = true;
    deps.score.mockResolvedValue({ ok: false, status: 503, message: "down" });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1")).toMatchObject({
      evaluation: original,
      score: { stale: true, retry: true, scored_at: NOW.toISOString() },
    });
  });

  it.each([409, 422, 503])(
    "clears old evidence on failure %s after the fingerprint changes",
    async (status) => {
      await refreshWithEvidence();
      deps.readPending.mockResolvedValue({
        trades: [trade({ proposedDate: NOW.getTime() })],
      });
      deps.score.mockResolvedValue({ ok: false, status, message: "down" });
      await refreshTradeInbox({ persist: true }, deps);
      expect(deps.store.rows.get("tx-1").evaluation).toBeNull();
      expect(deps.store.rows.get("tx-1").score.final_score).toBeNull();
    },
  );

  it.each([409, 422])(
    "clears same-offer evidence on permanent failure %s",
    async (status) => {
      await refreshWithEvidence();
      deps.store.rows.get("tx-1").score.retry = true;
      deps.score.mockResolvedValue({ ok: false, status, message: "rejected" });
      await refreshTradeInbox({ persist: true }, deps);
      expect(deps.store.rows.get("tx-1").evaluation).toBeNull();
    },
  );

  it("retains unavailable evidence on success but clears it on a transient failure with no numeric score", async () => {
    await refreshWithEvidence(null);
    expect(
      deps.store.rows.get("tx-1").evaluation.score.score.final_score,
    ).toBeNull();
    deps.store.rows.get("tx-1").score.retry = true;
    deps.score.mockResolvedValue({ ok: false, message: "timeout" });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").evaluation).toBeNull();
  });

  it("clears changed-offer evidence even when scoring is deferred by the refresh cap", async () => {
    await refreshWithEvidence();
    const earlier = Array.from({ length: 10 }, (_, i) =>
      trade({ id: `earlier-${i}`, expirationDate: EXPIRES - 1000 }),
    );
    deps.readPending.mockResolvedValue({
      trades: [...earlier, trade({ proposedDate: NOW.getTime() })],
    });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").evaluation).toBeNull();
    expect(deps.store.rows.get("tx-1").score.final_score).toBe(3);
  });

  it("keeps summaries when new evidence is invalid or oversized, without mixing in old evidence", async () => {
    await refreshWithEvidence();
    for (const body of [
      scoreBody(7),
      { ...fullScore(7), league_id: "1234567890", our_team: { team_id: "8", name: "Us" }, padding: "x".repeat(65536) },
    ]) {
      deps.store.rows.get("tx-1").score.retry = true;
      deps.score.mockResolvedValue({ ok: true, body });
      await refreshTradeInbox({ persist: true }, deps);
      expect(deps.store.rows.get("tx-1")).toMatchObject({
        score: { final_score: 7 },
        evaluation: null,
      });
    }
  });

  it("clears evidence for a locally unscorable changed offer", async () => {
    await refreshWithEvidence();
    deps.readPending.mockResolvedValue({
      trades: [trade({ items: [trade().items[0]] })],
    });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1")).toMatchObject({
      evaluation: null,
      score: { state: "unscorable" },
    });
  });

  it("leaves old rows nullable without an extra scoring call", async () => {
    await refreshTradeInbox({ persist: true }, deps);
    delete deps.store.rows.get("tx-1").evaluation;
    deps.score.mockClear();
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").evaluation).toBeNull();
    expect(deps.score).not.toHaveBeenCalled();
  });

  it("replaces evidence when the week changes and on a successful changed-offer refresh", async () => {
    await refreshWithEvidence();
    deps.readState.mockResolvedValue({ ...STATE, week: 6 });
    deps.now = new Date("2026-10-13T18:00:00Z");
    const body = {
      ...fullScore(4),
      as_of_week: 6,
      league_id: "1234567890",
      our_team: { team_id: "8", name: "Us" },
    };
    deps.score.mockResolvedValue({ ok: true, body });
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1").evaluation).toMatchObject({
      request: { week: 6 },
      evaluated_at: deps.now.toISOString(),
      score: body,
    });
    deps.readPending.mockResolvedValue({
      trades: [trade({ proposedDate: NOW.getTime() })],
    });
    const previous = deps.store.rows.get("tx-1").fingerprint;
    await refreshTradeInbox({ persist: true }, deps);
    const saved = deps.store.rows.get("tx-1");
    expect(saved.fingerprint).not.toBe(previous);
    expect(saved.evaluation.scored_fingerprint).toBe(saved.fingerprint);
    expect(saved.score.scored_fingerprint).toBe(saved.fingerprint);
  });

  it("preserves evidence when pending reads fail and when an offer retires", async () => {
    await refreshWithEvidence();
    const original = deps.store.rows.get("tx-1").evaluation;
    deps.readPending.mockRejectedValueOnce(new Error("ESPN down"));
    await expect(refreshTradeInbox({ persist: true }, deps)).rejects.toThrow(
      "ESPN down",
    );
    expect(deps.store.rows.get("tx-1").evaluation).toEqual(original);
    deps.readPending.mockResolvedValue({ trades: [] });
    deps.readHistory.mockResolvedValue([{ id: "tx-1", status: "CANCELED" }]);
    await refreshTradeInbox({ persist: true }, deps);
    expect(deps.store.rows.get("tx-1")).toMatchObject({
      evaluation: original,
      status: "withdrawn",
    });
  });

  it("is quiet off-season and opens no session", async () => {
    deps.readState.mockResolvedValue({ ...STATE, season_type: "off" });
    await expect(refreshTradeInbox({ persist: true }, deps)).resolves.toEqual({ status: "off_season" });
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("stores a new offer with core's score and closes the browser", async () => {
    const result = await refreshTradeInbox({ persist: true }, deps);

    expect(deps.readPending).toHaveBeenCalledWith({}, { leagueId: "1234567890", seasonId: "2026", teamId: "8" });
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

  describe("our counters", () => {
    const ourCounter = (overrides = {}) =>
      trade({ id: "ours-1", proposingTeamId: "8", relatedTransactionId: "root", proposedDate: Date.parse("2026-10-06T14:00:00Z"), ...overrides });
    const countered = (counter = null) => ({
      ...mergeEntry(null, toInboxEntry(trade({ id: "root" }), "8"), NOW),
      status: STATUS.COUNTERED,
      our_counter: counter,
    });

    it("records our pending counter on the entry it counters without changing its status", async () => {
      deps.store = memoryStore([countered()]);
      deps.readPending.mockResolvedValue({ trades: [ourCounter()] });

      const result = await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.rows.get("root")).toMatchObject({
        status: STATUS.COUNTERED,
        our_counter: { espn_transaction_id: "ours-1", status: STATUS.OPEN, send_espn_ids: ["4429795"] },
      });
      expect(result.counterUpdates).toEqual([{ id: "root", status: STATUS.OPEN }]);
      expect(deps.readHistory).not.toHaveBeenCalled();
    });

    it("writes nothing while a recorded counter is still pending", async () => {
      deps.store = memoryStore([countered(toCounterRecord(ourCounter(), "8", NOW))]);
      deps.readPending.mockResolvedValue({ trades: [ourCounter()] });

      const result = await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.update).not.toHaveBeenCalled();
      expect(result.counterUpdates).toEqual([]);
    });

    it("threads their reply to the original offer and settles our counter as countered", async () => {
      deps.store = memoryStore([countered(toCounterRecord(ourCounter(), "8", NOW))]);
      deps.readPending.mockResolvedValue({ trades: [trade({ id: "reply-1", relatedTransactionId: "ours-1" })] });

      const result = await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.rows.get("reply-1")).toMatchObject({ status: STATUS.OPEN, thread_root_id: "root" });
      expect(deps.store.rows.get("root").our_counter).toMatchObject({ status: STATUS.COUNTERED });
      expect(result.counterUpdates).toEqual([{ id: "root", status: STATUS.COUNTERED }]);
    });

    it("settles a vanished counter from the history", async () => {
      deps.store = memoryStore([countered(toCounterRecord(ourCounter(), "8", NOW))]);
      deps.readPending.mockResolvedValue({ trades: [] });
      deps.readHistory.mockResolvedValue([{ id: "dec", type: "TRADE_DECLINE", status: "EXECUTED", relatedTransactionId: "ours-1" }]);

      await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.rows.get("root")).toMatchObject({ status: STATUS.COUNTERED, our_counter: { status: STATUS.DECLINED } });
    });

    it("settles nothing about a vanished counter when the history read fails", async () => {
      const stored = countered(toCounterRecord(ourCounter(), "8", NOW));
      deps.store = memoryStore([stored]);
      deps.readPending.mockResolvedValue({ trades: [] });
      deps.readHistory.mockRejectedValue(new Error("history down"));

      await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.rows.get("root")).toEqual(stored);
    });

    it("threads a reply to a counter sent and answered between refreshes, from the history", async () => {
      deps.store = memoryStore([mergeEntry(null, toInboxEntry(trade({ id: "root" }), "8"), NOW)]);
      deps.readPending.mockResolvedValue({ trades: [trade({ id: "reply-1", relatedTransactionId: "ours-1" })] });
      deps.readHistory.mockResolvedValue([{ ...ourCounter(), status: "EXECUTED" }]);

      const result = await refreshTradeInbox({ persist: true }, deps);

      expect(deps.store.rows.get("reply-1").thread_root_id).toBe("root");
      expect(deps.store.rows.get("root")).toMatchObject({
        status: STATUS.COUNTERED,
        our_counter: { espn_transaction_id: "ours-1", status: STATUS.COUNTERED },
      });
      expect(result.exits).toEqual([{ id: "root", status: STATUS.COUNTERED }]);
    });

    it("does not read the history for an old countered entry with no counter recorded", async () => {
      deps.store = memoryStore([countered()]);
      deps.readPending.mockResolvedValue({ trades: [] });

      await refreshTradeInbox({ persist: true }, deps);

      expect(deps.readHistory).not.toHaveBeenCalled();
      expect(deps.store.update).not.toHaveBeenCalled();
    });
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
    [["--thread", "tx-1"], { mode: "thread", id: "tx-1" }],
  ])("parses %j", (args, expected) => {
    expect(parseArgs(args)).toEqual(expected);
  });

  it.each([[["--stage"]], [["--triage", "tx-1"]], [["--list", "--bogus"]], [["--counter-payload"]], [["--thread"]], [["--thread", "a", "b"]]])("rejects %j", (args) => {
    expect(() => parseArgs(args)).toThrow(/Usage/);
  });

  it("prints a thread found by any of its offers, including our counter", async () => {
    inboxDb.loadInbox.mockResolvedValue([
      {
        ...mergeEntry(null, toInboxEntry(trade({ id: "root" }), "8"), NOW),
        status: STATUS.COUNTERED,
        our_counter: toCounterRecord(
          trade({ id: "ours-1", proposingTeamId: "8", relatedTransactionId: "root", proposedDate: Date.parse("2026-10-06T14:00:00Z") }),
          "8",
          NOW,
        ),
      },
    ]);
    const thread = await main(["--thread", "ours-1"]);
    expect(thread).toMatchObject({ threadRootId: "root", state: "awaiting_them", ourCounters: 1 });
    expect(thread.turns.map((t) => t.side)).toEqual(["theirs", "ours"]);
  });

  it("refuses a thread for an offer the inbox doesn't know", async () => {
    inboxDb.loadInbox.mockResolvedValue([]);
    await expect(main(["--thread", "nope"])).rejects.toThrow(/not in the inbox/);
  });

  it("triages through the inbox store", async () => {
    inboxDb.setTriage.mockResolvedValue({});
    await main(["--triage", "tx-1", "dismissed", "conor"]);
    expect(inboxDb.setTriage).toHaveBeenCalledWith(
      "tx-1",
      { leagueId: "1234567890" },
      expect.objectContaining({ state: "dismissed", by: "conor" }),
    );
  });
});
