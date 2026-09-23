const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const { buildTradePortalUrl } = require("./trade_bot");
const { captureDebugSnapshot } = require("./debug_capture");
const {
  tryLoadStoredSession,
  launchWithManualLogin,
  waitForEnter,
  OUTPUT_DIR,
} = require("./draft_recon");

/**
 * One-off recon tool — NOT part of the production worker pipeline.
 *
 * Prerequisite for issue #90's submitCounterOffer: nothing has ever touched ESPN's actual
 * trade-builder form (unlike the draft room, or the trade portal's read-only pending-trade
 * list — see trade_bot.js's scrapeTradePortalContent, confirmed live 2026-09-16/2026-09-22).
 * Run this by hand against a real pending trade to capture the form's DOM/network shape before
 * writing submitCounterOffer's real selectors — do not guess them.
 *
 * Usage:
 *   node src/bots/trade_recon.js
 *
 * Needs ESPN_LEAGUE_ID / ESPN_TEAM_ID / CURRENT_YEAR (same env vars negotiateTradeProposal and
 * scrapePendingTradeProposals already use) and a real pending trade waiting in that league/team's
 * trade portal.
 *
 * Auth: same priority order and same rationale as draft_recon.js (FORCE_MANUAL_LOGIN=1 -> saved
 * session -> cookie injection -> manual login) — the trade portal is a rendered page, so it's
 * subject to the same auth-surface split documented in docs/espn-reverse-engineering.md.
 * Reuses draft_recon.js's tryLoadStoredSession/launchWithManualLogin (and its
 * .espn-storage-state.json) directly rather than re-implementing them: that file is a
 * site-wide ESPN login, not draft-specific, so one real manual login serves both recon tools.
 */

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function appendJsonLine(filename, record) {
  fs.appendFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify({ capturedAt: new Date().toISOString(), ...record }) + "\n",
  );
}

// Fixed filename (truncated fresh each run, not timestamped) — same "check the latest run"
// convention draft_recon.js uses, kept in its own file so the two tools' logs don't interleave.
const LOG_FILE = path.join(OUTPUT_DIR, "trade-recon-latest.log");

function openLog() {
  ensureOutputDir();
  const stream = fs.createWriteStream(LOG_FILE, { flags: "w" });
  const write = (prefix, message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    (prefix === "error" ? console.error : console.log)(line);
    stream.write(line + "\n");
  };
  return {
    log: (message) => write("log", message),
    warn: (message) => write("log", message),
    error: (message) => write("error", message),
  };
}

/**
 * Wires request/response capture onto the page. Filters to same-origin, non-GET traffic (a
 * submission is far more likely to be a POST/PUT/PATCH than a GET) plus anything URL-matching
 * /trade/i regardless of method — broader than draft_recon.js's keyword filter since the
 * trade-builder's API shape is completely unknown going in.
 */
function attachPageListeners(pageToWatch, log) {
  pageToWatch.on("close", () =>
    log.log(`[Trade Recon] Page closed. Last known URL: ${pageToWatch.url()}`),
  );

  pageToWatch.on("request", (request) => {
    const url = request.url();
    if (!/espn\.com/i.test(url)) return;
    if (request.method() === "GET" && !/trade/i.test(url)) return;

    log.log(`[Trade Recon] Relevant HTTP request: ${request.method()} ${url}`);
    appendJsonLine("trade-http-requests.jsonl", {
      event: "request",
      method: request.method(),
      url,
      postData: request.postData(),
    });
  });

  pageToWatch.on("response", async (response) => {
    const url = response.url();
    if (!/espn\.com/i.test(url)) return;
    if (response.request().method() === "GET" && !/trade/i.test(url)) return;

    let body = null;
    try {
      body = await response.text();
    } catch {
      // Non-text/binary response, skip body capture.
    }

    log.log(`[Trade Recon] Relevant HTTP response: ${response.status()} ${url}`);
    appendJsonLine("trade-http-responses.jsonl", {
      event: "response",
      status: response.status(),
      url,
      body,
    });
  });
}

async function runTradeRecon() {
  const log = openLog();
  log.log(`[Trade Recon] Output directory: ${OUTPUT_DIR}`);
  log.log(`[Trade Recon] Log file: ${LOG_FILE}`);

  let session = null;
  try {
    // Same auth priority as draft_recon.js — see this file's header for why.
    if (process.env.FORCE_MANUAL_LOGIN) {
      session = await launchWithManualLogin();
    } else {
      session =
        (await tryLoadStoredSession()) ||
        (resolveEspnCookies()
          ? await createAuthenticatedSession({ headless: false })
          : await launchWithManualLogin());
    }

    const leagueId = process.env.ESPN_LEAGUE_ID;
    const teamId = process.env.ESPN_TEAM_ID;
    const currentYear = process.env.CURRENT_YEAR || "2026";
    const tradeUrl = buildTradePortalUrl(leagueId, currentYear, teamId);

    session.browser.on("disconnected", () =>
      log.log("[Trade Recon] Browser disconnected."),
    );

    attachPageListeners(session.page, log);
    session.context.on("page", (newPage) => {
      log.log(`[Trade Recon] New page/tab opened by the app: ${newPage.url()}`);
      attachPageListeners(newPage, log);
    });

    log.log(`[Trade Recon] Navigating to trade portal: ${tradeUrl}`);
    await session.page.goto(tradeUrl, { waitUntil: "networkidle", timeout: 20000 });
    await captureDebugSnapshot(session.page, "trade-recon-portal-loaded");
    log.log(
      "[Trade Recon] Portal loaded — captured debug-trade-recon-portal-loaded.html/.png.",
    );

    await waitForEnter(
      "[Trade Recon] Manually open the Counter/trade-builder flow for the pending trade now, " +
        "then press Enter once the builder form is visible... ",
    );
    await captureDebugSnapshot(session.page, "trade-recon-builder-opened");
    log.log(
      "[Trade Recon] Captured debug-trade-recon-builder-opened.html/.png. Every relevant " +
        `HTTP request/response since navigation is logged to ${OUTPUT_DIR}.`,
    );

    await waitForEnter(
      "[Trade Recon] Manually submit the counter-offer through ESPN's UI now (or go as far as " +
        "you're comfortable going), then press Enter once done... ",
    );
    await captureDebugSnapshot(session.page, "trade-recon-post-submit");
    log.log("[Trade Recon] Captured debug-trade-recon-post-submit.html/.png.");
  } catch (error) {
    log.error(`[Trade Recon] Fatal error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
    log.log(`[Trade Recon] Done. Review ${OUTPUT_DIR} for captured traffic.`);
  }
}

if (require.main === module) {
  runTradeRecon();
}

module.exports = { runTradeRecon };
