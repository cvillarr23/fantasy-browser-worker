const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

/**
 * One-off recon tool — NOT part of the production pipeline. Verifies (or disproves) the
 * best-guess login selectors in refresh_espn_session.js against ESPN's real login page, the same
 * way draft_recon.js did for the draft room.
 *
 * Opens a *visible* browser (not headless) so you can watch it happen and step in if something
 * unexpected shows up (a CAPTCHA, an extra confirmation screen, etc.) — automated login flows are
 * exactly the kind of traffic bot-detection watches closest, so this deliberately isn't run
 * headless/unattended.
 *
 * Usage:
 *   node src/bots/login_recon.js
 * Credentials: ESPN_USERNAME/ESPN_PASSWORD env vars, else prompted for interactively. Never
 * passed as CLI args (would land in shell history / `ps` output).
 *
 * Output goes to recon-output/login-*  (gitignored, same directory draft_recon.js uses):
 *   login-dom-<n>.html      — full page DOM at each step
 *   login-screenshot-<n>.png
 *   login-frames.json       — every frame's URL (confirms whether the widget is iframe-embedded)
 *   login-selector-probe.json — which of the candidate selectors actually matched, and where
 */

const LOGIN_URL = "https://www.espn.com/login";
const OUTPUT_DIR = path.join(__dirname, "..", "..", "recon-output");

// Same candidates refresh_espn_session.js defaults to — this tool exists to confirm or replace
// them with real values.
const CANDIDATE_SELECTORS = {
  username: ['input[type="email"]', 'input[name="username"]', 'input[autocomplete="username"]'],
  password: ['input[type="password"]'],
  submit: ['button[type="submit"]', 'button[data-affiliatename]', 'button:has-text("Log In")'],
};

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function prompt(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }
    // No built-in hidden input in readline — mute the output stream while typing instead of
    // pulling in a dependency for a recon-only tool.
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => (chunk.includes(question) ? stdoutWrite(chunk, ...args) : true);
    rl.question(question, (answer) => {
      process.stdout.write = stdoutWrite;
      rl.close();
      console.log();
      resolve(answer);
    });
  });
}

async function getCredentials() {
  if (process.env.ESPN_USERNAME && process.env.ESPN_PASSWORD) {
    return { username: process.env.ESPN_USERNAME, password: process.env.ESPN_PASSWORD };
  }
  console.log("[Login Recon] ESPN_USERNAME/ESPN_PASSWORD not set — prompting interactively.");
  const username = await prompt("ESPN username/email: ");
  const password = await prompt("ESPN password: ", { hidden: true });
  return { username, password };
}

async function snapshot(page, label) {
  const html = await page.content();
  fs.writeFileSync(path.join(OUTPUT_DIR, `login-dom-${label}.html`), html);
  await page.screenshot({ path: path.join(OUTPUT_DIR, `login-screenshot-${label}.png`) }).catch(() => {});
  console.log(`[Login Recon] Captured DOM + screenshot: login-*-${label}`);
}

/** Tries every candidate selector against every frame, recording what actually matched. */
async function probeSelectors(page) {
  const frames = page.frames();
  const frameInfo = frames.map((f) => ({ url: f.url(), name: f.name() }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "login-frames.json"), JSON.stringify(frameInfo, null, 2));
  console.log(`[Login Recon] ${frames.length} frame(s) on the page:`, frameInfo.map((f) => f.url));

  const results = {};
  for (const [field, selectors] of Object.entries(CANDIDATE_SELECTORS)) {
    results[field] = [];
    for (const selector of selectors) {
      for (const frame of frames) {
        const count = await frame.locator(selector).count().catch(() => 0);
        if (count > 0) {
          results[field].push({ selector, frameUrl: frame.url(), matches: count });
        }
      }
    }
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "login-selector-probe.json"), JSON.stringify(results, null, 2));
  console.log("[Login Recon] Selector probe results:", JSON.stringify(results, null, 2));
  return results;
}

async function runLoginRecon() {
  ensureOutputDir();
  const { username, password } = await getCredentials();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // Log relevant auth-flow traffic (Disney/BAM identity infra showed up during draft room recon;
  // worth confirming whether login goes through it too).
  page.on("response", async (response) => {
    const url = response.url();
    if (!/espn\.com|bamgrid\.com|disney/i.test(url)) return;
    if (!/login|auth|token|session/i.test(url)) return;
    console.log(`[Login Recon] Auth-flow response: ${response.status()} ${url}`);
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000); // let any iframe/widget finish loading in
    await snapshot(page, "1-initial");

    const results = await probeSelectors(page);
    const usernameHit = results.username[0];
    const passwordHit = results.password[0];
    const submitHit = results.submit[0];

    if (!usernameHit || !passwordHit || !submitHit) {
      console.warn(
        "[Login Recon] Could not confidently find all three fields automatically. Review " +
          "recon-output/login-dom-1-initial.html and login-frames.json by hand, then either " +
          "adjust CANDIDATE_SELECTORS here and re-run, or set ESPN_LOGIN_*_SELECTOR env vars " +
          "directly on refresh_espn_session.js once you've found the real ones."
      );
      return;
    }

    console.log(`[Login Recon] Filling in credentials via frame ${usernameHit.frameUrl}...`);
    const frame = page.frames().find((f) => f.url() === usernameHit.frameUrl);
    await frame.locator(usernameHit.selector).first().fill(username);
    await frame.locator(passwordHit.selector).first().fill(password);
    await snapshot(page, "2-filled");

    await frame.locator(submitHit.selector).first().click();
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await snapshot(page, "3-after-submit");

    const cookies = await context.cookies("https://www.espn.com");
    const espnS2 = cookies.find((c) => c.name === "espn_s2")?.value;
    const swid = cookies.find((c) => c.name === "SWID")?.value;

    if (espnS2 && swid) {
      console.log(
        "[Login Recon] SUCCESS — espn_s2/SWID cookies were set. Confirmed working selectors:\n" +
          `  username: ${usernameHit.selector}\n  password: ${passwordHit.selector}\n  submit: ${submitHit.selector}\n` +
          "These match refresh_espn_session.js's defaults? Update ESPN_LOGIN_*_SELECTOR overrides " +
          "if not, or hardcode them as the new defaults there."
      );
    } else {
      console.warn(
        "[Login Recon] Submitted the form but espn_s2/SWID never appeared. Check " +
          "recon-output/login-dom-3-after-submit.html and the screenshot for what actually " +
          "happened (extra verification step? wrong field matched?)."
      );
    }
  } catch (error) {
    console.error(`[Login Recon] Fatal error: ${error.message}`);
    await snapshot(page, "error").catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log(`[Login Recon] Done. Review ${OUTPUT_DIR} for captured output.`);
  }
}

if (require.main === module) {
  runLoginRecon();
}

module.exports = { runLoginRecon };
