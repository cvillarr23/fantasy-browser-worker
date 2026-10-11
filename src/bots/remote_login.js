const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const selectors = require("../selectors/espn_selectors.json");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");

/**
 * WORKER-11: remote VNC-based interactive ESPN login.
 *
 * Runs inside a k8s Job whose container also runs scripts/start-vnc.sh (Xvfb + x11vnc + noVNC)
 * before this file, so `DISPLAY` is already pointed at a real virtual X11 display by the time this
 * launches Chromium headed. A human then drives the real ESPN login page from their phone, over
 * real VNC input (X11-level input injection via x11vnc) — NOT anything this file dispatches
 * itself.
 *
 * This file deliberately never calls `.click()`/`.fill()`/`.type()` against the login form. A
 * prior attempt to script that login (branch `espn-session-refresh`, commit `c3fd986`) filled the
 * form correctly but submit silently never completed — the signature of invisible reCAPTCHA
 * Enterprise blocking it. That's confirmed closed, not untested (see
 * docs/espn/session-and-auth.md) — do not re-attempt scripting any part of this form here.
 *
 * Flow:
 *   1. Launch Chromium headed on the Xvfb display, navigate to the ESPN login page.
 *   2. Poll (not a stdin/readline wait — there's no tty attached to a k8s Job, unlike
 *      draft_recon.js's launchWithManualLogin) for login success: first for espn_s2/SWID cookies
 *      to appear (without touching the page the human is actively driving), then a single roster
 *      page navigation to confirm the rendered UI accepts the session too, mirroring
 *      check_espn_session.js's staleness check inverted.
 *   3. On success, save the full storageState() (cookies + localStorage — this is what actually
 *      captures the Disney/MyDisney BAM SDK session the rendered draft room additionally gates
 *      on) into OpenBao at secret/fantasy/espn-session-state.
 *   4. Navigate to the mock draft lobby and leave the browser open indefinitely so the human can
 *      keep driving the now-authenticated session from their phone (play a practice draft, poke
 *      at the real draft room, etc). The only bound on this is the k8s Job's own
 *      activeDeadlineSeconds — this file must never impose its own short kill timer post-login.
 */

const OPENBAO_ESPN_SESSION_STATE_PATH =
  process.env.OPENBAO_ESPN_SESSION_STATE_PATH ||
  "secret/fantasy/espn-session-state";

const LOGIN_WAIT_TIMEOUT_MS = Number(
  process.env.LOGIN_WAIT_TIMEOUT_MS || 30 * 60 * 1000,
);
const LOGIN_POLL_INTERVAL_MS = Number(
  process.env.LOGIN_POLL_INTERVAL_MS || 5000,
);

function rosterUrl() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  return `https://fantasy.espn.com/football/team?leagueId=${leagueId}&teamId=${teamId}&seasonId=${seasonId}`;
}

/**
 * Polls WITHOUT navigating the human's active page until espn_s2/SWID actually show up in the
 * context's cookie jar (a plain context.cookies() read — never touches the page they're driving,
 * so it can't yank them off a Disney OneID/2FA flow mid-login the way repeatedly re-navigating the
 * login page itself would). Only once those cookies exist does this do a single roster-page
 * navigation, mirroring check_espn_session.js's staleness check inverted, to confirm the
 * *rendered* page also accepts the session (the separate Disney/MyDisney SDK gate) — by that
 * point the human is done with the login form itself, so one navigation away from it is fine.
 */
async function waitForLoginSuccess(page, context) {
  const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const hasAuthCookies =
      cookies.some((c) => c.name === "espn_s2") &&
      cookies.some((c) => c.name === "SWID");

    if (hasAuthCookies) {
      try {
        await page.goto(rosterUrl(), {
          waitUntil: "networkidle",
          timeout: 15000,
        });
        if (!/\/login\b/i.test(page.url())) {
          const visible = await page
            .locator(selectors.roster_table)
            .isVisible()
            .catch(() => false);
          if (visible) {
            return true;
          }
        }
        logger.info(
          "Auth cookies present but roster page didn't confirm login yet, still polling...",
        );
      } catch (err) {
        // Transient nav errors are expected here too (redirects, interstitial pages) — log and
        // keep polling rather than failing on the first one.
        logger.info(
          `Roster confirmation check failed, still polling: ${err.message}`,
        );
      }
    }
    await page.waitForTimeout(LOGIN_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Writes the full Playwright storageState (cookies + localStorage) to OpenBao via the `bao` CLI's
 * Kubernetes auth method, mirroring auth.js's existing execFileSync("bao", ...) pattern used for
 * reads. Requires OpenBao's Kubernetes auth method + a role/policy binding this Job's
 * ServiceAccount to write access on OPENBAO_ESPN_SESSION_STATE_PATH — that's fantasy-infra-side
 * work tracked as a companion issue to WORKER-11, not provisioned by this file. Fails loudly
 * (rethrows) rather than silently swallowing the error if that prerequisite isn't in place yet.
 */
function saveSessionStateToOpenBao(storageState) {
  const fs = require("fs");
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";

  logger.info(
    `Authenticating to OpenBao via Kubernetes auth (role=${process.env.OPENBAO_K8S_ROLE || "fantasy-browser-worker"})...`,
  );
  try {
    const jwt = fs.readFileSync(tokenPath, "utf8");
    execFileSync("bao", [
      "login",
      "-method=kubernetes",
      `role=${process.env.OPENBAO_K8S_ROLE || "fantasy-browser-worker"}`,
      `jwt=${jwt}`,
    ]);
    execFileSync("bao", [
      "kv",
      "put",
      OPENBAO_ESPN_SESSION_STATE_PATH,
      `state=${JSON.stringify(storageState)}`,
    ]);
  } catch (err) {
    logger.error(
      `Failed to write session state to OpenBao at "${OPENBAO_ESPN_SESSION_STATE_PATH}" — ` +
        "is OpenBao's Kubernetes auth method + a role/policy for this ServiceAccount provisioned yet? " +
        `(${err.message})`,
      { err },
    );
    throw err;
  }
  logger.info(
    `Saved full session state to OpenBao at "${OPENBAO_ESPN_SESSION_STATE_PATH}".`,
  );
}

/**
 * The login+save phase only — bounded (LOGIN_WAIT_TIMEOUT_MS) and instrumented, unlike the
 * indefinite post-login "stay open over VNC" phase below, which deliberately runs outside
 * withInstrumentation's span (see runRemoteLogin) since that wrapper's span/execution_log
 * semantics assume a bounded execution, not a multi-hour idle wait.
 */
async function performLoginAndSaveState(page, context) {
  logger.info(
    "Navigating to the ESPN login page — drive this from your phone over VNC.",
  );
  await page.goto("https://www.espn.com/login", {
    waitUntil: "load",
    timeout: 60000,
  });

  const loggedIn = await waitForLoginSuccess(page, context);
  if (!loggedIn) {
    throw new Error(
      `[Remote Login] Timed out after ${LOGIN_WAIT_TIMEOUT_MS}ms waiting for a successful login.`,
    );
  }
  logger.info("Login detected — roster page rendered successfully.");

  const storageState = await context.storageState();
  saveSessionStateToOpenBao(storageState);
}

async function runRemoteLogin() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--start-maximized",
    ],
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[Remote Login] Shutting down, closing browser...");
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Everything past launch is guarded the same way createAuthenticatedSession() is in auth.js: if
  // context/page creation or anything below throws, the browser process gets closed right here
  // rather than orphaned for up to activeDeadlineSeconds with nothing left to close it.
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await withInstrumentation(
      "remote_login",
      { trackingId: require("crypto").randomUUID() },
      () => performLoginAndSaveState(page, context),
    );

    await page.goto("https://fantasy.espn.com/football/mockdraftlobby", {
      waitUntil: "load",
      timeout: 60000,
    });

    logger.info(
      "[Remote Login] Session saved. Leaving the browser open and interactive over VNC — keep " +
        "driving it from your phone. This process stays alive until the k8s Job's " +
        "activeDeadlineSeconds is hit or it's deleted by hand.",
    );
    // Deliberately no internal timeout here — see this file's header. Bounded only by the Job's
    // own activeDeadlineSeconds and the SIGTERM handler above.
    const heartbeat = setInterval(
      () => logger.info("[Remote Login] Still alive, session open over VNC."),
      5 * 60 * 1000,
    );
    heartbeat.unref();
    await new Promise(() => {});
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

if (require.main === module) {
  runRemoteLogin().catch((err) => {
    logger.error(err.message, { err });
    process.exitCode = 1;
  });
  // No sdk.shutdown() finally block here, unlike check_espn_session.js's short-lived-job pattern —
  // withInstrumentation's span (scoped to just performLoginAndSaveState above) has already ended
  // and flushed the OTel batch exporter's normal way by the time this process either exits on
  // failure or settles into the indefinite post-login wait; there's no "about to exit" point in
  // the success path to hook a flush onto, since the process is meant to keep running.
}

module.exports = {
  runRemoteLogin,
  performLoginAndSaveState,
  waitForLoginSuccess,
  saveSessionStateToOpenBao,
};
