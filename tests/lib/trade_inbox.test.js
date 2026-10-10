const {
  splitPendingTrades,
  toInboxEntry,
  tradeFingerprint,
  computeDecisionKey,
  buildScoreRequest,
  scoreFromResponse,
  scoreAfterFailure,
  needsScore,
  rankInbox,
  shadowPolicy,
  resolveExit,
  mergeEntry,
  buildNegotiationPayload,
  verifyResponse,
  toCounterRecord,
  resolveCounter,
  buildThread,
  STATUS,
} = require("../../src/lib/trade_inbox");

const OURS = "8";
const NOW = new Date("2026-10-06T18:00:00Z");
const EXPIRES = Date.parse("2026-10-07T18:00:00Z");

// Normalized readPendingTrades output. The raw populated shape is still UNVERIFIED, so these
// fixtures follow the parser's contract rather than a capture.
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

function entry(overrides = {}) {
  return { ...toInboxEntry(trade(), OURS), status: STATUS.OPEN, ...overrides };
}

function scoreBody(overrides = {}) {
  return {
    scoring_version: "trade-score-v1",
    as_of_week: 5,
    send: [{ espn_id: "4429795", player_id: "9509", name: "Bijan Robinson" }],
    receive: [{ espn_id: "-16021", player_id: "PHI", name: "Eagles D/ST" }],
    raw_vorp: { delta_vorp: -3.5 },
    horizon: { complete_horizon: true },
    roster_impact: { us: { exceeds_roster_limit: false } },
    score: { final_score: 4.25, final_score_unavailable_reasons: [] },
    coverage: { unmapped_traded_espn_ids: [], partial_roster_weeks: [], nfl_schedule_unavailable_weeks: [] },
    ...overrides,
  };
}

describe("splitPendingTrades", () => {
  it("separates offers to us from our own offers and from pending accepts", () => {
    const ours = trade({ id: "tx-ours", proposingTeamId: "8" });
    const accept = trade({ id: "tx-acc", type: "TRADE_ACCEPT", relatedTransactionId: "tx-0" });
    const { incoming, outgoing, accepts } = splitPendingTrades([trade(), ours, accept], OURS);
    expect(incoming.map((t) => t.id)).toEqual(["tx-1"]);
    expect(outgoing.map((t) => t.id)).toEqual(["tx-ours"]);
    expect(accepts.map((t) => t.id)).toEqual(["tx-acc"]);
  });
});

describe("toInboxEntry", () => {
  it("splits players by direction relative to our team, keeping D/ST negative ids", () => {
    expect(toInboxEntry(trade({ comment: "Need a defense?" }), OURS)).toMatchObject({
      espn_transaction_id: "tx-1",
      proposing_team_id: "3",
      our_team_id: "8",
      espn_type: "TRADE_PROPOSAL",
      espn_status: "PENDING",
      receive_espn_ids: ["-16021"],
      send_espn_ids: ["4429795"],
      other_items: [],
      player_names: { "-16021": "Eagles D/ST", 4429795: "Bijan Robinson" },
      expiration_date: EXPIRES,
      comment: "Need a defense?",
      thread_root_id: "tx-1",
      parse_issues: [],
    });
  });

  it("keeps non-player items verbatim and threads a counter to its root", () => {
    const counter = trade({
      relatedTransactionId: "tx-0",
      items: [
        ...trade().items,
        { playerId: null, playerName: null, type: "ACQUISITION_BUDGET_TRADE", fromTeamId: "3", toTeamId: "8", acquisitionBudget: 10 },
      ],
    });
    const result = toInboxEntry(counter, OURS, { threadRootOf: () => "tx-root" });
    expect(result.other_items).toEqual([counter.items[2]]);
    expect(result.related_transaction_id).toBe("tx-0");
    expect(result.thread_root_id).toBe("tx-root");
  });

  it("records shape surprises instead of guessing", () => {
    const odd = trade({
      status: "OPEN",
      expirationDate: undefined,
      items: [
        ...trade().items,
        { playerId: "1", type: "TRADE", fromTeamId: "5", toTeamId: "8" },
        { playerId: null, type: "TRADE", fromTeamId: "3", toTeamId: "8" },
        { playerId: "2", type: "MYSTERY", fromTeamId: "3", toTeamId: "8" },
      ],
    });
    expect(toInboxEntry(odd, OURS).parse_issues).toEqual([
      "unrecognized status OPEN",
      "no expirationDate",
      "more than two teams",
      "TRADE item without a playerId",
      "unrecognized item type MYSTERY",
    ]);
  });
});

describe("tradeFingerprint", () => {
  it("ignores item order but changes with the players, proposer or expiry", () => {
    const base = tradeFingerprint(trade());
    expect(tradeFingerprint(trade({ items: [...trade().items].reverse() }))).toBe(base);
    expect(tradeFingerprint(trade({ expirationDate: EXPIRES + 1 }))).not.toBe(base);
    expect(tradeFingerprint(trade({ proposingTeamId: "4" }))).not.toBe(base);
    expect(tradeFingerprint(trade({ items: trade().items.slice(0, 1) }))).not.toBe(base);
  });
});

describe("computeDecisionKey", () => {
  const args = {
    leagueId: "1234567890",
    seasonId: "2026",
    ourTeamId: "8",
    transactionId: "tx-1",
    action: "decline",
    fingerprint: "abc",
    comment: null,
  };

  it("is a stable sha256 hex digest", () => {
    expect(computeDecisionKey(args)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeDecisionKey({ ...args })).toBe(computeDecisionKey(args));
  });

  it.each([
    ["transactionId", "tx-2"],
    ["action", "accept"],
    ["fingerprint", "abd"],
    ["comment", "No thanks"],
  ])("changes with %s", (field, value) => {
    expect(computeDecisionKey({ ...args, [field]: value })).not.toBe(computeDecisionKey(args));
  });

  it("treats an empty or blank note as no note", () => {
    expect(computeDecisionKey({ ...args, comment: "  " })).toBe(computeDecisionKey(args));
  });
});

describe("buildScoreRequest", () => {
  const period = { leagueId: "1234567890", season: 2026, week: 5 };

  it("scores from our side: what we send and what we receive", () => {
    expect(buildScoreRequest(entry(), period)).toEqual({
      request: {
        league_id: "1234567890",
        season: 2026,
        week: 5,
        our_team_id: "8",
        counterparty_team_id: "3",
        send_espn_ids: ["4429795"],
        receive_espn_ids: ["-16021"],
      },
      partialReasons: [],
    });
  });

  it("flags non-player items it cannot score", () => {
    const withFaab = entry({ other_items: [{ type: "ACQUISITION_BUDGET_TRADE" }] });
    expect(buildScoreRequest(withFaab, period).partialReasons).toEqual(["non_player_items_not_scored"]);
  });

  it.each([
    ["nothing to send", { send_espn_ids: [] }, "one_sided_trade"],
    ["nothing to receive", { receive_espn_ids: [] }, "one_sided_trade"],
    ["three teams", { parse_issues: ["more than two teams"] }, "multi_team_trade"],
  ])("is unscorable with %s", (_label, overrides, reason) => {
    expect(buildScoreRequest(entry(overrides), period)).toEqual({ unscorable: reason });
  });
});

describe("scoreFromResponse", () => {
  const meta = { fingerprint: "fp", scoredAt: NOW.toISOString(), partialReasons: [] };

  it("keeps core's numbers and the evidence the ranking needs", () => {
    expect(scoreFromResponse(scoreBody(), meta)).toEqual({
      state: "scored",
      scoring_version: "trade-score-v1",
      as_of_week: 5,
      final_score: 4.25,
      complete_horizon: true,
      unavailable_reasons: [],
      raw_delta_vorp: -3.5,
      exceeds_roster_limit: false,
      unmapped_espn_ids: [],
      partial_reasons: [],
      players: {
        4429795: { player_id: "9509", name: "Bijan Robinson" },
        "-16021": { player_id: "PHI", name: "Eagles D/ST" },
      },
      scored_fingerprint: "fp",
      scored_at: NOW.toISOString(),
      retry: false,
      stale: false,
      error: null,
    });
  });

  it.each([
    ["an incomplete horizon", { horizon: { complete_horizon: false } }],
    ["unmapped players", { coverage: { ...scoreBody().coverage, unmapped_traded_espn_ids: ["1"] } }],
  ])("marks %s incomplete without dropping the score", (_label, overrides) => {
    const result = scoreFromResponse(scoreBody(overrides), meta);
    expect(result).toMatchObject({ state: "incomplete", final_score: 4.25 });
  });

  it("is unavailable with core's reasons when there is no final score, and not retried this week", () => {
    const body = scoreBody({ score: { final_score: null, final_score_unavailable_reasons: ["no_matchup_weeks"] } });
    expect(scoreFromResponse(body, meta)).toMatchObject({
      state: "unavailable",
      final_score: null,
      unavailable_reasons: ["no_matchup_weeks"],
      retry: false,
    });
  });
});

describe("scoreAfterFailure", () => {
  const meta = { fingerprint: "fp", scoredAt: NOW.toISOString(), week: 5 };
  const previous = scoreFromResponse(scoreBody(), { ...meta, partialReasons: [] });

  it("treats a 409 as players having moved", () => {
    expect(scoreAfterFailure(null, { status: 409, message: "not on team" }, meta)).toMatchObject({
      state: "stale_ownership",
      final_score: null,
      retry: false,
      error: "not on team",
    });
  });

  it("treats a 422 as unscorable", () => {
    expect(scoreAfterFailure(null, { status: 422, message: "bad" }, meta)).toMatchObject({
      state: "unscorable",
      retry: false,
    });
  });

  it.each([502, 503, 504, undefined])("keeps the last score for this offer, marked stale, on %s", (status) => {
    const result = scoreAfterFailure(previous, { status, message: "down" }, meta);
    expect(result).toMatchObject({ state: "scored", final_score: 4.25, stale: true, retry: true, error: "down" });
  });

  it("does not carry a score from a different version of the offer", () => {
    const result = scoreAfterFailure({ ...previous, scored_fingerprint: "old" }, { status: 503, message: "down" }, meta);
    expect(result).toMatchObject({ state: "unavailable", final_score: null, retry: true });
  });
});

describe("needsScore", () => {
  const scored = (overrides = {}) =>
    entry({
      fingerprint: "fp",
      score: { ...scoreFromResponse(scoreBody(), { fingerprint: "fp", partialReasons: [] }), ...overrides },
    });

  it("scores a new entry, a changed offer, a new week or a retryable failure", () => {
    expect(needsScore(entry({ score: null }), 5)).toBe(true);
    expect(needsScore(scored({ scored_fingerprint: "old" }), 5)).toBe(true);
    expect(needsScore(scored(), 6)).toBe(true);
    expect(needsScore(scored({ retry: true }), 5)).toBe(true);
  });

  it("leaves a current score alone", () => {
    expect(needsScore(scored(), 5)).toBe(false);
    expect(needsScore(scored({ state: "unscorable", final_score: null }), 5)).toBe(false);
  });
});

describe("rankInbox", () => {
  const scoredEntry = (id, final, expiresAt = EXPIRES) =>
    entry({ espn_transaction_id: id, expiration_date: expiresAt, score: { state: "scored", final_score: final } });

  it("puts scored offers first by score, then the rest by soonest expiry", () => {
    const rows = [
      entry({ espn_transaction_id: "unscored-late", expiration_date: EXPIRES + 2, score: { state: "unavailable", final_score: null } }),
      scoredEntry("low", -2),
      entry({ espn_transaction_id: "unscored-soon", expiration_date: EXPIRES + 1, score: null }),
      scoredEntry("high", 7),
    ];
    expect(rankInbox(rows, { now: NOW }).map((r) => r.espn_transaction_id)).toEqual([
      "high",
      "low",
      "unscored-soon",
      "unscored-late",
    ]);
  });

  it("breaks score ties by expiry, then proposal date, then id", () => {
    const rows = [scoredEntry("b", 1), scoredEntry("a", 1), scoredEntry("soon", 1, EXPIRES - 1)];
    expect(rankInbox(rows, { now: NOW }).map((r) => r.espn_transaction_id)).toEqual(["soon", "a", "b"]);
  });

  it("hides dismissed, snoozed and closed offers unless asked", () => {
    const rows = [
      scoredEntry("open", 1),
      { ...scoredEntry("dismissed", 9), triage: { state: "dismissed" } },
      { ...scoredEntry("snoozed", 9), triage: { state: "snoozed", snooze_until: "2026-10-07T00:00:00Z" } },
      { ...scoredEntry("snooze-over", 2), triage: { state: "snoozed", snooze_until: "2026-10-06T00:00:00Z" } },
      { ...scoredEntry("declined", 9), status: STATUS.DECLINED },
    ];
    expect(rankInbox(rows, { now: NOW }).map((r) => r.espn_transaction_id)).toEqual(["snooze-over", "open"]);
    expect(rankInbox(rows, { now: NOW, includeHidden: true })).toHaveLength(5);
  });
});

describe("shadowPolicy", () => {
  const score = (overrides = {}) => ({ state: "scored", final_score: 5, unmapped_espn_ids: [], exceeds_roster_limit: false, partial_reasons: [], ...overrides });
  const thresholds = { acceptMin: 4, declineMax: -4 };

  it("has no opinion until thresholds are configured", () => {
    expect(shadowPolicy(score(), {})).toMatchObject({ would: "none", reason: "no thresholds configured" });
  });

  it("would accept at or above the accept threshold and decline at or below the decline one", () => {
    expect(shadowPolicy(score({ final_score: 4 }), thresholds).would).toBe("accept");
    expect(shadowPolicy(score({ final_score: -4 }), thresholds).would).toBe("decline");
    expect(shadowPolicy(score({ final_score: 0 }), thresholds)).toMatchObject({ would: "none", reason: "between thresholds" });
  });

  it.each([
    ["no final score", score({ final_score: null })],
    ["unmapped traded players", score({ unmapped_espn_ids: ["1"] })],
    ["roster limit exceeded; drops are not simulated", score({ exceeds_roster_limit: true })],
    ["non-player items not scored", score({ partial_reasons: ["non_player_items_not_scored"] })],
    ["score is stale", score({ stale: true })],
  ])("abstains with %s", (reason, input) => {
    expect(shadowPolicy(input, thresholds)).toMatchObject({ would: "none", reason });
  });

  it("abstains on overlapping thresholds", () => {
    expect(shadowPolicy(score(), { acceptMin: -1, declineMax: 1 })).toMatchObject({ would: "none", reason: "invalid thresholds" });
  });
});

describe("resolveExit", () => {
  const base = { now: NOW, history: [], outgoing: [] };

  it("expires an offer past its expiration date", () => {
    expect(resolveExit(entry({ expiration_date: Date.parse("2026-10-06T00:00:00Z") }), base)).toMatchObject({
      status: STATUS.EXPIRED,
    });
  });

  it.each([
    [{ type: "TRADE_DECLINE", status: "EXECUTED" }, STATUS.DECLINED],
    [{ type: "TRADE_ACCEPT", status: "EXECUTED", isPending: false }, STATUS.ACCEPTED],
    [{ type: "TRADE_ACCEPT", status: "PENDING", isPending: true }, STATUS.ACCEPTED_PENDING_PROCESSING],
    [{ type: "TRADE_VETO", status: "EXECUTED" }, STATUS.VETOED],
    [{ type: "TRADE_PROPOSAL", status: "PENDING" }, STATUS.COUNTERED],
    [{ type: "TRADE_PROPOSAL", status: "EXECUTED", executionType: "CANCEL" }, STATUS.WITHDRAWN],
  ])("reads %j in the history as %s", (row, status) => {
    const history = [{ id: "later", relatedTransactionId: "tx-1", ...row }];
    expect(resolveExit(entry(), { ...base, history })).toMatchObject({ status });
  });

  it("treats a canceled original as withdrawn", () => {
    const history = [{ id: "tx-1", type: "TRADE_PROPOSAL", status: "CANCELED" }];
    expect(resolveExit(entry(), { ...base, history })).toMatchObject({ status: STATUS.WITHDRAWN });
  });

  it("marks it countered when one of our pending offers answers it", () => {
    const outgoing = [trade({ id: "ours", proposingTeamId: "8", relatedTransactionId: "tx-1" })];
    expect(resolveExit(entry(), { ...base, outgoing })).toMatchObject({ status: STATUS.COUNTERED });
  });

  it("does not mark it countered for an unlinked pending offer to the same team", () => {
    const outgoing = [trade({ id: "ours", proposingTeamId: "8" })];
    expect(resolveExit(entry(), { ...base, outgoing })).not.toMatchObject({ status: STATUS.COUNTERED });
  });

  it("closes an unexplained disappearance only after repeated misses", () => {
    const first = resolveExit(entry(), base);
    expect(first).toMatchObject({ status: STATUS.OPEN, missed_reads: 1 });
    expect(resolveExit(entry({ missed_reads: 1 }), base)).toMatchObject({ status: STATUS.CLOSED_UNKNOWN, missed_reads: 2 });
  });

  it("never retires an offer we are responding to", () => {
    expect(resolveExit(entry({ status: STATUS.RESPONDING, missed_reads: 5 }), base)).toBeNull();
  });

  it("promotes a processing accept once the history shows it executed", () => {
    const history = [{ id: "acc", type: "TRADE_ACCEPT", status: "EXECUTED", isPending: false, relatedTransactionId: "tx-1" }];
    expect(resolveExit(entry({ status: STATUS.ACCEPTED_PENDING_PROCESSING }), { ...base, history })).toMatchObject({
      status: STATUS.ACCEPTED,
    });
  });
});

describe("mergeEntry", () => {
  it("preserves triage, decisions and a current score across refreshes", () => {
    const stored = entry({
      fingerprint: "fp",
      triage: { state: "seen", by: "conor" },
      decision: { decision_key: "k" },
      score: { state: "scored", final_score: 1, scored_fingerprint: "fp" },
      first_seen_at: "2026-10-05T00:00:00Z",
      missed_reads: 1,
    });
    const fresh = entry({ fingerprint: "fp" });
    expect(mergeEntry(stored, fresh, NOW)).toMatchObject({
      triage: { state: "seen", by: "conor" },
      decision: { decision_key: "k" },
      score: { final_score: 1 },
      first_seen_at: "2026-10-05T00:00:00Z",
      last_seen_at: NOW.toISOString(),
      missed_reads: 0,
    });
  });

  it("brings a dismissed offer back when the offer itself changes", () => {
    const stored = entry({ fingerprint: "old", triage: { state: "dismissed", by: "conor" } });
    expect(mergeEntry(stored, entry({ fingerprint: "new" }), NOW).triage).toMatchObject({ state: "new" });
  });

  it("starts a never-seen offer as new and unparsed when its shape surprised us", () => {
    const fresh = entry({ parse_issues: ["no expirationDate"] });
    expect(mergeEntry(null, fresh, NOW)).toMatchObject({
      status: STATUS.UNPARSED,
      triage: { state: "new" },
      first_seen_at: NOW.toISOString(),
    });
  });
});

describe("buildNegotiationPayload", () => {
  const scored = entry({
    score: scoreFromResponse(scoreBody(), { fingerprint: "fp", partialReasons: [] }),
  });

  it("hands the negotiator internal ids from core's score evidence", () => {
    expect(buildNegotiationPayload(scored, { season: 2026, week: 5, trackingId: "t" })).toEqual({
      tracking_id: "t",
      season: 2026,
      week: 5,
      offering_team_id: "3",
      incoming_player_ids: ["PHI"],
      outgoing_player_ids: ["9509"],
      related_transaction_id: "tx-1",
      thread_root_id: "tx-1",
    });
  });

  it("carries the thread root of a multi-turn negotiation", () => {
    const reply = { ...scored, espn_transaction_id: "tx-3", thread_root_id: "tx-1" };
    expect(buildNegotiationPayload(reply, { season: 2026, week: 5, trackingId: "t" })).toMatchObject({
      related_transaction_id: "tx-3",
      thread_root_id: "tx-1",
    });
  });

  it("refuses when a traded player has no internal id", () => {
    const unmapped = { ...scored, score: { ...scored.score, players: { 4429795: { player_id: null } } } };
    expect(() => buildNegotiationPayload(unmapped, { season: 2026, week: 5 })).toThrow(/no internal id/);
  });

  it("refuses without a score", () => {
    expect(() => buildNegotiationPayload(entry({ score: null }), { season: 2026, week: 5 })).toThrow(/no internal id/);
  });
});

describe("verifyResponse", () => {
  const pendingOffer = trade();
  const verify = (action, { trades = [], history = [] } = {}) =>
    verifyResponse({ action, transactionId: "tx-1", trades, history });

  it("confirms a decline from a related history row or from the offer leaving the pending list", () => {
    expect(verify("decline", { history: [{ id: "d", type: "TRADE_DECLINE", relatedTransactionId: "tx-1" }] })).toMatchObject({
      status: STATUS.DECLINED,
    });
    expect(verify("decline")).toMatchObject({ status: STATUS.DECLINED });
  });

  it("confirms an accept only from ESPN's own accept row", () => {
    const pendingAccept = trade({ id: "a", type: "TRADE_ACCEPT", proposingTeamId: "8", relatedTransactionId: "tx-1", isPending: true });
    expect(verify("accept", { trades: [pendingAccept] })).toMatchObject({ status: STATUS.ACCEPTED_PENDING_PROCESSING });
    expect(
      verify("accept", { history: [{ id: "a", type: "TRADE_ACCEPT", status: "EXECUTED", isPending: false, relatedTransactionId: "tx-1" }] }),
    ).toMatchObject({ status: STATUS.ACCEPTED });
    expect(verify("accept")).toMatchObject({ status: "unknown" });
  });

  it("reports an offer that is still pending", () => {
    expect(verify("decline", { trades: [pendingOffer] })).toMatchObject({ status: "still_pending" });
    expect(verify("accept", { trades: [pendingOffer] })).toMatchObject({ status: "still_pending" });
  });

  it("flags evidence of a different outcome than the one sent", () => {
    expect(verify("accept", { history: [{ id: "d", type: "TRADE_DECLINE", relatedTransactionId: "tx-1" }] })).toMatchObject({
      status: "conflict",
      observed: STATUS.DECLINED,
    });
  });
});

// Our counter to tx-1: we send Bijan back and ask for a different player.
function ourCounterTrade(overrides = {}) {
  return trade({
    id: "ours-1",
    proposingTeamId: OURS,
    relatedTransactionId: "tx-1",
    proposedDate: Date.parse("2026-10-06T14:00:00Z"),
    items: [
      { playerId: "3117251", playerName: "Christian McCaffrey", type: "TRADE", fromTeamId: "3", toTeamId: OURS },
      { playerId: "4429795", playerName: "Bijan Robinson", type: "TRADE", fromTeamId: OURS, toTeamId: "3" },
    ],
    ...overrides,
  });
}

describe("toCounterRecord", () => {
  it("keeps what our counter trades, its dates and when it was first seen", () => {
    expect(toCounterRecord(ourCounterTrade(), OURS, NOW)).toEqual({
      espn_transaction_id: "ours-1",
      send_espn_ids: ["4429795"],
      receive_espn_ids: ["3117251"],
      player_names: { 3117251: "Christian McCaffrey", 4429795: "Bijan Robinson" },
      proposed_date: Date.parse("2026-10-06T14:00:00Z"),
      expiration_date: EXPIRES,
      status: STATUS.OPEN,
      missed_reads: 0,
      exit_reason: null,
      seen_at: NOW.toISOString(),
    });
  });
});

describe("resolveCounter", () => {
  const countered = (ourCounter = null) => entry({ status: STATUS.COUNTERED, our_counter: ourCounter });
  const recorded = (overrides = {}) => ({ ...toCounterRecord(ourCounterTrade(), OURS, NOW), ...overrides });
  const base = { now: NOW, history: [], accepts: [], incoming: [], outgoing: [], ourTeamId: OURS };

  it("records our pending counter the first time ESPN shows it", () => {
    expect(resolveCounter(countered(), { ...base, outgoing: [ourCounterTrade()] })).toEqual(recorded());
  });

  it("changes nothing while a recorded counter is still pending", () => {
    expect(resolveCounter(countered(recorded()), { ...base, outgoing: [ourCounterTrade()] })).toBeNull();
  });

  it("resets the miss count when a counter missed once is pending again", () => {
    const missed = recorded({ missed_reads: 1, seen_at: "2026-10-06T15:00:00Z" });
    expect(resolveCounter(countered(missed), { ...base, outgoing: [ourCounterTrade()] })).toEqual({
      ...missed,
      missed_reads: 0,
    });
  });

  it.each([
    [{ type: "TRADE_ACCEPT", status: "EXECUTED", isPending: false }, STATUS.ACCEPTED],
    [{ type: "TRADE_DECLINE", status: "EXECUTED" }, STATUS.DECLINED],
    [{ type: "TRADE_VETO", status: "EXECUTED" }, STATUS.VETOED],
    [{ type: "TRADE_PROPOSAL", status: "PENDING" }, STATUS.COUNTERED],
    [{ type: "TRADE_PROPOSAL", status: "EXECUTED", executionType: "CANCEL" }, STATUS.WITHDRAWN],
  ])("settles a vanished counter from history row %j as %s", (row, status) => {
    const history = [{ id: "later", relatedTransactionId: "ours-1", ...row }];
    expect(resolveCounter(countered(recorded()), { ...base, history })).toMatchObject({
      espn_transaction_id: "ours-1",
      status,
    });
  });

  it("marks it accepted-pending from a pending accept of our counter", () => {
    const accepts = [{ id: "acc", type: "TRADE_ACCEPT", status: "PENDING", isPending: true, relatedTransactionId: "ours-1" }];
    expect(resolveCounter(countered(recorded()), { ...base, accepts })).toMatchObject({
      status: STATUS.ACCEPTED_PENDING_PROCESSING,
    });
  });

  it("marks it countered when their pending reply answers it", () => {
    const incoming = [trade({ id: "reply-1", relatedTransactionId: "ours-1" })];
    expect(resolveCounter(countered(recorded()), { ...base, incoming })).toMatchObject({
      status: STATUS.COUNTERED,
      exit_reason: "their counter is pending",
    });
  });

  it("treats our own canceled counter as withdrawn", () => {
    const history = [{ id: "ours-1", type: "TRADE_PROPOSAL", status: "CANCELED" }];
    expect(resolveCounter(countered(recorded()), { ...base, history })).toMatchObject({ status: STATUS.WITHDRAWN });
  });

  it("expires a counter past its expiration date", () => {
    const stale = recorded({ expiration_date: Date.parse("2026-10-06T00:00:00Z") });
    expect(resolveCounter(countered(stale), base)).toMatchObject({ status: STATUS.EXPIRED });
  });

  it("closes an unexplained disappearance only after repeated misses", () => {
    expect(resolveCounter(countered(recorded()), base)).toMatchObject({ status: STATUS.OPEN, missed_reads: 1 });
    expect(resolveCounter(countered(recorded({ missed_reads: 1 })), base)).toMatchObject({
      status: STATUS.CLOSED_UNKNOWN,
      missed_reads: 2,
    });
  });

  it("settles nothing that needs the history when the history read failed", () => {
    expect(resolveCounter(countered(recorded()), { ...base, history: null })).toBeNull();
  });

  it("leaves a settled counter alone", () => {
    const history = [{ id: "later", type: "TRADE_DECLINE", status: "EXECUTED", relatedTransactionId: "ours-1" }];
    expect(resolveCounter(countered(recorded({ status: STATUS.ACCEPTED })), { ...base, history })).toBeNull();
  });

  it("finds a counter that was sent and answered between refreshes in the history", () => {
    const history = [
      { ...ourCounterTrade(), status: "EXECUTED" },
      { id: "dec", type: "TRADE_DECLINE", status: "EXECUTED", relatedTransactionId: "ours-1" },
    ];
    expect(resolveCounter(countered(), { ...base, history })).toMatchObject({
      espn_transaction_id: "ours-1",
      send_espn_ids: ["4429795"],
      status: STATUS.DECLINED,
    });
  });

  it("does not take another team's proposal in the history for our counter", () => {
    const history = [{ ...ourCounterTrade(), proposingTeamId: "5" }];
    expect(resolveCounter(countered(), { ...base, history })).toBeNull();
  });

  it("does not take a cancel of the offer in the history for our counter", () => {
    const history = [{ ...ourCounterTrade(), status: "EXECUTED", executionType: "CANCEL" }];
    expect(resolveCounter(countered(), { ...base, history })).toBeNull();
  });
});

describe("buildThread", () => {
  const counter = (overrides = {}) => ({ ...toCounterRecord(ourCounterTrade(), OURS, NOW), ...overrides });
  const reply = (overrides = {}) =>
    entry({
      ...toInboxEntry(trade({ id: "reply-1", relatedTransactionId: "ours-1", proposedDate: Date.parse("2026-10-06T16:00:00Z") }), OURS),
      thread_root_id: "tx-1",
      status: STATUS.OPEN,
      ...overrides,
    });

  it("is empty for a thread with no entries", () => {
    expect(buildThread([entry()], "nope")).toEqual({ threadRootId: "nope", turns: [], state: null, ourCounters: 0 });
  });

  it("orders their offers and our counters by proposal time", () => {
    const thread = buildThread(
      [reply(), entry({ status: STATUS.COUNTERED, our_counter: counter({ status: STATUS.COUNTERED }) }), entry({ espn_transaction_id: "other", thread_root_id: "other" })],
      "tx-1",
    );
    expect(thread.turns.map((t) => [t.side, t.espn_transaction_id])).toEqual([
      ["theirs", "tx-1"],
      ["ours", "ours-1"],
      ["theirs", "reply-1"],
    ]);
    expect(thread).toMatchObject({ state: "awaiting_us", ourCounters: 1 });
  });

  it("is awaiting them while our counter is pending", () => {
    expect(buildThread([entry({ status: STATUS.COUNTERED, our_counter: counter() })], "tx-1").state).toBe("awaiting_them");
  });

  it("is awaiting them when ESPN shows the original countered but our counter isn't recorded yet", () => {
    expect(buildThread([entry({ status: STATUS.COUNTERED, our_counter: null })], "tx-1")).toMatchObject({
      state: "awaiting_them",
      ourCounters: 0,
    });
  });

  it("is awaiting us when our counter was countered but the reply isn't stored yet", () => {
    const thread = buildThread([entry({ status: STATUS.COUNTERED, our_counter: counter({ status: STATUS.COUNTERED }) })], "tx-1");
    expect(thread.state).toBe("awaiting_us");
  });

  it.each([
    [STATUS.ACCEPTED, "agreed"],
    [STATUS.ACCEPTED_PENDING_PROCESSING, "agreed"],
    [STATUS.DECLINED, "rejected"],
    [STATUS.VETOED, "rejected"],
    [STATUS.EXPIRED, "expired"],
    [STATUS.WITHDRAWN, "abandoned"],
    [STATUS.CLOSED_UNKNOWN, "abandoned"],
  ])("reads our counter %s as %s", (status, state) => {
    expect(buildThread([entry({ status: STATUS.COUNTERED, our_counter: counter({ status }) })], "tx-1").state).toBe(state);
  });

  it.each([
    [STATUS.OPEN, "awaiting_us"],
    [STATUS.UNPARSED, "awaiting_us"],
    [STATUS.RESPONDING, "awaiting_us"],
    [STATUS.ACCEPTED, "agreed"],
    [STATUS.DECLINED, "rejected"],
    [STATUS.EXPIRED, "expired"],
    [STATUS.WITHDRAWN, "abandoned"],
  ])("reads their latest offer %s as %s", (status, state) => {
    expect(buildThread([entry({ status })], "tx-1").state).toBe(state);
  });

  it("treats an entry stored without a thread root as the root of its own thread", () => {
    const legacy = entry();
    delete legacy.thread_root_id;
    expect(buildThread([legacy], "tx-1").turns).toHaveLength(1);
  });
});
