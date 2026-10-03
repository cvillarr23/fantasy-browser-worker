const fs = require("fs");
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const { logger } = require("../telemetry/logger");

// A small pool of realistic, current desktop Chrome UAs, rotated per session rather than sending
// the exact same fingerprint on every request across every bot — a single fixed UA repeated
// across thousands of requests is itself a signal, on top of anything Chromium already leaks via
// --disable-blink-features=AutomationControlled below.
const USER_AGENT_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
];

function pickUserAgent() {
  return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
}

/**
 * Falls back to OpenBao when ESPN_S2/SWID aren't in the environment. Matches the storage
 * convention from the cookie-refresh ticket (`bao kv put secret/fantasy/espn espn_s2=... swid=...`),
 * consumed in production via fantasy-infra's ExternalSecret — this is for local runs where that
 * env injection hasn't happened, so it just shells out to whatever `bao` CLI session is already
 * authenticated (BAO_ADDR/BAO_TOKEN etc.), it does not perform its own OpenBao login.
 */
function fetchEspnCookiesFromOpenBao() {
  const secretPath =
    process.env.OPENBAO_ESPN_SECRET_PATH || "secret/fantasy/espn";
  logger.info(
    `[Auth Engine] ESPN_S2/SWID not set in environment, checking OpenBao at "${secretPath}"...`,
  );

  let raw;
  try {
    raw = execFileSync("bao", ["kv", "get", "-format=json", secretPath], {
      encoding: "utf8",
    });
  } catch (err) {
    logger.error(`[Auth Engine] OpenBao lookup failed: ${err.message}`, {
      err,
    });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `[Auth Engine] Could not parse OpenBao response: ${err.message}`,
      {
        err,
      },
    );
    return null;
  }

  // KV v2 nests the secret under data.data; KV v1 puts it directly under data.
  const fields = parsed?.data?.data ?? parsed?.data;
  if (!fields?.espn_s2 || !fields?.swid) {
    logger.error(
      `[Auth Engine] OpenBao secret at "${secretPath}" is missing espn_s2/swid fields.`,
    );
    return null;
  }

  logger.info("[Auth Engine] Loaded ESPN_S2/SWID from OpenBao.");
  return { espnS2: fields.espn_s2, swid: fields.swid };
}

/** Env vars take priority (how production/ExternalSecrets inject them); OpenBao is the local-dev fallback. */
function resolveEspnCookies() {
  if (process.env.ESPN_S2 && process.env.SWID) {
    return { espnS2: process.env.ESPN_S2, swid: process.env.SWID };
  }
  return fetchEspnCookiesFromOpenBao();
}

/**
 * Full Playwright `storageState()` (cookies AND localStorage) from a real interactive login,
 * saved by WORKER-11's `remote_login.js` — distinct from the plain espn_s2/swid fields above.
 * This is what actually satisfies the Disney/MyDisney identity SDK gate the *rendered* draft room
 * page imposes on top of cookie auth (see draft_room_dom.js's header for the full story); bare
 * cookie injection never establishes that session.
 */
function fetchStoredSessionStateFromOpenBao() {
  const secretPath =
    process.env.OPENBAO_ESPN_SESSION_STATE_PATH ||
    "secret/fantasy/espn-session-state";
  logger.info(
    `[Auth Engine] Checking OpenBao for a saved full session state at "${secretPath}"...`,
  );

  let raw;
  try {
    raw = execFileSync("bao", ["kv", "get", "-format=json", secretPath], {
      encoding: "utf8",
    });
  } catch (err) {
    logger.info(
      `[Auth Engine] No stored session state at "${secretPath}" (${err.message}) — falling back to cookie injection.`,
    );
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `[Auth Engine] Could not parse OpenBao response: ${err.message}`,
      { err },
    );
    return null;
  }

  // KV v2 nests the secret under data.data; KV v1 puts it directly under data.
  const fields = parsed?.data?.data ?? parsed?.data;
  if (!fields?.state) {
    logger.error(
      `[Auth Engine] OpenBao secret at "${secretPath}" is missing the "state" field.`,
    );
    return null;
  }

  try {
    return JSON.parse(fields.state);
  } catch (err) {
    logger.error(
      `[Auth Engine] Stored session state at "${secretPath}" is not valid JSON: ${err.message}`,
      { err },
    );
    return null;
  }
}

/**
 * Env/file input takes priority (production: an ExternalSecret-mounted file, same delivery model
 * as ESPN_S2/SWID's secretKeyRef env vars above, just a file instead of a plain env var since this
 * blob is a full JSON storageState rather than a couple of short strings). The direct `bao` CLI
 * read (fetchStoredSessionStateFromOpenBao) is a LOCAL-DEV-ONLY fallback — it shells out to
 * whatever `bao` CLI session is already authenticated via scripts/openbao-connect.sh, exactly like
 * fetchEspnCookiesFromOpenBao's doc comment already describes for the plain cookie fields. No
 * running Job authenticates to OpenBao for a *read* here (only remote_login.js writes, via its own
 * Kubernetes-auth login) — production consumers of this stored state must go through
 * ESPN_SESSION_STATE_FILE instead.
 */
function fetchStoredSessionState() {
  const statePath = process.env.ESPN_SESSION_STATE_FILE;
  if (statePath) {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch (err) {
      logger.error(
        `[Auth Engine] Could not read/parse ESPN_SESSION_STATE_FILE at "${statePath}": ${err.message}`,
        { err },
      );
      return null;
    }
  }
  return fetchStoredSessionStateFromOpenBao();
}

/**
 * Headless Browser Sandbox Initializer
 * Establishes optimized browser context pools while keeping container RAM under 1200MiB.
 */
async function createAuthenticatedSession({ headless = true } = {}) {
  // Resolve credentials before launching anything — if this throws, there's no browser process
  // left dangling with nothing left to close it.
  const cookies = resolveEspnCookies();
  if (!cookies) {
    throw new Error(
      "[Auth Engine] Critical Failure: Required session cookies (ESPN_S2/SWID) are missing — not found in environment variables or OpenBao.",
    );
  }
  const { espnS2, swid } = cookies;

  logger.info(
    "[Auth Engine] Spawning optimized headless Chromium sandbox instance...",
  );

  // Opt-in live viewing: set CDP_DEBUG_PORT to expose a Chrome DevTools Protocol endpoint even
  // while fully headless. Locally, just open chrome://inspect and point it at localhost:<port>.
  // In the cluster, `kubectl port-forward` that port from the running pod first, then do the same
  // — this is meant for watching/debugging the bot live (e.g. on draft day), not left on by default.
  const debugPort = process.env.CDP_DEBUG_PORT;
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled", // Lowers bot detection footprint
  ];

  if (debugPort) {
    launchArgs.push(
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=0.0.0.0",
    );
    logger.info(
      `[Auth Engine] CDP_DEBUG_PORT set — remote debugging enabled on port ${debugPort}. ` +
        `Open chrome://inspect locally against localhost:${debugPort} (port-forward it first if running in the cluster).`,
    );
  }

  // 1. Launch a sandboxed browser process explicitly optimized for containerized Linux engines.
  // `headless` is overridable only so the recon tools (lineup_recon.js --watch-save) can open a
  // window you interact with by hand; every production bot leaves it at the default.
  const browser = await chromium.launch({
    headless,
    args: launchArgs,
  });

  // Everything past launch is wrapped: the browser process exists from this point on, but callers
  // only ever receive it via the returned session. If any setup step below throws, the caller's
  // `finally { session.browser.close() }` never sees a session to close, so the Chromium process
  // would be orphaned — and in the long-lived queue worker that leaks one per failed message until
  // the 1200MiB pod limit OOM-kills it.
  try {
    // 2. Initialize a blank workspace container context
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: pickUserAgent(),
    });

    logger.info(
      "[Auth Engine] Injecting authentication state storage tokens into browser context pool...",
    );

    // 3. Force inject active cookies into the browser memory layer to trick ESPN into bypassing MFA challenges
    await context.addCookies([
      {
        name: "espn_s2",
        value: espnS2,
        domain: ".espn.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
      {
        name: "SWID",
        value: swid,
        domain: ".espn.com",
        path: "/",
        httpOnly: false,
        secure: true,
      },
    ]);

    // 4. Optimize network overhead by blocking media and tracking script downloads on demand
    const page = await context.newPage();
    await page.route(
      "**/*.{png,jpg,jpeg,gif,png,svg,css,woff,woff2,eot,ttf}",
      (route) => {
        // Blocks heavy structural css/images during instant waiver sniping windows to save network cycles
        if (process.env.NODE_ENV === "production") {
          return route.abort();
        }
        return route.continue();
      },
    );

    return { browser, context, page, swid, headless };
  } catch (setupError) {
    await browser.close().catch(() => {}); // Never let a close failure mask the real error.
    throw setupError;
  }
}

/**
 * A stored login whose espn_s2 is missing or past its expiry can't be logged in, so don't launch
 * Chromium for it. A session-lifetime cookie (expires -1) is left to storedLoginRejected.
 */
function storedLoginExpired(storageState, now = Date.now()) {
  const espnS2 = (storageState.cookies || []).find((c) => c.name === "espn_s2");
  if (!espnS2) return true;
  return typeof espnS2.expires === "number" && espnS2.expires > 0 && espnS2.expires * 1000 <= now;
}

/**
 * Whether ESPN rejects the stored login: the same authenticated mTeam read as
 * session_health.assertCookieSessionValid (401/403 = logged out). Only a definite rejection
 * counts. A network error or 5xx can't tell us anything, and the cookie pair would hit the same
 * outage, so those keep the stored session. Skipped without ESPN_LEAGUE_ID/CURRENT_YEAR. A league
 * readable without login would also pass, so this catches a dead login, not every degraded one.
 */
const STORED_LOGIN_CHECK_TIMEOUT_MS = 5000;

async function storedLoginRejected(context) {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const seasonId = process.env.CURRENT_YEAR;
  if (!leagueId || !seasonId) return false;
  try {
    const response = await context.request.get(
      `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mTeam`,
      // Short: draft_room_dom.js builds a session inside a live pick clock, and a timeout here
      // only means "keep the stored session" anyway.
      { timeout: STORED_LOGIN_CHECK_TIMEOUT_MS },
    );
    return response.status() === 401 || response.status() === 403;
  } catch {
    return false;
  }
}

/**
 * Prefers a real interactive-login session (full storageState, satisfies the Disney/MyDisney SDK
 * gate) over the bare cookie injection createAuthenticatedSession does above. Returns null — not a
 * throw — when no stored state exists in OpenBao, or when its login is expired or rejected (#128),
 * so callers can cleanly fall through to createAuthenticatedSession() instead; leaves that
 * function itself untouched, so WORKER-06's cookie-only WS submission path is unaffected either way.
 */
async function createSessionFromStoredState({ headless = true } = {}) {
  const storageState = fetchStoredSessionState();
  if (!storageState) {
    return null;
  }
  // Every caller falls back to createAuthenticatedSession() (the ESPN_S2/SWID pair) on null, and
  // the pair is refreshed separately from this state (#128). So a stored login that's expired or
  // rejected returns null rather than running a logged-out session.
  if (storedLoginExpired(storageState)) {
    logger.warn(
      "[Auth Engine] Stored session state has no unexpired espn_s2 cookie; falling back to cookie auth.",
    );
    return null;
  }

  logger.info(
    "[Auth Engine] Spawning Chromium sandbox from a saved full session state...",
  );

  const debugPort = process.env.CDP_DEBUG_PORT;
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];
  if (debugPort) {
    launchArgs.push(
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=0.0.0.0",
    );
  }

  const browser = await chromium.launch({ headless, args: launchArgs });
  try {
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1280, height: 720 },
      userAgent: pickUserAgent(),
    });
    const page = await context.newPage();

    if (await storedLoginRejected(context)) {
      logger.warn(
        "[Auth Engine] ESPN rejected the stored session state (401/403); falling back to cookie auth.",
      );
      await browser.close().catch(() => {});
      return null;
    }

    // Callers (e.g. draft_room_dom.js's buildDraftUrl) expect `swid` back the same way
    // createAuthenticatedSession() provides it, even though it came from the stored state's
    // cookies rather than ESPN_S2/SWID env/OpenBao fields.
    const cookies = await context.cookies();
    const swid = cookies.find((c) => c.name === "SWID")?.value;

    return { browser, context, page, swid, headless };
  } catch (setupError) {
    await browser.close().catch(() => {});
    throw setupError;
  }
}

module.exports = {
  createAuthenticatedSession,
  createSessionFromStoredState,
  resolveEspnCookies,
};
