const { createAuthenticatedSession } = require("./auth");
const selectors = require("../selectors/espn_selectors.json");

/**
 * Lineup Realignment Automation Bot
 * Processes algebraic roster shifts under strict process cleanup fences.
 */
async function executeLineupAdjustments(payload) {
  const teamId = payload.team_id;
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const currentYear = process.env.CURRENT_YEAR || "2026";
  
  if (!payload.optimized_swaps || payload.optimized_swaps.length === 0) {
    console.log(`[Lineup Bot] No transaction swaps specified for Team ${teamId}. Aborting.`);
    return;
  }

  const targetUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${teamId}&seasonId=${currentYear}`;
  console.log(`[Lineup Bot] Commencing roster adjustment pass for Team ${teamId} at URL: ${targetUrl}`);
  
  let session = null;
  try {
    session = await createAuthenticatedSession();
    await session.page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    // Ensure the roster grid is fully rendered before evaluating elements
    await session.page.waitForSelector(selectors.roster_table, { timeout: 10000 });

    for (const swap of payload.optimized_swaps) {
      console.log(`[Lineup Bot] Processing swap sequence: Move Player ID ${swap.drop_player_id} to make room for Player ID ${swap.add_player_id}`);

      // Locate the precise row of the bench player using their unique ESPN data attribute
      const benchRow = session.page.locator(`tr[data-player-id="${swap.drop_player_id}"]`);
      if (!(await benchRow.count())) {
        console.error(`[Lineup Bot] Error: Player ID ${swap.drop_player_id} not located on active roster grid.`);
        continue;
      }

      // 1. Click the "Move" button on the target player row
      const moveBtn = benchRow.locator(selectors.move_button);
      await moveBtn.click();
      console.log("[Lineup Bot] Engaged Move selector. Awaiting target layout highlights...");

      // 2. Locate the row of the player currently in the starting slot to finalize the swap
      const starterRow = session.page.locator(`tr[data-player-id="${swap.add_player_id}"]`);
      if (!(await starterRow.count())) {
        console.error(`[Lineup Bot] Error: Destination Player ID ${swap.add_player_id} not located on active grid.`);
        continue;
      }

      // 3. Click the highlighted confirmation action button on the destination row
      const swapConfirmBtn = starterRow.locator(selectors.move_button);
      await swapConfirmBtn.click();
      console.log(`[Lineup Bot] Transaction locked successfully for position slot frame: ${swap.slot}`);
    }
  } catch (error) {
    console.error(`[Lineup Bot] Critical browser transaction runtime exception: ${error.message}`);
    throw error; // Bubble up error to force safe RabbitMQ re-queuing
  } finally {
    if (session && session.browser) {
      await session.browser.close();
      console.log("[Lineup Bot] Headless Chromium instance safely terminated. Memory cleared.");
    }
  }
}

module.exports = { executeLineupAdjustments };

