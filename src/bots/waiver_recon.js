const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const {
  launchWithManualLogin,
  waitForEnter,
  OUTPUT_DIR,
} = require("./draft_recon");
const { readRoster } = require("./espn_api");
const { logger } = require("../telemetry/logger");

/**
 * One-off recon tool for the free-agent/waiver add flow — NOT part of the production worker
 * pipeline. Sibling of lineup_recon.js, same purpose: capture what ESPN's own UI actually sends
 * on a real add/waiver claim, rather than trusting espn_api.js's submitWaiverClaim(), which is
 * currently an UNVERIFIED shape modeled on submitLineup() plus public reverse-engineering
 * knowledge of this endpoint family (see that function's header).
 *
 * What this is specifically for confirming:
 *   - The top-level `type` ESPN's client actually sends for an immediate free-agent pickup
 *     ("FREEAGENT" is only a guess here) vs an in-window waiver claim (may be "WAIVER", may carry
 *     a FAAB `bidAmount`, may not use `executionType: "EXECUTE"` at all since it's queued rather
 *     than immediate).
 *   - Whether a same-transaction drop uses item `type: "DROP"` the way this guesses, or something
 *     else.
 *
 * Usage:
 *   node src/bots/waiver_recon.js               # roster snapshot only
 *   node src/bots/waiver_recon.js --watch-save  # also record XHR while you add/claim a player by hand
 *
 * Auth: ESPN_S2/SWID env vars, then OpenBao, then a visible browser you log into yourself.
 */

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID || "1248158344";
const TEAM_ID = process.env.ESPN_TEAM_ID || "8";
const SEASON_ID = process.env.CURRENT_YEAR || "2026";

function buildFreeAgentUrl() {
  return `https://fantasy.espn.com/football/players/add?leagueId=${LEAGUE_ID}&seasonId=${SEASON_ID}`;
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify(data, null, 2),
  );
}

function appendJsonLine(filename, record) {
  fs.appendFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify({ capturedAt: new Date().toISOString(), ...record }) + "\n",
  );
}

/** Records every espn.com XHR/fetch, which is how the add/claim request gets captured. */
function recordApiTraffic(page) {
  page.on("request", (request) => {
    const url = request.url();
    if (!/espn\.com/i.test(url)) return;
    if (!["xhr", "fetch"].includes(request.resourceType())) return;
    if (request.method() === "GET") return; // Only writes are interesting here.

    appendJsonLine("waiver-xhr.jsonl", {
      event: "request",
      method: request.method(),
      url,
      headers: request.headers(),
      body: request.postData(),
    });
    logger.info(`[Waiver Recon] Captured ${request.method()} ${url}`);
  });
}

async function runWaiverRecon() {
  const watchSave = process.argv.includes("--watch-save");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  logger.info(`[Waiver Recon] Output directory: ${OUTPUT_DIR}`);
  logger.info(
    `[Waiver Recon] Target: league ${LEAGUE_ID}, team ${TEAM_ID}, season ${SEASON_ID}`,
  );

  let session = null;
  try {
    // --watch-save needs a window you can actually click Add/Claim in, so it never runs headless.
    session = resolveEspnCookies()
      ? await createAuthenticatedSession({ headless: !watchSave })
      : await launchWithManualLogin();
    const { page } = session;

    if (watchSave) recordApiTraffic(page);

    await page.goto(buildFreeAgentUrl(), {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, "waiver-dom.html"),
      await page.content(),
    );
    await page.screenshot({
      path: path.join(OUTPUT_DIR, "waiver-screenshot.png"),
      fullPage: true,
    });

    const roster = await readRoster(session.context, {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      teamId: TEAM_ID,
    });
    writeJson("waiver-roster-snapshot.json", {
      entryCount: roster.entryCount,
      scoringPeriodId: roster.scoringPeriodId,
      slotByPlayerId: Object.fromEntries(roster.slotByPlayerId),
    });
    logger.info(
      `[Waiver Recon] Roster: ${roster.entryCount} players, scoringPeriodId ${roster.scoringPeriodId}.`,
    );

    if (watchSave) {
      logger.info(
        "\n[Waiver Recon] --watch-save active. In the browser window, add or claim a free agent " +
          "(and, separately if possible, submit an actual in-window waiver claim rather than an " +
          "immediate pickup, to see whether the shape differs).\n" +
          "Every non-GET espn.com XHR is being written to recon-output/waiver-xhr.jsonl.",
      );
      await waitForEnter(
        "[Waiver Recon] Press Enter once you've submitted a claim... ",
      );
    }
  } catch (error) {
    logger.error(`[Waiver Recon] Fatal error: ${error.message}`, {
      err: error,
    });
    process.exitCode = 1;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
    logger.info(`[Waiver Recon] Done. Review ${OUTPUT_DIR}.`);
  }
}

if (require.main === module) {
  runWaiverRecon();
}

module.exports = { runWaiverRecon };
