const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const { startFreshPracticeDraft, parseDraftRoomUrl } = require("./mock_draft");

/**
 * One-off recon tool — NOT part of the production worker pipeline.
 *
 * Run this by hand against a live ESPN mock draft to capture what actually happens on the wire
 * (WebSocket frames or HTTP polling responses) and in the DOM during a draft. This is what
 * originally produced the real URL/WebSocket-protocol values draft_sync.js now ships with
 * (verified 2026-08-10, see its own header comment) — kept around for re-verifying if ESPN
 * changes the draft room, and because espn_selectors.json's DOM selectors (used by the other
 * bots, not draft_sync.js) are still unverified placeholders.
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
 * Auth, in priority order:
 *   1. A saved browser session (.espn-storage-state.json, gitignored) from a previous manual
 *      login — reused automatically so you don't have to log in by hand every single run. This is
 *      the ONLY auth path that renders a working page: cookie injection (below) is sufficient for
 *      REST/WS but NOT for the rendered UI, which additionally gates on a Disney/MyDisney identity
 *      SDK session that only a real interactive login establishes (confirmed 2026-08-17 — see
 *      draft_room_socket.js's header for the full story). If the saved session has gone stale,
 *      you'll see ESPN's own "Log in Required" gate in the browser window; delete the file and
 *      rerun to force a fresh login.
 *   2. FORCE_MANUAL_LOGIN=1 or no ESPN_S2/SWID anywhere (env vars, then OpenBao) — opens a
 *      *visible* browser and pauses for you to log into ESPN by hand, then SAVES that session to
 *      the file above for every future run to reuse via path 1.
 *   3. Otherwise, cookie injection (env/OpenBao) — fine for anything that doesn't need the
 *      rendered UI, but will hit the login gate for anything that does.
 */

const OUTPUT_DIR = path.join(__dirname, "..", "..", "recon-output");
const STORAGE_STATE_PATH = path.join(__dirname, "..", "..", ".espn-storage-state.json");

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

// Fixed filename (truncated fresh each run, not timestamped) — so "check the latest recon run"
// is always the same path, no hunting through a pile of old runs to find the right one.
const LOG_FILE = path.join(OUTPUT_DIR, "draft-recon-latest.log");

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

function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Loads a previously-saved browser session (see launchWithManualLogin's storageState save below).
 * Returns null if no saved state file exists — caller falls through to another auth path.
 * Headed, same as the manual-login path: a stale session shows ESPN's own "Log in Required" gate
 * visibly rather than failing silently, which is your signal to delete the file and log in fresh.
 */
async function tryLoadStoredSession() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) return null;
  console.log(`[Recon] Reusing saved session: ${STORAGE_STATE_PATH}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    storageState: STORAGE_STATE_PATH,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * No cookies available anywhere (or FORCE_MANUAL_LOGIN set) — open a real browser window and let
 * the user log in by hand. Saves the resulting session to STORAGE_STATE_PATH afterward so future
 * runs reuse it via tryLoadStoredSession() instead of requiring a fresh login every time.
 */
async function launchWithManualLogin() {
  console.log(
    "[Recon] Opening a visible browser — log into ESPN there, then come back to this terminal.",
  );
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  await page.goto("https://www.espn.com/login", {
    waitUntil: "load",
    timeout: 60000,
  });
  await waitForEnter(
    "[Recon] Press Enter once you're logged in to continue... ",
  );
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log(`[Recon] Session saved to ${STORAGE_STATE_PATH} — future runs will reuse it automatically.`);
  return { browser, context, page };
}

async function runRecon() {
  // Any argument other than the (now-default) fresh-start behavior is treated as an explicit
  // room URL to resume/observe directly instead of starting a new practice draft.
  const explicitUrl =
    process.argv[2] && process.argv[2] !== "--fresh" ? process.argv[2] : null;

  // Also truncates/recreates recon-output/draft-recon-latest.log — always the same path, so
  // "check the latest run" never requires hunting through a pile of old timestamped files.
  const log = openLog();
  log.log(`[Recon] Output directory: ${OUTPUT_DIR}`);
  log.log(`[Recon] Log file: ${LOG_FILE}`);

  let session = null;
  try {
    // Always headed: this tool exists for a human to watch traffic AND manually interact. Auth
    // priority: saved session (reuse a prior real login, avoids logging in every run) -> manual
    // login (FORCE_MANUAL_LOGIN=1, or no saved session and no cookies) -> cookie injection. See
    // this file's header for why cookie injection alone can't render the draft room UI (it's
    // sufficient for REST/WS, not for the page itself — a separate Disney/MyDisney identity SDK
    // gate, confirmed 2026-08-17).
    session =
      (await tryLoadStoredSession()) ||
      (resolveEspnCookies() && !process.env.FORCE_MANUAL_LOGIN
        ? await createAuthenticatedSession({ headless: false })
        : await launchWithManualLogin());

    // Reassigned if startFreshPracticeDraft ends up navigating a brand-new tab instead of the
    // original page (confirmed 2026-08-17 — see mock_draft.js's header). Every closure below
    // reads this variable at call time, not the page it was defined with, so reassigning it here
    // is enough to redirect all of them at once.
    let activePage = session.page;

    session.browser.on("disconnected", () => log.log("[Recon] Browser disconnected."));

    // Set once the room URL is known (after navigation, below) — attached before that so it
    // doesn't race the page's own WebSocket connect, so this has to be a closed-over mutable var
    // rather than an argument.
    let ourTeamId = null;
    let ourTurnSnapshotCount = 0;

    /**
     * Captures the DOM/screenshot the instant it's actually our turn — the periodic 60s-interval
     * snapshots below have never once caught the "Draft" button, almost certainly because it's
     * only rendered when the current user is on the clock, which a fixed interval isn't
     * guaranteed to land inside. WORKER-06's DOM-click fallback needs this to get a verified
     * selector instead of guessing (the exact mistake issue #14 already caught once).
     */
    const captureOurTurnSnapshot = async () => {
      ourTurnSnapshotCount += 1;
      const tag = `dom-snapshot-our-turn-${ourTurnSnapshotCount}`;
      try {
        const html = await activePage.content();
        fs.writeFileSync(path.join(OUTPUT_DIR, `${tag}.html`), html);
        await activePage.screenshot({ path: path.join(OUTPUT_DIR, `${tag}.png`) });
        log.log(`[Recon] Captured our-turn snapshot: ${tag}`);
      } catch (err) {
        log.error(`[Recon] Our-turn snapshot failed: ${err.message}`);
      }
    };

    /**
     * Wires up every capture listener on a given page. Called on the original page immediately
     * (below), and again on any brand-new tab the app opens (via context.on("page")) — ESPN's
     * "Practice Draft" flow sometimes opens the real draft room in a new tab rather than
     * navigating the current page in place, and a listener attached only to the original page
     * would silently miss everything happening in that new one.
     */
    const attachPageListeners = (pageToWatch) => {
      pageToWatch.on("close", () => log.log(`[Recon] Page closed. Last known URL: ${pageToWatch.url()}`));

      pageToWatch.on("websocket", (ws) => {
        log.log(`[Recon] WebSocket opened: ${ws.url()}`);
        appendJsonLine("websockets.jsonl", { event: "open", url: ws.url() });

        ws.on("framereceived", (frame) => {
          const payload = frame.payload.toString();
          log.log(`[Recon] WS frame received (${payload.length} bytes)`);
          appendJsonLine("websockets.jsonl", {
            event: "framereceived",
            url: ws.url(),
            payload,
          });

          const line = payload.trim();
          if (ourTeamId && line.startsWith("SELECTING ")) {
            const [, selectingTeam] = line.split(/\s+/);
            if (selectingTeam === String(ourTeamId)) {
              log.log(`[Recon] SELECTING matched our team (${ourTeamId}) — capturing DOM now.`);
              captureOurTurnSnapshot();
            }
          }
        });

        ws.on("framesent", (frame) => {
          appendJsonLine("websockets.jsonl", {
            event: "framesent",
            url: ws.url(),
            payload: frame.payload.toString(),
          });
        });

        ws.on("close", () => {
          log.log(`[Recon] WebSocket closed: ${ws.url()}`);
          appendJsonLine("websockets.jsonl", { event: "close", url: ws.url() });
        });
      });

      // Capture outgoing request bodies too — the response logger below only shows what ESPN sent
      // back, never what the page's own client sent to submit a pick. WORKER-06 needs that
      // send-side shape (POST body or query) to know how a draft pick is actually transmitted
      // over HTTP, same as ws framesent already captures the send side for the WebSocket.
      pageToWatch.on("request", (request) => {
        const url = request.url();
        if (!/espn\.com/i.test(url)) return;
        if (!/draft|mDraftDetail|pick/i.test(url)) return;

        log.log(`[Recon] Relevant HTTP request: ${request.method()} ${url}`);
        appendJsonLine("http-requests.jsonl", {
          event: "request",
          method: request.method(),
          url,
          postData: request.postData(),
        });
      });

      // Capture background HTTP polling in case ESPN uses request/response instead of (or
      // alongside) a WebSocket for draft state — filter to same-origin API-shaped calls to keep
      // the log readable.
      pageToWatch.on("response", async (response) => {
        const url = response.url();
        if (!/espn\.com/i.test(url)) return;
        if (!/draft|mDraftDetail|pick/i.test(url)) return;

        let body = null;
        try {
          body = await response.text();
        } catch {
          // Non-text/binary response, skip body capture.
        }

        log.log(`[Recon] Relevant HTTP response: ${response.status()} ${url}`);
        appendJsonLine("http-responses.jsonl", {
          event: "response",
          status: response.status(),
          url,
          body,
        });
      });
    };

    attachPageListeners(activePage);
    session.context.on("page", (newPage) => {
      log.log(`[Recon] New page/tab opened by the app: ${newPage.url()}`);
      attachPageListeners(newPage);
    });

    if (explicitUrl) {
      log.log(`[Recon] Resuming explicit draft room URL: ${explicitUrl}`);
      await activePage.goto(explicitUrl, { waitUntil: "load", timeout: 60000 });
    } else {
      ({ page: activePage } = await startFreshPracticeDraft(activePage, log));
    }

    try {
      ourTeamId = parseDraftRoomUrl(activePage.url()).teamId;
      log.log(`[Recon] Our team id: ${ourTeamId} — will capture DOM the instant it's our turn.`);
    } catch (err) {
      log.error(`[Recon] Could not parse teamId from room URL (${activePage.url()}): ${err.message}`);
    }

    log.log(
      "[Recon] Page loaded. Leaving the browser open for 10 minutes — join/observe the draft " +
        "manually now. Every WS frame and matching HTTP request/response is being logged to " +
        `${OUTPUT_DIR}. IMPORTANT for WORKER-06: make sure you actually DRAFT at least one player ` +
        "yourself during this window (not just watch autodraft picks land) — that's the only " +
        "action that produces a submission-side sample (a WS framesent or an outgoing HTTP " +
        "request) instead of just the broadcast/reconciliation traffic every other bot already " +
        "has captures of. Press Ctrl+C once you've captured a few picks including your own.",
    );

    // Snapshot the DOM periodically in case the network layer alone isn't enough and a fallback
    // selector strategy is needed.
    let snapshotCount = 0;
    const snapshotInterval = setInterval(async () => {
      try {
        snapshotCount += 1;
        const html = await activePage.content();
        fs.writeFileSync(
          path.join(OUTPUT_DIR, `dom-snapshot-${snapshotCount}.html`),
          html,
        );
        await activePage.screenshot({
          path: path.join(OUTPUT_DIR, `screenshot-${snapshotCount}.png`),
        });
        log.log(
          `[Recon] Captured DOM + screenshot snapshot #${snapshotCount}`,
        );
      } catch (err) {
        log.error(`[Recon] Snapshot failed: ${err.message}`);
      }
    }, 60000);

    await activePage.waitForTimeout(10 * 60 * 1000);
    clearInterval(snapshotInterval);
  } catch (error) {
    log.error(`[Recon] Fatal error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
    log.log(`[Recon] Done. Review ${OUTPUT_DIR} for captured traffic.`);
  }
}

if (require.main === module) {
  runRecon();
}

module.exports = {
  runRecon,
  launchWithManualLogin,
  tryLoadStoredSession,
  waitForEnter,
  OUTPUT_DIR,
  LOG_FILE,
  STORAGE_STATE_PATH,
};
