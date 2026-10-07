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

    // League RB mean is -6, so the rival sits 4 above it: 1 + (-6 - -2) = -3.
    expect(result).toEqual([
      { team_id: "rival", position: "RB", deficit: 1, severity: -3 },
    ]);
  });

  it("targets below-average positions on full rosters", () => {
    // Mid-season every roster fills its starting slots, so no position has a deficit and
    // weakness only shows up as net_vorp below the league average.
    const deficits = {
      teams: {
        own: { RB: { deficit: 0, net_vorp: -8 }, QB: { deficit: 0, net_vorp: -6 } },
        a: { RB: { deficit: 0, net_vorp: -55 }, QB: { deficit: 0, net_vorp: -4 } },
        b: { RB: { deficit: 0, net_vorp: -20 }, QB: { deficit: 0, net_vorp: -44 } },
        c: { RB: { deficit: 0, net_vorp: 3 }, QB: { deficit: 0, net_vorp: -6 } },
      },
    };

    const result = findTradeTargets(deficits, "own");

    // RB mean -20 and QB mean -15: only a:RB and b:QB are below average.
    expect(result).toEqual([
      { team_id: "a", position: "RB", deficit: 0, severity: 35 },
      { team_id: "b", position: "QB", deficit: 0, severity: 29 },
    ]);
  });

  it("excludes positions at or above the league average without a deficit", () => {
    const deficits = {
      teams: {
        rival: {
          RB: { rostered: 3, starters_required: 2, deficit: -1, net_vorp: 4 },
          WR: { rostered: 2, starters_required: 2, deficit: 0, net_vorp: 0 },
        },
        other: {
          RB: { deficit: 0, net_vorp: 4 },
          WR: { deficit: 0, net_vorp: 0 },
        },
      },
    };

    expect(findTradeTargets(deficits, "own")).toEqual([]);
  });

  it("keeps a position with a deficit even when its net_vorp is above average", () => {
    const deficits = {
      teams: {
        rival: { TE: { rostered: 0, starters_required: 1, deficit: 1, net_vorp: 2 } },
        own: { TE: { deficit: 0, net_vorp: -2 } },
      },
    };

    expect(findTradeTargets(deficits, "own")).toEqual([
      { team_id: "rival", position: "TE", deficit: 1, severity: -1 },
    ]);
  });

  it("sorts by severity (deficit plus distance below the league average) descending", () => {
    const deficits = {
      teams: {
        a: { RB: { deficit: 1, net_vorp: -1 } },
        b: { RB: { deficit: 2, net_vorp: -6 } },
        c: { RB: { deficit: 0, net_vorp: -11 } },
        d: { RB: { deficit: 0, net_vorp: 2 } },
      },
    };

    const result = findTradeTargets(deficits, "own");

    // RB mean -4: c 7, b 4, a -2; d is above average with no deficit.
    expect(result.map((entry) => `${entry.team_id}:${entry.severity}`)).toEqual([
      "c:7",
      "b:4",
      "a:-2",
    ]);
  });

  it("leaves positions with a missing net_vorp out of the average", () => {
    const deficits = {
      teams: {
        a: { WR: { deficit: 0, net_vorp: -10 } },
        b: { WR: { deficit: 0, net_vorp: null } },
        c: { WR: { deficit: 0, net_vorp: 0 } },
      },
    };

    expect(findTradeTargets(deficits, "own")).toEqual([
      { team_id: "a", position: "WR", deficit: 0, severity: 5 },
    ]);
  });

  it("returns an empty array when there are no other teams", () => {
    const deficits = { teams: { own: { RB: { deficit: 2, net_vorp: -5 } } } };

    expect(findTradeTargets(deficits, "own")).toEqual([]);
  });

  it("returns an empty array for a response with no teams", () => {
    expect(findTradeTargets({ teams: {} }, "own")).toEqual([]);
  });
});
