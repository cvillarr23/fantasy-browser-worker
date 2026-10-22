jest.mock("../../src/telemetry/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { fetchOpenOutgoingOffers, pendingOfferConflict } = require("../../src/lib/pending_offers");

const offer = (status, to, incoming, outgoing, from = "1") => ({
  status, from_team_id: from, to_team_id: to, incoming_player_ids: incoming, outgoing_player_ids: outgoing,
});

test("the same players in any order to the same team is already staged", () => {
  const open = [offer("awaiting_approval", "3", ["1", "2"], ["9"])];
  expect(pendingOfferConflict(open, { toTeamId: "3", incomingPlayerIds: ["2", "1"], outgoingPlayerIds: ["9"] })).toBe("already_staged");
  expect(pendingOfferConflict(open, { toTeamId: "4", incomingPlayerIds: ["1", "2"], outgoingPlayerIds: ["9"] })).toBeNull();
  expect(pendingOfferConflict(open, { toTeamId: "3", incomingPlayerIds: ["1"], outgoingPlayerIds: ["9"] })).toBeNull();
});

test("only approved or sent offers commit their outgoing players", () => {
  const pkg = { toTeamId: "5", incomingPlayerIds: ["7"], outgoingPlayerIds: ["9"] };
  expect(pendingOfferConflict([offer("awaiting_approval", "3", ["1"], ["9"])], pkg)).toBeNull();
  for (const status of ["approval_pending", "approved", "submitting", "submitted"])
    expect(pendingOfferConflict([offer(status, "3", ["1"], ["9"])], pkg)).toBe("player_committed");
});

describe("fetchOpenOutgoingOffers", () => {
  afterEach(() => { delete global.fetch; });

  test("reads every status, keeps only our offers and pages through full pages", async () => {
    const full = Array.from({ length: 200 }, () => offer("awaiting_approval", "3", ["1"], ["2"], "8"));
    global.fetch = jest.fn(async (url) => {
      const query = new URL(url).searchParams;
      let offers = [];
      if (query.get("status") === "awaiting_approval")
        offers = query.get("offset") === "0" ? full : [offer("awaiting_approval", "3", ["4"], ["5"])];
      return { ok: true, json: async () => ({ offers }) };
    });
    const result = await fetchOpenOutgoingOffers({ leagueId: "123", season: 2026, fromTeamId: "1" });
    expect(result).toEqual([offer("awaiting_approval", "3", ["4"], ["5"])]);
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  test("returns nothing when core cannot answer", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect(await fetchOpenOutgoingOffers({ leagueId: "123", season: 2026, fromTeamId: "1" })).toEqual([]);
  });
});
