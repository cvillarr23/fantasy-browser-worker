const { createAuthenticatedSession } = require("./auth");
const { assertRenderedSessionValid } = require("./session_health");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");

/**
 * Scheduled health check (issue #7's "at minimum" fallback — now the primary approach, see PR
 * discussion): confirms the stored espn_s2/SWID cookies still authenticate, and fails loudly and
 * distinguishably if they don't, so a human knows to re-extract them by hand rather than the
 * pipeline just silently failing ESPN auth on draft day with no warning.
 *
 * Automated re-extraction via stored username/password (the original plan for issue #7) turned
 * out not to be viable: ESPN's login goes through a Disney OneID widget gated by invisible
 * reCAPTCHA Enterprise, which is specifically designed to block automated submissions — confirmed
 * via login_recon.js against the real login page (selectors matched correctly, form filled
 * correctly, submit never went through). This check deliberately never touches the login form —
 * it only reuses the same cookie-injection auth.js already does for every other bot, so there's
 * nothing for anti-automation controls to catch.
 *
 * Exits non-zero on any auth failure so this can run as a Kubernetes CronJob whose failure state
 * *is* the alert (visible via `kubectl get cronjob`/job history, or wired into whatever the
 * cluster's existing Prometheus/Grafana/Loki stack already alerts on for failed Jobs).
 */
async function checkEspnSession() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";

  let session = null;
  try {
    session = await createAuthenticatedSession();
    await assertRenderedSessionValid(session.page, { leagueId, teamId, seasonId });

    logger.info(
      `[Session Check] ESPN session is healthy — roster table rendered for league ${leagueId}, team ${teamId}.`,
    );
  } catch (error) {
    logger.error(error.message, { err: error });
    if (session?.page) {
      await session.page
        .screenshot({ path: "auth_failure_diagnostics.png" })
        .catch(() => {});
    }
    // Rethrow instead of just setting process.exitCode -- this runs inside withInstrumentation's
    // handler (see require.main below), so swallowing the error here would make the wrapper
    // record a successful span/execution_log row for a failed auth check. Exit-code handling
    // moves to a .catch() after the wrapper settles.
    throw error;
  } finally {
    if (session?.browser) {
      await session.browser.close();
    }
  }
}

if (require.main === module) {
  withInstrumentation(
    "check_espn_session",
    { trackingId: require("crypto").randomUUID() },
    checkEspnSession,
  )
    .catch(() => {
      // Non-zero exit is the alert this CronJob relies on (see header comment) -- set it here,
      // after withInstrumentation's own catch has already recorded the failed span/execution_log
      // row, rather than swallowing the error inside checkEspnSession itself.
      process.exitCode = 1;
    })
    .finally(async () => {
      // Flush any buffered spans before this short-lived CronJob pod's event loop drains --
      // not guaranteed to happen on its own before exit.
      const { sdk } = require("../telemetry/init");
      await sdk.shutdown();
    });
}

module.exports = { checkEspnSession };
