const {
  assertCookieSessionValid,
  assertRenderedSessionValid,
} = require("../../src/bots/session_health");
const { PermanentError, SessionExpiredError } = require("../../src/errors");

function makeContext(status) {
  return {
    request: {
      get: jest.fn(async () => ({
        status: () => status,
        ok: () => status >= 200 && status < 300,
      })),
    },
  };
}

describe("assertCookieSessionValid", () => {
  it("resolves cleanly on a 200", async () => {
    const context = makeContext(200);
    await expect(
      assertCookieSessionValid(context, { leagueId: "1", seasonId: "2026" }),
    ).resolves.toBeUndefined();
  });

  it("throws SessionExpiredError on a 401", async () => {
    const context = makeContext(401);
    await expect(
      assertCookieSessionValid(context, { leagueId: "1", seasonId: "2026" }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("throws SessionExpiredError on a 403", async () => {
    const context = makeContext(403);
    await expect(
      assertCookieSessionValid(context, { leagueId: "1", seasonId: "2026" }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("throws a plain Error (not SessionExpiredError) on an unrelated failure like a 500", async () => {
    const context = makeContext(500);
    const promise = assertCookieSessionValid(context, {
      leagueId: "1",
      seasonId: "2026",
    });
    await expect(promise).rejects.not.toBeInstanceOf(SessionExpiredError);
    await expect(promise).rejects.toThrow(/500/);
  });

  it("throws PermanentError on a 404 — the league is gone, not just unreachable", async () => {
    const context = makeContext(404);
    const promise = assertCookieSessionValid(context, {
      leagueId: "1234567895",
      seasonId: "2026",
    });
    await expect(promise).rejects.toBeInstanceOf(PermanentError);
    await expect(promise).rejects.toThrow(/not found/);
  });
});

function makeFakePage({ finalUrl, rosterTableVisible }) {
  return {
    goto: jest.fn(async () => {}),
    url: () => finalUrl,
    waitForSelector: jest.fn(async () => {
      if (!rosterTableVisible) throw new Error("timeout waiting for selector");
    }),
  };
}

describe("assertRenderedSessionValid", () => {
  const target = { leagueId: "1", teamId: "8", seasonId: "2026" };

  it("resolves cleanly when the roster page renders", async () => {
    const page = makeFakePage({
      finalUrl: "https://fantasy.espn.com/football/team?leagueId=1&teamId=8&seasonId=2026",
      rosterTableVisible: true,
    });
    await expect(assertRenderedSessionValid(page, target)).resolves.toBeUndefined();
  });

  it("throws SessionExpiredError when redirected to a login page", async () => {
    const page = makeFakePage({
      finalUrl: "https://www.espn.com/login?redirectUrl=...",
      rosterTableVisible: true,
    });
    await expect(assertRenderedSessionValid(page, target)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it("throws SessionExpiredError when the roster table never renders", async () => {
    const page = makeFakePage({
      finalUrl: "https://fantasy.espn.com/football/team?leagueId=1&teamId=8&seasonId=2026",
      rosterTableVisible: false,
    });
    await expect(assertRenderedSessionValid(page, target)).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });
});
