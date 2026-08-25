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
const {
  fetchDraftDetail,
  fetchDraftTotals,
  connectAndStream,
  createDraftState,
  parseSelectedFrame,
  decideReconnectAction,
} = require("../../src/bots/draft_sync");

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

  it("gives up once the reconnect cap is exceeded", () => {
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
    const context = { on: jest.fn(), request: { get: requestGet } };
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

  it("treats DRAFT_STALL_TERMINAL_CYCLES consecutive empty-picks cycles as terminal", async () => {
    const redisClient = buildRedisClient({
      // One already-published pick, so picksAtCycleStart > 0 every cycle — the gate that keeps a
      // brand-new empty draft from ever being misdetected.
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

    // Matches DRAFT_STALL_TERMINAL_CYCLES' default (3) — see the constant in draft_sync.js.
    const STALL_TERMINAL_CYCLES = 3;
    const results = [];
    for (let i = 0; i < STALL_TERMINAL_CYCLES; i += 1) {
      const { session } = buildSession({ requestGet: buildRequestGet() });
      createAuthenticatedSession.mockResolvedValueOnce(session);
      results.push(await connectAndStream(redisClient, state));
    }

    expect(results.slice(0, -1).every((r) => r.terminal === false)).toBe(true);
    expect(results[results.length - 1].terminal).toBe(true);
    expect(state.consecutiveEmptyCycles).toBe(STALL_TERMINAL_CYCLES);

    const finalHeartbeat = lastSetPayload(redisClient, "draft:987:health");
    expect(finalHeartbeat.terminal).toBe(true);
    expect(finalHeartbeat.terminal_reason).toMatch(
      /consecutive reconnect cycles/,
    );
    expect(redisClient.del).toHaveBeenCalledWith("draft:987:connected");
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
      url: () => "wss://fake",
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
});
