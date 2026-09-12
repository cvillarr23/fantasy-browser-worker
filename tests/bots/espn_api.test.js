const fs = require("fs");
const os = require("os");
const path = require("path");

// Set before requiring espn_api.js so its module-level WRITE_CAPTURE_DIR never resolves to the
// repo's real recon-output/ — every test in this file, not just the capture-focused ones below,
// otherwise leaks a write-log file into tracked working-directory state.
const MODULE_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "espn-api-test-"));
process.env.DEBUG_OUTPUT_DIR = MODULE_TMP_DIR;

const { submitLineup, submitWaiverClaim } = require("../../src/bots/espn_api");

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
          { playerId: 111, type: "ADD" },
          { playerId: 222, type: "DROP" },
        ],
      },
    });
  });

  it("classifies a 4xx (non-429) failure as permanent", async () => {
    const context = fakeContext({ message: "already claimed" }, 403);
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
