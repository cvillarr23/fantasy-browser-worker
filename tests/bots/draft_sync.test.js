const { fetchDraftDetail } = require("../../src/bots/draft_sync");

describe("fetchDraftDetail", () => {
  it("throws a clear error when ESPN reports a deleted draft league", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: async () => ({ type: "LEAGUE_NOT_FOUND_DELETED" }),
        }),
      },
    };

    await expect(
      fetchDraftDetail(context, { leagueId: "294773976", seasonId: "2026" }),
    ).rejects.toThrow(/LEAGUE_NOT_FOUND_DELETED/);
    await expect(
      fetchDraftDetail(context, { leagueId: "294773976", seasonId: "2026" }),
    ).rejects.toThrow(/Set DRAFT_ROOM_URL/);
  });

  it("keeps generic HTTP failures unchanged for non-deleted-league errors", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 503,
          json: async () => ({ type: "SOME_OTHER_ERROR" }),
        }),
      },
    };

    await expect(
      fetchDraftDetail(context, { leagueId: "1", seasonId: "2026" }),
    ).rejects.toThrow("mDraftDetail fetch failed: HTTP 503");
  });
});
