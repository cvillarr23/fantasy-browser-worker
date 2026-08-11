/* eslint-env browser */
// The page.evaluate() callback below runs inside the browser page, not Node — document/window
// are real globals there, hence the browser env for this file.
const { createAuthenticatedSession } = require("./auth");

/**
 * Automated Trade Proposal Scraper
 * Extracts unstructured transaction text to feed into the cloud LLM strategy brain.
 */
async function scrapePendingTradeProposals() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const currentYear = process.env.CURRENT_YEAR || "2026";
  const tradeUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${currentYear}`;
  
  console.log(`[Trade Scraper] Scanning portal execution files for incoming offers at: ${tradeUrl}`);
  
  let session = null;
  try {
    session = await createAuthenticatedSession();
    await session.page.goto(tradeUrl, { waitUntil: "networkidle", timeout: 20000 });

    // Wait for the main trade transaction layout overview component to render
    await session.page.waitForSelector(".trade-container, .no-pending-trades", { timeout: 10000 });
    
    // Extract raw block text entries directly from active elements to pass down to Claude over MCP
    const proposalContentText = await session.page.evaluate(() => {
      const tradeCards = document.querySelectorAll(".trade-card-wrapper");
      if (tradeCards.length === 0) return "NO_PENDING_PROPOSALS";
      
      return Array.from(tradeCards).map(card => card.innerText.replace(/\s+/g, " ").strip()).join(" | ");
    });

    console.log(`[Trade Scraper] Extraction loop finished cleanly. Payload: "${proposalContentText}"`);
    return proposalContentText;
    
  } catch (error) {
    console.error(`[Trade Scraper] Failed to extract page details from trade matrix portal: ${error.message}`);
    return null;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

module.exports = { scrapePendingTradeProposals };

