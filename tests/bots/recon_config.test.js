jest.mock("../../src/bots/auth", () => ({
  resolveEspnCookies: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));
jest.mock("../../src/bots/draft_recon", () => ({
  launchWithManualLogin: jest.fn(),
  waitForEnter: jest.fn(),
  OUTPUT_DIR: "unused-recon-output",
}));
jest.mock("../../src/telemetry/logger", () => ({
  logger: { error: jest.fn(), info: jest.fn() },
}));

const fs = require("fs");

const reconTools = [
  ["lineup_recon", "runLineupRecon"],
  ["waiver_recon", "runWaiverRecon"],
];

describe.each(reconTools)("%s league configuration", (moduleName, entrypoint) => {
  const originalLeagueId = process.env.ESPN_LEAGUE_ID;
  const originalExitCode = process.exitCode;
  let mkdirSpy;

  beforeEach(() => {
    jest.resetModules();
    mkdirSpy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = originalExitCode;
    if (originalLeagueId === undefined) delete process.env.ESPN_LEAGUE_ID;
    else process.env.ESPN_LEAGUE_ID = originalLeagueId;
  });

  it.each([undefined, "", "   "])("fails before filesystem or auth work for league ID %p", async (leagueId) => {
    if (leagueId === undefined) delete process.env.ESPN_LEAGUE_ID;
    else process.env.ESPN_LEAGUE_ID = leagueId;
    const auth = require("../../src/bots/auth");
    const { launchWithManualLogin } = require("../../src/bots/draft_recon");
    const { logger } = require("../../src/telemetry/logger");
    const run = require(`../../src/bots/${moduleName}`)[entrypoint];

    await run();

    expect(process.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("ESPN_LEAGUE_ID is required"));
    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(auth.resolveEspnCookies).not.toHaveBeenCalled();
    expect(auth.createAuthenticatedSession).not.toHaveBeenCalled();
    expect(launchWithManualLogin).not.toHaveBeenCalled();
  });

  it("uses the configured league when opening the recon page", async () => {
    process.env.ESPN_LEAGUE_ID = " 1234567890 ";
    const auth = require("../../src/bots/auth");
    const page = { goto: jest.fn().mockRejectedValue(new Error("Stop after navigation")) };
    const browser = { close: jest.fn() };
    auth.resolveEspnCookies.mockReturnValue({});
    auth.createAuthenticatedSession.mockResolvedValue({ page, browser });
    const run = require(`../../src/bots/${moduleName}`)[entrypoint];

    await run();

    expect(page.goto).toHaveBeenCalledWith(
      expect.stringContaining("leagueId=1234567890&"),
      expect.any(Object),
    );
    expect(browser.close).toHaveBeenCalled();
  });
});
