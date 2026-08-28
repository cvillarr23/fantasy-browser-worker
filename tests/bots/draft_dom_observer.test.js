const {
  dedupeScanRecords,
  detectLoginGate,
  attachDraftDomObserver,
} = require("../../src/bots/draft_dom_observer");
const { logger } = require("../../src/telemetry/logger");

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

describe("detectLoginGate", () => {
  it("reports true when no player-id nodes exist AND the page text mentions the login-required gate", () => {
    expect(
      detectLoginGate(0, "Log in Required\nYou must be signed in to view this draft room."),
    ).toBe(true);
  });

  it("is case- and whitespace-insensitive for the gate phrase", () => {
    expect(detectLoginGate(0, "LOG   IN required, please sign in")).toBe(true);
  });

  it("reports false when player-id nodes exist, even if the gate phrase somehow also appears", () => {
    // A real board with content present is never actually gated — the node count alone already
    // disproves it, regardless of what stray text is also on the page.
    expect(detectLoginGate(3, "Log in Required")).toBe(false);
  });

  it("reports false when there are no player-id nodes but the page text doesn't mention the gate", () => {
    // A genuinely stale selector (real board content the strategies just don't match) must not
    // be misclassified as the login gate.
    expect(detectLoginGate(0, "Draft Room — Round 1")).toBe(false);
  });

  it("handles missing/empty body text without throwing", () => {
    expect(detectLoginGate(0, "")).toBe(false);
    expect(detectLoginGate(0, undefined)).toBe(false);
  });
});

describe("attachDraftDomObserver", () => {
  function buildPage(evaluateResult) {
    return {
      isClosed: () => false,
      evaluate: jest.fn().mockResolvedValue(evaluateResult),
      exposeBinding: jest.fn().mockResolvedValue(undefined),
    };
  }

  it("surfaces page_gated in both the selector-miss log payload and getHealth()", async () => {
    const page = buildPage({
      records: [],
      matched_strategy: null,
      diagnostics: [{ name: "generic-player-team-pair", matched: 0 }],
      sample_html: "<div>Log in Required</div>",
      player_id_nodes: 0,
      page_gated: true,
      url: "https://fantasy.espn.com/football/draft?leagueId=1",
    });
    const warnSpy = jest.spyOn(logger, "warn");

    const handle = await attachDraftDomObserver(page, {
      pollIntervalMs: 999999,
    });

    expect(
      warnSpy.mock.calls.some(([, fields]) => fields?.page_gated === true),
    ).toBe(true);
    expect(handle.getHealth().login_gate_detected).toBe(true);

    warnSpy.mockRestore();
    await handle.stop();
  });

  it("clears login_gate_detected once a later scan matches a strategy again", async () => {
    const gatedResult = {
      records: [],
      matched_strategy: null,
      diagnostics: [],
      sample_html: "<div>Log in Required</div>",
      player_id_nodes: 0,
      page_gated: true,
      url: "https://fantasy.espn.com/football/draft?leagueId=1",
    };
    const recoveredResult = {
      records: [{ player_id: 1, team_id: 2, round: 1, round_pick_number: 1 }],
      matched_strategy: "generic-player-team-pair",
      diagnostics: [],
      sample_html: null,
      player_id_nodes: 1,
      page_gated: false,
      url: "https://fantasy.espn.com/football/draft?leagueId=1",
    };
    const page = buildPage(gatedResult);

    const handle = await attachDraftDomObserver(page, {
      pollIntervalMs: 999999,
    });
    expect(handle.getHealth().login_gate_detected).toBe(true);

    page.evaluate.mockResolvedValue(recoveredResult);
    await handle.scanNow("poll");

    expect(handle.getHealth().login_gate_detected).toBe(false);
    await handle.stop();
  });

  // #108 follow-up: full-fidelity DOM/WS/REST capture on every practice draft, gated at
  // LOG_LEVEL=debug (already set unconditionally on every practice-draft Job) - raw evidence
  // for anything the pick-focused PICK_STRATEGIES scanner isn't looking for.
  it("captures the full page on the very first scan at debug level", async () => {
    const page = buildPage({
      records: [],
      matched_strategy: null,
      diagnostics: [],
      sample_html: null,
      player_id_nodes: 0,
      page_gated: false,
      url: "https://fantasy.espn.com/football/draft?leagueId=1",
    });
    page.content = jest.fn().mockResolvedValue("<html>full page</html>");
    page.url = jest.fn().mockReturnValue("https://fantasy.espn.com/football/draft?leagueId=1");
    const debugSpy = jest.spyOn(logger, "debug");

    const handle = await attachDraftDomObserver(page, { pollIntervalMs: 999999 });

    const captureCall = debugSpy.mock.calls.find(
      ([, fields]) => fields?.component === "draft_dom_capture",
    );
    expect(captureCall).toBeDefined();
    expect(captureCall[1].html).toBe("<html>full page</html>");
    expect(captureCall[1].scan_number).toBe(1);

    debugSpy.mockRestore();
    await handle.stop();
  });

  it("does not break the scan when the DOM capture itself fails", async () => {
    const page = buildPage({
      records: [{ player_id: 1, team_id: 2, round: 1, round_pick_number: 1 }],
      matched_strategy: "generic-player-team-pair",
      diagnostics: [],
      sample_html: null,
      player_id_nodes: 1,
      page_gated: false,
      url: "https://fantasy.espn.com/football/draft?leagueId=1",
    });
    page.content = jest.fn().mockRejectedValue(new Error("page navigated away"));
    page.url = jest.fn().mockReturnValue("https://fantasy.espn.com/football/draft?leagueId=1");

    const handle = await attachDraftDomObserver(page, { pollIntervalMs: 999999 });

    expect(handle.getHealth().scans).toBe(1);
    expect(handle.getHealth().last_record_count).toBe(1);
    await handle.stop();
  });
});
