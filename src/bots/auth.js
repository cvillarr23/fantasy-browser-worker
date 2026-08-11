const { chromium } = require("playwright");
const { execFileSync } = require("child_process");

/**
 * Falls back to OpenBao when ESPN_S2/SWID aren't in the environment. Matches the storage
 * convention from the cookie-refresh ticket (`bao kv put secret/fantasy/espn espn_s2=... swid=...`),
 * consumed in production via fantasy-infra's ExternalSecret — this is for local runs where that
 * env injection hasn't happened, so it just shells out to whatever `bao` CLI session is already
 * authenticated (BAO_ADDR/BAO_TOKEN etc.), it does not perform its own OpenBao login.
 */
function fetchEspnCookiesFromOpenBao() {
  const secretPath = process.env.OPENBAO_ESPN_SECRET_PATH || "secret/fantasy/espn";
  console.log(`[Auth Engine] ESPN_S2/SWID not set in environment, checking OpenBao at "${secretPath}"...`);

  let raw;
  try {
    raw = execFileSync("bao", ["kv", "get", "-format=json", secretPath], { encoding: "utf8" });
  } catch (err) {
    console.error(`[Auth Engine] OpenBao lookup failed: ${err.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[Auth Engine] Could not parse OpenBao response: ${err.message}`);
    return null;
  }

  // KV v2 nests the secret under data.data; KV v1 puts it directly under data.
  const fields = parsed?.data?.data ?? parsed?.data;
  if (!fields?.espn_s2 || !fields?.swid) {
    console.error(`[Auth Engine] OpenBao secret at "${secretPath}" is missing espn_s2/swid fields.`);
    return null;
  }

  console.log("[Auth Engine] Loaded ESPN_S2/SWID from OpenBao.");
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
 * Headless Browser Sandbox Initializer
 * Establishes optimized browser context pools while keeping container RAM under 1200MiB.
 */
async function createAuthenticatedSession({ headless = true } = {}) {
  // Resolve credentials before launching anything — if this throws, there's no browser process
  // left dangling with nothing left to close it.
  const cookies = resolveEspnCookies();
  if (!cookies) {
    throw new Error(
      "[Auth Engine] Critical Failure: Required session cookies (ESPN_S2/SWID) are missing — not found in environment variables or OpenBao."
    );
  }
  const { espnS2, swid } = cookies;

  console.log("[Auth Engine] Spawning optimized headless Chromium sandbox instance...");

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
    "--disable-blink-features=AutomationControlled" // Lowers bot detection footprint
  ];

  if (debugPort) {
    launchArgs.push(`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=0.0.0.0");
    console.log(
      `[Auth Engine] CDP_DEBUG_PORT set — remote debugging enabled on port ${debugPort}. ` +
        `Open chrome://inspect locally against localhost:${debugPort} (port-forward it first if running in the cluster).`
    );
  }

  // 1. Launch a sandboxed browser process explicitly optimized for containerized Linux engines.
  // `headless` is overridable only so the recon tools (lineup_recon.js --watch-save) can open a
  // window you interact with by hand; every production bot leaves it at the default.
  const browser = await chromium.launch({
    headless,
    args: launchArgs
  });

  // 2. Initialize a blank workspace container context
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  console.log("[Auth Engine] Injecting authentication state storage tokens into browser context pool...");

  // 3. Force inject active cookies into the browser memory layer to trick ESPN into bypassing MFA challenges
  await context.addCookies([
    {
      name: "espn_s2",
      value: espnS2,
      domain: ".espn.com",
      path: "/",
      httpOnly: true,
      secure: true
    },
    {
      name: "SWID",
      value: swid,
      domain: ".espn.com",
      path: "/",
      httpOnly: false,
      secure: true
    }
  ]);

  // 4. Optimize network overhead by blocking media and tracking script downloads on demand
  const page = await context.newPage();
  await page.route("**/*.{png,jpg,jpeg,gif,png,svg,css,woff,woff2,eot,ttf}", (route) => {
    // Blocks heavy structural css/images during instant waiver sniping windows to save network cycles
    if (process.env.NODE_ENV === "production") {
      return route.abort();
    }
    return route.continue();
  });

  return { browser, context, page, swid };
}

module.exports = {
  createAuthenticatedSession,
  resolveEspnCookies
};

