const MOCK_LOBBY_URL = "https://fantasy.espn.com/football/mockdraftlobby";
// Unverified selector text beyond what draft_recon.js has already confirmed once — re-check if
// ESPN changes the lobby's copy/markup.
const PRACTICE_DRAFT_LINK_TEXT = /practice draft/i;
const DRAFT_ROOM_URL_PATTERN = /\/football\/draft/i;

// Bounded retry for the auto-click below — WORKER-17: a headless run has no human to fall back
// on, so it needs a real recovery strategy (try a couple of selector shapes, a couple of times)
// rather than a single attempt followed by a long unattended wait that can only ever pay off with
// a person watching.
const LOBBY_CLICK_ATTEMPTS = 3;
const LOBBY_CLICK_RETRY_DELAY_MS = 2000;
const LOBBY_CLICK_ATTEMPT_TIMEOUT_MS = 5000;

/** Thrown when the headless auto-click exhausts every attempt/strategy with no human to fall back on. */
class HeadlessLobbyJoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeadlessLobbyJoinError";
  }
}

/**
 * One click attempt against a single locator, bounded to a short per-attempt timeout (short
 * because this runs inside a retry loop — no point waiting long on a locator that isn't there).
 * Returns true on success, false on any failure (never throws) so the caller can just try the
 * next strategy/attempt.
 */
async function tryClick(locator, logger, label) {
  try {
    // click() starts its own actionability wait (visible, stable, receives events, etc.) with
    // Playwright's default 30s timeout if not given one explicitly — a visible-but-covered or
    // detached element would otherwise stall each retry far past LOBBY_CLICK_ATTEMPT_TIMEOUT_MS
    // (PR #42 review). Bounding it here keeps every attempt actually bounded to that window.
    await locator.click({ timeout: LOBBY_CLICK_ATTEMPT_TIMEOUT_MS });
    return true;
  } catch (err) {
    logger.warn(`[MockDraft] "${label}" click attempt failed: ${err.message}`);
    return false;
  }
}

/**
 * Navigates to the mock draft lobby and starts a brand-new practice draft, since practice draft
 * rooms are ephemeral and there's nothing durable to link to ahead of time.
 *
 * Retries the "Practice Draft" auto-click a few times across two selector strategies (text, then
 * a role-based fallback — the latter is untested defense-in-depth against a markup change, not a
 * confirmed second selector) before giving up. What happens after that split on `headless`:
 * headless has no human to fall back on, so it throws `HeadlessLobbyJoinError` immediately rather
 * than idling out the full activePagePromise wait below, which can only ever succeed with someone
 * present to click manually. Headed keeps today's behavior — log and let a person click it.
 *
 * WORKER-17 LIVE-RUN RISK, check this first if the headless auto-click above keeps failing:
 * draft_sync.js's DRAFT_ROOM_URL doc comment records an earlier, more specific finding
 * (2026-08-10, live-debugged) that ESPN's "League Specific Practice Draft" button — possibly a
 * different element than the generic "Practice Draft" text this file targets, possibly the same
 * one under an inconsistent description — triggers a DisneyID identity-verification flow gated by
 * the same reCAPTCHA Enterprise that blocks automated login. If so, no amount of retry/selector
 * hardening here fixes it; confirm live whether that gate still appears before assuming this
 * file's retry loop is sufficient for a fully headless join.
 *
 * Returns `{ url, page }` — NOT just a URL string (changed 2026-08-17). ESPN sometimes opens the
 * actual draft room in a brand-new tab/window rather than navigating the current page in place
 * (confirmed via draft_recon.js diagnostics: a new page appeared carrying the draft URL while the
 * original page stayed on the lobby; the old code only ever watched the original page for a URL
 * change that could never come there, which eventually timed out and tore down the whole
 * session). Callers MUST use the returned `page`, not whatever page they originally passed in —
 * it may be a different object.
 */
async function startFreshPracticeDraft(page, logger = console, { headless = false } = {}) {
  logger.log("[MockDraft] Navigating to mock draft lobby to start a fresh practice draft...");
  await page.goto(MOCK_LOBBY_URL, { waitUntil: "load", timeout: 60000 });

  const context = page.context();

  // Race both possibilities — the original page navigating in place, or a new page opening and
  // navigating there — set up BEFORE attempting the click, so it's already listening no matter
  // who ends up clicking "Practice Draft" (our auto-click, or a human, in a headed session).
  const activePagePromise = Promise.race([
    page.waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 150000 }).then(() => page),
    new Promise((resolve, reject) => {
      context.once("page", (newPage) => {
        newPage
          .waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 150000 })
          .then(() => resolve(newPage))
          .catch(reject);
      });
    }),
  ]);
  // Marks the race as handled immediately, independent of whatever later actually awaits it —
  // matters because the headless-exhausted branch below can throw before that `await
  // activePagePromise` ever runs. Left unhandled, the caller then closes the browser (per its own
  // catch/finally), which rejects the abandoned page.waitForURL()/context "page" listener with no
  // handler in sight, and Node's unhandled-rejection behavior can crash the process outright
  // instead of the intended HeadlessLobbyJoinError propagating cleanly (PR #42 review).
  activePagePromise.catch(() => {});

  let clicked = false;
  for (let attempt = 1; attempt <= LOBBY_CLICK_ATTEMPTS && !clicked; attempt += 1) {
    if (attempt > 1) {
      await page.waitForTimeout(LOBBY_CLICK_RETRY_DELAY_MS);
    }
    clicked =
      (await tryClick(page.getByText(PRACTICE_DRAFT_LINK_TEXT).first(), logger, "text")) ||
      (await tryClick(
        page.getByRole("link", { name: PRACTICE_DRAFT_LINK_TEXT }),
        logger,
        "role=link",
      )) ||
      (await tryClick(
        page.getByRole("button", { name: PRACTICE_DRAFT_LINK_TEXT }),
        logger,
        "role=button",
      ));
  }

  if (!clicked) {
    if (headless) {
      throw new HeadlessLobbyJoinError(
        `[MockDraft] Headless auto-click exhausted ${LOBBY_CLICK_ATTEMPTS} attempts across all ` +
          "selector strategies — no human available to click manually. Aborting practice-draft join.",
      );
    }
    logger.warn(
      `[MockDraft] Couldn't auto-click "Practice Draft" after ${LOBBY_CLICK_ATTEMPTS} attempts. ` +
        "If this is a headed session, click it yourself now — waiting up to 2.5 minutes for the " +
        "draft room to load (either the current tab or a new one)...",
    );
  }

  const activePage = await activePagePromise;
  logger.log(`[MockDraft] In a fresh practice draft room: ${activePage.url()}`);
  return { url: activePage.url(), page: activePage };
}

/** Pulls leagueId/seasonId/teamId/memberId back out of a draft room URL. */
function parseDraftRoomUrl(url) {
  const parsed = new URL(url);
  return {
    leagueId: parsed.searchParams.get("leagueId"),
    seasonId: parsed.searchParams.get("seasonId"),
    teamId: parsed.searchParams.get("teamId"),
    memberId: parsed.searchParams.get("memberId"),
  };
}

module.exports = {
  MOCK_LOBBY_URL,
  PRACTICE_DRAFT_LINK_TEXT,
  DRAFT_ROOM_URL_PATTERN,
  HeadlessLobbyJoinError,
  startFreshPracticeDraft,
  parseDraftRoomUrl,
};
