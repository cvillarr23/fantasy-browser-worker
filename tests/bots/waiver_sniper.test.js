jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/espn_api");

const { createAuthenticatedSession } = require("../../src/bots/auth");
const { readRoster, submitWaiverClaim } = require("../../src/bots/espn_api");
const { executeInstantWaiverClaim } = require("../../src/bots/waiver_sniper");

const ENV_KEYS = ["DRY_RUN", "ESPN_LEAGUE_ID", "ESPN_TEAM_ID"];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESPN_LEAGUE_ID = "1234567890";
  process.env.ESPN_TEAM_ID = "8";

  createAuthenticatedSession.mockResolvedValue({
    context: {},
    browser: { close: jest.fn() },
    swid: "{TEST-SWID}",
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function roster(slotByPlayerId, scoringPeriodId = 3) {
  return {
    slotByPlayerId: new Map(Object.entries(slotByPlayerId)),
    scoringPeriodId,
  };
}

describe("executeInstantWaiverClaim", () => {
  it("rejects a non-object payload", async () => {
    await expect(executeInstantWaiverClaim(null)).rejects.toMatchObject({
      permanent: true,
    });
    await expect(executeInstantWaiverClaim([1, 2])).rejects.toMatchObject({
      permanent: true,
    });
    await expect(executeInstantWaiverClaim("nope")).rejects.toMatchObject({
      permanent: true,
    });
  });

  it("rejects when ESPN_LEAGUE_ID is not set", async () => {
    delete process.env.ESPN_LEAGUE_ID;
    await expect(
      executeInstantWaiverClaim({ player_id: "100" }),
    ).rejects.toMatchObject({ permanent: true, message: /ESPN_LEAGUE_ID/ });
  });

  it("rejects when ESPN_TEAM_ID is not set", async () => {
    delete process.env.ESPN_TEAM_ID;
    await expect(
      executeInstantWaiverClaim({ player_id: "100" }),
    ).rejects.toMatchObject({ permanent: true, message: /ESPN_TEAM_ID/ });
  });

  it("rejects a non-numeric player_id", async () => {
    await expect(
      executeInstantWaiverClaim({ player_id: "not-a-number" }),
    ).rejects.toMatchObject({ permanent: true });
  });

  it("rejects when player_id and drop_player_id are the same", async () => {
    await expect(
      executeInstantWaiverClaim({ player_id: "100", drop_player_id: "100" }),
    ).rejects.toMatchObject({ permanent: true, message: /cannot be added and dropped/ });
  });

  it("is idempotent: add already on roster and no drop requested is a no-op", async () => {
    readRoster.mockResolvedValue(roster({ "100": 4 }));
    process.env.DRY_RUN = "false";

    await executeInstantWaiverClaim({ player_id: "100" });

    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });

  it("is idempotent: add and drop both already applied is a no-op", async () => {
    readRoster.mockResolvedValue(roster({ "100": 4 }));
    process.env.DRY_RUN = "false";

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "999" });

    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });

  it("submits only the drop when the add already landed", async () => {
    readRoster.mockResolvedValue(roster({ "100": 4 }));
    readRoster.mockResolvedValueOnce(roster({ "100": 4, "200": 20 }));
    process.env.DRY_RUN = "false";
    submitWaiverClaim.mockResolvedValue(undefined);

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "200" });

    expect(submitWaiverClaim).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ addPlayerId: null, dropPlayerId: "200" }),
    );
  });

  it("rejects when the drop target isn't on the roster and the add hasn't landed", async () => {
    readRoster.mockResolvedValue(roster({}));
    process.env.DRY_RUN = "false";

    await expect(
      executeInstantWaiverClaim({ player_id: "100", drop_player_id: "999" }),
    ).rejects.toMatchObject({
      permanent: true,
      message: /999 is not on team 8's roster/,
    });
    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });

  it("does not submit when DRY_RUN is unset (defaults true)", async () => {
    readRoster.mockResolvedValue(roster({}));

    await executeInstantWaiverClaim({ player_id: "100" });

    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });

  it("submits both add and drop on the happy path", async () => {
    readRoster.mockResolvedValueOnce(roster({ "200": 20 }));
    readRoster.mockResolvedValueOnce(roster({ "100": 20, "200": 20 }));
    process.env.DRY_RUN = "false";
    submitWaiverClaim.mockResolvedValue(undefined);

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "200" });

    expect(submitWaiverClaim).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        addPlayerId: "100",
        dropPlayerId: "200",
        memberId: "{TEST-SWID}",
        scoringPeriodId: 3,
        leagueId: "1234567890",
        teamId: "8",
      }),
    );
  });

  // ESPN gives a team defense a negative player id (#116): Team 8's Eagles D/ST is -16021.
  it("claims a D/ST off waivers by its negative id", async () => {
    readRoster.mockResolvedValueOnce(roster({ "200": 20 }));
    readRoster.mockResolvedValueOnce(roster({ "-16021": 20, "200": 20 }));
    process.env.DRY_RUN = "false";
    submitWaiverClaim.mockResolvedValue(undefined);

    await executeInstantWaiverClaim({ player_id: "-16021", drop_player_id: "200" });

    expect(submitWaiverClaim).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ addPlayerId: "-16021", dropPlayerId: "200" }),
    );
  });

  it("drops a rostered D/ST by its negative id", async () => {
    readRoster.mockResolvedValueOnce(roster({ "-16021": 16 }));
    readRoster.mockResolvedValueOnce(roster({ "-16030": 20 }));
    process.env.DRY_RUN = "false";
    submitWaiverClaim.mockResolvedValue(undefined);

    await executeInstantWaiverClaim({ player_id: "-16030", drop_player_id: "-16021" });

    expect(submitWaiverClaim).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ addPlayerId: "-16030", dropPlayerId: "-16021" }),
    );
  });

  it.each(["", "-", "-0", "-00", "-012", "--1", "+5", "1.5", "-1.5", "abc", " - 1"])(
    "rejects junk player_id %p",
    async (junk) => {
      await expect(executeInstantWaiverClaim({ player_id: junk })).rejects.toMatchObject({
        permanent: true,
        message: /player_id ".*" is not a valid numeric ESPN player id/,
      });
    },
  );

  // An empty drop_player_id means "no drop", so "" is not junk here.
  it.each(["-", "-0", "-00", "-012", "--1", "+5", "1.5", "-1.5", "abc", " - 1"])(
    "rejects junk drop_player_id %p",
    async (junk) => {
      await expect(
        executeInstantWaiverClaim({ player_id: "100", drop_player_id: junk }),
      ).rejects.toMatchObject({
        permanent: true,
        message: /drop_player_id ".*" is not a valid numeric ESPN player id/,
      });
    },
  );
});

describe("per-request dry_run override", () => {
  // clearMocks keeps queued mockResolvedValueOnce values, which would leak between these cases.
  beforeEach(() => readRoster.mockReset());

  it("submits when the request sets dry_run=false even though DRY_RUN is unset", async () => {
    delete process.env.DRY_RUN;
    readRoster.mockResolvedValueOnce(roster({ "200": 20 }));
    readRoster.mockResolvedValueOnce(roster({ "100": 20 }));
    submitWaiverClaim.mockResolvedValue(undefined);

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "200", dry_run: false });

    expect(submitWaiverClaim).toHaveBeenCalledTimes(1);
  });

  it("stays dry when the request sets dry_run=true even though DRY_RUN=false", async () => {
    readRoster.mockResolvedValue(roster({ "200": 20 }));
    process.env.DRY_RUN = "false";

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "200", dry_run: true });

    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });

  it.each([null, "false", 0])("ignores a non-boolean dry_run (%p) and keeps the env default", async (value) => {
    delete process.env.DRY_RUN;
    readRoster.mockResolvedValue(roster({ "200": 20 }));

    await executeInstantWaiverClaim({ player_id: "100", drop_player_id: "200", dry_run: value });

    expect(submitWaiverClaim).not.toHaveBeenCalled();
  });
});
