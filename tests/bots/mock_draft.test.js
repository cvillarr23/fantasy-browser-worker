const {
  startFreshPracticeDraft,
  HeadlessLobbyJoinError,
} = require("../../src/bots/mock_draft");

/**
 * Fake locator: `attemptsBeforeSuccess` failures (rejects) before a click resolves; pass -1 to
 * always fail. Every locator on the fake page shares one underlying success/fail sequence so
 * tests can simulate "the Nth attempt across any selector strategy succeeds."
 */
function makeFakePage({ url, attemptsBeforeSuccess, hangOnWaitForUrl = false }) {
  let calls = 0;
  const locator = () => {
    const self = {
      click: async () => {
        calls += 1;
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
    getByText: jest.fn(locator),
    getByRole: jest.fn(locator),
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
    // Fails the first two attempts across all three selector strategies (6 calls), succeeds on
    // the 7th call — the first strategy ("text") of the third attempt.
    const page = makeFakePage({ url, attemptsBeforeSuccess: 6 });

    const result = await startFreshPracticeDraft(page, silentLogger, {
      headless: true,
    });

    expect(result.url).toBe(
      "https://fantasy.espn.com/football/draft?leagueId=1&seasonId=2026&teamId=1",
    );
  });
});
