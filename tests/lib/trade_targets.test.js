const { findTradeTargets } = require("../../src/lib/trade_targets");

describe("findTradeTargets", () => {
  it("excludes the caller's own team", () => {
    const deficits = {
      teams: {
        own: {
          RB: { rostered: 2, starters_required: 2, deficit: 3, net_vorp: -10 },
        },
        rival: {
          RB: { rostered: 2, starters_required: 2, deficit: 1, net_vorp: -2 },
        },
      },
    };

    const result = findTradeTargets(deficits, "own");

    expect(result).toEqual([
      { team_id: "rival", position: "RB", deficit: 1, severity: 3 },
    ]);
  });

  it("excludes positions with no deficit", () => {
    const deficits = {
      teams: {
        rival: {
          RB: { rostered: 3, starters_required: 2, deficit: -1, net_vorp: 4 },
          WR: { rostered: 2, starters_required: 2, deficit: 0, net_vorp: 0 },
          TE: { rostered: 0, starters_required: 1, deficit: 1, net_vorp: -3 },
        },
      },
    };

    const result = findTradeTargets(deficits, "own");

    expect(result).toEqual([
      { team_id: "rival", position: "TE", deficit: 1, severity: 4 },
    ]);
  });

  it("sorts by combined severity (deficit minus net_vorp) descending", () => {
    const deficits = {
      teams: {
        a: {
          RB: { rostered: 1, starters_required: 2, deficit: 1, net_vorp: -1 },
        },
        b: {
          WR: { rostered: 0, starters_required: 2, deficit: 2, net_vorp: -6 },
        },
        c: {
          TE: { rostered: 1, starters_required: 2, deficit: 1, net_vorp: 1 },
        },
      },
    };

    const result = findTradeTargets(deficits, "own");

    expect(result.map((entry) => `${entry.team_id}:${entry.position}`)).toEqual(
      ["b:WR", "a:RB", "c:TE"],
    );
  });

  it("covers every deficient position across multiple teams", () => {
    const deficits = {
      teams: {
        a: {
          RB: { rostered: 1, starters_required: 2, deficit: 1, net_vorp: -2 },
          WR: { rostered: 2, starters_required: 2, deficit: 0, net_vorp: 0 },
        },
        b: {
          TE: { rostered: 0, starters_required: 1, deficit: 1, net_vorp: -1 },
        },
      },
    };

    const result = findTradeTargets(deficits, "own");

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { team_id: "a", position: "RB", deficit: 1, severity: 3 },
        { team_id: "b", position: "TE", deficit: 1, severity: 2 },
      ]),
    );
  });

  it("returns an empty array when there are no other teams' deficits", () => {
    const deficits = { teams: { own: { RB: { deficit: 2, net_vorp: -5 } } } };

    expect(findTradeTargets(deficits, "own")).toEqual([]);
  });

  it("returns an empty array for a response with no teams", () => {
    expect(findTradeTargets({ teams: {} }, "own")).toEqual([]);
  });
});
