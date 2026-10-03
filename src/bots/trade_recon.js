/* eslint-env browser */
// dumpRows' page.evaluate() callback runs inside the browser page, hence the browser env.
const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const { buildTradePortalUrl } = require("./trade_bot");
const { buildTradeBuilderUrl, installWriteGuard } = require("./trade_builder");
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
 * Verifies trade_builder.js's (#90) trade_* selectors in espn_selectors.json against the real
 * trade-builder page, WITHOUT SENDING ANYTHING. We only have the live league, so this runs
 * trade_builder.js's write guard for the whole session: every non-GET request to an ESPN host is
 * aborted and logged. The operator ticks boxes and clicks Continue by hand, and the tool captures
 * DOM/screenshot/network at each step plus a per-row dump of what each table row exposes
 * (headshot src, text, checkbox type), then clicks Cancel Trade. It never clicks the final submit,
 * so the final-submit request body stays uncaptured until a sandbox league (or a deliberate,
 * human-sent offer) is available.
 *
 * Usage:
 *   TRADE_RECON_TO_TEAM_ID=3 node src/bots/trade_recon.js
 *
 * Needs ESPN_LEAGUE_ID / ESPN_TEAM_ID / CURRENT_YEAR (same env vars negotiateTradeProposal and
 * scrapePendingTradeProposals already use), plus TRADE_RECON_TO_TEAM_ID, the other manager's team
 * whose roster the builder shows on the left.
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
const SELECTORS = require("../selectors/espn_selectors.json");

/**
 * Per-row dump of what the trade builder exposes, the evidence for promoting trade_* selectors to
 * `_verified`: does each row carry a headshot whose src embeds the ESPN id? What text does a D/ST
 * row show? Is the checkbox a real <input> or an ARIA widget, and is it reported as checked?
 */
async function dumpRows(page, label, log) {
  const rows = await page.evaluate(
    ({ rowSel, checkboxSel }) =>
      Array.from(document.querySelectorAll(rowSel)).map((row, index) => {
        const box = row.querySelector(checkboxSel);
        return {
          index,
          text: row.innerText.replace(/\s+/g, " ").trim().slice(0, 120),
          imgSrcs: Array.from(row.querySelectorAll("img")).map((img) => img.getAttribute("src")),
          checkbox: box
            ? {
                tag: box.tagName,
                type: box.getAttribute("type"),
                role: box.getAttribute("role"),
                checked: box.checked ?? null,
                ariaChecked: box.getAttribute("aria-checked"),
              }
            : null,
        };
      }),
    { rowSel: SELECTORS.trade_player_row, checkboxSel: SELECTORS.trade_player_checkbox },
  );
  appendJsonLine("trade-recon-rows.jsonl", { label, rows });
  log.log(`[Trade Recon] ${label}: ${rows.length} row(s) matched trade_player_row, dumped to trade-recon-rows.jsonl.`);
}

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

    // On the whole BrowserContext (not just this page) and before any navigation, so nothing the
    // operator clicks, including in a popup the app opens, can send. Page and context share route().
    const guard = await installWriteGuard(session.context);

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

    const toTeamId = process.env.TRADE_RECON_TO_TEAM_ID;
    if (!toTeamId) {
      throw new Error("TRADE_RECON_TO_TEAM_ID is not set — which team's trade builder to open?");
    }
    const builderUrl = buildTradeBuilderUrl({
      leagueId,
      seasonId: currentYear,
      fromTeamId: teamId,
      toTeamId,
    });
    log.log(`[Trade Recon] Write guard on. Opening trade builder: ${builderUrl}`);
    await session.page.goto(builderUrl, { waitUntil: "networkidle", timeout: 20000 });
    await captureDebugSnapshot(session.page, "trade-recon-builder-opened");
    await dumpRows(session.page, "builder-opened", log);

    await waitForEnter(
      "[Trade Recon] Tick a few players on BOTH sides (include a D/ST if you can), then press Enter... ",
    );
    await captureDebugSnapshot(session.page, "trade-recon-builder-checked");
    await dumpRows(session.page, "builder-checked", log);

    await waitForEnter(
      "[Trade Recon] Click Continue to reach the review screen (writes are blocked either way). " +
        "DO NOT click the final propose/send button. Press Enter once the review screen shows... ",
    );
    await captureDebugSnapshot(session.page, "trade-recon-review");
    log.log(
      "[Trade Recon] Captured debug-trade-recon-review.html/.png. Check it for the final submit " +
        "button's text and whether there's a note field (trade_submit_button / trade_message_input).",
    );

    try {
      await session.page.locator(SELECTORS.trade_cancel_button).first().click({ timeout: 5000 });
      log.log("[Trade Recon] Clicked Cancel Trade.");
    } catch (cancelError) {
      log.warn(`[Trade Recon] Could not click Cancel Trade (${cancelError.message}); closing the browser abandons the draft offer anyway.`);
    }

    log.log(
      `[Trade Recon] Write guard blocked ${guard.blocked.length} request(s)` +
        (guard.blocked.length ? `: ${guard.blocked.map((r) => `${r.method} ${r.url}`).join(" | ")}` : "."),
    );
    appendJsonLine("trade-recon-blocked-writes.jsonl", { blocked: guard.blocked });
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
