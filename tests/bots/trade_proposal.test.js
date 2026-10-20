jest.mock("../../src/bots/auth", () => ({
  createSessionFromStoredState: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));
jest.mock("../../src/bots/trade_bot", () => ({
  fetchRosterDeficits: jest.fn(),
}));
jest.mock("../../src/lib/trade_candidates", () => ({
  ...jest.requireActual("../../src/lib/trade_candidates"),
  fetchTradeCandidates: jest.fn(),
}));
jest.mock("../../src/lib/llm_client", () => ({
  completeWithFallback: jest.fn(),
}));
jest.mock("../../src/bots/trade_builder", () => ({
  submitTradeOffer: jest.fn(),
}));
jest.mock("../../src/lib/trade_scoring", () => ({
  ...jest.requireActual("../../src/lib/trade_scoring"),
  fetchTradeContext: jest.fn(),
  scoreTradePackage: jest.fn(),
}));
const { fetchTradeCandidates } = require("../../src/lib/trade_candidates");
const { generateTradeProposal } = require("../../src/bots/trade_proposal");
const { createSessionFromStoredState } = require("../../src/bots/auth");
const { fetchRosterDeficits } = require("../../src/bots/trade_bot");
const { completeWithFallback } = require("../../src/lib/llm_client");
const { submitTradeOffer } = require("../../src/bots/trade_builder");
const { fetchTradeContext, scoreTradePackage, buildPitchEvidence } = require("../../src/lib/trade_scoring");
const { makeScore, lineupWeek } = require("../fixtures/trade_score");

const close = jest.fn();
const player = (espnId, position, extra = {}) => ({
  espn_id: espnId,
  player_id: `p${espnId}`,
  name: `Player ${espnId}`,
  position,
  nfl_team: "CIN",
  slot: "BE",
  eligible_slots: [],
  injury_status: null,
  metrics: {},
  ...extra,
});
const team = (teamId, roster) => ({ team_id: teamId, name: `Team ${teamId}`, roster });
const payload = {
  season: 2026,
  week: 5,
  tracking_id: "test",
  approval: { approved_by: "bypass", offer_key: "a".repeat(64) },
};
const pkg = (to, incoming, outgoing) => ({
  to_team_id: to,
  incoming_player_ids: incoming,
  outgoing_player_ids: outgoing,
});

let packages;
let pitch;
let scores;
beforeEach(() => {
  jest.resetAllMocks();
  fetchTradeCandidates.mockResolvedValue({ status: "fallback", reason: "empty" });
  process.env.ESPN_LEAGUE_ID = "123";
  process.env.ESPN_TEAM_ID = "1";
  fetchRosterDeficits.mockResolvedValue({
    teams: {
      1: {},
      2: { RB: { deficit: 1, net_vorp: -5 } },
      3: { RB: { deficit: 1, net_vorp: -2 } },
    },
  });
  fetchTradeContext.mockResolvedValue({
    league_id: "123",
    teams: {
      1: team("1", [player("100", "RB"), player("101", "RB"), player("-16021", "D/ST")]),
      2: team("2", [player("200", "WR")]),
      3: team("3", [player("300", "WR"), player("301", "WR", { player_id: null })]),
    },
  });
  packages = [pkg("2", ["200"], ["100"]), pkg("3", ["300"], ["101"])];
  // Team 3's package has the better per-week gain; the LLM listed it second.
  scores = {
    2: makeScore({ counterpartyTeamId: "2", ourWeeks: [lineupWeek(5, 1)] }),
    3: makeScore({
      counterpartyTeamId: "3",
      send: [{ espn_id: "101", player_id: "p101", name: "Player 101", position: "RB", nfl_team: "CIN" }],
      receive: [{ espn_id: "300", player_id: "p300", name: "Player 300", position: "WR", nfl_team: "DET" }],
      ourWeeks: [lineupWeek(5, 3.1)],
      theirWeeks: [lineupWeek(5, 0.4)],
    }),
  };
  scoreTradePackage.mockImplementation(async ({ tradePackage }) => ({
    status: "scored",
    request: { counterparty_team_id: tradePackage.to_team_id },
    score: scores[tradePackage.to_team_id],
  }));
  pitch = () => ({ message: "Player 101 lifts your week 5 lineup by 0.4.", cited_evidence_ids: ["e1", "e3"] });
  completeWithFallback.mockImplementation(async (_prompt, { callSite }) => ({
    text: JSON.stringify(callSite === "trade_proposal_packages" ? { packages } : pitch()),
  }));
  createSessionFromStoredState.mockResolvedValue({ context: {}, browser: { close } });
  submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", messageAttached: false });
});
afterAll(() => {
  delete process.env.ESPN_LEAGUE_ID;
  delete process.env.ESPN_TEAM_ID;
});

const systemPrompt = (callSite) =>
  completeWithFallback.mock.calls.find(([, options]) => options.callSite === callSite)?.[1].systemPrompt;

test("stages the top-ranked scored package with a grounded pitch and never an approval", async () => {
  const result = await generateTradeProposal(payload);
  expect(result.submission.status).toBe("awaiting_approval");
  const [offer, options] = submitTradeOffer.mock.calls[0];
  expect(offer).toEqual({
    leagueId: "123",
    seasonId: "2026",
    fromTeamId: "1",
    toTeamId: "3",
    incomingPlayerIds: ["300"],
    outgoingPlayerIds: ["101"],
    message: "Player 101 lifts your week 5 lineup by 0.4.",
  });
  expect(options).toEqual({
    source: "proposal",
    trackingId: "test",
    session: expect.any(Object),
    evaluation: expect.any(Object),
  });
  expect(options).not.toHaveProperty("approval");
  expect(options.evaluation).toMatchObject({
    version: "proposal-evaluation-v1",
    score: scores[3],
    target: { team_id: "3", position: "RB" },
    ranking: { basis: "our_lineup_gain", rank: 1, packages_proposed: 2, packages_scored: 2, packages_eligible: 2 },
    pitch: { message: offer.message, cited_evidence_ids: ["e1", "e3"] },
  });
  expect(options.evaluation.request).toEqual({ counterparty_team_id: "3" });
  expect(close).toHaveBeenCalledTimes(1);
});

test("scores every package with the scan's period and ESPN ids, sequentially", async () => {
  await generateTradeProposal(payload);
  expect(fetchTradeContext).toHaveBeenCalledWith({ leagueId: "123", season: 2026, week: 5, horizon: 4 });
  expect(scoreTradePackage.mock.calls.map(([args]) => args)).toEqual([
    { leagueId: "123", season: 2026, week: 5, horizon: 4, ourTeamId: "1", tradePackage: packages[0] },
    { leagueId: "123", season: 2026, week: 5, horizon: 4, ourTeamId: "1", tradePackage: packages[1] },
  ]);
});

test("package prompt is grounded in context rosters and asks for no numbers or pitch", async () => {
  await generateTradeProposal(payload);
  const prompt = systemPrompt("trade_proposal_packages");
  expect(prompt).toContain('"espn_id":"-16021"');
  expect(prompt).toContain('"espn_id":"301","name":"Player 301"');
  expect(prompt).toMatch(/"espn_id":"301"[^}]*"scorable":false/);
  expect(prompt).not.toContain("p100");
  expect(prompt).toMatch(/do not write a pitch/i);
});

test("pitch prompt carries only counterparty-facing evidence", async () => {
  await generateTradeProposal(payload);
  const prompt = systemPrompt("trade_proposal_pitch");
  for (const item of buildPitchEvidence(scores[3])) expect(prompt).toContain(item.text);
  expect(prompt).not.toContain("3.1");
  expect(prompt).not.toContain("final_score");
  expect(prompt).not.toContain("our_lineup_gain");
});

test("no target avoids context, scoring, LLM and browser work", async () => {
  fetchRosterDeficits.mockResolvedValue({ teams: {} });
  await expect(generateTradeProposal(payload)).resolves.toEqual({ status: "no_target" });
  expect(fetchTradeContext).not.toHaveBeenCalled();
  expect(scoreTradePackage).not.toHaveBeenCalled();
  expect(completeWithFallback).not.toHaveBeenCalled();
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
});

test("excluded teams never reach prompts or scoring", async () => {
  await generateTradeProposal({ ...payload, exclude_team_ids: ["3"] });
  expect(systemPrompt("trade_proposal_packages")).not.toContain("Team 3");
  expect(scoreTradePackage.mock.calls.map(([args]) => args.tradePackage.to_team_id)).toEqual(["2"]);
  expect(await generateTradeProposal({ ...payload, exclude_team_ids: ["2", "3"] })).toEqual({ status: "no_target" });
});

test("the model can decline: no_offer without scoring or a browser", async () => {
  packages = [];
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({ status: "no_offer", reason: "no_packages" });
  expect(scoreTradePackage).not.toHaveBeenCalled();
  expect(submitTradeOffer).not.toHaveBeenCalled();
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
});

test.each([
  ["an unowned incoming id", pkg("2", ["999"], ["100"])],
  ["our player as incoming", pkg("2", ["100"], ["100"])],
  ["a duplicate id", pkg("2", ["200"], ["100", "100"])],
  ["a numeric id", pkg("2", [200], ["100"])],
  ["a team that isn't a target", pkg("4", ["200"], ["100"])],
  ["no player at the weak position", pkg("2", ["200"], ["-16021"])],
])("drops a package with %s and scores the rest", async (_label, bad) => {
  packages = [bad, pkg("3", ["300"], ["101"])];
  const result = await generateTradeProposal(payload);
  expect(scoreTradePackage).toHaveBeenCalledTimes(1);
  expect(result.offer.toTeamId).toBe("3");
});

test("only invalid packages is no_offer", async () => {
  packages = [pkg("2", ["999"], ["100"])];
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    status: "no_offer",
    reason: "no_valid_packages",
  });
  expect(submitTradeOffer).not.toHaveBeenCalled();
});

test("duplicate packages are scored once", async () => {
  packages = [pkg("3", ["300"], ["101"]), pkg("3", ["300"], ["101"])];
  await generateTradeProposal(payload);
  expect(scoreTradePackage).toHaveBeenCalledTimes(1);
});

test("no useful scored package is no_offer with its reasons and stages nothing", async () => {
  scores[2] = makeScore({ ourWeeks: [lineupWeek(5, -1)] });
  scores[3] = makeScore({ exceeds: { us: false, counterparty: true } });
  const result = await generateTradeProposal(payload);
  expect(result).toMatchObject({ status: "no_offer", reason: "no_useful_offer" });
  expect(result.rejections.map((r) => r.reasons)).toEqual([["no_gain_for_us"], ["exceeds_roster_limit"]]);
  expect(completeWithFallback).toHaveBeenCalledTimes(1);
  expect(submitTradeOffer).not.toHaveBeenCalled();
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
});

test("a package with an unmapped player is rejected, not scored as zero", async () => {
  packages = [pkg("3", ["301"], ["101"])];
  scoreTradePackage.mockResolvedValue({
    status: "scored",
    request: {},
    score: makeScore({ ourWeeks: [], theirWeeks: [], unmappedTraded: ["301"] }),
  });
  const result = await generateTradeProposal(payload);
  expect(result).toMatchObject({ status: "no_offer", reason: "no_useful_offer" });
  expect(result.rejections[0].reasons).toEqual(expect.arrayContaining(["unmapped_traded_player", "no_scored_weeks"]));
});

test("a partial scoring failure stages from the packages that scored", async () => {
  scoreTradePackage.mockImplementationOnce(async () => ({ status: "rejected", reason: "score_unavailable" }));
  const result = await generateTradeProposal(payload);
  expect(result.offer.toTeamId).toBe("3");
  expect(result.evaluation.ranking).toMatchObject({ packages_scored: 1 });
});

test("when core can't score anything the run fails transiently and stages nothing", async () => {
  scoreTradePackage.mockResolvedValue({ status: "rejected", reason: "score_unavailable" });
  await expect(generateTradeProposal(payload)).rejects.toMatchObject({ retryDelayMs: 5000 });
  expect(submitTradeOffer).not.toHaveBeenCalled();
});

test("ownership changes alone are no_offer, not a failure", async () => {
  scoreTradePackage.mockResolvedValue({ status: "rejected", reason: "ownership_changed" });
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    status: "no_offer",
    reason: "no_useful_offer",
  });
});

test.each([
  ["an invented number", () => ({ message: "You gain 12 points.", cited_evidence_ids: ["e1"] })],
  ["no citations", () => ({ message: "Player 101 helps you.", cited_evidence_ids: [] })],
  ["a declined pitch", () => ({ message: null })],
])("a pitch with %s is no_offer and stages nothing", async (_label, bad) => {
  pitch = bad;
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    status: "no_offer",
    reason: "pitch_rejected",
  });
  expect(submitTradeOffer).not.toHaveBeenCalled();
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
});

test("malformed package JSON is delayed for retry", async () => {
  completeWithFallback.mockResolvedValue({ text: "bad" });
  await expect(generateTradeProposal(payload)).rejects.toMatchObject({ retryDelayMs: 5000 });
  expect(submitTradeOffer).not.toHaveBeenCalled();
});

test("staging failure returns the computed offer without regenerating", async () => {
  submitTradeOffer.mockRejectedValue(new Error("selector missing"));
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    offer: { toTeamId: "3" },
    submission: { status: "fill_failed" },
  });
  // One package call, then a pitch for each of the two staged alternatives.
  expect(completeWithFallback).toHaveBeenCalledTimes(3);
  expect(close).toHaveBeenCalled();
});

test("rejects a malformed exclusion list", async () => {
  await expect(generateTradeProposal({ ...payload, exclude_team_ids: "2" })).rejects.toMatchObject({
    permanent: true,
  });
});

test.each([null, [], {}, { season: 2026, week: 0 }])("invalid payload fails permanently before I/O: %j", async (value) => {
  await expect(generateTradeProposal(value)).rejects.toMatchObject({ permanent: true });
  expect(fetchRosterDeficits).not.toHaveBeenCalled();
});

test("package prompt carries each player's bye week and both teams' bye crunch weeks", async () => {
  const context = await fetchTradeContext();
  context.teams[1].roster[0].nfl_bye_week = 8;
  context.teams[1].bye_outlook = {
    crunch_weeks: [8],
    weeks: [{ week: 8, on_bye: ["100", "101"], unfilled_slots: ["RB"], crunch: true }],
  };
  context.teams[3].bye_outlook = { crunch_weeks: [], weeks: [] };
  fetchTradeContext.mockResolvedValue(context);

  await generateTradeProposal(payload);

  const prompt = systemPrompt("trade_proposal_packages");
  expect(prompt).toMatch(/"espn_id":"100"[^}]*"nfl_bye_week":8/);
  expect(prompt).toContain(
    'Our bye outlook: {"crunch_weeks":[8],"weeks_with_byes":[{"week":8,"on_bye":["Player 100","Player 101"],"empty_starter_slots":["RB"],"crunch":true}]}',
  );
  expect(prompt).toContain('bye outlook: {"crunch_weeks":[],"weeks_with_byes":[]}');
  expect(prompt).toMatch(/never propose sending a player away just because he has a bye/i);
});

test("stages the best package for each counterparty as alternatives, best first", async () => {
  packages = [pkg("2", ["200"], ["100"]), pkg("3", ["300"], ["101"]), pkg("3", ["300"], ["100"])];
  pitch = () => ({ message: "This deal helps your lineup.", cited_evidence_ids: ["e1"] });

  const result = await generateTradeProposal(payload);

  expect(submitTradeOffer.mock.calls.map(([offer]) => offer.toTeamId)).toEqual(["3", "2"]);
  expect(result.offers.map((offer) => offer.evaluation.ranking.rank)).toEqual([1, 2]);
  expect(result.offer.toTeamId).toBe("3");
  expect(close).toHaveBeenCalledTimes(1);
});

test("a rejected pitch skips that alternative and still stages the rest", async () => {
  let calls = 0;
  pitch = () => (++calls === 1
    ? { message: "Trust me, 99 points.", cited_evidence_ids: ["e1"] }
    : { message: "This deal helps your lineup.", cited_evidence_ids: ["e1"] });

  const result = await generateTradeProposal(payload);

  expect(result.offers).toHaveLength(1);
  expect(submitTradeOffer).toHaveBeenCalledTimes(1);
});

test("with bye crunch weeks, teams whose byes miss ours are added as bye partners", async () => {
  fetchRosterDeficits.mockResolvedValue({
    teams: {
      1: {},
      // Least severe last: 5 and 6 miss the top three.
      2: { RB: { deficit: 1, net_vorp: -5 } },
      3: { RB: { deficit: 1, net_vorp: -4 } },
      4: { RB: { deficit: 1, net_vorp: -3 } },
      5: { RB: { deficit: 1, net_vorp: -2 } },
      6: { RB: { deficit: 1, net_vorp: -1 } },
    },
  });
  const context = await fetchTradeContext();
  context.teams[1].bye_outlook = { crunch_weeks: [8], weeks: [] };
  context.teams[5] = { ...team("5", [player("500", "RB")]), bye_outlook: { crunch_weeks: [8], weeks: [] } };
  context.teams[6] = { ...team("6", [player("600", "RB")]), bye_outlook: { crunch_weeks: [9], weeks: [] } };
  context.teams[4] = team("4", [player("400", "RB")]);
  fetchTradeContext.mockResolvedValue(context);

  await generateTradeProposal(payload);

  const prompt = systemPrompt("trade_proposal_packages");
  expect(prompt).toMatch(/Team 6 weakness: \{[^}]*"bye_partner":true/);
  expect(prompt).not.toContain("Team 5 weakness");
});

const useCandidates = (items = [
  { counterparty: { team_id: "3" }, receive: [{ espn_id: "300", player_id: "wrong-id" }], send: [{ espn_id: "101" }], status: "proposable", final_score: 10 },
  { counterparty: { team_id: "2" }, receive: [{ espn_id: "200" }], send: [{ espn_id: "100" }], status: "proposable", final_score: 9 },
]) => {
  pitch = () => ({ message: "This deal helps your lineup.", cited_evidence_ids: ["e1"] });
  return fetchTradeCandidates.mockResolvedValue({ status: "available", computedAt: "2026-10-20T12:00:00Z", items });
};

test("fresh candidates stage evaluated alternatives with live scores and only LLM pitches", async () => {
  useCandidates();
  const result = await generateTradeProposal(payload);
  expect(result.offers.map(({ offer }) => offer.toTeamId)).toEqual(["3", "2"]);
  expect(result.evaluation).toMatchObject({
    request: { counterparty_team_id: "3" }, score: scores[3],
    ranking: { source: "candidates", packages_proposed: 2, packages_scored: 2, packages_eligible: 2 },
  });
  expect(completeWithFallback.mock.calls.map(([, opts]) => opts.callSite)).toEqual([
    "trade_proposal_pitch", "trade_proposal_pitch",
  ]);
  expect(scoreTradePackage.mock.calls[0][0]).toEqual({
    leagueId: "123", season: 2026, week: 5, horizon: 4, ourTeamId: "1",
    tradePackage: { to_team_id: "3", incoming_player_ids: ["300"], outgoing_player_ids: ["101"] },
  });
  expect(submitTradeOffer).toHaveBeenCalledTimes(2);
});

test("candidates can stage even when no deficit target exists", async () => {
  useCandidates();
  fetchRosterDeficits.mockResolvedValue({ teams: {} });
  const result = await generateTradeProposal(payload);
  expect(result.offers).toHaveLength(2);
  expect(fetchRosterDeficits).not.toHaveBeenCalled();
});

test("candidate exclusions apply before scoring", async () => {
  useCandidates();
  const result = await generateTradeProposal({ ...payload, exclude_team_ids: ["3"] });
  expect(result.offers.map(({ offer }) => offer.toTeamId)).toEqual(["2"]);
  expect(scoreTradePackage.mock.calls.map(([args]) => args.tradePackage.to_team_id)).toEqual(["2"]);
});

test.each(["ownership_changed", "score_unavailable"])("a live %s skips that candidate and stages the surviving alternative", async (reason) => {
  useCandidates();
  scoreTradePackage.mockResolvedValueOnce({ status: "rejected", reason });
  const result = await generateTradeProposal(payload);
  expect(result.offers.map(({ offer }) => offer.toTeamId)).toEqual(["2"]);
  expect(result.evaluation.ranking.source).toBe("candidates");
  expect(completeWithFallback.mock.calls.map(([, opts]) => opts.callSite)).toEqual(["trade_proposal_pitch"]);
});

test.each([
  { ourWeeks: [lineupWeek(5, 0)] },
  { theirWeeks: [lineupWeek(5, -1)] },
  { exceeds: { us: true, counterparty: false } },
  { unmappedTraded: ["300"] },
])("live gate drift skips that candidate: %j", async (drift) => {
  useCandidates();
  scores[3] = makeScore(drift);
  const result = await generateTradeProposal(payload);
  expect(result.offers.map(({ offer }) => offer.toTeamId)).toEqual(["2"]);
  expect(completeWithFallback.mock.calls.map(([, opts]) => opts.callSite)).toEqual(["trade_proposal_pitch"]);
});

test("all live candidates failing gates stages nothing without generating replacements", async () => {
  useCandidates();
  scoreTradePackage.mockResolvedValue({ status: "rejected", reason: "ownership_changed" });
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({ status: "no_offer", reason: "no_useful_offer" });
  expect(completeWithFallback).not.toHaveBeenCalled();
  expect(submitTradeOffer).not.toHaveBeenCalled();
});

test.each(["never_run", "unavailable", "empty", "stale", "invalid"])("%s candidate data uses the LLM fallback and records its source", async (reason) => {
  fetchTradeCandidates.mockResolvedValue({ status: "fallback", reason });
  const result = await generateTradeProposal(payload);
  expect(result.evaluation.ranking.source).toBe("llm");
  expect(systemPrompt("trade_proposal_packages")).toBeDefined();
});

test.each([false, true])("scan offersStaged counts only surviving live candidates (all drift=%s)", async (allDrift) => {
  useCandidates();
  if (allDrift) scoreTradePackage.mockResolvedValue({ status: "rejected", reason: "ownership_changed" });
  else scoreTradePackage.mockResolvedValueOnce({ status: "rejected", reason: "ownership_changed" });
  const { runTradeScan } = require("../../src/bots/trade_scan");
  const result = await runTradeScan({ stage: true }, {
    now: new Date("2026-10-20T18:00:00Z"),
    readState: async () => ({ season_type: "regular", season: "2026", week: 5 }),
    claim: async () => true,
    refreshInbox: async () => ({ openOfferTeamIds: [] }),
    pool: {},
    generate: generateTradeProposal,
  });
  expect(result.offersStaged).toBe(allDrift ? 0 : 1);
  expect(submitTradeOffer).toHaveBeenCalledTimes(allDrift ? 0 : 1);
});
