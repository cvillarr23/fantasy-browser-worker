jest.mock("../../src/bots/auth", () => ({
  createSessionFromStoredState: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));
jest.mock("../../src/bots/espn_api", () => ({ readRosters: jest.fn() }));
jest.mock("../../src/bots/trade_bot", () => ({
  fetchRosterDeficits: jest.fn(),
}));
jest.mock("../../src/lib/llm_client", () => ({
  completeWithFallback: jest.fn(),
}));
jest.mock("../../src/bots/trade_builder", () => ({
  submitTradeOffer: jest.fn(),
}));
const { generateTradeProposal } = require("../../src/bots/trade_proposal");
const { createSessionFromStoredState } = require("../../src/bots/auth");
const { readRosters } = require("../../src/bots/espn_api");
const { fetchRosterDeficits } = require("../../src/bots/trade_bot");
const { completeWithFallback } = require("../../src/lib/llm_client");
const { submitTradeOffer } = require("../../src/bots/trade_builder");
const close = jest.fn();
const roster = (id, position) => ({
  slotByPlayerId: new Map([[id, 20]]),
  nameByPlayerId: new Map([[id, `Player ${id}`]]),
  positionByPlayerId: new Map([[id, position]]),
});
const payload = {
  season: 2026,
  week: 4,
  tracking_id: "test",
  approval: { approved_by: "bypass" },
};
let offer;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.ESPN_LEAGUE_ID = "123";
  process.env.ESPN_TEAM_ID = "1";
  offer = {
    incoming_player_ids: ["200"],
    outgoing_player_ids: ["100"],
    message: "This fills your RB gap.",
  };
  fetchRosterDeficits.mockResolvedValue({
    teams: { 1: {}, 2: { RB: { deficit: 1, net_vorp: -5 } } },
  });
  createSessionFromStoredState.mockResolvedValue({
    context: {},
    browser: { close },
  });
  readRosters.mockResolvedValue(
    new Map([
      ["1", roster("100", 2)],
      ["2", roster("200", 3)],
    ]),
  );
  completeWithFallback.mockImplementation(async () => ({
    text: JSON.stringify({ offer }),
  }));
  submitTradeOffer.mockResolvedValue({
    status: "awaiting_approval",
    messageAttached: false,
  });
});
afterAll(() => {
  delete process.env.ESPN_LEAGUE_ID;
  delete process.env.ESPN_TEAM_ID;
});
test("grounds ESPN ids and stages the exact pitch without forwarding approval", async () => {
  const result = await generateTradeProposal(payload);
  expect(result.submission.status).toBe("awaiting_approval");
  expect(submitTradeOffer).toHaveBeenCalledWith(
    {
      leagueId: "123",
      seasonId: "2026",
      fromTeamId: "1",
      toTeamId: "2",
      incomingPlayerIds: ["200"],
      outgoingPlayerIds: ["100"],
      message: offer.message,
    },
    { source: "proposal", trackingId: "test", session: expect.any(Object) },
  );
  expect(completeWithFallback.mock.calls[0][1].systemPrompt).toContain(
    '"position_id":2',
  );
  expect(close).toHaveBeenCalledTimes(1);
});
test.each([
  { incoming_player_ids: ["999"] },
  { incoming_player_ids: ["100"] },
  { outgoing_player_ids: ["100", "100"] },
  { outgoing_player_ids: [100] },
  { message: "" },
  { message: "x".repeat(1001) },
])("rejects invalid generated offers %j before staging", async (change) => {
  Object.assign(offer, change);
  await expect(generateTradeProposal(payload)).rejects.toMatchObject({
    retryDelayMs: 5000,
  });
  expect(submitTradeOffer).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
test("rejects an offer that doesn't fill the identified position", async () => {
  readRosters.mockResolvedValue(
    new Map([
      ["1", roster("100", 1)],
      ["2", roster("200", 3)],
    ]),
  );
  await expect(generateTradeProposal(payload)).rejects.toThrow(
    "target weakness",
  );
});
test("no deficit avoids browser and LLM work", async () => {
  fetchRosterDeficits.mockResolvedValue({ teams: {} });
  await expect(generateTradeProposal(payload)).resolves.toEqual({
    status: "no_target",
  });
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
  expect(completeWithFallback).not.toHaveBeenCalled();
});
test("skips teams the scan excludes, such as one with an unanswered offer to us", async () => {
  expect(await generateTradeProposal({ ...payload, exclude_team_ids: ["2"] })).toEqual({
    status: "no_target",
  });
  expect(createSessionFromStoredState).not.toHaveBeenCalled();
});
test("rejects a malformed exclusion list", async () => {
  await expect(generateTradeProposal({ ...payload, exclude_team_ids: "2" })).rejects.toMatchObject({
    permanent: true,
  });
});
test("model can decline an offer", async () => {
  offer = null;
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    status: "no_offer",
  });
  expect(submitTradeOffer).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
test("malformed JSON is delayed and closes the browser", async () => {
  completeWithFallback.mockResolvedValue({ text: "bad" });
  await expect(generateTradeProposal(payload)).rejects.toMatchObject({
    retryDelayMs: 5000,
  });
  expect(close).toHaveBeenCalled();
});
test("staging failure returns the computed offer without regenerating", async () => {
  submitTradeOffer.mockRejectedValue(new Error("selector missing"));
  await expect(generateTradeProposal(payload)).resolves.toMatchObject({
    offer: { message: offer.message },
    submission: { status: "fill_failed" },
  });
  expect(completeWithFallback).toHaveBeenCalledTimes(1);
});
test.each([null, [], {}, { season: 2026, week: 0 }])(
  "invalid payload fails permanently before I/O: %j",
  async (value) => {
    await expect(generateTradeProposal(value)).rejects.toMatchObject({
      permanent: true,
    });
    expect(fetchRosterDeficits).not.toHaveBeenCalled();
  },
);
