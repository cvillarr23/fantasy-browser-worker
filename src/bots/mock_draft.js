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
async function startFreshPracticeDraft(page) {
  console.log("[MockDraft] Navigating to mock draft lobby to start a fresh practice draft...");
  await page.goto(MOCK_LOBBY_URL, { waitUntil: "load", timeout: 60000 });

  try {
    const practiceLink = page.getByText(PRACTICE_DRAFT_LINK_TEXT).first();
    await practiceLink.waitFor({ timeout: 15000 });
    await Promise.all([
      page.waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 30000 }),
      practiceLink.click(),
    ]);
  } catch (err) {
    console.warn(
      `[MockDraft] Couldn't auto-start a practice draft (${err.message}). If this is a headed ` +
        "session, click \"Practice Draft\" yourself now — waiting up to 2 minutes for the draft " +
        "room to load..."
    );
    await page.waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 120000 });
  }

  console.log(`[MockDraft] In a fresh practice draft room: ${page.url()}`);
  return page.url();
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
