const { createAuthenticatedSession } = require("./auth");
const selectors = require("../selectors/espn_selectors.json");

/**
 * 1-Click Automated Draft Execution Bot
 * Executes high-speed player selections inside active draft frames.
 */
async function executeAutomatedDraftSelection(payload) {
  const targetId = payload.player_id;
  const targetName = payload.name;
  console.log(`[Draft Clicker] TARGET ASSIGNED: Locking in pick selection for: "${targetName}" (ID: ${targetId})`);

  // Share active context properties with the live tracking frame to prevent dual login conflicts
  let session = null;
  try {
    session = await createAuthenticatedSession();
    const leagueId = process.env.ESPN_LEAGUE_ID;
    await session.page.goto(`https://fantasy.espn.com/football/draft?leagueId=${leagueId}`, { waitUntil: "networkidle" });

    // 1. Locate search component, clear inputs, and fill name target properties
    await session.page.waitForSelector(selectors.search_input, { timeout: 5000 });
    await session.page.locator(selectors.search_input).fill(targetName);
    
    // 2. Isolate the target player row directly using their custom attribute signature
    const targetPlayerRow = session.page.locator(`tr[data-player-id="${targetId}"]`);
    await session.page.waitForSelector(`tr[data-player-id="${targetId}"]`, { timeout: 5000 });

    // 3. Fire the automated selection click on the active draft button selector
    const draftButtonElement = targetPlayerRow.locator(selectors.draft_button);
    await draftButtonElement.click();
    
    console.log(`[Draft Clicker] SUCCESS: Automated selection committed cleanly. Welcome to the team, ${targetName}.`);
  } catch (error) {
    console.error(`[Draft Clicker] Selection bot failed to input or commit transaction element: ${error.message}`);
    throw error;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

module.exports = { executeAutomatedDraftSelection };

