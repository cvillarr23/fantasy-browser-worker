const {
  buildIncomingEvaluation,
  incomingEvaluationFor,
  MAX_INCOMING_EVALUATION_BYTES,
  toInboxEntry,
  mergeEntry,
  buildScoreRequest,
  scoreFromResponse,
  rankInbox,
  shadowPolicy,
  tradeFingerprint,
  computeDecisionKey,
  buildNegotiationPayload,
} = require("../../src/lib/trade_inbox");
const { makeScore } = require("../fixtures/trade_score");

const NOW = new Date("2026-10-08T12:00:00.000Z");
const TRADE = {
  id: "tx-1",
  type: "TRADE_PROPOSAL",
  status: "PENDING",
  proposingTeamId: "2",
  proposedDate: NOW.getTime(),
  expirationDate: NOW.getTime() + 86400000,
  items: [
    { type: "TRADE", playerId: "100", fromTeamId: "1", toTeamId: "2" },
    { type: "TRADE", playerId: "200", fromTeamId: "2", toTeamId: "1" },
  ],
};
const PERIOD = { leagueId: "123", season: 2026, week: 5 };

function fixture(body = makeScore({ score: { final_score: 3 } })) {
  const entry = mergeEntry(null, toInboxEntry(TRADE, "1"), NOW);
  const { request, partialReasons } = buildScoreRequest(entry, PERIOD);
  entry.score = scoreFromResponse(body, {
    fingerprint: entry.fingerprint,
    scoredAt: NOW.toISOString(),
    partialReasons,
  });
  const input = {
    request,
    body,
    fingerprint: entry.fingerprint,
    evaluatedAt: NOW.toISOString(),
  };
  entry.evaluation = buildIncomingEvaluation(input);
  return { entry, input };
}

describe("incoming score evidence", () => {
  it("retains the exact request and entire response, without injecting a default horizon", () => {
    const { entry, input } = fixture();
    expect(entry.evaluation).toEqual({
      version: "incoming-trade-evaluation-v1",
      evaluated_at: input.evaluatedAt,
      scored_fingerprint: entry.fingerprint,
      request: input.request,
      score: input.body,
    });
    expect(entry.evaluation.request).not.toHaveProperty("horizon");
    expect(incomingEvaluationFor(entry)).toEqual(entry.evaluation);
  });

  it("retains unavailable scores and unscored-week reasons", () => {
    const { entry, input } = fixture(makeScore());
    expect(entry.score.final_score).toBeNull();
    expect(entry.evaluation.score).toEqual(input.body);
    expect(entry.evaluation.score.horizon.unscored_weeks[0].reasons).toEqual([
      "no_week_metrics",
    ]);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["unknown version", { version: "future" }],
  ])("tolerates %s stored evidence", (_label, evaluation) => {
    expect(
      incomingEvaluationFor({ ...fixture().entry, evaluation }),
    ).toBeNull();
  });

  it.each([
    [
      "fingerprint",
      (e) => {
        e.scored_fingerprint = "a".repeat(64);
      },
    ],
    [
      "timestamp",
      (e) => {
        e.evaluated_at = "2026-10-07T12:00:00.000Z";
      },
    ],
    [
      "request team",
      (e) => {
        e.request.our_team_id = "9";
      },
    ],
    [
      "request players",
      (e) => {
        e.request.receive_espn_ids = ["999"];
      },
    ],
    [
      "response week",
      (e) => {
        e.score.as_of_week = 6;
      },
    ],
    [
      "response team",
      (e) => {
        e.score.counterparty_team.team_id = "9";
      },
    ],
    [
      "response players",
      (e) => {
        e.score.send[0].espn_id = "999";
      },
    ],
    [
      "response version",
      (e) => {
        e.score.scoring_version = "future";
      },
    ],
    [
      "response structure",
      (e) => {
        e.score.horizon = null;
      },
    ],
  ])("rejects a mismatched %s", (_label, mutate) => {
    const { entry } = fixture();
    mutate(entry.evaluation);
    expect(incomingEvaluationFor(entry)).toBeNull();
  });

  it("rejects invalid provenance or missing responses without throwing", () => {
    const { input } = fixture();
    expect(buildIncomingEvaluation({ ...input, body: null })).toBeNull();
    expect(
      buildIncomingEvaluation({
        ...input,
        body: { scoring_version: "trade-score-v1" },
      }),
    ).toBeNull();
    expect(
      buildIncomingEvaluation({ ...input, evaluatedAt: "yesterday" }),
    ).toBeNull();
    expect(
      buildIncomingEvaluation({ ...input, evaluatedAt: "2026-10-08T12:00:00" }),
    ).toBeNull();
    expect(buildIncomingEvaluation({ ...input, request: null })).toBeNull();
    const circular = { ...input.body };
    circular.circular = circular;
    expect(buildIncomingEvaluation({ ...input, body: circular })).toBeNull();
    expect(buildIncomingEvaluation({ ...input, body: { ...input.body, weights: { strength_weight: Infinity } } })).toBeNull();
  });

  it.each([
    ["summary fingerprint", (e) => { e.score.scored_fingerprint = "a".repeat(64); }],
    ["summary timestamp", (e) => { e.score.scored_at = "2026-10-07T12:00:00.000Z"; }],
    ["summary final score", (e) => { e.score.final_score = 99; }],
    ["entry team", (e) => { e.our_team_id = "9"; }],
    ["entry players", (e) => { e.send_espn_ids = ["999"]; }],
  ])("rejects evidence inconsistent with %s", (_label, mutate) => {
    const { entry } = fixture();
    mutate(entry);
    expect(incomingEvaluationFor(entry)).toBeNull();
  });

  it("binds player sides independently of ordering, including negative D/ST ids", () => {
    const { input } = fixture();
    input.request.send_espn_ids.push("-16021");
    input.body.send.unshift({ espn_id: "-16021", player_id: "PHI", name: "Eagles D/ST", position: "D/ST", nfl_team: "PHI" });
    expect(buildIncomingEvaluation(input)).not.toBeNull();
  });

  it("caps the UTF-8 envelope at exactly 65536 bytes, including multibyte text", () => {
    const { input } = fixture();
    const body = { ...input.body, padding: "" };
    const baseline = buildIncomingEvaluation({ ...input, body });
    const remaining =
      MAX_INCOMING_EVALUATION_BYTES -
      Buffer.byteLength(JSON.stringify(baseline), "utf8");
    body.padding =
      "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    const atLimit = buildIncomingEvaluation({ ...input, body });
    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(65536);
    expect(atLimit).not.toBeNull();
    body.padding += "x";
    expect(buildIncomingEvaluation({ ...input, body })).toBeNull();
  });

  it("clears evidence on fingerprint change without altering the old flattened score", () => {
    const { entry } = fixture();
    const next = mergeEntry(
      entry,
      { ...entry, fingerprint: "a".repeat(64) },
      NOW,
    );
    expect(next.evaluation).toBeNull();
    expect(next.score).toEqual(entry.score);
    expect(mergeEntry(entry, entry, NOW).evaluation).toEqual(entry.evaluation);
  });

  it("never changes ranking, shadow verdict, fingerprint, decision keys or counter payload", () => {
    const { entry } = fixture();
    const plain = { ...entry, evaluation: null };
    const garbage = {
      ...entry,
      evaluation: { version: "garbage", score: 99999 },
    };
    const key = (e) =>
      computeDecisionKey({
        ...PERIOD,
        seasonId: 2026,
        ourTeamId: "1",
        transactionId: "tx-1",
        action: "accept",
        fingerprint: e.fingerprint,
      });
    for (const candidate of [plain, entry, garbage]) {
      expect(key(candidate)).toBe(key(plain));
      expect(
        tradeFingerprint({ ...TRADE, evaluation: candidate.evaluation }),
      ).toBe(tradeFingerprint(TRADE));
      expect(shadowPolicy(candidate.score, { acceptMin: 1 })).toEqual(
        shadowPolicy(plain.score, { acceptMin: 1 }),
      );
      expect(
        buildNegotiationPayload(candidate, {
          season: 2026,
          week: 5,
          trackingId: "fixed",
        }),
      ).toEqual(
        buildNegotiationPayload(plain, {
          season: 2026,
          week: 5,
          trackingId: "fixed",
        }),
      );
      expect(
        rankInbox(
          [
            {
              ...plain,
              espn_transaction_id: "other",
              score: { final_score: 2 },
            },
            candidate,
          ],
          { now: NOW },
        ).map((e) => e.espn_transaction_id),
      ).toEqual(["tx-1", "other"]);
    }
  });
});
