const MOCK_LOBBY_URL = "https://fantasy.espn.com/football/mockdraftlobby";
// Unverified selector text beyond what draft_recon.js has already confirmed once — re-check if
// ESPN changes the lobby's copy/markup.
const PRACTICE_DRAFT_LINK_TEXT = /practice draft/i;
const DRAFT_ROOM_URL_PATTERN = /\/football\/draft/i;

/**
 * Navigates to the mock draft lobby and starts a brand-new practice draft, since practice draft
 * rooms are ephemeral and there's nothing durable to link to ahead of time. Falls back to letting
 * a human click it if the auto-click selector doesn't match ESPN's current lobby markup — only
 * useful when `page` is on a visible/headed browser, so headless test runs should treat that
 * timeout as a real failure rather than something a person will resolve.
 */
/**
 * Returns `{ url, page }` — NOT just a URL string (changed 2026-08-17). ESPN sometimes opens the
 * actual draft room in a brand-new tab/window rather than navigating the current page in place
 * (confirmed via draft_recon.js diagnostics: a new page appeared carrying the draft URL while the
 * original page stayed on the lobby; the old code only ever watched the original page for a URL
 * change that could never come there, which eventually timed out and tore down the whole
 * session). Callers MUST use the returned `page`, not whatever page they originally passed in —
 * it may be a different object.
 */
async function startFreshPracticeDraft(page, logger = console) {
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

  try {
    const practiceLink = page.getByText(PRACTICE_DRAFT_LINK_TEXT).first();
    await practiceLink.waitFor({ timeout: 15000 });
    await practiceLink.click();
  } catch (err) {
    logger.warn(
      `[MockDraft] Couldn't auto-click "Practice Draft" (${err.message}). If this is a headed ` +
        "session, click it yourself now — waiting up to 2.5 minutes for the draft room to load " +
        "(either the current tab or a new one)..."
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
  startFreshPracticeDraft,
  parseDraftRoomUrl,
};
