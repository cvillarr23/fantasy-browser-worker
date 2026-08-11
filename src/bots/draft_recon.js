const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const { startFreshPracticeDraft } = require("./mock_draft");

/**
 * One-off recon tool — NOT part of the production worker pipeline.
 *
 * Run this by hand against a live ESPN mock draft to capture what actually happens on the wire
 * (WebSocket frames or HTTP polling responses) and in the DOM during a draft, before wiring real
 * extraction logic into draft_sync.js. draft_sync.js and espn_selectors.json currently ship with
 * placeholder/unverified URLs and selectors — this script's output (recon-output/*.jsonl, *.html,
 * *.png) is what replaces those placeholders with real values.
 *
 * Usage:
 *   node src/bots/draft_recon.js            # start a fresh practice draft from the lobby (default)
 *   node src/bots/draft_recon.js <url>       # resume/observe a specific, still-active draft room
 *
 * Practice/mock drafts are ephemeral — a room URL is only good until that particular draft ends, so
 * there's no fixed default draft URL to point at. Instead, the default path navigates to the mock
 * draft lobby and clicks into a fresh "Practice Draft" room itself each run. Pass an explicit URL
 * only if you're rejoining a specific room that's still open (e.g. from another tab).
 *
 * Auth: tries ESPN_S2/SWID env vars, then OpenBao (see auth.js), and if neither is available opens
 * a *visible* (non-headless) browser window and pauses so you can log into ESPN by hand — good
 * enough for a one-off local recon run without needing cookies extracted or secrets set up first.
 */

const OUTPUT_DIR = path.join(__dirname, "..", "..", "recon-output");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function appendJsonLine(filename, record) {
  fs.appendFileSync(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify({ capturedAt: new Date().toISOString(), ...record }) + "\n"
  );
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** No cookies available anywhere — open a real browser window and let the user log in by hand. */
async function launchWithManualLogin() {
  console.log(
    "[Recon] No ESPN_S2/SWID in env or OpenBao. Opening a visible browser — log into ESPN there, " +
      "then come back to this terminal."
  );
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto("https://www.espn.com/login", { waitUntil: "load", timeout: 60000 });
  await waitForEnter("[Recon] Press Enter once you're logged in to continue... ");
  return { browser, context, page };
}

async function runRecon() {
  // Any argument other than the (now-default) fresh-start behavior is treated as an explicit
  // room URL to resume/observe directly instead of starting a new practice draft.
  const explicitUrl = process.argv[2] && process.argv[2] !== "--fresh" ? process.argv[2] : null;

  ensureOutputDir();
  console.log(`[Recon] Output directory: ${OUTPUT_DIR}`);

  let session = null;
  try {
    session = resolveEspnCookies() ? await createAuthenticatedSession() : await launchWithManualLogin();
    const { page } = session;

    page.on("websocket", (ws) => {
      console.log(`[Recon] WebSocket opened: ${ws.url()}`);
      appendJsonLine("websockets.jsonl", { event: "open", url: ws.url() });

      ws.on("framereceived", (frame) => {
        const payload = frame.payload.toString();
        console.log(`[Recon] WS frame received (${payload.length} bytes)`);
        appendJsonLine("websockets.jsonl", {
          event: "framereceived",
          url: ws.url(),
          payload,
        });
      });

      ws.on("framesent", (frame) => {
        appendJsonLine("websockets.jsonl", {
          event: "framesent",
          url: ws.url(),
          payload: frame.payload.toString(),
        });
      });

      ws.on("close", () => {
        console.log(`[Recon] WebSocket closed: ${ws.url()}`);
        appendJsonLine("websockets.jsonl", { event: "close", url: ws.url() });
      });
    });

    // Capture background HTTP polling in case ESPN uses request/response instead of (or alongside) a
    // WebSocket for draft state — filter to same-origin API-shaped calls to keep the log readable.
    page.on("response", async (response) => {
      const url = response.url();
      if (!/espn\.com/i.test(url)) return;
      if (!/draft|mDraftDetail|pick/i.test(url)) return;

      let body = null;
      try {
        body = await response.text();
      } catch {
        // Non-text/binary response, skip body capture.
      }

      console.log(`[Recon] Relevant HTTP response: ${response.status()} ${url}`);
      appendJsonLine("http-responses.jsonl", {
        event: "response",
        status: response.status(),
        url,
        body,
      });
    });

    if (explicitUrl) {
      console.log(`[Recon] Resuming explicit draft room URL: ${explicitUrl}`);
      await page.goto(explicitUrl, { waitUntil: "load", timeout: 60000 });
    } else {
      await startFreshPracticeDraft(page);
    }

    console.log(
      "[Recon] Page loaded. Leaving the browser open for 10 minutes — join/observe the draft " +
        "manually now. Every WS frame and matching HTTP response is being logged to " +
        `${OUTPUT_DIR}. Press Ctrl+C once you've captured a few picks.`
    );

    // Snapshot the DOM periodically in case the network layer alone isn't enough and a fallback
    // selector strategy is needed.
    let snapshotCount = 0;
    const snapshotInterval = setInterval(async () => {
      try {
        snapshotCount += 1;
        const html = await page.content();
        fs.writeFileSync(
          path.join(OUTPUT_DIR, `dom-snapshot-${snapshotCount}.html`),
          html
        );
        await page.screenshot({
          path: path.join(OUTPUT_DIR, `screenshot-${snapshotCount}.png`),
        });
        console.log(`[Recon] Captured DOM + screenshot snapshot #${snapshotCount}`);
      } catch (err) {
        console.error(`[Recon] Snapshot failed: ${err.message}`);
      }
    }, 60000);

    await page.waitForTimeout(10 * 60 * 1000);
    clearInterval(snapshotInterval);
  } catch (error) {
    console.error(`[Recon] Fatal error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
    console.log(`[Recon] Done. Review ${OUTPUT_DIR} for captured traffic.`);
  }
}

if (require.main === module) {
  runRecon();
}

module.exports = { runRecon };
