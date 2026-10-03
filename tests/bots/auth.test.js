const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("playwright", () => ({ chromium: { launch: jest.fn() } }));
const { chromium } = require("playwright");
const { createSessionFromStoredState } = require("../../src/bots/auth");

const ENV_KEYS = ["ESPN_SESSION_STATE_FILE", "ESPN_LEAGUE_ID", "CURRENT_YEAR"];
let savedEnv;
let tmpDir;

function writeState(cookies) {
  const file = path.join(tmpDir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ cookies, origins: [] }));
  process.env.ESPN_SESSION_STATE_FILE = file;
}

const inAWeek = () => Math.floor(Date.now() / 1000) + 7 * 86400;
const loggedInCookies = () => [
  { name: "espn_s2", value: "s2", domain: ".espn.com", path: "/", expires: inAWeek() },
  { name: "SWID", value: "{SWID}", domain: ".espn.com", path: "/", expires: inAWeek() },
];

function fakeBrowser({ status = 200, getThrows = null } = {}) {
  const get = jest.fn(async () => {
    if (getThrows) throw getThrows;
    return { status: () => status, ok: () => status >= 200 && status < 300 };
  });
  const context = {
    newPage: jest.fn(async () => ({})),
    cookies: jest.fn(async () => [{ name: "SWID", value: "{SWID}" }]),
    request: { get },
  };
  const browser = { newContext: jest.fn(async () => context), close: jest.fn(async () => {}) };
  chromium.launch.mockResolvedValue(browser);
  return { browser, context, get };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.CURRENT_YEAR = "2026";
  chromium.launch.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("createSessionFromStoredState: stale stored login (#128)", () => {
  it("returns the stored session after ESPN accepts it on an authenticated league read", async () => {
    writeState(loggedInCookies());
    const { browser, get } = fakeBrowser();

    const session = await createSessionFromStoredState();

    expect(session).toMatchObject({ browser, swid: "{SWID}" });
    expect(get).toHaveBeenCalledWith(
      "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1248158344?view=mTeam",
      { timeout: 5000 },
    );
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("returns null without launching Chromium when the stored espn_s2 has expired", async () => {
    const cookies = loggedInCookies();
    cookies[0].expires = Math.floor(Date.now() / 1000) - 60;
    writeState(cookies);

    await expect(createSessionFromStoredState()).resolves.toBeNull();
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("returns null when the stored state has no espn_s2 at all", async () => {
    writeState(loggedInCookies().slice(1));

    await expect(createSessionFromStoredState()).resolves.toBeNull();
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "returns null and closes the browser when ESPN rejects the stored login (HTTP %i)",
    async (status) => {
      writeState(loggedInCookies());
      const { browser } = fakeBrowser({ status });

      await expect(createSessionFromStoredState()).resolves.toBeNull();
      expect(browser.close).toHaveBeenCalled();
    },
  );

  it("keeps the stored session when the check itself can't complete (network error or 5xx)", async () => {
    writeState(loggedInCookies());
    fakeBrowser({ getThrows: new Error("ECONNRESET") });
    await expect(createSessionFromStoredState()).resolves.not.toBeNull();

    fakeBrowser({ status: 503 });
    await expect(createSessionFromStoredState()).resolves.not.toBeNull();
  });

  it("skips the live check when no league is configured", async () => {
    delete process.env.ESPN_LEAGUE_ID;
    writeState(loggedInCookies());
    const { get } = fakeBrowser();

    await expect(createSessionFromStoredState()).resolves.not.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps a session-lifetime espn_s2 (expires -1) and lets the live check decide", async () => {
    const cookies = loggedInCookies();
    cookies[0].expires = -1;
    writeState(cookies);
    fakeBrowser();

    await expect(createSessionFromStoredState()).resolves.not.toBeNull();
  });
});
