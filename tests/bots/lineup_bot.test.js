const { resolveSlotId, planSwaps } = require("../../src/bots/lineup_bot");

const noopLog = () => {};

function roster(slotByPlayerId, slotCounts) {
  return {
    slotByPlayerId: new Map(Object.entries(slotByPlayerId)),
    slotCounts,
  };
}

// Matches src/selectors/lineup_slots.json's slot_counts.
const DEFAULT_SLOT_COUNTS = {
  0: 1, // QB
  2: 2, // RB
  4: 2, // WR
  6: 1, // TE
  16: 1, // D/ST
  17: 1, // K
  20: 7, // Bench
  21: 1, // IR
  23: 1, // FLEX
};

describe("resolveSlotId", () => {
  it("strips a trailing ordinal suffix", () => {
    expect(resolveSlotId("RB1")).toBe(2);
    expect(resolveSlotId("RB2")).toBe(2);
    expect(resolveSlotId("WR")).toBe(4);
  });

  it("normalizes case and whitespace", () => {
    expect(resolveSlotId(" flex ")).toBe(23);
    expect(resolveSlotId("d/st")).toBe(16);
  });

  it("throws on an unrecognized slot", () => {
    expect(() => resolveSlotId("QUARTERBACK")).toThrow(/Unrecognized lineup slot/);
  });

  it("throws when slot is missing", () => {
    expect(() => resolveSlotId(undefined)).toThrow(/missing its target/);
    expect(() => resolveSlotId(null)).toThrow(/missing its target/);
  });
});

describe("planSwaps", () => {
  it("rejects a non-array swaps input", () => {
    expect(() => planSwaps("nope", roster({}, DEFAULT_SLOT_COUNTS), noopLog)).toThrow(
      /optimized_swaps must be an array/,
    );
  });

  it("produces two LINEUP items for a single swap", () => {
    const r = roster(
      { "100": 4 /* WR bench-worthy, currently in WR */, "200": 20 /* bench */ },
      DEFAULT_SLOT_COUNTS,
    );
    const { items, intended, skipped } = planSwaps(
      [{ drop_player_id: "100", add_player_id: "200", slot: "WR1" }],
      r,
      noopLog,
    );

    expect(skipped).toBe(0);
    expect(items).toEqual([
      { playerId: 100, type: "LINEUP", fromLineupSlotId: 4, toLineupSlotId: 20 },
      { playerId: 200, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 4 },
    ]);
    expect(intended.get("200")).toBe(4);
    expect(intended.get("100")).toBe(20);
  });

  it("skips a swap that's already fully satisfied", () => {
    const r = roster({ "100": 20, "200": 4 }, DEFAULT_SLOT_COUNTS);
    const { items, skipped } = planSwaps(
      [{ drop_player_id: "100", add_player_id: "200", slot: "WR1" }],
      r,
      noopLog,
    );

    expect(items).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("rejects the same player appearing in two swaps", () => {
    const r = roster({ "100": 4, "200": 20, "300": 6 }, DEFAULT_SLOT_COUNTS);
    expect(() =>
      planSwaps(
        [
          { drop_player_id: "100", add_player_id: "200", slot: "WR1" },
          { drop_player_id: "300", add_player_id: "100", slot: "TE" },
        ],
        r,
        noopLog,
      ),
    ).toThrow(/already appears in swap #1/);
  });

  it("rejects drop_player_id === add_player_id", () => {
    const r = roster({ "100": 4 }, DEFAULT_SLOT_COUNTS);
    expect(() =>
      planSwaps(
        [{ drop_player_id: "100", add_player_id: "100", slot: "WR1" }],
        r,
        noopLog,
      ),
    ).toThrow(/cannot be benched and promoted in the same swap/);
  });

  it("rejects a drop player not on the roster", () => {
    const r = roster({ "200": 20 }, DEFAULT_SLOT_COUNTS);
    expect(() =>
      planSwaps(
        [{ drop_player_id: "999", add_player_id: "200", slot: "WR1" }],
        r,
        noopLog,
      ),
    ).toThrow(/999 \(drop\) is not on team's roster/);
  });

  it("rejects an add player not on the roster", () => {
    const r = roster({ "100": 4 }, DEFAULT_SLOT_COUNTS);
    expect(() =>
      planSwaps(
        [{ drop_player_id: "100", add_player_id: "999", slot: "WR1" }],
        r,
        noopLog,
      ),
    ).toThrow(/999 \(add\) is not on team's roster/);
  });

  it("rejects a slot the league does not field", () => {
    const r = roster({ "100": 20, "200": 4 }, { ...DEFAULT_SLOT_COUNTS, 21: 0 });
    expect(() =>
      planSwaps(
        [{ drop_player_id: "200", add_player_id: "100", slot: "IR" }],
        r,
        noopLog,
      ),
    ).toThrow(/this league does not field/);
  });

  // ESPN gives a team defense a negative player id (#116): Team 8's Eagles D/ST is -16021.
  it("benches a D/ST on the drop side, keeping the negative id's sign", () => {
    const r = roster({ "-16021": 16, "-16030": 20 }, DEFAULT_SLOT_COUNTS);
    const { items, intended, skipped } = planSwaps(
      [{ drop_player_id: "-16021", add_player_id: "-16030", slot: "D/ST" }],
      r,
      noopLog,
    );

    expect(skipped).toBe(0);
    expect(items).toEqual([
      { playerId: -16021, type: "LINEUP", fromLineupSlotId: 16, toLineupSlotId: 20 },
      { playerId: -16030, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 16 },
    ]);
    expect(intended.get("-16021")).toBe(20);
    expect(intended.get("-16030")).toBe(16);
  });

  it("promotes a benched D/ST on the add side", () => {
    const r = roster({ "-16021": 20, "-16030": 16 }, DEFAULT_SLOT_COUNTS);
    const { items } = planSwaps(
      [{ drop_player_id: "-16030", add_player_id: "-16021", slot: "D/ST" }],
      r,
      noopLog,
    );

    expect(items).toEqual([
      { playerId: -16030, type: "LINEUP", fromLineupSlotId: 16, toLineupSlotId: 20 },
      { playerId: -16021, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 16 },
    ]);
  });

  it("still rejects a D/ST that isn't on the roster", () => {
    const r = roster({ "-16030": 16 }, DEFAULT_SLOT_COUNTS);
    expect(() =>
      planSwaps(
        [{ drop_player_id: "-16030", add_player_id: "-16021", slot: "D/ST" }],
        r,
        noopLog,
      ),
    ).toThrow(/-16021 \(add\) is not on team's roster/);
  });

  it.each(["", "-", "-0", "-00", "-012", "--1", "+5", "1.5", "-1.5", "abc", " - 1", null])(
    "rejects junk player id %p",
    (junk) => {
      const r = roster({ "100": 4, "200": 20 }, DEFAULT_SLOT_COUNTS);
      for (const swap of [
        { drop_player_id: junk, add_player_id: "200", slot: "WR1" },
        { drop_player_id: "100", add_player_id: junk, slot: "WR1" },
      ]) {
        expect(() => planSwaps([swap], r, noopLog)).toThrow(
          /is not a valid numeric ESPN player id/,
        );
      }
    },
  );

  it("rejects a plan that overfills a slot's capacity", () => {
    // FLEX only has 1 spot; two independent swaps (no shared players) both promote into FLEX.
    const r = roster(
      { "100": 20, "200": 20, "300": 23, "400": 20 },
      DEFAULT_SLOT_COUNTS,
    );
    expect(() =>
      planSwaps(
        [
          { drop_player_id: "300", add_player_id: "100", slot: "FLEX" },
          { drop_player_id: "400", add_player_id: "200", slot: "FLEX" },
        ],
        r,
        noopLog,
      ),
    ).toThrow(/Planned lineup overfills/);
  });
});
