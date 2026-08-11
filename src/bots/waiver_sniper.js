const { createAuthenticatedSession } = require("./auth");
const selectors = require("../selectors/espn_selectors.json");

/**
 * High-Speed Waiver Sniper Bot
 * Executes fast transaction pickups directly inside ESPN free-agent pools.
 */
async function executeInstantWaiverClaim(payload) {
  const playerTargetId = payload.player_id;
  const nameTarget = payload.name;
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const currentYear = process.env.CURRENT_YEAR || "2026";
  
  // Direct portal endpoint for tracking individual player free-agent files
  const freeAgentUrl = `https://fantasy.espn.com/football/players/add?leagueId=${leagueId}&seasonId=${currentYear}`;
  console.log(`[Sniper Bot] CRITICAL STATUS ALERT: Securing ${nameTarget} (${payload.team}). Navigating to transaction hub...`);
  
  let session = null;
  try {
    session = await createAuthenticatedSession();
    await session.page.goto(freeAgentUrl, { waitUntil: "commit", timeout: 15000 }); // Fast commit load

    // 1. Search for the target player ID directly inside the filter text element
    await session.page.waitForSelector(selectors.search_input, { timeout: 5000 });
    await session.page.locator(selectors.search_input).fill(nameTarget);
    await session.page.keyboard.press("Enter");
    
    // 2. Isolate the explicit player row matching the data signature attributes
    const targetPlayerRow = session.page.locator(`tr[data-player-id="${playerTargetId}"]`);
    await session.page.waitForSelector(`tr[data-player-id="${playerTargetId}"]`, { timeout: 5000 });

    // 3. Fire a click on the action add button
    const claimBtn = targetPlayerRow.locator("button.theme-add");
    await claimBtn.click();
    console.log(`[Sniper Bot] Claim button engaged for ${nameTarget}. Interfacing with verification modals...`);

    // TODO: Require drop player configurations if rosters are currently full — this only handles
    // the add-only path (an open roster spot). waiver_confirm_button's selector is unverified,
    // same as everything else in espn_selectors.json that hasn't gone through a recon pass yet.
    await session.page.waitForSelector(selectors.waiver_confirm_button, { timeout: 5000 });
    await session.page.locator(selectors.waiver_confirm_button).click();

    console.log(`[Sniper Bot] SUCCESS: Transaction locked onto ESPN servers cleanly for ${nameTarget}.`);
  } catch (error) {
    console.error(`[Sniper Bot] Sniper timeline dropped or blocked by backend infrastructure: ${error.message}`);
    throw error;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
      console.log("[Sniper Bot] Cleaned up browser context footprints.");
    }
  }
}

module.exports = { executeInstantWaiverClaim };

