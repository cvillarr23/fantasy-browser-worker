const fs = require("fs");
const os = require("os");
const path = require("path");

// Set before requiring espn_api.js so its module-level WRITE_CAPTURE_DIR never resolves to the
// repo's real recon-output/ — every test in this file, not just the capture-focused ones below,
// otherwise leaks a write-log file into tracked working-directory state.
const MODULE_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "espn-api-test-"));
process.env.DEBUG_OUTPUT_DIR = MODULE_TMP_DIR;

const {
  readRoster,
  readRosters,
  submitLineup,
  submitWaiverClaim,
  buildTradeProposalBody,
  readPendingTrades,
  readLeagueChat,
  readTradeHistory,
  buildTradeResponseBody,
  submitTradeResponse,
  VERIFIED_TRADE_RESPONSE_ACTIONS,
} = require("../../src/bots/espn_api");
const { SessionExpiredError } = require("../../src/errors");

afterAll(() => {
  fs.rmSync(MODULE_TMP_DIR, { recursive: true, force: true });
});

function fakeContext(responseBody, status = 200) {
  const text = JSON.stringify(responseBody);
  return {
    request: {
      post: jest.fn().mockResolvedValue({
        ok: () => status >= 200 && status < 300,
        status: () => status,
        text: async () => text,
      }),
    },
  };
}

const BASE_URL =
  "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1248158344/transactions/";

// Confirmed 2026-09-12 against a real captured save (league 1248158344 team 8): both headers, and
// this envelope shape, match ESPN's actual web client exactly.
const EXPECTED_HEADERS = {
  "Content-Type": "application/json",
  "x-fantasy-source": "kona",
  "x-fantasy-platform": "espn-fantasy-web",
};

// ESPN gives a team defense a negative player id (#116): Team 8's Eagles D/ST is -16021.
describe("D/ST negative player ids", () => {
  it("readRoster keys a D/ST entry by its signed id as a string", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          json: async () => ({
            scoringPeriodId: 4,
            teams: [
              {
                id: 8,
                roster: {
                  entries: [
                    { playerId: -16021, lineupSlotId: 16 },
                    { playerId: 4239996, lineupSlotId: 20 },
                  ],
                },
              },
            ],
          }),
        }),
      },
    };

    const roster = await readRoster(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
    });

    expect(roster.slotByPlayerId.get("-16021")).toBe(16);
    expect(roster.slotByPlayerId.has("16021")).toBe(false);
  });

  it("readRoster exposes each rostered player's name by signed id, null when ESPN omits it", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          json: async () => ({
            scoringPeriodId: 4,
            teams: [
              {
                id: 8,
                roster: {
                  entries: [
                    {
                      playerId: -16021,
                      lineupSlotId: 16,
                      playerPoolEntry: { player: { fullName: "Eagles D/ST" } },
                    },
                    { playerId: 4239996, lineupSlotId: 20 },
                  ],
                },
              },
            ],
          }),
        }),
      },
    };

    const roster = await readRoster(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
    });

    expect(roster.nameByPlayerId.get("-16021")).toBe("Eagles D/ST");
    expect(roster.nameByPlayerId.get("4239996")).toBeNull();
  });

  it("readRoster exposes each rostered player's ESPN injuryStatus, null when ESPN omits it", async () => {
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => true,
          json: async () => ({
            scoringPeriodId: 4,
            teams: [
              {
                id: 8,
                roster: {
                  entries: [
                    {
                      playerId: 4239996,
                      lineupSlotId: 20,
                      playerPoolEntry: { player: { injuryStatus: "OUT" } },
                    },
                    { playerId: 3916148, lineupSlotId: 23 },
                  ],
                },
              },
            ],
          }),
        }),
      },
    };

    const roster = await readRoster(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
    });

    expect(roster.injuryStatusByPlayerId.get("4239996")).toBe("OUT");
    expect(roster.injuryStatusByPlayerId.get("3916148")).toBeNull();
  });

  it("readRosters returns several teams from a single league read", async () => {
    const get = jest.fn().mockResolvedValue({
      ok: () => true,
      json: async () => ({
        scoringPeriodId: 4,
        teams: [
          { id: 3, roster: { entries: [{ playerId: 1, lineupSlotId: 20 }] } },
          { id: 8, roster: { entries: [{ playerId: -16021, lineupSlotId: 16 }] } },
        ],
      }),
    });

    const rosters = await readRosters(
      { request: { get } },
      { leagueId: "1248158344", seasonId: "2026", teamIds: ["3", "8"] },
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(rosters.get("3").slotByPlayerId.has("1")).toBe(true);
    expect(rosters.get("8").slotByPlayerId.get("-16021")).toBe(16);
  });

  it("submitWaiverClaim keeps the sign on D/ST ADD and DROP items", async () => {
    const context = fakeContext({ id: "abc" });

    await submitWaiverClaim(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 4,
      addPlayerId: "-16021",
      dropPlayerId: "-16030",
    });

    expect(context.request.post.mock.calls[0][1].data.items).toEqual([
      { playerId: -16021, type: "ADD", toTeamId: 8 },
      { playerId: -16030, type: "DROP", fromTeamId: 8 },
    ]);
  });
});

describe("submitLineup", () => {
  it("sends the verified request shape", async () => {
    const context = fakeContext({ id: "abc" });
    const items = [
      { playerId: 4239996, type: "LINEUP", fromLineupSlotId: 23, toLineupSlotId: 20 },
      { playerId: 3916148, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 23 },
    ];

    await submitLineup(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
      scoringPeriodId: 1,
      items,
    });

    expect(context.request.post).toHaveBeenCalledWith(BASE_URL, {
      headers: EXPECTED_HEADERS,
      data: {
        isLeagueManager: false,
        teamId: 8,
        type: "ROSTER",
        memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
        scoringPeriodId: 1,
        executionType: "EXECUTE",
        items,
      },
    });
  });

  it("throws with the response body on a non-2xx status", async () => {
    const context = fakeContext({ message: "nope" }, 500);
    await expect(
      submitLineup(context, {
        leagueId: "1",
        seasonId: "2026",
        teamId: "8",
        memberId: "x",
        scoringPeriodId: 1,
        items: [],
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
  it("throws a PermanentError on a 4xx rejection so the message is not requeued", async () => {
    const context = fakeContext({ details: [{ type: "TRAN_ROSTER_INELIGIBLE_IR_NOT_INJURED" }] }, 409);
    await expect(
      submitLineup(context, {
        leagueId: "1",
        seasonId: "2026",
        teamId: "8",
        memberId: "x",
        scoringPeriodId: 1,
        items: [],
      }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/HTTP 409/) });
  });

  it("treats a 401/403 as an expired session to retry, not a doomed request", async () => {
    for (const status of [401, 403]) {
      const error = await submitLineup(fakeContext({}, status), {
        leagueId: "1",
        seasonId: "2026",
        teamId: "8",
        memberId: "x",
        scoringPeriodId: 1,
        items: [],
      }).catch((e) => e);
      expect(error.name).toBe("SessionExpiredError");
      expect(error.permanent).toBeUndefined();
    }
  });

  it("keeps a 429 or 5xx retriable", async () => {
    for (const status of [429, 503]) {
      const error = await submitLineup(fakeContext({}, status), {
        leagueId: "1",
        seasonId: "2026",
        teamId: "8",
        memberId: "x",
        scoringPeriodId: 1,
        items: [],
      }).catch((e) => e);
      expect(error.permanent).toBeUndefined();
    }
  });
});

describe("submitWaiverClaim", () => {
  it("sends the shared envelope with FREEAGENT/ADD+DROP items", async () => {
    const context = fakeContext({ id: "abc" });

    await submitWaiverClaim(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
      scoringPeriodId: 1,
      addPlayerId: "111",
      dropPlayerId: "222",
    });

    expect(context.request.post).toHaveBeenCalledWith(BASE_URL, {
      headers: EXPECTED_HEADERS,
      data: {
        isLeagueManager: false,
        teamId: 8,
        type: "FREEAGENT",
        memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
        scoringPeriodId: 1,
        executionType: "EXECUTE",
        items: [
          { playerId: 111, type: "ADD", toTeamId: 8 },
          { playerId: 222, type: "DROP", fromTeamId: 8 },
        ],
      },
    });
  });

  // ESPN rejected an ADD without toTeamId with HTTP 409 TRAN_ITEM_TO_TEAM_ID_MISSING (live web-UI
  // claim, 2026-10-07). Its frontend sends roster-fix drops as {playerId, type: "DROP", fromTeamId}.
  it("names the claiming team on each item: toTeamId for an ADD, fromTeamId for a DROP", async () => {
    const context = fakeContext({ id: "abc" });

    await submitWaiverClaim(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 5,
      addPlayerId: "4832800",
      dropPlayerId: "4432773",
    });

    expect(context.request.post.mock.calls[0][1].data.items).toEqual([
      { playerId: 4832800, type: "ADD", toTeamId: 8 },
      { playerId: 4432773, type: "DROP", fromTeamId: 8 },
    ]);
  });

  it("classifies a 4xx (non-429) failure as permanent", async () => {
    const context = fakeContext({ message: "already claimed" }, 409);
    await expect(
      submitWaiverClaim(context, {
        leagueId: "1",
        seasonId: "2026",
        teamId: "8",
        memberId: "x",
        scoringPeriodId: 1,
        addPlayerId: "111",
      }),
    ).rejects.toMatchObject({ permanent: true });
  });

  it.each([401, 403])("retries HTTP %s after the session is refreshed", async (status) => {
    const context = fakeContext({ message: "authentication required" }, status);
    const error = await submitWaiverClaim(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 5,
      addPlayerId: "11122",
    }).catch((err) => err);

    expect(error.name).toBe("SessionExpiredError");
    expect(error.permanent).toBeUndefined();
    expect(error.retryDelayMs).toBeGreaterThan(0);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it("sends an add-only claim and preserves a roster-limit rejection", async () => {
    // A frontend-derived fixture checks classification without submitting a real league write.
    const rejection = {
      details: [{
        type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE",
        message: "Maximum roster size would be exceeded.",
      }],
    };
    const context = fakeContext(rejection, 409);

    await expect(submitWaiverClaim(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 5,
      addPlayerId: "11122",
    })).rejects.toMatchObject({
      name: "PermanentError",
      permanent: true,
      message: expect.stringContaining("TRAN_ROSTER_LIMIT_EXCEEDED_ONE"),
    });
    expect(context.request.post).toHaveBeenCalledTimes(1);
    expect(context.request.post).toHaveBeenCalledWith(BASE_URL, {
      headers: EXPECTED_HEADERS,
      data: {
        isLeagueManager: false,
        teamId: 8,
        type: "FREEAGENT",
        memberId: "x",
        scoringPeriodId: 5,
        executionType: "EXECUTE",
        items: [{ playerId: 11122, type: "ADD", toTeamId: 8 }],
      },
    });
  });
});

// Inferred 2026-10-03 (#124) from ESPN's own frontend (TransactionService.proposeTrade), not yet
// seen on the wire: see docs/espn-reverse-engineering.md "Trade proposals".
describe("buildTradeProposalBody", () => {
  const base = {
    teamId: "8",
    toTeamId: "1",
    memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
    scoringPeriodId: 4,
    incomingPlayerIds: ["3117251", "-16019"],
    outgoingPlayerIds: ["4429795"],
    expirationDate: new Date("2026-10-05T15:04:05.123Z"),
  };

  it("builds the TRADE_PROPOSAL envelope with one directed TRADE item per player", () => {
    expect(buildTradeProposalBody({ ...base, comment: "Let's deal" })).toEqual({
      isLeagueManager: false,
      teamId: 8,
      type: "TRADE_PROPOSAL",
      memberId: "{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}",
      scoringPeriodId: 4,
      executionType: "EXECUTE",
      items: [
        { playerId: 3117251, type: "TRADE", fromTeamId: 1, toTeamId: 8 },
        { playerId: -16019, type: "TRADE", fromTeamId: 1, toTeamId: 8 },
        { playerId: 4429795, type: "TRADE", fromTeamId: 8, toTeamId: 1 },
      ],
      expirationDate: "2026-10-05T15:04:05.123Z",
      comment: "Let's deal",
    });
  });

  it("sends an empty comment, as ESPN's client does, when there is no note", () => {
    expect(buildTradeProposalBody(base).comment).toBe("");
    expect(buildTradeProposalBody({ ...base, comment: null }).comment).toBe("");
  });
});

describe("write-artifact capture", () => {
  let tmpDir;
  const originalDebugOutputDir = process.env.DEBUG_OUTPUT_DIR;
  const originalDebugCapture = process.env.DEBUG_CAPTURE;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "espn-write-log-"));
    process.env.DEBUG_OUTPUT_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDebugOutputDir === undefined) delete process.env.DEBUG_OUTPUT_DIR;
    else process.env.DEBUG_OUTPUT_DIR = originalDebugOutputDir;
    if (originalDebugCapture === undefined) delete process.env.DEBUG_CAPTURE;
    else process.env.DEBUG_CAPTURE = originalDebugCapture;
  });

  it("appends one JSONL record per write by default", async () => {
    delete process.env.DEBUG_CAPTURE;
    jest.resetModules();
    const { submitLineup: submitLineupFresh } = require("../../src/bots/espn_api");
    const context = fakeContext({ id: "abc" });

    await submitLineupFresh(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 1,
      items: [],
      trackingId: "test-tracking",
    });

    const logPath = path.join(tmpDir, "espn-write-log.jsonl");
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      kind: "lineup",
      trackingId: "test-tracking",
      leagueId: "1248158344",
      teamId: "8",
      responseStatus: 200,
      responseOk: true,
    });
  });

  it("captures nothing when DEBUG_CAPTURE is disabled", async () => {
    process.env.DEBUG_CAPTURE = "false";
    jest.resetModules();
    const { submitLineup: submitLineupFresh } = require("../../src/bots/espn_api");
    const context = fakeContext({ id: "abc" });

    await submitLineupFresh(context, {
      leagueId: "1248158344",
      seasonId: "2026",
      teamId: "8",
      memberId: "x",
      scoringPeriodId: 1,
      items: [],
    });

    expect(fs.existsSync(path.join(tmpDir, "espn-write-log.jsonl"))).toBe(false);
  });
});

function fakeGetContext(responseBody, status = 200) {
  return {
    request: {
      get: jest.fn().mockResolvedValue({
        ok: () => status >= 200 && status < 300,
        status: () => status,
        json: async () => responseBody,
        text: async () => JSON.stringify(responseBody),
      }),
    },
  };
}

const LEAGUE_READ_URL =
  "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1248158344";

// Rosters/owners as mRoster+mTeam return them. The pending-trade entries are a GUESS at the
// populated shape (only the empty state has been observed live, #101): mTransactions2's verified
// executed-transaction shape with a trade type, which is how other views shape transactions.
const LEAGUE_TEAMS = [
  {
    id: 8,
    owners: ["{OWNER-8}"],
    roster: { entries: [{ playerId: 4429795, playerPoolEntry: { player: { fullName: "Bijan Robinson" } } }] },
  },
  {
    id: 3,
    owners: ["{OWNER-3A}", "{OWNER-3B}"],
    roster: { entries: [{ playerId: -16021, playerPoolEntry: { player: { fullName: "Eagles D/ST" } } }] },
  },
];

function pendingTrade(overrides = {}) {
  return {
    id: "trade-1",
    type: "TRADE_PROPOSAL",
    status: "PENDING",
    teamId: 3,
    items: [
      { playerId: -16021, type: "TRADE", fromTeamId: 3, toTeamId: 8 },
      { playerId: 4429795, type: "TRADE", fromTeamId: 8, toTeamId: 3 },
    ],
    ...overrides,
  };
}

describe("readPendingTrades", () => {
  const ids = { leagueId: "1248158344", seasonId: "2026", teamId: "8" };

  it("reads the same views the clubhouse page loads", async () => {
    const context = fakeGetContext({ teams: LEAGUE_TEAMS });

    await readPendingTrades(context, ids);

    expect(context.request.get).toHaveBeenCalledWith(
      `${LEAGUE_READ_URL}?view=mPendingTransactions&view=mRoster&view=mTeam`,
    );
  });

  // Confirmed live 2026-10-03: with nothing pending ESPN omits the key rather than sending [].
  it("returns no trades when the response has no transactions key", async () => {
    const { trades } = await readPendingTrades(fakeGetContext({ teams: LEAGUE_TEAMS }), ids);
    expect(trades).toEqual([]);
  });

  it("returns a trade involving our team with signed ESPN ids and roster names", async () => {
    const context = fakeGetContext({ teams: LEAGUE_TEAMS, transactions: [pendingTrade()] });

    const { trades } = await readPendingTrades(context, ids);

    expect(trades).toEqual([
      {
        id: "trade-1",
        type: "TRADE_PROPOSAL",
        status: "PENDING",
        proposingTeamId: "3",
        items: [
          { playerId: "-16021", playerName: "Eagles D/ST", type: "TRADE", fromTeamId: "3", toTeamId: "8" },
          { playerId: "4429795", playerName: "Bijan Robinson", type: "TRADE", fromTeamId: "8", toTeamId: "3" },
        ],
      },
    ]);
  });

  // ESPN's own league store reads the raw `pendingTransactions` key (frontend bundle, #124).
  it("reads pendingTransactions as well as transactions, once per id, with date and comment", async () => {
    const proposedDate = 1791033600000;
    const context = fakeGetContext({
      teams: LEAGUE_TEAMS,
      pendingTransactions: [pendingTrade({ proposedDate, comment: "Let's deal" })],
      transactions: [pendingTrade(), pendingTrade({ id: "trade-2" })],
    });

    const { trades } = await readPendingTrades(context, ids);

    expect(trades.map((t) => t.id)).toEqual(["trade-1", "trade-2"]);
    expect(trades[0]).toMatchObject({ proposedDate, comment: "Let's deal" });
    expect("comment" in trades[1]).toBe(false);
  });

  it("skips non-trade transactions and trades between two other teams", async () => {
    const context = fakeGetContext({
      teams: LEAGUE_TEAMS,
      transactions: [
        pendingTrade({ id: "waiver", type: "WAIVER" }),
        pendingTrade({
          id: "other-teams",
          teamId: 5,
          items: [{ playerId: 1, type: "TRADE", fromTeamId: 5, toTeamId: 6 }],
        }),
      ],
    });

    const { trades } = await readPendingTrades(context, ids);

    expect(trades).toEqual([]);
  });

  it("maps every owner's member id to their team, for attributing chat posts", async () => {
    const { teamIdByMemberId } = await readPendingTrades(fakeGetContext({ teams: LEAGUE_TEAMS }), ids);

    expect(teamIdByMemberId.get("{OWNER-8}")).toBe("8");
    expect(teamIdByMemberId.get("{OWNER-3B}")).toBe("3");
  });

  it("throws on a non-2xx read", async () => {
    await expect(readPendingTrades(fakeGetContext({ message: "nope" }, 503), ids)).rejects.toThrow(
      /Pending-trade read failed with HTTP 503/,
    );
  });

  it("passes through expiry, related-transaction and pending fields only when ESPN sends them", async () => {
    const context = fakeGetContext({
      teams: LEAGUE_TEAMS,
      pendingTransactions: [
        pendingTrade({ expirationDate: 1791206400000, relatedTransactionId: "trade-0", isPending: true }),
      ],
    });

    const [trade] = (await readPendingTrades(context, ids)).trades;

    expect(trade).toMatchObject({
      expirationDate: 1791206400000,
      relatedTransactionId: "trade-0",
      isPending: true,
    });
    const [bare] = (await readPendingTrades(fakeGetContext({ teams: LEAGUE_TEAMS, transactions: [pendingTrade()] }), ids)).trades;
    expect("expirationDate" in bare).toBe(false);
    expect("relatedTransactionId" in bare).toBe(false);
  });

  it("keeps draft-pick and FAAB items without inventing a player id", async () => {
    const context = fakeGetContext({
      teams: LEAGUE_TEAMS,
      transactions: [
        pendingTrade({
          items: [
            { playerId: 4429795, type: "TRADE", fromTeamId: 8, toTeamId: 3 },
            { type: "ACQUISITION_BUDGET_TRADE", acquisitionBudget: 15, fromTeamId: 3, toTeamId: 8 },
            { type: "DRAFT_TRADE", overallPickNumber: 27, fromTeamId: 3, toTeamId: 8 },
          ],
        }),
      ],
    });

    const [trade] = (await readPendingTrades(context, ids)).trades;

    expect(trade.items.slice(1)).toEqual([
      { playerId: null, playerName: null, type: "ACQUISITION_BUDGET_TRADE", fromTeamId: "3", toTeamId: "8", acquisitionBudget: 15 },
      { playerId: null, playerName: null, type: "DRAFT_TRADE", fromTeamId: "3", toTeamId: "8", overallPickNumber: 27 },
    ]);
  });

  it.each([401, 403])("raises SessionExpiredError on HTTP %i so the read retries after a refresh", async (status) => {
    await expect(readPendingTrades(fakeGetContext({}, status), ids)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("keeps the raw transactions when any are present, since the populated shape is unverified", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "espn-pending-"));
    const originalDir = process.env.DEBUG_OUTPUT_DIR;
    process.env.DEBUG_OUTPUT_DIR = tmpDir;
    try {
      jest.resetModules();
      const { readPendingTrades: fresh } = require("../../src/bots/espn_api");
      await fresh(fakeGetContext({ teams: LEAGUE_TEAMS, transactions: [pendingTrade()] }), ids);

      const lines = fs
        .readFileSync(path.join(tmpDir, "espn-pending-transactions.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).transactions[0].id).toBe("trade-1");
    } finally {
      process.env.DEBUG_OUTPUT_DIR = originalDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("readLeagueChat", () => {
  const ids = { leagueId: "1248158344", seasonId: "2026" };

  function chatTopic(messages) {
    return { id: "bde68199", type: "CHAT_ALL_MEMBERS", messages };
  }

  it("asks the communication feed for the league-chat topic only", async () => {
    const context = fakeGetContext({ topics: [] });

    await readLeagueChat(context, ids);

    const [url, opts] = context.request.get.mock.calls[0];
    expect(url).toBe(`${LEAGUE_READ_URL}/communication/?view=kona_league_communication`);
    const filter = JSON.parse(opts.headers["x-fantasy-filter"]);
    expect(filter.topics.filterType.value).toEqual(["CHAT_ALL_MEMBERS"]);
  });

  it("returns posts with text oldest first, skipping system cards and deleted posts", async () => {
    const context = fakeGetContext({
      topics: [
        chatTopic([
          { author: "{OWNER-3A}", date: 3000, content: "still want Bijan?", isDeleted: false },
          { author: "LM", date: 2500, content: null, messageTypeId: 266, isDeleted: false },
          { author: "{OWNER-8}", date: 2000, content: "deleted", isDeleted: true },
          { author: "{OWNER-8}", date: 1000, content: "anyone trading a WR", isDeleted: false },
        ]),
        // The server-side filter is unverified, so other topic types must be dropped here too.
        { type: "ACTIVITY_TRANSACTIONS", messages: [{ author: "x", date: 1, content: "nope" }] },
      ],
    });

    const messages = await readLeagueChat(context, ids);

    expect(messages).toEqual([
      { authorId: "{OWNER-8}", date: 1000, content: "anyone trading a WR" },
      { authorId: "{OWNER-3A}", date: 3000, content: "still want Bijan?" },
    ]);
  });

  it("drops posts without a numeric date rather than breaking the ordering", async () => {
    const context = fakeGetContext({
      topics: [
        chatTopic([
          { author: "LM", date: 2, content: "kept", isDeleted: false },
          { author: "LM", content: "no date", isDeleted: false },
          { author: "LM", date: "yesterday", content: "bad date", isDeleted: false },
        ]),
      ],
    });

    const messages = await readLeagueChat(context, ids);

    expect(messages.map((m) => m.content)).toEqual(["kept"]);
  });

  it("keeps only the most recent `limit` posts", async () => {
    const posts = [1, 2, 3].map((n) => ({ author: "LM", date: n, content: `post ${n}`, isDeleted: false }));
    const messages = await readLeagueChat(fakeGetContext({ topics: [chatTopic(posts)] }), {
      ...ids,
      limit: 2,
    });

    expect(messages.map((m) => m.content)).toEqual(["post 2", "post 3"]);
  });

  it("throws on a non-2xx read", async () => {
    await expect(readLeagueChat(fakeGetContext({}, 500), ids)).rejects.toThrow(
      /League chat read failed with HTTP 500/,
    );
  });
});

describe("readTradeHistory", () => {
  const ids = { leagueId: "1248158344", seasonId: "2026" };

  it("reads mTransactions2 filtered to trade transaction types", async () => {
    const context = fakeGetContext({ transactions: [] });

    await readTradeHistory(context, { ...ids, scoringPeriodId: 5 });

    const [url, options] = context.request.get.mock.calls[0];
    expect(url).toBe(`${LEAGUE_READ_URL}?view=mTransactions2&scoringPeriodId=5`);
    const filter = JSON.parse(options.headers["x-fantasy-filter"]);
    expect(filter.transactions.filterType.value).toEqual(
      expect.arrayContaining(["TRADE_PROPOSAL", "TRADE_ACCEPT", "TRADE_DECLINE"]),
    );
  });

  it("omits the scoring period when none is given and returns the trade rows", async () => {
    const row = {
      id: "t-9",
      type: "TRADE_DECLINE",
      status: "EXECUTED",
      relatedTransactionId: "trade-1",
      teamId: 8,
      items: [],
    };
    const context = fakeGetContext({ transactions: [row, { id: "w", type: "WAIVER" }] });

    const rows = await readTradeHistory(context, ids);

    expect(context.request.get.mock.calls[0][0]).toBe(`${LEAGUE_READ_URL}?view=mTransactions2`);
    expect(rows).toEqual([row]);
  });

  it("returns [] when ESPN omits the transactions key", async () => {
    expect(await readTradeHistory(fakeGetContext({}), ids)).toEqual([]);
  });

  it("throws SessionExpiredError on 401 and a plain error on 5xx", async () => {
    await expect(readTradeHistory(fakeGetContext({}, 401), ids)).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(readTradeHistory(fakeGetContext({}, 502), ids)).rejects.toThrow(/Trade history read failed with HTTP 502/);
  });
});

describe("trade responses", () => {
  const base = {
    teamId: "8",
    memberId: "{SWID}",
    scoringPeriodId: 5,
    transactionId: "trade-1",
  };

  it("ships with no verified response actions, so nothing can be sent yet", () => {
    expect(VERIFIED_TRADE_RESPONSE_ACTIONS).toEqual([]);
    expect(Object.isFrozen(VERIFIED_TRADE_RESPONSE_ACTIONS)).toBe(true);
  });

  it("builds an accept on the shared envelope, related to the offer", () => {
    expect(buildTradeResponseBody({ ...base, action: "accept" })).toEqual({
      isLeagueManager: false,
      teamId: 8,
      type: "TRADE_ACCEPT",
      memberId: "{SWID}",
      scoringPeriodId: 5,
      executionType: "EXECUTE",
      relatedTransactionId: "trade-1",
      items: [],
    });
  });

  it("builds a decline that carries the note, empty when there is none", () => {
    expect(buildTradeResponseBody({ ...base, action: "decline" })).toMatchObject({
      type: "TRADE_DECLINE",
      comment: "",
    });
    expect(buildTradeResponseBody({ ...base, action: "decline", comment: "No thanks" }).comment).toBe(
      "No thanks",
    );
  });

  it("refuses any other action, including a veto", () => {
    expect(() => buildTradeResponseBody({ ...base, action: "veto" })).toThrow(/Unsupported trade response/);
  });

  it("posts the body, captures it, and returns ESPN's parsed response", async () => {
    const context = fakeContext({ id: "resp-1" });

    const result = await submitTradeResponse(context, {
      ...base,
      leagueId: "1248158344",
      seasonId: "2026",
      action: "decline",
      trackingId: "t-1",
    });

    expect(result).toEqual({ id: "resp-1" });
    const [url, options] = context.request.post.mock.calls[0];
    expect(url).toBe(BASE_URL);
    expect(options.data.type).toBe("TRADE_DECLINE");
    expect(options.headers["x-fantasy-platform"]).toBe("espn-fantasy-web");
  });

  it("raises SessionExpiredError on 401/403 and a PermanentError carrying ESPN's details on other 4xx", async () => {
    const args = { ...base, leagueId: "1248158344", seasonId: "2026", action: "accept" };
    await expect(submitTradeResponse(fakeContext({}, 403), args)).rejects.toBeInstanceOf(SessionExpiredError);

    const rejected = submitTradeResponse(
      fakeContext({ details: [{ type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE", message: "drop needed" }] }, 409),
      args,
    );
    await expect(rejected).rejects.toMatchObject({
      permanent: true,
      status: 409,
      details: [{ type: "TRAN_ROSTER_LIMIT_EXCEEDED_ONE", message: "drop needed" }],
    });
  });

  it("marks a 5xx as an unknown outcome rather than a rejection", async () => {
    const args = { ...base, leagueId: "1248158344", seasonId: "2026", action: "accept" };
    await expect(submitTradeResponse(fakeContext({}, 503), args)).rejects.toMatchObject({
      status: 503,
      outcomeUnknown: true,
    });
  });
});
