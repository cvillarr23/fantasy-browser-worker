const {
  EVALUATION_VERSION,
  MAX_EVALUATION_BYTES,
  packageKey,
  fetchTradeContext,
  scoreTradePackage,
  rankScoredPackages,
  buildPitchEvidence,
  validatePitch,
  buildEvaluation,
  evaluationFits,
  resolvePointer,
} = require("../../src/lib/trade_scoring");
const { makeScore, lineupWeek } = require("../fixtures/trade_score");

const pkg = (to, incoming, outgoing) => ({
  to_team_id: to,
  incoming_player_ids: incoming,
  outgoing_player_ids: outgoing,
});
const entry = (p, score) => ({ package: p, request: {}, score });

describe("rankScoredPackages", () => {
  test("orders by core's score, never by raw VORP", () => {
    const low = entry(pkg("2", ["200"], ["100"]), makeScore({ deltaVorp: 50, score: { final_score: 1 } }));
    const high = entry(pkg("3", ["300"], ["101"]), makeScore({ deltaVorp: -5, score: { final_score: 4 } }));
    const { ranked } = rankScoredPackages([low, high]);
    expect(ranked.map((r) => r.package.to_team_id)).toEqual(["3", "2"]);
    expect(ranked[0]).toMatchObject({ basis: "final_score", value_per_scored_week: 4 });
  });

  test("a non-null final_score outranks a bigger raw lineup gain; scales are never mixed", () => {
    const unweighted = entry(pkg("2", ["200"], ["100"]), makeScore({ ourWeeks: [lineupWeek(5, 20)] }));
    const weighted = entry(pkg("3", ["300"], ["101"]), makeScore({ score: { final_score: 0.5 } }));
    const { ranked } = rankScoredPackages([unweighted, weighted]);
    expect(ranked.map((r) => r.basis)).toEqual(["final_score", "our_lineup_gain"]);
  });

  test("compares value per scored week so a missing week never counts as zero", () => {
    const oneWeek = entry(pkg("2", ["200"], ["100"]), makeScore({ ourWeeks: [lineupWeek(5, 4)] }));
    const twoWeeks = entry(
      pkg("3", ["300"], ["101"]),
      makeScore({ ourWeeks: [lineupWeek(5, 3), lineupWeek(6, 3)], unscoredWeeks: [] }),
    );
    const { ranked } = rankScoredPackages([twoWeeks, oneWeek]);
    expect(ranked.map((r) => r.value_per_scored_week)).toEqual([4, 3]);
  });

  test("ties break by coverage, then counterparty change, then package key", () => {
    const base = { ourWeeks: [lineupWeek(5, 2)] };
    const a = entry(pkg("2", ["200"], ["100"]), makeScore({ ...base, theirWeeks: [lineupWeek(5, 0)] }));
    const b = entry(pkg("3", ["300"], ["101"]), makeScore({ ...base, theirWeeks: [lineupWeek(5, 1)] }));
    const c = entry(pkg("4", ["400"], ["102"]), makeScore({ ...base, theirWeeks: [lineupWeek(5, 0)] }));
    const wider = entry(
      pkg("5", ["500"], ["103"]),
      makeScore({ ourWeeks: [lineupWeek(5, 2), lineupWeek(6, 2)], theirWeeks: [lineupWeek(5, 0)] }),
    );
    const { ranked } = rankScoredPackages([c, a, b, wider]);
    expect(ranked.map((r) => r.package.to_team_id)).toEqual(["5", "3", "2", "4"]);
  });

  test.each([
    ["no_gain_for_us", { ourWeeks: [lineupWeek(5, 0)] }],
    ["no_gain_for_us", { ourWeeks: [lineupWeek(5, -1)] }],
    ["hurts_counterparty", { theirWeeks: [lineupWeek(5, -0.1)] }],
    ["exceeds_roster_limit", { exceeds: { us: true, counterparty: false } }],
    ["exceeds_roster_limit", { exceeds: { us: false, counterparty: true } }],
    ["unmapped_traded_player", { unmappedTraded: ["200"] }],
  ])("rejects %s", (reason, options) => {
    const { ranked, rejections } = rankScoredPackages([entry(pkg("2", ["200"], ["100"]), makeScore(options))]);
    expect(ranked).toEqual([]);
    expect(rejections[0].reasons).toContain(reason);
  });

  test("rejects a package with no scored weeks and a null gain", () => {
    const score = makeScore({ ourWeeks: [], theirWeeks: [] });
    const { rejections } = rankScoredPackages([entry(pkg("2", ["200"], ["100"]), score)]);
    expect(rejections[0].reasons).toEqual(expect.arrayContaining(["no_scored_weeks", "no_gain_for_us"]));
  });

  test("missing strength and an incomplete horizon still rank by lineup gain", () => {
    const score = makeScore();
    expect(score.strength_metric.teams_with_strength).toBe(0);
    expect(score.horizon.complete_horizon).toBe(false);
    const { ranked } = rankScoredPackages([entry(pkg("2", ["200"], ["100"]), score)]);
    expect(ranked[0]).toMatchObject({ basis: "our_lineup_gain", value_per_scored_week: 3.1 });
  });
});

describe("packageKey", () => {
  test("sorts ids as strings and keeps the sides distinct", () => {
    expect(packageKey(pkg("2", ["9", "-16021"], ["10"]))).toBe(packageKey(pkg("2", ["-16021", "9"], ["10"])));
    expect(packageKey(pkg("2", ["9"], ["10"]))).not.toBe(packageKey(pkg("2", ["10"], ["9"])));
  });
});

describe("core HTTP calls", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const respond = (status, body) =>
    jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  const args = {
    leagueId: "123",
    season: 2026,
    week: 5,
    horizon: 4,
    ourTeamId: "1",
    tradePackage: pkg("2", ["200", "-16021"], ["100"]),
  };

  test("maps outgoing to send and incoming to receive, as ESPN string ids", async () => {
    const score = makeScore();
    global.fetch = respond(200, score);
    const result = await scoreTradePackage(args);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/v1\/trade\/score$/);
    expect(JSON.parse(init.body)).toEqual({
      league_id: "123",
      season: 2026,
      week: 5,
      horizon: 4,
      our_team_id: "1",
      counterparty_team_id: "2",
      send_espn_ids: ["100"],
      receive_espn_ids: ["200", "-16021"],
    });
    expect(result).toEqual({ status: "scored", request: JSON.parse(init.body), score });
  });

  test.each([
    [409, "ownership_changed"],
    [422, "invalid_request"],
    [429, "score_unavailable"],
    [503, "score_unavailable"],
    [504, "score_unavailable"],
  ])("HTTP %i becomes %s without throwing", async (status, reason) => {
    global.fetch = respond(status, { detail: "x" });
    await expect(scoreTradePackage(args)).resolves.toMatchObject({ status: "rejected", reason });
  });

  test("a timeout or network failure is score_unavailable", async () => {
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(scoreTradePackage(args)).resolves.toMatchObject({ status: "rejected", reason: "score_unavailable" });
    expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
  });

  test("fetchTradeContext queries the scan's league, period and horizon", async () => {
    global.fetch = respond(200, { teams: {} });
    await fetchTradeContext({ leagueId: "123", season: 2026, week: 5, horizon: 4 });
    expect(global.fetch.mock.calls[0][0]).toMatch(
      /\/v1\/trade\/context\?league_id=123&season=2026&week=5&horizon=4$/,
    );
  });

  test("fetchTradeContext failures are transient unless core says the request is invalid", async () => {
    global.fetch = respond(503, {});
    await expect(fetchTradeContext({ leagueId: "123", season: 2026, week: 5, horizon: 4 })).rejects.toMatchObject({
      retryDelayMs: 5000,
    });
    global.fetch = respond(422, {});
    await expect(fetchTradeContext({ leagueId: "123", season: 2026, week: 5, horizon: 4 })).rejects.toMatchObject({
      permanent: true,
    });
  });
});

describe("pitch grounding", () => {
  const score = makeScore();
  const evidence = buildPitchEvidence(score);

  test("evidence is counterparty-facing and every path resolves in the score", () => {
    for (const item of evidence) {
      expect(resolvePointer(score, item.path)).not.toBeUndefined();
    }
    const text = JSON.stringify(evidence);
    expect(text).toContain("Player 100");
    expect(text).toContain("+0.4");
    expect(text).not.toContain("3.1");
    expect(evidence.some((item) => item.path.startsWith("/roster_impact/us"))).toBe(false);
    expect(evidence.some((item) => item.path.startsWith("/score"))).toBe(false);
  });

  test("accepts a pitch that cites evidence and only repeats its numbers", () => {
    const cite = evidence.find((item) => item.text.includes("+0.4")).id;
    expect(
      validatePitch({ message: "Player 100 lifts your week 5 lineup by 0.4.", cited_evidence_ids: [cite] }, evidence),
    ).toEqual({ message: "Player 100 lifts your week 5 lineup by 0.4.", cited_evidence_ids: [cite] });
  });

  test.each([
    ["an invented number", { message: "This adds +12 points for you." }],
    ["our own score", { message: "Worth 3.1 to you." }],
    ["an empty message", { message: " " }],
    ["a declined pitch", { message: null }],
    ["an overlong message", { message: "x".repeat(1001) }],
    ["no citations", { cited_evidence_ids: [] }],
    ["an unknown citation", { cited_evidence_ids: ["nope"] }],
  ])("rejects %s", (_label, change) => {
    const pitch = { message: "Player 100 helps your RB room.", cited_evidence_ids: [evidence[0].id], ...change };
    expect(() => validatePitch(pitch, evidence)).toThrow();
  });
});

describe("buildEvaluation", () => {
  const score = makeScore();
  const request = { league_id: "123", season: 2026, week: 5, horizon: 4 };
  const evidence = buildPitchEvidence(score);
  const evaluation = buildEvaluation({
    request,
    score,
    target: { team_id: "2", position: "RB", deficit: 1, severity: 6 },
    ranking: { basis: "our_lineup_gain", value_per_scored_week: 3.1, rank: 1 },
    pitch: { message: "m", cited_evidence_ids: [evidence[0].id] },
    evidence,
    evaluatedAt: "2026-10-07T12:00:00.000Z",
  });

  test("is the v1 envelope around the verbatim score", () => {
    expect(evaluation).toEqual({
      version: EVALUATION_VERSION,
      evaluated_at: "2026-10-07T12:00:00.000Z",
      request,
      score,
      target: { team_id: "2", position: "RB", deficit: 1, severity: 6 },
      ranking: { basis: "our_lineup_gain", value_per_scored_week: 3.1, rank: 1 },
      pitch: { message: "m", evidence, cited_evidence_ids: [evidence[0].id] },
    });
    expect(evaluation.version).toBe("proposal-evaluation-v1");
    expect(evaluation.score.score.final_score).toBeNull();
  });

  test("fails closed when it would exceed the size budget", () => {
    expect(evaluationFits(evaluation)).toBe(true);
    expect(evaluationFits({ ...evaluation, padding: "x".repeat(MAX_EVALUATION_BYTES) })).toBe(false);
  });
});
