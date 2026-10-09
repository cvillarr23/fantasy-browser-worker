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
 * One-off recon tool for the team/roster page — NOT part of the production worker pipeline.
 * Sibling of draft_recon.js, same idea: capture what ESPN actually does rather than guessing.
 *
 * What the first run (2026-08-11, league 1234567890 team 8) established, and why lineup_bot.js
 * ended up API-driven:
 *   - `tr[data-player-id]` -> 0 matches. So does `tr[data-playerid]`, and so does a sweep for ANY
 *     attribute matching /player.?id/i. The roster DOM exposes no player identifier at all.
 *   - Rows carry only `data-idx` — a positional index, which WORKER-03 forbids relying on.
 *   - `.roster-table` -> 0 matches; the real table is `.Table` with `.Table__TR` rows.
 *   - settings.rosterSettings.lineupSlotCounts gave the verified slot map now in
 *     src/selectors/lineup_slots.json.
 *
 * What is STILL unverified, and the reason this script exists going forward: the write request.
 * Capturing the `transactions` POST that ESPN's UI sends on save requires an actual roster, and the
 * league had not drafted (mRoster returned entries: []). Once it has, run:
 *
 *   node src/bots/lineup_recon.js --watch-save
 *
 * then move a player and hit Save in the opened browser. The captured body goes to
 * recon-output/lineup-xhr.jsonl — diff it against what espn_api.js's submitLineup() sends.
 *
 * IR (lineupSlotId 21) moves: the snapshot lists each player's slot and ESPN injuryStatus. Pick a
 * BENCH player whose status is OUT or INJURY_RESERVE, so moving them back to the bench is an exact
 * revert. Run --watch-save and move them to IR, then back to the bench. lineup-xhr.jsonl records
 * both requests and ESPN's responses, including the rejection body for an ineligible player.
 *
 * Requires ESPN_LEAGUE_ID to select your league.
 *
 * Usage:
 *   node src/bots/lineup_recon.js               # DOM + selector probe + API snapshot
 *   node src/bots/lineup_recon.js --watch-save  # also record XHR while you save a lineup by hand
 *
 * Auth: ESPN_S2/SWID env vars, then OpenBao, then a visible browser you log into yourself.
 */

const LEAGUE_ID = (process.env.ESPN_LEAGUE_ID || "").trim();
const EXIT_CODE_FAILURE = 1;
const TEAM_ID = process.env.ESPN_TEAM_ID || "8";
const SEASON_ID = process.env.CURRENT_YEAR || "2026";

// Every selector the bots currently believe in, plus the alternatives worth testing against the
// real page. Mirrors the shape of recon-output/login-selector-probe.json.
const CANDIDATE_SELECTORS = [
  "tr[data-player-id]",
  "tr[data-playerid]",
  ".roster-table",
  ".Table",
  ".Table__TR",
  '[class*="player-column"]',
  'a[href*="/player/"]',
  'button:has-text("Move")',
  'button:has-text("Here")',
  'button:has-text("Save")',
  'button:has-text("Drop")',
];

function buildTeamUrl() {
  return `https://fantasy.espn.com/football/team?leagueId=${LEAGUE_ID}&teamId=${TEAM_ID}&seasonId=${SEASON_ID}`;
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

/** Counts matches for each candidate and records a sample element's attributes. */
async function probeSelectors(page) {
  const results = {};
  for (const selector of CANDIDATE_SELECTORS) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      let sampleAttributes = null;
      if (count > 0) {
        sampleAttributes = await locator
          .first()
          .evaluate((el) =>
            Object.fromEntries(
              [...el.attributes].map((a) => [a.name, a.value.slice(0, 80)]),
            ),
          );
      }
      results[selector] = { count, sampleAttributes };
    } catch (err) {
      results[selector] = { error: err.message };
    }
  }
  return results;
}

function isCapturedWrite(request) {
  if (!/espn\.com/i.test(request.url())) return false;
  if (!["xhr", "fetch"].includes(request.resourceType())) return false;
  return request.method() !== "GET"; // Only writes are interesting here.
}

/**
 * Records every espn.com XHR/fetch write and its response, which is how the save request gets
 * captured. The response matters as much as the request: ESPN's rejection body (`details[].type`,
 * e.g. for an IR-ineligible player) is only visible there.
 */
function recordApiTraffic(page) {
  page.on("request", (request) => {
    if (!isCapturedWrite(request)) return;

    appendJsonLine("lineup-xhr.jsonl", {
      event: "request",
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: request.postData(),
    });
    logger.info(`[Lineup Recon] Captured ${request.method()} ${request.url()}`);
  });

  page.on("response", async (response) => {
    const request = response.request();
    if (!isCapturedWrite(request)) return;

    let body;
    try {
      body = await response.text();
    } catch (err) {
      body = `<unreadable: ${err.message}>`;
    }
    appendJsonLine("lineup-xhr.jsonl", {
      event: "response",
      method: request.method(),
      url: response.url(),
      status: response.status(),
      body,
    });
    logger.info(`[Lineup Recon] Captured HTTP ${response.status()} for ${request.method()} ${response.url()}`);
  });
}

/** The roster snapshot written to lineup-roster-snapshot.json, with what's needed to pick an IR test player. */
function summarizeRoster(roster) {
  return {
    entryCount: roster.entryCount,
    scoringPeriodId: roster.scoringPeriodId,
    slotCounts: roster.slotCounts,
    lineupLocked: roster.lineupLocked,
    rosterLocked: roster.rosterLocked,
    slotByPlayerId: Object.fromEntries(roster.slotByPlayerId),
    players: [...roster.slotByPlayerId].map(([playerId, lineupSlotId]) => ({
      playerId,
      name: roster.nameByPlayerId.get(playerId) ?? null,
      lineupSlotId,
      injuryStatus: roster.injuryStatusByPlayerId.get(playerId) ?? null,
    })),
  };
}

async function runLineupRecon() {
  if (!LEAGUE_ID) {
    logger.error("[Lineup Recon] ESPN_LEAGUE_ID is required.");
    process.exitCode = EXIT_CODE_FAILURE;
    return;
  }

  const watchSave = process.argv.includes("--watch-save");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  logger.info(`[Lineup Recon] Output directory: ${OUTPUT_DIR}`);
  logger.info(
    `[Lineup Recon] Target: league ${LEAGUE_ID}, team ${TEAM_ID}, season ${SEASON_ID}`,
  );

  let session = null;
  try {
    // --watch-save needs a window you can actually click Save in, so it never runs headless.
    session = resolveEspnCookies()
      ? await createAuthenticatedSession({ headless: !watchSave })
      : await launchWithManualLogin();
    const { page } = session;

    if (watchSave) recordApiTraffic(page);

    await page.goto(buildTeamUrl(), {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    // 1. Raw DOM + screenshot.
    fs.writeFileSync(
      path.join(OUTPUT_DIR, "lineup-dom.html"),
      await page.content(),
    );
    await page.screenshot({
      path: path.join(OUTPUT_DIR, "lineup-screenshot.png"),
      fullPage: true,
    });

    // 2. Selector probe — the artifact that decides whether DOM automation is even viable.
    const probe = await probeSelectors(page);
    writeJson("lineup-selector-probe.json", probe);
    logger.info("[Lineup Recon] Selector probe:");
    for (const [selector, result] of Object.entries(probe)) {
      logger.info(
        `  ${String(result.count ?? "ERR").padStart(4)}  ${selector}`,
      );
    }

    // 3. Authoritative API snapshot — slot map and current assignments.
    const roster = await readRoster(session.context, {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      teamId: TEAM_ID,
    });
    writeJson("lineup-roster-snapshot.json", summarizeRoster(roster));
    logger.info(
      `[Lineup Recon] Roster: ${roster.entryCount} players, scoringPeriodId ${roster.scoringPeriodId}, ` +
        `locked=${roster.lineupLocked || roster.rosterLocked}`,
    );

    if (roster.entryCount === 0) {
      logger.warn(
        "[Lineup Recon] Roster is EMPTY — the draft hasn't happened. The Move/Here/Save controls " +
          "and the save request cannot be captured yet. Re-run this post-draft.",
      );
    }

    if (watchSave) {
      logger.info(
        "\n[Lineup Recon] --watch-save active. In the browser window, move a player and click Save.\n" +
          "Every non-GET espn.com XHR and its response is being written to recon-output/lineup-xhr.jsonl.",
      );
      await waitForEnter(
        "[Lineup Recon] Press Enter once you've saved a lineup change... ",
      );
    }
  } catch (error) {
    logger.error(`[Lineup Recon] Fatal error: ${error.message}`, {
      err: error,
    });
    process.exitCode = EXIT_CODE_FAILURE;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
    logger.info(`[Lineup Recon] Done. Review ${OUTPUT_DIR}.`);
  }
}

if (require.main === module) {
  runLineupRecon();
}

module.exports = {
  runLineupRecon,
  probeSelectors,
  recordApiTraffic,
  summarizeRoster,
  CANDIDATE_SELECTORS,
};
