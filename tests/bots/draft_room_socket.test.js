const { parseSelectedFrame } = require("../../src/bots/draft_room_socket");

describe("parseSelectedFrame", () => {
  it("reads the third token as a lineup slot id, not a round", () => {
    // ESPN's frame is SELECTED <teamId> <playerId> <lineupSlotId>. Verified against a
    // 160-pick practice draft: slot 1 was ten quarterbacks, slot 6 ten tight ends.
    expect(parseSelectedFrame("SELECTED 8 4360438 6")).toEqual({
      team_id: 8,
      player_id: 4360438,
      lineup_slot_id: 6,
      round: null,
    });
  });

  it("reports round as an explicit null so consumers never read undefined", () => {
    // draft_clicker and scripts/draft-watch both read `.round` off this object; an absent
    // key would silently become undefined rather than a deterministic "unknown".
    const parsed = parseSelectedFrame("SELECTED 8 4360438 1 {SWID}");
    expect(parsed).toHaveProperty("round", null);
  });

  it("ignores frames that are not SELECTED", () => {
    expect(parseSelectedFrame("SELECTING 8 60000")).toBeNull();
  });

  it("returns null for a truncated frame rather than inventing a slot", () => {
    expect(parseSelectedFrame("SELECTED 8 4360438")).toBeNull();
  });
});
