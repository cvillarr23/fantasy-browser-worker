// Separate from trade_bot.test.js: these mocks (session, LLM, trade_builder) would otherwise apply
// to that file's pure-function tests too.
jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/debug_capture");
jest.mock("../../src/lib/llm_client");
jest.mock("../../src/db/execution_log");
jest.mock("../../src/bots/trade_builder");

const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("../../src/bots/auth");
const { completeWithFallback } = require("../../src/lib/llm_client");
const { recordTradeNegotiation } = require("../../src/db/execution_log");
const { submitTradeOffer } = require("../../src/bots/trade_builder");
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
  "9999": { name: "Eagles D/ST", espn_id: null },
  "202": { name: "Some Receiver", espn_id: "3139477" },
};

function routeFetch(url) {
  const summary = url.match(/\/v1\/players\/([^/]+)\/summary$/);
  if (summary) {
    const entry = CROSSWALK[decodeURIComponent(summary[1])];
    return entry
      ? jsonResponse({ player_id: summary[1], name: entry.name })
      : jsonResponse({ detail: "not found" }, 404);
  }
  const search = url.match(/\/v1\/players\/search\?q=(.*)$/);
  if (search) {
    const q = decodeURIComponent(search[1]);
    return jsonResponse(
      Object.entries(CROSSWALK)
        .filter(([, e]) => e.name.includes(q))
        .map(([player_id, e]) => ({ player_id, espn_id: e.espn_id, name: e.name })),
    );
  }
  return jsonResponse({ delta_vorp: 1.5 });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.ESPN_TEAM_ID = "8";

  session = {
    page: {
      goto: jest.fn(async () => {}),
      waitForSelector: jest.fn(async () => {}),
      evaluate: jest.fn(async () => "Team 3 offers X for Y"),
      getByText: jest.fn(() => ({ first: () => ({ click: async () => { throw new Error("no chat"); } }) })),
    },
    context: {},
    browser: { close: jest.fn(async () => {}) },
  };
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

  it("keeps the negotiation result when staging fails, rather than requeueing the LLM call", async () => {
    submitTradeOffer.mockRejectedValue(new PermanentError("player 4259545 not on team 3"));

    const result = await negotiateTradeProposal(payload);

    expect(result.counterOffer.incomingPlayerIds).toEqual(["12483"]);
    expect(result.submission).toMatchObject({ status: "fill_failed", error: expect.stringMatching(/not on team 3/) });
    expect(session.browser.close).toHaveBeenCalled();
  });

  it("stages nothing when any player has no ESPN id (e.g. a D/ST), recording why", async () => {
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
