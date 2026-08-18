const { createAuthenticatedSession } = require("./auth");
const selectors = require("../selectors/espn_selectors.json");
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
  const targetUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${teamId}&seasonId=${seasonId}`;

  let session = null;
  try {
    session = await createAuthenticatedSession();
    await session.page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    const finalUrl = session.page.url();
    if (/\/login\b/i.test(finalUrl)) {
      throw new Error(
        `[ESPN Auth Failure] Redirected to a login page (${finalUrl}) — stored espn_s2/SWID ` +
          "cookies are no longer valid. Re-extract them from a logged-in browser and update " +
          "OpenBao: bao kv put secret/fantasy/espn espn_s2=<new> swid=<new>"
      );
    }

    await session.page.waitForSelector(selectors.roster_table, { timeout: 10000 }).catch(() => {
      throw new Error(
        `[ESPN Auth Failure] Landed on ${finalUrl} but the roster table never rendered — ` +
          "either the session is invalid in a way that didn't trigger a login redirect, or " +
          "ESPN changed the page layout. Check auth_failure_diagnostics.png."
      );
    });

    logger.info(`[Session Check] ESPN session is healthy — roster table rendered for ${targetUrl}`);
  } catch (error) {
    logger.error(error.message, { error: error.message });
    if (session?.page) {
      await session.page.screenshot({ path: "auth_failure_diagnostics.png" }).catch(() => {});
    }
    process.exitCode = 1;
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
  );
}

module.exports = { checkEspnSession };
