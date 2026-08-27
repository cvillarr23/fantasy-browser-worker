jest.mock("../../src/bots/auth", () => ({
  createAuthenticatedSession: jest.fn(),
}));

jest.mock("../../src/bots/mock_draft", () => ({
  startFreshPracticeDraft: jest.fn(),
  parseDraftRoomUrl: jest.fn(),
}));

jest.mock("../../src/bots/session_health", () => ({
  assertCookieSessionValid: jest.fn(),
  assertRenderedSessionValid: jest.fn(),
}));

const { createAuthenticatedSession } = require("../../src/bots/auth");
const { parseDraftRoomUrl } = require("../../src/bots/mock_draft");
const { assertCookieSessionValid } = require("../../src/bots/session_health");
const { logger } = require("../../src/telemetry/logger");
const { PermanentError } = require("../../src/errors");
const {
  fetchDraftDetail,
  fetchDraftTotals,
  connectAndStream,
  createDraftState,
  pollDraftCommands,
  parseSelectedFrame,
  parseSelectingFrame,
  parseAutodraftFrame,
  decideReconnectAction,
  attachDraftListeners,
  isDraftRoomSocketUrl,
  reconcileFromRest,
} = require("../../src/bots/draft_sync");

describe("parseSelectingFrame", () => {
  it("reads the team on the clock and the remaining clock in ms", () => {
    expect(parseSelectingFrame("SELECTING 8 45000")).toEqual({
      team_id: 8,
      clock_ms: 45000,
    });
  });

  it("degrades to a null clock rather than dropping the frame when the clock token is malformed", () => {
    expect(parseSelectingFrame("SELECTING 8 abc")).toEqual({
      team_id: 8,
      clock_ms: null,
    });
  });

  it("returns null for a non-SELECTING frame", () => {
    expect(parseSelectingFrame("CLOCK 90")).toBeNull();
  });

  it("returns null when the team id token is missing or malformed", () => {
    expect(parseSelectingFrame("SELECTING abc 45000")).toBeNull();
  });
});

describe("parseAutodraftFrame", () => {
  it("reads a truthy autodraft toggle", () => {
    expect(parseAutodraftFrame("AUTODRAFT 8 true")).toEqual({
      team_id: 8,
      active: true,
    });
    expect(parseAutodraftFrame("AUTODRAFT 8 1")).toEqual({
      team_id: 8,
      active: true,
    });
  });

  it("reads a falsy autodraft toggle", () => {
    expect(parseAutodraftFrame("AUTODRAFT 8 false")).toEqual({
      team_id: 8,
      active: false,
    });
    expect(parseAutodraftFrame("AUTODRAFT 8 0")).toEqual({
      team_id: 8,
      active: false,
    });
  });

  it("returns null for a non-AUTODRAFT frame", () => {
    expect(parseAutodraftFrame("AUTOSUGGEST 123")).toBeNull();
  });

  it("returns null when the team id token is missing or malformed", () => {
    expect(parseAutodraftFrame("AUTODRAFT abc true")).toBeNull();
  });
});

describe("parseSelectedFrame", () => {
  // ESPN's SELECTED frame is `SELECTED <teamId> <playerId> <lineupSlotId> [<memberId>]`. The
  // third token was long read as a round; joining a full 160-pick practice draft against player
  // positions showed slot 1 was QB x10, 6 was TE x10 and 7 the FLEX. It masquerades as a round
  // convincingly because a 10-team, 16-slot league produces exactly ten of every value either way.
  it("reads the third token as a lineup slot id, not a round", () => {
    expect(parseSelectedFrame("SELECTED 3 4360248 4")).toEqual({
      team_id: 3,
      player_id: 4360248,
      lineup_slot_id: 4,
      member_id: null,
    });
  });

  it("captures the member id when ESPN attributes the pick to a human", () => {
    expect(parseSelectedFrame("SELECTED 3 4360248 4 {OTHER-SWID}")).toEqual({
      team_id: 3,
      player_id: 4360248,
      lineup_slot_id: 4,
      member_id: "{OTHER-SWID}",
    });
  });

  it("ignores frames that are not SELECTED", () => {
    expect(parseSelectedFrame("CLOCK 3 90")).toBeNull();
  });

  it("rejects a truncated SELECTED frame rather than inventing a slot", () => {
    expect(parseSelectedFrame("SELECTED 3 4360248")).toBeNull();
  });
});

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

  it("throws a PermanentError (not a plain Error) for LEAGUE_NOT_FOUND_DELETED", async () => {
    const state = { leagueId: "156611456", seasonId: "2026" };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({ type: "LEAGUE_NOT_FOUND_DELETED" }),
        }),
      },
    };
    await expect(fetchDraftDetail(context, state)).rejects.toThrow(
      PermanentError,
    );
  });

  it("throws a PermanentError for any other non-ok HTTP status from mDraftDetail", async () => {
    const state = { leagueId: "156611456", seasonId: "2026" };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({}),
        }),
      },
    };
    await expect(fetchDraftDetail(context, state)).rejects.toThrow(
      PermanentError,
    );
  });
});

describe("reconcileFromRest permanent-error handling", () => {
  it("stores a PermanentError on state.permanentError instead of only counting it as a failed poll", async () => {
    const state = {
      leagueId: "156611456",
      seasonId: "2026",
      health: { rest: { polls: 0, empty_polls: 0, failed_polls: 0 } },
      permanentError: null,
    };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({}),
        }),
      },
    };
    await reconcileFromRest(context, {}, state);
    expect(state.health.rest.failed_polls).toBe(1);
    expect(state.permanentError).toBeInstanceOf(PermanentError);
  });

  it("does not touch state.permanentError for an ordinary (transient) REST failure", async () => {
    const state = {
      leagueId: "156611456",
      seasonId: "2026",
      health: { rest: { polls: 0, empty_polls: 0, failed_polls: 0 } },
      permanentError: null,
    };
    const context = {
      request: {
        get: jest.fn().mockRejectedValue(new Error("network blip")),
      },
    };
    await reconcileFromRest(context, {}, state);
    expect(state.health.rest.failed_polls).toBe(1);
    expect(state.permanentError).toBeNull();
  });
});

describe("decideReconnectAction", () => {
  // Regression coverage for issue #62's actual fix: previously a clean-but-stalled
  // connectAndStream return was indistinguishable from real progress, so backoff/the reconnect
  // cap never engaged and a finished draft looped forever.
  it("exits clean when the cycle was terminal, regardless of attempt count", () => {
    expect(
      decideReconnectAction({
        terminal: true,
        newPicksThisCycle: 0,
        attempt: 9,
      }),
    ).toEqual({ action: "exit_clean" });
  });

  it("retries immediately with backoff reset when the cycle made real progress", () => {
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 3,
        attempt: 2,
      }),
    ).toEqual({ action: "retry_immediate", nextAttempt: 0 });
  });

  it("backs off exponentially when a cycle produced no new picks and the cap isn't hit", () => {
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 0,
        attempt: 0,
      }),
    ).toEqual({ action: "retry_after_delay", nextAttempt: 1, delayMs: 2000 });
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 0,
        attempt: 3,
      }),
    ).toEqual({ action: "retry_after_delay", nextAttempt: 4, delayMs: 16000 });
    // Capped at RECONNECT_MAX_DELAY_MS rather than continuing to grow unbounded.
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 0,
        attempt: 8,
      }),
    ).toEqual({ action: "retry_after_delay", nextAttempt: 9, delayMs: 30000 });
  });

  it("gives up right at the reconnect cap boundary, not one call past it", () => {
    // MAX_RECONNECT_ATTEMPTS (10) caps at exactly 10 connectAndStream() calls (attempts 0..9),
    // matching the original `while (attempt < MAX_RECONNECT_ATTEMPTS)` loop's semantics. attempt:9
    // means the 10th call already happened — an 11th must never be scheduled. This is the
    // off-by-one a PR review caught (`>` instead of `>=` let an extra Chromium launch through).
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 0,
        attempt: 9,
      }),
    ).toEqual({ action: "exit_failed" });
    expect(
      decideReconnectAction({
        terminal: false,
        newPicksThisCycle: 0,
        attempt: 10,
      }),
    ).toEqual({ action: "exit_failed" });
  });
});

describe("fetchDraftTotals", () => {
  const state = { leagueId: "987", seasonId: "2026" };

  it("computes teams x roster slots from mSettings/mTeam", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          status: () => 200,
          json: async () => ({
            teams: [{ id: 1 }, { id: 2 }],
            settings: { rosterSettings: { lineupSlotCounts: { 0: 1, 2: 1 } } },
          }),
        }),
      },
    };

    await expect(fetchDraftTotals(context, state)).resolves.toEqual({
      teamCount: 2,
      rosterSlotsPerTeam: 2,
      totalExpectedPicks: 4,
    });
  });

  it("resolves null (never throws) on an HTTP failure", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
        }),
      },
    };

    await expect(fetchDraftTotals(context, state)).resolves.toBeNull();
  });

  it("resolves null when the body is missing usable team/roster data — the unverified-for-practice-drafts case", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          status: () => 200,
          json: async () => ({}),
        }),
      },
    };

    await expect(fetchDraftTotals(context, state)).resolves.toBeNull();
  });

  it("excludes the IR slot (21) from the roster-slot sum — the real practice-draft recon finding", async () => {
    // Real capture (league 20050783, 2026-08-25): 10 teams, rosterSettings.lineupSlotCounts
    // summed to 17 (including one IR slot), but the draft only ever produced 160 picks (10 x 16),
    // not the naively-computed 170. IR is filled via free agency/waivers, never during the draft.
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          status: () => 200,
          json: async () => ({
            teams: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })),
            settings: {
              rosterSettings: {
                lineupSlotCounts: {
                  0: 1,
                  2: 2,
                  4: 2,
                  6: 1,
                  16: 1,
                  17: 1,
                  20: 7,
                  21: 1,
                  23: 1,
                },
              },
            },
          }),
        }),
      },
    };

    await expect(fetchDraftTotals(context, state)).resolves.toEqual({
      teamCount: 10,
      rosterSlotsPerTeam: 16,
      totalExpectedPicks: 160,
    });
  });
});

// Diagnostics added for the "connector goes silent forever after a delegated pick" investigation
// (see draft_sync.js's attachDraftListeners/connectAndStream) — these assert the new trace points
// exist and report correct raw values, not that any bug is fixed (root cause isn't confirmed yet).
describe("isDraftRoomSocketUrl", () => {
  it("recognizes the real ESPN draft-room JOIN socket", () => {
    expect(
      isDraftRoomSocketUrl(
        "wss://fantasydraft.espn.com/game-1/league-156611456/JOIN?1=1&2=156611456",
      ),
    ).toBe(true);
  });

  it("rejects the unrelated BAM/Disney identity-SDK socket", () => {
    expect(
      isDraftRoomSocketUrl(
        "wss://espn.connections.edge.bamgrid.com/5d3054/connection?X-Application-Version=0.0.1",
      ),
    ).toBe(false);
  });

  it("rejects an unrecognized socket URL rather than throwing", () => {
    expect(isDraftRoomSocketUrl("wss://example.com/socket")).toBe(false);
    expect(isDraftRoomSocketUrl("")).toBe(false);
  });
});

describe("attachDraftListeners debug instrumentation", () => {
  it("logs a debug line when the handle is created, and debugSnapshot() reflects real openSockets/idle state across open+close", () => {
    const start = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const debugSpy = jest.spyOn(logger, "debug");
      const pageListeners = {};
      const page = {
        url: () => "https://fantasy.espn.com/football/draft?x=1",
        on: jest.fn((event, cb) => {
          pageListeners[event] = cb;
        }),
      };
      const state = createDraftState();

      const handle = attachDraftListeners(page, {}, state);

      expect(
        debugSpy.mock.calls.some(
          ([msg, fields]) =>
            msg.includes("new handle created") &&
            fields.page_url === "https://fantasy.espn.com/football/draft?x=1",
        ),
      ).toBe(true);

      let snap = handle.debugSnapshot();
      expect(snap).toEqual({
        openSockets: 0,
        lastActivityAt: start,
        idleMs: 0,
      });

      const wsListeners = {};
      pageListeners.websocket({
        url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
        on: jest.fn((event, cb) => {
          wsListeners[event] = cb;
        }),
      });
      snap = handle.debugSnapshot();
      expect(snap.openSockets).toBe(1);
      expect(snap.idleMs).toBe(0);

      jest.setSystemTime(start + 5000);
      wsListeners.close();
      snap = handle.debugSnapshot();
      // close() doesn't touch lastActivityAt (only the last frame/open does) — idleMs should
      // reflect the 5s that has actually elapsed since the socket opened, not 0.
      expect(snap.openSockets).toBe(0);
      expect(snap.idleMs).toBe(5000);

      debugSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does NOT count an unrelated (non-draft-room) socket toward openSockets/lastActivityAt/isDead", () => {
    const start = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const pageListeners = {};
      const page = {
        url: () => "https://fantasy.espn.com/football/draft?x=1",
        on: jest.fn((event, cb) => {
          pageListeners[event] = cb;
        }),
      };
      const state = createDraftState();
      const handle = attachDraftListeners(page, {}, state);

      // The real draft-room JOIN socket opens and immediately closes (an eviction) at t=0.
      const draftWsListeners = {};
      pageListeners.websocket({
        url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
        on: jest.fn((event, cb) => {
          draftWsListeners[event] = cb;
        }),
      });
      draftWsListeners.close();
      expect(handle.debugSnapshot().openSockets).toBe(0);

      // 40 seconds later (past WS_DEAD_GRACE_MS=30000), an unrelated BAM identity-SDK socket
      // opens and (if the current code still registered its frame listener) would receive a
      // frame — this must NOT resurrect openSockets or lastActivityAt for the purposes of
      // isDead(), since it carries no draft picks. The fixed code returns early before ever
      // calling ws.on(...) for a non-draft-room socket, so no listener is registered at all;
      // guarded with `?.()` so this test fails cleanly (not with a TypeError) against the
      // pre-fix code, which DOES register a "framereceived" listener here.
      jest.setSystemTime(start + 40000);
      const bamWsListeners = {};
      pageListeners.websocket({
        url: () => "wss://espn.connections.edge.bamgrid.com/5d3054/connection?X-Application-Version=0.0.1",
        on: jest.fn((event, cb) => {
          bamWsListeners[event] = cb;
        }),
      });
      bamWsListeners.framereceived?.({
        payload: Buffer.from("PING PING%201700000000000"),
      });

      expect(handle.debugSnapshot().openSockets).toBe(0);
      expect(handle.isDead()).toBe(true);
      expect(handle.hasOpenSocket()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("connectAndStream", () => {
  const ENV_KEYS = ["DRAFT_ROOM_URL", "ESPN_LEAGUE_ID", "ESPN_TEAM_ID"];
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.DRAFT_ROOM_URL = "https://fantasy.espn.com/football/draft?x=1";
    process.env.ESPN_LEAGUE_ID = "";
    process.env.ESPN_TEAM_ID = "";
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("writes the connected heartbeat at connect-time and refreshes it on reconcile interval", async () => {
    const pageListeners = {};
    const page = {
      on: jest.fn((event, callback) => {
        pageListeners[event] = callback;
      }),
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest
        .fn()
        .mockReturnValue(
          "https://fantasy.espn.com/football/draft?leagueId=987&seasonId=2026&teamId=4",
        ),
      waitForTimeout: jest.fn(async (ms) => {
        await jest.advanceTimersByTimeAsync(ms + 30000);
      }),
    };
    const context = {
      on: jest.fn(),
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          status: () => 200,
          json: async () => ({ draftDetail: { picks: [] } }),
        }),
      },
      addInitScript: jest.fn().mockResolvedValue(undefined),
    };
    const browser = { close: jest.fn().mockResolvedValue(undefined) };
    const redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      // The ingest path seeds the dedup ledger from the durable board before anything else
      // (issue #52); an empty hash is the "fresh draft" case.
      hGetAll: jest.fn().mockResolvedValue({}),
    };
    // Built by the same factory as the real entry point so this test can't silently drift from
    // the state shape the ingest path actually dereferences.
    const state = createDraftState();

    createAuthenticatedSession.mockResolvedValue({
      page,
      context,
      browser,
      headless: true,
      swid: "{TEST-SWID}",
    });
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    await connectAndStream(redisClient, state);

    expect(redisClient.set).toHaveBeenNthCalledWith(
      1,
      "draft:987:connected",
      "1",
      { EX: 60 },
    );
    expect(redisClient.set).toHaveBeenCalledWith("draft:987:connected", "1", {
      EX: 60,
    });
    expect(redisClient.set.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  // --- Issue #62 fixtures -------------------------------------------------------------------

  /** A context.request.get mock that answers differently for mDraftDetail vs mSettings/mTeam. */
  function buildRequestGet({ draftDetailPicks = [], settingsBody = {} } = {}) {
    return jest.fn(async (url) => {
      if (url.includes("mDraftDetail")) {
        const picks =
          typeof draftDetailPicks === "function"
            ? draftDetailPicks()
            : draftDetailPicks;
        return {
          ok: () => true,
          status: () => 200,
          json: async () => ({ draftDetail: { picks } }),
        };
      }
      // mSettings/mTeam (fetchDraftTotals). Defaults to a body with no usable team/roster data,
      // matching every pre-#62 test's implicit assumption that this call is a no-op.
      return {
        ok: () => true,
        status: () => 200,
        json: async () => settingsBody,
      };
    });
  }

  function buildSession({
    leagueId = "987",
    seasonId = "2026",
    teamId = "4",
    requestGet,
  } = {}) {
    const pageListeners = {};
    const page = {
      on: jest.fn((event, callback) => {
        pageListeners[event] = callback;
      }),
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest
        .fn()
        .mockReturnValue(
          `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&seasonId=${seasonId}&teamId=${teamId}`,
        ),
      waitForTimeout: jest.fn(async (ms) => {
        await jest.advanceTimersByTimeAsync(ms + 30000);
      }),
    };
    const context = {
      on: jest.fn(),
      request: { get: requestGet },
      addInitScript: jest.fn().mockResolvedValue(undefined),
    };
    const browser = { close: jest.fn().mockResolvedValue(undefined) };
    return {
      session: { page, context, browser, headless: true, swid: "{TEST-SWID}" },
      page,
      context,
      browser,
      pageListeners,
    };
  }

  function buildRedisClient(overrides = {}) {
    const multiChain = {
      xAdd: jest.fn().mockReturnThis(),
      hSet: jest.fn().mockReturnThis(),
      hDel: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(undefined),
    };
    return {
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      hGetAll: jest.fn().mockResolvedValue({}),
      multi: jest.fn(() => multiChain),
      publish: jest.fn().mockResolvedValue(undefined),
      xRead: jest.fn().mockResolvedValue(null),
      xRevRange: jest.fn().mockResolvedValue([]),
      ...overrides,
    };
  }

  /** Finds the JSON-parsed payload of the LAST redisClient.set call for a given key prefix. */
  function lastSetPayload(redisClient, keyPrefix) {
    const calls = redisClient.set.mock.calls.filter(([key]) =>
      key.startsWith(keyPrefix),
    );
    if (calls.length === 0) return null;
    return JSON.parse(calls[calls.length - 1][1]);
  }

  it("does not misdetect a brand-new, legitimately-empty draft as terminal", async () => {
    const { session } = buildSession({
      requestGet: buildRequestGet(),
    });
    const redisClient = buildRedisClient();
    const state = createDraftState();

    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const result = await connectAndStream(redisClient, state);

    expect(result).toEqual({ terminal: false, newPicksThisCycle: 0 });
    expect(redisClient.del).not.toHaveBeenCalled();
  });

  it("logs the raw isDead() operands + delegated-command state on each reconnect-loop tick, and logs when context 'page' reassigns the handle (silent-forever-reconnect investigation)", async () => {
    const contextListeners = {};
    const { session, context } = buildSession({
      requestGet: buildRequestGet(),
    });
    context.on = jest.fn((event, cb) => {
      contextListeners[event] = cb;
    });
    const redisClient = buildRedisClient();
    const state = createDraftState();

    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const debugSpy = jest.spyOn(logger, "debug");
    const infoSpy = jest.spyOn(logger, "info");

    await connectAndStream(redisClient, state);

    const tickLogs = debugSpy.mock.calls.filter(([msg]) =>
      msg.includes("Reconnect-loop tick"),
    );
    expect(tickLogs.length).toBeGreaterThanOrEqual(1);
    expect(tickLogs[0][1]).toEqual(
      expect.objectContaining({
        component: "draft_ingest",
        open_sockets: expect.any(Number),
        idle_ms: expect.any(Number),
        ws_dead_grace_ms: expect.any(Number),
        total_picks_reached: false,
        draft_completed: false,
        pending_command: null,
        command_poll_in_flight: false,
      }),
    );

    // Simulate a stray new Page appearing mid-draft — the theory under investigation is that this
    // (previously silent) event resets the handle's isDead() clock out from under the reconnect
    // loop. This just confirms it's now observable, not that it's the confirmed root cause.
    expect(contextListeners.page).toBeInstanceOf(Function);
    const otherPage = { url: () => "https://fantasy.espn.com/other", on: jest.fn() };
    contextListeners.page(otherPage);

    const reassignLogs = infoSpy.mock.calls.filter(([msg]) =>
      msg.includes("reassigning WebSocket listener handle"),
    );
    expect(reassignLogs).toHaveLength(1);
    expect(reassignLogs[0][1]).toEqual(
      expect.objectContaining({
        component: "draft_ws",
        new_page_url: "https://fantasy.espn.com/other",
      }),
    );

    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("never treats a stall streak alone as terminal, but escalates logging (PR review: silence isn't proof of completion)", async () => {
    // A sustained ESPN/network outage on a still-ACTIVE draft looks identical to a finished one
    // at this layer — repeated empty cycles must never, on their own, cause a clean exit that
    // permanently stops syncing a draft that's still going. Only draftCompleted (STATE 2) or
    // totalPicksReached() may set terminal:true; a stall streak is purely a logging escalation,
    // and the actual bound comes from decideReconnectAction's reconnect cap (tested separately).
    const redisClient = buildRedisClient({
      hGetAll: jest.fn().mockResolvedValue({
        1: JSON.stringify({
          league_id: "987",
          player_id: 111,
          pick_number: 1,
          team_id: 1,
          source: "rest",
        }),
      }),
    });
    const state = createDraftState();
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const errorSpy = jest.spyOn(logger, "error");
    // One cycle past DRAFT_STALL_TERMINAL_CYCLES' default (3) — see the constant in
    // draft_sync.js — to prove escalation continues past the old (now-removed) terminal trigger.
    const CYCLES = 4;
    const results = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const { session } = buildSession({ requestGet: buildRequestGet() });
      createAuthenticatedSession.mockResolvedValueOnce(session);
      results.push(await connectAndStream(redisClient, state));
    }

    expect(results.every((r) => r.terminal === false)).toBe(true);
    expect(state.consecutiveEmptyCycles).toBe(CYCLES);
    expect(redisClient.del).not.toHaveBeenCalled();

    const finalHeartbeat = lastSetPayload(redisClient, "draft:987:health");
    expect(finalHeartbeat.terminal).toBe(false);
    expect(finalHeartbeat.terminal_reason).toBeNull();

    // Escalates to error level once the stall streak reaches the threshold (cycles 3 and 4 here).
    const escalatedCalls = errorSpy.mock.calls.filter(([msg]) =>
      msg.includes("connection may be stuck"),
    );
    expect(escalatedCalls.length).toBe(2);
    errorSpy.mockRestore();
  });

  it("resets the stall counter once a cycle sees a genuinely new pick", async () => {
    const redisClient = buildRedisClient();
    const state = createDraftState();
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    // Cycle 1: nothing anywhere — bumps consecutiveEmptyCycles to 1.
    const { session: sessionA } = buildSession({
      requestGet: buildRequestGet(),
    });
    createAuthenticatedSession.mockResolvedValueOnce(sessionA);
    await connectAndStream(redisClient, state);
    expect(state.consecutiveEmptyCycles).toBe(1);

    // Cycle 2: the initial reconcile still sees nothing, but a later periodic reconcile (fired
    // while the isDead() watchdog is waiting) picks up a genuinely new pick from REST.
    let restCallCount = 0;
    const { session: sessionB } = buildSession({
      requestGet: buildRequestGet({
        draftDetailPicks: () => {
          restCallCount += 1;
          return restCallCount === 1
            ? []
            : [
                {
                  playerId: 555,
                  overallPickNumber: 1,
                  teamId: 1,
                  roundId: 1,
                  roundPickNumber: 1,
                },
              ];
        },
      }),
    });
    createAuthenticatedSession.mockResolvedValueOnce(sessionB);
    const result = await connectAndStream(redisClient, state);

    expect(result.newPicksThisCycle).toBeGreaterThan(0);
    expect(state.consecutiveEmptyCycles).toBe(0);
  });

  it("issue #70: persists the draft_commands cursor across reconnects instead of resetting to \"$\"", async () => {
    // A cursor reset to "$" on every connectAndStream() call (one per reconnect) would silently
    // skip any command published during the reconnect gap between the old socket dying and the
    // new one coming up — this proves state.commandLastIdRef survives across two calls sharing
    // the same `state`, advancing rather than resetting.
    const redisClient = buildRedisClient({
      xRead: jest.fn().mockResolvedValue([
        {
          name: "draft_commands:987",
          messages: [
            {
              id: "5-1",
              message: { payload: JSON.stringify({ command_id: "a", command: "submit_pick" }) },
            },
          ],
        },
      ]),
    });
    const state = createDraftState();
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    // Left unset until the consumer's first poll resolves a real cursor (session_registry.js's
    // resolveInitialCursor via XREVRANGE) — no longer pre-seeded with the literal "$", which
    // never actually consumed anything against a real (non-blocking) Redis XREAD.
    expect(state.commandLastIdRef.current).toBeUndefined();

    const { session: sessionA } = buildSession({ requestGet: buildRequestGet() });
    createAuthenticatedSession.mockResolvedValueOnce(sessionA);
    await connectAndStream(redisClient, state);
    // The command-poll interval never fires within a single synchronous connectAndStream() call
    // in this test harness (no fake timers advanced here), so directly exercise the cursor
    // object connectAndStream hands to pollDraftCommands, mirroring what the real interval does.
    await pollDraftCommands(redisClient, state, sessionA, state.commandLastIdRef);
    expect(state.commandLastIdRef.current).toBe("5-1");

    const { session: sessionB } = buildSession({ requestGet: buildRequestGet() });
    createAuthenticatedSession.mockResolvedValueOnce(sessionB);
    await connectAndStream(redisClient, state);

    // A fresh connectAndStream() call (simulating a reconnect) must not have reset the cursor
    // back to "$" — it should still read the same state.commandLastIdRef object, now advanced.
    expect(state.commandLastIdRef.current).toBe("5-1");
    expect(redisClient.xRead).toHaveBeenCalledWith(
      { key: "draft_commands:987", id: "5-1" },
      { COUNT: 10 },
    );
  });

  it("stores a PermanentError from the periodic session check on state.permanentError (not just sessionExpiredError), and connectAndStream propagates it instead of looping forever", async () => {
    // Reuses this describe block's established buildSession/buildRequestGet harness. The main
    // while loop's waitForTimeout(5000) mock advances fake timers by ms+30000=35000ms per call —
    // comfortably past REST_RECONCILE_INTERVAL_MS (15000ms) — so the periodic session-check
    // interval fires at least once before the loop's own isDead() check (30s WS_DEAD_GRACE_MS)
    // ends the cycle.
    const redisClient = buildRedisClient();
    const state = createDraftState();
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockRejectedValueOnce(
      new PermanentError(
        "[Session Health] League 987 not found (HTTP 404) — the room no longer exists.",
      ),
    );

    const { session } = buildSession({ requestGet: buildRequestGet() });
    createAuthenticatedSession.mockResolvedValueOnce(session);

    await expect(connectAndStream(redisClient, state)).rejects.toThrow(
      PermanentError,
    );
    expect(state.permanentError).toBeInstanceOf(PermanentError);
    expect(state.sessionExpiredError).toBeNull();
  });

  it("resets the stall counter and the learned total when the league changes", async () => {
    const redisClient = buildRedisClient();
    const state = createDraftState();
    assertCookieSessionValid.mockResolvedValue(undefined);

    // League 987: two empty cycles build up a stall streak and (deliberately) never learn a total.
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    for (let i = 0; i < 2; i += 1) {
      const { session } = buildSession({
        leagueId: "987",
        requestGet: buildRequestGet(),
      });
      createAuthenticatedSession.mockResolvedValueOnce(session);
      // Seed one pick so picksAtCycleStart > 0 and the streak actually accumulates.
      redisClient.hGetAll.mockResolvedValueOnce({
        1: JSON.stringify({
          league_id: "987",
          player_id: 111,
          pick_number: 1,
          team_id: 1,
          source: "rest",
        }),
      });
      await connectAndStream(redisClient, state);
    }
    expect(state.consecutiveEmptyCycles).toBeGreaterThan(0);

    // DRAFT_MODE=mock's every-reconnect-is-a-new-league behavior: a fresh league id.
    parseDraftRoomUrl.mockReturnValueOnce({
      leagueId: "123",
      seasonId: "2026",
      teamId: "9",
    });
    const { session: freshSession } = buildSession({
      leagueId: "123",
      requestGet: buildRequestGet(),
    });
    createAuthenticatedSession.mockResolvedValueOnce(freshSession);
    redisClient.hGetAll.mockResolvedValueOnce({});
    await connectAndStream(redisClient, state);

    // The league-change reset zeroes the counter, then this cycle's own (legitimate, first-ever
    // for league 123) empty-picks accounting bumps it back to 1. The proof the reset actually
    // fired is that it's 1, not 3 — the old league's 2 accumulated stalls plus this one.
    expect(state.consecutiveEmptyCycles).toBe(1);
    expect(state.leagueId).toBe("123");
  });

  it("exits proactively once the learned total-picks count is reached, without waiting on isDead()", async () => {
    const redisClient = buildRedisClient({
      hGetAll: jest.fn().mockResolvedValue({
        1: JSON.stringify({
          league_id: "987",
          player_id: 111,
          pick_number: 1,
          team_id: 1,
          source: "rest",
        }),
        2: JSON.stringify({
          league_id: "987",
          player_id: 222,
          pick_number: 2,
          team_id: 2,
          source: "rest",
        }),
      }),
    });
    const state = createDraftState();
    const { session, page } = buildSession({
      requestGet: buildRequestGet({
        // 2 teams x 1 roster slot = 2 total picks, matching the 2 already-seeded picks above.
        settingsBody: {
          teams: [{ id: 1 }, { id: 2 }],
          settings: { rosterSettings: { lineupSlotCounts: { 0: 1 } } },
        },
      }),
    });
    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const result = await connectAndStream(redisClient, state);

    expect(state.expectedTotalPicks).toBe(2);
    expect(result).toEqual({ terminal: true, newPicksThisCycle: 0 });
    // The proactive fast path exits before ever needing to wait out WS_DEAD_GRACE_MS.
    expect(page.waitForTimeout).not.toHaveBeenCalled();

    const finalHeartbeat = lastSetPayload(redisClient, "draft:987:health");
    expect(finalHeartbeat.terminal_reason).toBe("total_picks_reached");
  });

  it("exits proactively the instant a WS STATE 2 frame arrives — ESPN's confirmed completion signal", async () => {
    const redisClient = buildRedisClient();
    const state = createDraftState();
    const { session, page, pageListeners } = buildSession({
      requestGet: buildRequestGet(),
    });

    // Override waitForTimeout so its FIRST call fires a live STATE 2 frame instead of advancing
    // the clock — proves the loop reacts directly to the frame rather than needing
    // WS_DEAD_GRACE_MS to elapse (the case the "total-picks" test above covers instead).
    let fired = false;
    page.waitForTimeout = jest.fn(async () => {
      if (fired) return;
      fired = true;
      const wsFrameListeners = {};
      pageListeners.websocket({
        url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
        on: (event, cb) => {
          wsFrameListeners[event] = cb;
        },
      });
      await wsFrameListeners.framereceived({ payload: Buffer.from("STATE 2") });
    });

    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const result = await connectAndStream(redisClient, state);

    expect(result).toEqual({ terminal: true, newPicksThisCycle: 0 });
    expect(page.waitForTimeout).toHaveBeenCalledTimes(1);

    const finalHeartbeat = lastSetPayload(redisClient, "draft:987:health");
    expect(finalHeartbeat.terminal_reason).toBe("state_2_frame");
  });

  it("captures unknown WS frame types instead of silently discarding them (issue #62 proposal #4)", async () => {
    const { session, pageListeners } = buildSession({
      requestGet: buildRequestGet(),
    });
    const redisClient = buildRedisClient();
    const state = createDraftState();

    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    const infoSpy = jest.spyOn(logger, "info");
    await connectAndStream(redisClient, state);

    // Simulate a WS frame arriving. The registered listeners are plain closures over `state`, so
    // this works even though connectAndStream's own promise has already settled.
    const wsFrameListeners = {};
    pageListeners.websocket({
      url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
      on: (event, cb) => {
        wsFrameListeners[event] = cb;
      },
    });
    const infoCallsBefore = infoSpy.mock.calls.length;
    await wsFrameListeners.framereceived({
      payload: Buffer.from("CLOCK 3 90"),
    });
    await wsFrameListeners.framereceived({
      payload: Buffer.from("CLOCK 3 91"),
    });

    expect(state.health.ws.other_frames.CLOCK).toBe(2);
    // First-seen-only logging: exactly one new info line for the CLOCK type across both frames.
    const newInfoCalls = infoSpy.mock.calls
      .slice(infoCallsBefore)
      .filter(([msg]) => msg.includes("First-seen frame type"));
    expect(newInfoCalls).toHaveLength(1);
    infoSpy.mockRestore();
  });

  it("buffers an AUTOSUGGEST frame that arrives before ready, publishing it once ready flips (PR #65 review)", async () => {
    // 2 teams x 1 roster slot = 2 total picks, matching the 2 already-seeded picks below, so the
    // proactive total-picks exit fires immediately and the run loop never has to actually wait —
    // same trick as the "exits proactively once the learned total-picks count is reached" test.
    const redisClient = buildRedisClient({
      hGetAll: jest.fn().mockResolvedValue({
        1: JSON.stringify({
          league_id: "987",
          player_id: 111,
          pick_number: 1,
          team_id: 1,
          source: "rest",
        }),
        2: JSON.stringify({
          league_id: "987",
          player_id: 222,
          pick_number: 2,
          team_id: 2,
          source: "rest",
        }),
      }),
    });
    const state = createDraftState();

    let capturedPageListeners;
    const wsFrameListeners = {};
    let injected = false;
    let suggestedSetsRightAfterInjection = null;
    const baseRequestGet = buildRequestGet({
      settingsBody: {
        teams: [{ id: 1 }, { id: 2 }],
        settings: { rosterSettings: { lineupSlotCounts: { 0: 1 } } },
      },
    });
    // fetchDraftTotals is the first REST call connectAndStream makes after attachDraftListeners
    // has already registered the page's "websocket" handler — so this is the earliest point a
    // test can simulate a frame arriving while state.ready is still false.
    const requestGet = jest.fn(async (url) => {
      if (!injected && capturedPageListeners) {
        injected = true;
        capturedPageListeners.websocket({
          url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
          on: (event, cb) => {
            wsFrameListeners[event] = cb;
          },
        });
        await wsFrameListeners.framereceived({
          payload: Buffer.from("AUTOSUGGEST 4426515"),
        });
        // Recorded here (not asserted inline) so a failure can't be silently swallowed by
        // fetchDraftTotals' own try/catch around this same call.
        suggestedSetsRightAfterInjection = redisClient.set.mock.calls.filter(
          ([key]) => key === "draft:987:suggested",
        ).length;
      }
      return baseRequestGet(url);
    });
    const { session, pageListeners } = buildSession({ requestGet });
    capturedPageListeners = pageListeners;

    createAuthenticatedSession.mockResolvedValue(session);
    parseDraftRoomUrl.mockReturnValue({
      leagueId: "987",
      seasonId: "2026",
      teamId: "4",
    });
    assertCookieSessionValid.mockResolvedValue(undefined);

    await connectAndStream(redisClient, state);

    expect(suggestedSetsRightAfterInjection).toBe(0);
    expect(state.pendingAutosuggest).toBeNull();
    const suggestion = lastSetPayload(redisClient, "draft:987:suggested");
    expect(suggestion).toMatchObject({
      league_id: "987",
      player_id: 4426515,
    });
  });
});
