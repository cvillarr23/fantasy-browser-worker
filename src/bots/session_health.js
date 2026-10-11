const { buildLeagueReadUrl } = require("./espn_api");
const selectors = require("../selectors/espn_selectors.json");
const { PermanentError, SessionExpiredError } = require("../errors");

/**
 * Proactive session-validity checks (WORKER-17) — every consumer of the stored espn_s2/SWID
 * cookies used to only discover staleness reactively (a WS failure, an unconfirmed pick, a
 * rendered "Log in Required" page). For a full unattended draft (15-20+ minutes), that's too late
 * to "abort cleanly" on — by the time a pick attempt itself fails, a turn may already be missed.
 *
 * Two tiers, matching the two auth surfaces documented in docs/espn/session-and-auth.md:
 *   1. Cookie/WS-layer (cheap, REST-only, no page navigation) — what matters for
 *      draft_clicker.js's WS-only primary path, which never renders a page at all.
 *   2. Rendered-page/BAM-SDK-layer (needs an existing page) — what matters for
 *      draft_room_dom.js's fallback tier and mock_draft.js's lobby-join flow. This tier's logic
 *      was originally check_espn_session.js's inline CronJob body; it now lives here so both the
 *      scheduled CronJob and an in-draft pre-flight/periodic check share one implementation.
 *
 * Both throw SessionExpiredError (src/errors.js) on failure — deliberately not PermanentError,
 * since a refreshed session can make a redelivered pick succeed; this is an infra condition, not
 * a doomed payload.
 */

/** No browser needed — just an authenticated REST round-trip against a cheap view. */
async function assertCookieSessionValid(context, { leagueId, seasonId }) {
  const url = buildLeagueReadUrl(leagueId, seasonId, ["mTeam"]);
  const response = await context.request.get(url);

  if (response.status() === 401 || response.status() === 403) {
    throw new SessionExpiredError(
      `[Session Health] ESPN session cookies rejected (HTTP ${response.status()}) for league ` +
        `${leagueId} — espn_s2/SWID have likely expired. Re-extract them and update OpenBao: ` +
        "bao kv put secret/fantasy/espn espn_s2=<new> swid=<new>",
    );
  }
  // A cancelled/expired practice room 404s here permanently — every redelivery of a message
  // targeting it fails identically forever, since the league itself is gone, not merely
  // slow/unreachable. Confirmed live 2026-08-27: a message for a cancelled room's league_id
  // (1234567895) requeued via a plain Error every ~0.5s for 3+ hours, pinning a worker replica,
  // until manually purged. A 5xx/other non-ok status stays a plain (retryable) Error below —
  // those genuinely can recover on their own.
  if (response.status() === 404) {
    throw new PermanentError(
      `[Session Health] League ${leagueId} not found (HTTP 404) — the room no longer exists ` +
        "(ended, cancelled, or never existed for this season); retrying can't help.",
    );
  }
  if (!response.ok()) {
    throw new Error(
      `[Session Health] Unexpected HTTP ${response.status()} checking session validity for ` +
        `league ${leagueId} — not treating this as an expired session, just an unhealthy request.`,
    );
  }
}

/**
 * Needs an already-open page (don't launch a new browser just to check) — navigates it to the
 * roster page and confirms it renders rather than gating on the Disney/MyDisney BAM SDK "Log in
 * Required" overlay. Navigates the page it's given, so only call this against a page whose
 * current work is done (e.g. a pre-flight check before that page's real navigation, not mid-use).
 */
async function assertRenderedSessionValid(page, { leagueId, teamId, seasonId }) {
  const targetUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${teamId}&seasonId=${seasonId}`;
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

  const finalUrl = page.url();
  if (/\/login\b/i.test(finalUrl)) {
    throw new SessionExpiredError(
      `[Session Health] Redirected to a login page (${finalUrl}) — stored session is no longer ` +
        "valid for rendered pages.",
    );
  }

  await page.waitForSelector(selectors.roster_table, { timeout: 10000 }).catch(() => {
    throw new SessionExpiredError(
      `[Session Health] Landed on ${finalUrl} but the roster table never rendered — either the ` +
        "session is invalid in a way that didn't trigger a login redirect, or ESPN changed the " +
        "page layout.",
    );
  });
}

module.exports = { assertCookieSessionValid, assertRenderedSessionValid };
