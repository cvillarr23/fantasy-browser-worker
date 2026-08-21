const {
  startFreshPracticeDraft,
  HeadlessLobbyJoinError,
} = require("../../src/bots/mock_draft");

/**
 * Fake locator: `attemptsBeforeSuccess` failures (rejects) before a click resolves; pass -1 to
 * always fail. Every locator on the fake page shares one underlying success/fail sequence so
 * tests can simulate "the Nth attempt across any selector strategy succeeds."
 *
 * `clickLog` (shared across every locator built for one fake page) records `label` for every
 * click ATTEMPT, in order — this is what lets a test assert not just "it eventually clicked
 * something" but which strategy actually fired and in what order, so a regression that reverts
 * the role=button-first ordering (PR #45's actual bug) fails a test instead of passing silently.
 */
function makeFakePage({
  url,
  attemptsBeforeSuccess,
  hangOnWaitForUrl = false,
  clickLog = [],
}) {
  let calls = 0;
  const locator = (label) => {
    const self = {
      click: async () => {
        calls += 1;
        clickLog.push(label);
        if (attemptsBeforeSuccess === -1 || calls <= attemptsBeforeSuccess) {
          throw new Error(`not found (call ${calls})`);
        }
      },
      first: () => self,
    };
    return self;
  };

  const contextListeners = {};
  return {
    goto: jest.fn(async () => {}),
    getByText: jest.fn(() => locator("text")),
    getByRole: jest.fn((role) => locator(`role=${role}`)),
    // hangOnWaitForUrl: never resolves — used to prove the headless-exhausted path throws
    // BEFORE awaiting activePagePromise, rather than idling out the 150s wait first (a test that
    // still hung it and had this resolve immediately couldn't distinguish the two).
    waitForURL: jest.fn(() =>
      hangOnWaitForUrl
        ? new Promise(() => {})
        : Promise.resolve().then(() => {
            url.current =
              "https://fantasy.espn.com/football/draft?leagueId=1&seasonId=2026&teamId=1";
          }),
    ),
    waitForTimeout: jest.fn(async () => {}),
    url: () => url.current,
    context: () => ({
      once: (event, cb) => {
        contextListeners[event] = cb;
      },
    }),
  };
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

describe("startFreshPracticeDraft", () => {
  it("headless + all attempts exhausted throws HeadlessLobbyJoinError without waiting on activePagePromise", async () => {
    const url = { current: "https://fantasy.espn.com/football/mockdraftlobby" };
    const page = makeFakePage({
      url,
      attemptsBeforeSuccess: -1,
      hangOnWaitForUrl: true,
    });

    // If the code incorrectly fell through to `await activePagePromise` after exhausting
    // retries, this would hang until Jest's default test timeout instead of rejecting promptly.
    await expect(
      startFreshPracticeDraft(page, silentLogger, { headless: true }),
    ).rejects.toBeInstanceOf(HeadlessLobbyJoinError);
  });

  it("headed + all attempts exhausted falls through to the existing manual-click wait (no regression)", async () => {
    const url = { current: "https://fantasy.espn.com/football/mockdraftlobby" };
    const page = makeFakePage({ url, attemptsBeforeSuccess: -1 });

    const result = await startFreshPracticeDraft(page, silentLogger, {
      headless: false,
    });

    expect(page.waitForURL).toHaveBeenCalled();
    expect(result.page).toBe(page);
  });

  it("succeeds on a later retry attempt and resolves normally", async () => {
    const url = { current: "https://fantasy.espn.com/football/mockdraftlobby" };
    const clickLog = [];
    // Fails the first two attempts across all three selector strategies (6 calls, in
    // role=button/role=link/text order each attempt), succeeds on the 7th call — role=button,
    // the first strategy tried on the third attempt.
    const page = makeFakePage({ url, attemptsBeforeSuccess: 6, clickLog });

    const result = await startFreshPracticeDraft(page, silentLogger, {
      headless: true,
    });

    expect(result.url).toBe(
      "https://fantasy.espn.com/football/draft?leagueId=1&seasonId=2026&teamId=1",
    );
    expect(clickLog).toEqual([
      "role=button",
      "role=link",
      "text",
      "role=button",
      "role=link",
      "text",
      "role=button",
    ]);
  });

  it("PR #45 regression: tries role=button before role=link/text, and never falls through to them once it succeeds", async () => {
    const url = { current: "https://fantasy.espn.com/football/mockdraftlobby" };
    const clickLog = [];
    // Succeeds on the very first click attempt -- the real button in the real bug this PR fixed
    // (the lobby's "League Specific Practice Draft" heading also matches the /practice draft/i
    // text pattern, and a getByText-first ordering would click that heading instead, silently
    // navigating nowhere). If role=button isn't tried first, this test's clickLog assertion below
    // fails even though the overall click still "succeeds" -- exactly the silent-regression gap
    // the reviewer flagged, since the old shared-locator fake couldn't distinguish which strategy
    // actually fired.
    const page = makeFakePage({ url, attemptsBeforeSuccess: 0, clickLog });

    const result = await startFreshPracticeDraft(page, silentLogger, {
      headless: true,
    });

    expect(clickLog).toEqual(["role=button"]);
    expect(page.getByRole).toHaveBeenCalledWith(
      "button",
      expect.objectContaining({ name: expect.anything() }),
    );
    expect(result.url).toBe(
      "https://fantasy.espn.com/football/draft?leagueId=1&seasonId=2026&teamId=1",
    );
  });
});
