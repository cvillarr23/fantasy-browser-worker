const { dedupeScanRecords } = require("../../src/bots/draft_dom_observer");

/**
 * The in-page scan itself (scanInPage) executes in a browser and needs a real DOM, so it isn't
 * exercised here — there's no jsdom environment in this project and adding one for a single
 * function isn't worth the dependency. Its within-scan collapsing logic IS pure and is the part
 * with real correctness risk, so it's tested directly.
 */
describe("dedupeScanRecords", () => {
  it("collapses a player rendered in several places on the board", () => {
    // The same pick legitimately appears in the board grid, the recent-picks ticker and a roster
    // panel at once. Without collapsing, cross-scan duplicate counts become meaningless.
    const records = dedupeScanRecords([
      { player_id: 1, team_id: 8, round: 1, round_pick_number: 4 },
      { player_id: 1, team_id: 8, round: 1, round_pick_number: 4 },
    ]);

    expect(records).toHaveLength(1);
  });

  it("keeps the most complete copy when duplicates carry different detail", () => {
    const records = dedupeScanRecords([
      { player_id: 1, team_id: null, round: null, round_pick_number: null },
      { player_id: 1, team_id: 8, round: 2, round_pick_number: 5 },
    ]);

    expect(records).toEqual([
      { player_id: 1, team_id: 8, round: 2, round_pick_number: 5 },
    ]);
  });

  it("does not merge distinct players", () => {
    const records = dedupeScanRecords([
      { player_id: 1, team_id: 8 },
      { player_id: 2, team_id: 3 },
    ]);

    expect(records).toHaveLength(2);
  });

  it("handles an empty scan", () => {
    expect(dedupeScanRecords([])).toEqual([]);
  });
});
