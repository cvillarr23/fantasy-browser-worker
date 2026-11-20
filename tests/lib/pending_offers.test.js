jest.mock("../../src/telemetry/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { fetchOfferByKey, fetchOpenOutgoingOffers, pendingOfferConflict } = require("../../src/lib/pending_offers");

const offer = (status, to, incoming, outgoing, from = "1") => ({
  status, from_team_id: from, to_team_id: to, incoming_player_ids: incoming, outgoing_player_ids: outgoing,
});

test("the same players in any order to the same team is already staged; anything else sending them is committed", () => {
  const open = [offer("approved", "3", ["1", "2"], ["9"])];
  expect(pendingOfferConflict(open, { toTeamId: "3", incomingPlayerIds: ["2", "1"], outgoingPlayerIds: ["9"] })).toBe("already_staged");
  expect(pendingOfferConflict(open, { toTeamId: "4", incomingPlayerIds: ["1", "2"], outgoingPlayerIds: ["9"] })).toBe("player_committed");
  expect(pendingOfferConflict(open, { toTeamId: "3", incomingPlayerIds: ["1"], outgoingPlayerIds: ["9"] })).toBe("player_committed");
});

test("approved or sent offers commit their outgoing players", () => {
  const pkg = { toTeamId: "5", incomingPlayerIds: ["7"], outgoingPlayerIds: ["9"] };
  for (const status of ["approval_pending", "approved", "submitting", "submitted"])
    expect(pendingOfferConflict([offer(status, "3", ["1"], ["9"])], pkg)).toBe("player_committed");
});

describe("fetchOpenOutgoingOffers", () => {
  afterEach(() => { delete global.fetch; });

  test("reads every approved status, keeps only our offers and pages through full pages", async () => {
    const full = Array.from({ length: 200 }, () => offer("approved", "3", ["1"], ["2"], "8"));
    global.fetch = jest.fn(async (url) => {
      const query = new URL(url).searchParams;
      let offers = [];
      if (query.get("status") === "approved")
        offers = query.get("offset") === "0" ? full : [offer("approved", "3", ["4"], ["5"])];
      return { ok: true, json: async () => ({ offers }) };
    });
    const result = await fetchOpenOutgoingOffers({ leagueId: "123", season: 2026, fromTeamId: "1" });
    expect(result).toEqual([offer("approved", "3", ["4"], ["5"])]);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  test("never reads offers that are only awaiting approval, since each scan replaces them", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ offers: [] }) }));
    await fetchOpenOutgoingOffers({ leagueId: "123", season: 2026, fromTeamId: "1" });
    const statuses = global.fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("status"));
    expect(statuses).toEqual(["approval_pending", "approved", "submitting", "submitted"]);
  });

  test("returns nothing when core cannot answer", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    expect(await fetchOpenOutgoingOffers({ leagueId: "123", season: 2026, fromTeamId: "1" })).toEqual([]);
  });
});

describe("fetchOfferByKey", () => {
  const KEY = "a".repeat(64);
  const keyed = (status, key = KEY) => ({ ...offer(status, "3", ["1"], ["2"], "8"), offer_key: key });
  afterEach(() => { delete global.fetch; });

  function serve(byStatus) {
    global.fetch = jest.fn(async (url) => {
      const query = new URL(url).searchParams;
      const all = byStatus[query.get("status")] || [];
      const offset = Number(query.get("offset"));
      return { ok: true, json: async () => ({ offers: all.slice(offset, offset + Number(query.get("limit"))) }) };
    });
  }

  test("finds an approved key, asking core to filter on it", async () => {
    serve({ approved: [keyed("approved")] });
    expect(await fetchOfferByKey(KEY)).toEqual(keyed("approved"));
    const queries = global.fetch.mock.calls.map(([url]) => new URL(url).searchParams);
    expect(queries.map((query) => query.get("status"))).toEqual(["approval_pending", "approved"]);
    expect(queries.every((query) => query.get("offer_key") === KEY)).toBe(true);
  });

  test("matches the key itself when core ignores the filter, paging past other offers", async () => {
    const others = Array.from({ length: 200 }, (_, index) => keyed("approved", String(index).padStart(64, "0")));
    serve({ approved: [...others, keyed("approved")] });
    expect(await fetchOfferByKey(KEY)).toEqual(keyed("approved"));
  });

  test("reports the key's status when it isn't approved", async () => {
    serve({ submitted: [keyed("submitted")] });
    expect((await fetchOfferByKey(KEY)).status).toBe("submitted");
  });

  test("returns null for a key core doesn't know", async () => {
    serve({ approved: [keyed("approved", "b".repeat(64))] });
    expect(await fetchOfferByKey(KEY)).toBeNull();
  });

  test("throws when core can't answer, so nothing is sent on a guess", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchOfferByKey(KEY)).rejects.toThrow("offers HTTP 503");
  });
});
