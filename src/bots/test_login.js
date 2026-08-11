const { createAuthenticatedSession } = require("./auth");
const selectors = require("../selectors/espn_selectors.json");

async function runLoginDiagnostic() {
  console.log("[Diagnostic Bot] Commencing programmatic portal verification loop...");
  
  const leagueId = process.env.ESPN_LEAGUE_ID || "12345678";
  const teamId = process.env.ESPN_TEAM_ID || "1";
  const currentYear = process.env.CURRENT_YEAR || "2026";
  
  const targetUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${teamId}&seasonId=${currentYear}`;
  let session = null;

  try {
    // 1. Spawns our pre-authenticated browser thread context matrix
    session = await createAuthenticatedSession();
    
    console.log(`[Diagnostic Bot] Directing navigation timeline to endpoint: ${targetUrl}`);
    await session.page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    console.log("[Diagnostic Bot] Parsing webpage DOM layer to evaluate authentication success...");
    
    // 2. Perform a state verification check using the global selector file parameters
    // If the authentication cookies failed, the page would redirect to public login views, missing this table element
    await session.page.waitForSelector(selectors.roster_table, { timeout: 10000 });
    
    const pageTitle = await session.page.title();
    console.log(`[Diagnostic Bot] SUCCESS: Connected cleanly. Dashboard Title: "${pageTitle}"`);
    console.log("[Diagnostic Bot] Roster transaction grid rendered successfully. Pod environment verified operational.");
    
  } catch (error) {
    console.error(`[Diagnostic Bot] FAILURE: Authentication routing blocked or timed out: ${error.message}`);
    
    // Capture a debugging file snapshot inside the container workspace if a failure occurs to ease troubleshooting
    if (session && session.page) {
      try {
        await session.page.screenshot({ path: "auth_failure_diagnostics.png" });
        console.log("[Diagnostic Bot] Diagnostic visual screenshot captured successfully at: auth_failure_diagnostics.png");
      } catch (screenshotErr) {
        console.error(`[Diagnostic Bot] Critical snapshot failure: ${screenshotErr.message}`);
      }
    }
    process.exit(1);
  } finally {
    // 3. Always clean up browser instances to protect the 12GB host cluster limit
    if (session && session.browser) {
      await session.browser.close();
      console.log("[Diagnostic Bot] Terminated browser session context cleanly.");
    }
  }
}

if (require.main === module) {
  runLoginDiagnostic();
}

