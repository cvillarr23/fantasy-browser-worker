const { chromium } = require("playwright");
const { kubernetesLogin, readSecret, writeSecret } = require("../lib/openbao_client");

/**
 * Scheduled job (issue #7): logs into ESPN with a stored username/password, extracts the fresh
 * espn_s2/SWID session cookies that result, and writes them back to OpenBao — so the cookies
 * espn-session-secrets (ExternalSecret) hands to every other bot stay current without a human
 * re-extracting them from a browser by hand.
 *
 * Runs as its own Kubernetes CronJob under a dedicated ServiceAccount, distinct from the regular
 * bots: it needs OpenBao *write* access to secret/fantasy/espn (and read on
 * secret/fantasy/espn-login), which ESO's own read-only role deliberately doesn't have. See
 * homelab-deployment's scripts/openbao-init-espn-refresher.sh for how that role gets created.
 *
 * Assumes no MFA on the ESPN account (confirmed) — a TOTP step would need to be added to
 * loginAndExtractCookies() below if that ever changes.
 *
 * UNVERIFIED: nobody has captured ESPN's actual login page DOM yet (only the draft room has been
 * reconned, via draft_recon.js). The selectors below are a best guess — ESPN's login widget is
 * likely a Disney/BAM-hosted "OneID" component (per the espn.connections.edge.bamgrid.com traffic
 * seen during draft room recon), possibly inside an iframe, which loginAndExtractCookies()
 * accounts for by searching all frames — but the exact field/button selectors need a real recon
 * pass to confirm. Override via ESPN_LOGIN_*_SELECTOR env vars if the defaults are wrong.
 */

const OPENBAO_ROLE = process.env.OPENBAO_ROLE || "espn-session-refresher";
const LOGIN_URL = "https://www.espn.com/login";

const USERNAME_SELECTOR =
  process.env.ESPN_LOGIN_USERNAME_SELECTOR || 'input[type="email"], input[name="username"]';
const PASSWORD_SELECTOR = process.env.ESPN_LOGIN_PASSWORD_SELECTOR || 'input[type="password"]';
const SUBMIT_SELECTOR = process.env.ESPN_LOGIN_SUBMIT_SELECTOR || 'button[type="submit"]';

async function fetchEspnLoginFromOpenBao(vaultToken) {
  const creds = await readSecret(vaultToken, "fantasy/espn-login");
  if (!creds?.username || !creds?.password) {
    throw new Error("OpenBao secret fantasy/espn-login is missing username/password fields.");
  }
  return creds;
}

/** Polls every frame on the page (login widgets are commonly iframe-embedded) for a selector. */
async function findFrameWithSelector(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if ((await frame.locator(selector).count()) > 0) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`[ESPN Auth Failure] Could not find login field "${selector}" in page or any iframe.`);
}

async function loginAndExtractCookies(username, password) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 30000 });

    const frame = await findFrameWithSelector(page, USERNAME_SELECTOR, 15000);
    await frame.locator(USERNAME_SELECTOR).first().fill(username);
    await frame.locator(PASSWORD_SELECTOR).first().fill(password);
    await frame.locator(SUBMIT_SELECTOR).first().click();

    // Success is judged by the cookies actually showing up below, not any specific post-login
    // element we haven't verified exists — just give the redirect/session-set time to settle.
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    const cookies = await context.cookies("https://www.espn.com");
    const espnS2 = cookies.find((c) => c.name === "espn_s2")?.value;
    const swid = cookies.find((c) => c.name === "SWID")?.value;

    if (!espnS2 || !swid) {
      throw new Error(
        "[ESPN Auth Failure] Login flow completed but espn_s2/SWID cookies were never set — " +
          "selectors may be stale, or the login didn't actually succeed. Needs a recon pass " +
          "against the real login page."
      );
    }

    return { espnS2, swid };
  } finally {
    await browser.close();
  }
}

async function refreshEspnSession() {
  console.log("[Session Refresh] Authenticating to OpenBao via Kubernetes auth...");
  const vaultToken = await kubernetesLogin(OPENBAO_ROLE);

  console.log("[Session Refresh] Reading stored ESPN login credentials...");
  const { username, password } = await fetchEspnLoginFromOpenBao(vaultToken);

  console.log("[Session Refresh] Logging into ESPN and extracting fresh session cookies...");
  const { espnS2, swid } = await loginAndExtractCookies(username, password);

  console.log("[Session Refresh] Writing refreshed espn_s2/SWID back to OpenBao...");
  await writeSecret(vaultToken, "fantasy/espn", { espn_s2: espnS2, swid });

  console.log("[Session Refresh] Done. espn-session-secrets will pick these up within its refreshInterval.");
}

if (require.main === module) {
  refreshEspnSession().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { refreshEspnSession };
