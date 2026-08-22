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
const { fetchDraftDetail, connectAndStream } = require("../../src/bots/draft_sync");

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
    const redisClient = { set: jest.fn().mockResolvedValue("OK") };
    const state = {
      lastPickNumber: null,
      pickCounter: 0,
      leagueId: null,
      seasonId: null,
      teamId: null,
      ready: false,
      pendingFrames: [],
      sessionExpiredError: null,
    };

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
    expect(redisClient.set).toHaveBeenCalledWith(
      "draft:987:connected",
      "1",
      { EX: 60 },
    );
    expect(redisClient.set.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
