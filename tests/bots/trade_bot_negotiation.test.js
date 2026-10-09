// Separate from trade_bot.test.js: these mocks (session, LLM, trade_builder) would otherwise apply
// to that file's pure-function tests too.
jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/debug_capture");
jest.mock("../../src/lib/llm_client");
jest.mock("../../src/db/execution_log");
jest.mock("../../src/bots/trade_builder");
jest.mock("../../src/bots/espn_api");

const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("../../src/bots/auth");
const { completeWithFallback } = require("../../src/lib/llm_client");
const { recordTradeNegotiation } = require("../../src/db/execution_log");
const { submitTradeOffer } = require("../../src/bots/trade_builder");
const { readPendingTrades, readLeagueChat } = require("../../src/bots/espn_api");
const { PermanentError } = require("../../src/errors");
const { negotiateTradeProposal } = require("../../src/bots/trade_bot");

const ENV_KEYS = ["ESPN_LEAGUE_ID", "ESPN_TEAM_ID"];
let savedEnv;
let session;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// core-pipeline's internal (Sleeper) id -> {name, espn_id}. The LLM's counter uses internal ids,
// the same space /v1/trade/evaluate takes. These deliberately collide numerically with ESPN ids,
// as the real spaces do (internal 12483 is Jack Bech, ESPN 12483 is Matthew Stafford).
const CROSSWALK = {
  "12483": { name: "Jack Bech", espn_id: "4685720" },
  "9999": { name: "Some Kicker", espn_id: null },
  "202": { name: "Some Receiver", espn_id: "3139477" },
  // A D/ST's internal id is its team abbreviation; its ESPN id is -(16000 + proTeamId).
  PHI: { name: "Philadelphia Eagles", espn_id: "-16021" },
};

function routeFetch(url) {
  const summary = url.match(/\/v1\/players\/([^/]+)\/summary$/);
  if (summary) {
    const entry = CROSSWALK[decodeURIComponent(summary[1])];
    if (!entry) return jsonResponse({ detail: "not found" }, 404);
    return jsonResponse({ player_id: summary[1], name: entry.name, espn_id: entry.espn_id });
  }
  return jsonResponse({ delta_vorp: 1.5 });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.ESPN_TEAM_ID = "8";

  session = {
    page: { goto: jest.fn(async () => {}) },
    context: { request: {} },
    browser: { close: jest.fn(async () => {}) },
  };
  readPendingTrades.mockResolvedValue({
    trades: [
      {
        id: "trade-1",
        type: "TRADE_PROPOSAL",
        status: "PENDING",
        proposingTeamId: "3",
        items: [{ playerId: "4685720", playerName: "Jack Bech", fromTeamId: "3", toTeamId: "8" }],
      },
    ],
    teamIdByMemberId: new Map([["{OWNER-3}", "3"]]),
  });
  readLeagueChat.mockResolvedValue([
    { authorId: "{OWNER-3}", date: Date.UTC(2026, 9, 1), content: "Bech for your WR2?" },
  ]);
  createSessionFromStoredState.mockResolvedValue(session);
  createAuthenticatedSession.mockResolvedValue(session);
  global.fetch = jest.fn(async (url) => routeFetch(url));
  completeWithFallback.mockResolvedValue({
    text: JSON.stringify({
      counter_offer: { incoming_player_ids: ["12483"], outgoing_player_ids: ["202"] },
    }),
  });
});

afterEach(() => {
  delete global.fetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const payload = {
  tracking_id: "neg-1",
  incoming_player_ids: ["101"],
  outgoing_player_ids: ["202"],
  season: 2026,
  week: 3,
  offering_team_id: "3",
};

describe("negotiateTradeProposal -> trade builder", () => {
  it("translates the counter's internal ids to ESPN ids and stages a dry fill, never with an approval", async () => {
    submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", offerKey: "k", dryRun: true });

    const result = await negotiateTradeProposal(payload);

    expect(submitTradeOffer).toHaveBeenCalledTimes(1);
    const [offer, opts] = submitTradeOffer.mock.calls[0];
    expect(offer).toEqual({
      leagueId: "1248158344",
      seasonId: "2026",
      fromTeamId: "8",
      toTeamId: "3",
      // Translated, NOT the raw internal ids: forwarding "12483" would target Stafford.
      incomingPlayerIds: ["4685720"],
      outgoingPlayerIds: ["3139477"],
    });
    expect(opts).toMatchObject({ source: "counter_offer", trackingId: "neg-1", session });
    expect(opts.approval).toBeUndefined();
    expect(result.submission).toMatchObject({ status: "awaiting_approval", offerKey: "k" });
    expect(recordTradeNegotiation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "computed", dryRun: true }),
    );
  });

  it("links a counter's staged offer and log row to the incoming offer and its thread", async () => {
    submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", offerKey: "k", dryRun: true });

    await negotiateTradeProposal({ ...payload, related_transaction_id: "trade-1", thread_root_id: "trade-0" });

    const [offer, opts] = submitTradeOffer.mock.calls[0];
    expect(offer).toMatchObject({ relatedTransactionId: "trade-1", threadRootId: "trade-0" });
    expect(opts.approval).toBeUndefined();
    expect(recordTradeNegotiation).toHaveBeenCalledWith(
      expect.objectContaining({
        counterOffer: expect.objectContaining({ relatedTransactionId: "trade-1", threadRootId: "trade-0" }),
      }),
    );
  });

  it("keeps the negotiation result when staging fails, rather than requeueing the LLM call", async () => {
    submitTradeOffer.mockRejectedValue(new PermanentError("player 4259545 not on team 3"));

    const result = await negotiateTradeProposal(payload);

    expect(result.counterOffer.incomingPlayerIds).toEqual(["12483"]);
    expect(result.submission).toMatchObject({ status: "fill_failed", error: expect.stringMatching(/not on team 3/) });
    expect(session.browser.close).toHaveBeenCalled();
  });

  it("takes the ESPN id from /summary alone, never a name search", async () => {
    submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", offerKey: "k", dryRun: true });

    await negotiateTradeProposal(payload);

    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("/v1/players/search"))).toBe(false);
    expect(submitTradeOffer.mock.calls[0][0].incomingPlayerIds).toEqual(["4685720"]);
  });

  it("stages a D/ST by its negative ESPN id", async () => {
    submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", offerKey: "k", dryRun: true });
    completeWithFallback.mockResolvedValue({
      text: JSON.stringify({
        counter_offer: { incoming_player_ids: ["PHI"], outgoing_player_ids: ["202"] },
      }),
    });

    await negotiateTradeProposal(payload);

    expect(submitTradeOffer.mock.calls[0][0].incomingPlayerIds).toEqual(["-16021"]);
  });

  it("stages nothing when any player has no ESPN id, recording why", async () => {
    completeWithFallback.mockResolvedValue({
      text: JSON.stringify({
        counter_offer: { incoming_player_ids: ["12483", "9999"], outgoing_player_ids: ["202"] },
      }),
    });

    const result = await negotiateTradeProposal(payload);

    expect(submitTradeOffer).not.toHaveBeenCalled();
    expect(result.submission).toMatchObject({
      status: "fill_failed",
      error: expect.stringMatching(/9999.*no ESPN id/),
    });
  });

  it("stages nothing when the internal id is unknown to core-pipeline", async () => {
    completeWithFallback.mockResolvedValue({
      text: JSON.stringify({
        counter_offer: { incoming_player_ids: ["777"], outgoing_player_ids: ["202"] },
      }),
    });

    const result = await negotiateTradeProposal(payload);

    expect(submitTradeOffer).not.toHaveBeenCalled();
    expect(result.submission).toMatchObject({ status: "fill_failed", error: expect.stringMatching(/777/) });
  });
});

describe("negotiateTradeProposal -> pending trade and chat reads (#101)", () => {
  beforeEach(() => {
    submitTradeOffer.mockResolvedValue({ status: "awaiting_approval", offerKey: "k", dryRun: true });
  });

  it("reads the pending trade and league chat over REST, never loading the clubhouse page", async () => {
    await negotiateTradeProposal(payload);

    expect(readPendingTrades).toHaveBeenCalledWith(session.context, {
      leagueId: "1248158344",
      seasonId: 2026,
      teamId: "8",
    });
    expect(readLeagueChat).toHaveBeenCalledWith(session.context, {
      leagueId: "1248158344",
      seasonId: 2026,
    });
    expect(session.page.goto).not.toHaveBeenCalled();

    const { systemPrompt } = completeWithFallback.mock.calls[0][1];
    expect(systemPrompt).toContain("TRADE_PROPOSAL from team 3 (PENDING): team 3 sends Jack Bech");
    expect(systemPrompt).toContain("team 3: Bech for your WR2?");
  });

  it("describes only the offering team's trade, not other pending ones with us", async () => {
    readPendingTrades.mockResolvedValue({
      trades: [
        {
          id: "from-7",
          type: "TRADE_PROPOSAL",
          status: "PENDING",
          proposingTeamId: "7",
          items: [{ playerId: "1", playerName: "Team Seven Guy", fromTeamId: "7", toTeamId: "8" }],
        },
        {
          id: "from-3",
          type: "TRADE_PROPOSAL",
          status: "PENDING",
          proposingTeamId: "3",
          items: [{ playerId: "2", playerName: "Team Three Guy", fromTeamId: "3", toTeamId: "8" }],
        },
      ],
      teamIdByMemberId: new Map(),
    });

    await negotiateTradeProposal(payload); // offering_team_id "3"

    const { systemPrompt } = completeWithFallback.mock.calls[0][1];
    expect(systemPrompt).toContain("Team Three Guy");
    expect(systemPrompt).not.toContain("Team Seven Guy");
  });

  it("still negotiates, proposals-only, when the chat read fails", async () => {
    readLeagueChat.mockRejectedValue(new Error("HTTP 500"));

    const result = await negotiateTradeProposal(payload);

    expect(completeWithFallback.mock.calls[0][1].systemPrompt).toContain(
      "Recent league chat: CHAT_LOG_UNAVAILABLE",
    );
    expect(result.submission).toMatchObject({ status: "awaiting_approval" });
  });

  it("tells the model when nothing is pending", async () => {
    readPendingTrades.mockResolvedValue({ trades: [], teamIdByMemberId: new Map() });

    await negotiateTradeProposal(payload);

    expect(completeWithFallback.mock.calls[0][1].systemPrompt).toContain(
      "Pending trade proposal(s): NO_PENDING_PROPOSALS",
    );
  });

  it("fails with a retry delay when the pending-trade read fails, recording the failure", async () => {
    readPendingTrades.mockRejectedValue(new Error("[ESPN API] Pending-trade read failed with HTTP 503"));

    await expect(negotiateTradeProposal(payload)).rejects.toMatchObject({
      retryDelayMs: expect.any(Number),
    });
    expect(completeWithFallback).not.toHaveBeenCalled();
    expect(recordTradeNegotiation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure", errorMessage: expect.stringMatching(/HTTP 503/) }),
    );
    expect(session.browser.close).toHaveBeenCalled();
  });
});
