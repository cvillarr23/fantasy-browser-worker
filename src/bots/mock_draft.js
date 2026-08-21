const MOCK_LOBBY_URL = "https://fantasy.espn.com/football/mockdraftlobby";
// Unverified selector text beyond what draft_recon.js has already confirmed once — re-check if
// ESPN changes the lobby's copy/markup.
const PRACTICE_DRAFT_LINK_TEXT = /practice draft/i;
const DRAFT_ROOM_URL_PATTERN = /\/football\/draft/i;

// Bounded retry for the auto-click below — WORKER-17: a headless run has no human to fall back
// on, so it needs a real recovery strategy (try a couple of selector shapes, a couple of times)
// rather than a single attempt followed by a long unattended wait that can only ever pay off with
// a person watching.
const LOBBY_CLICK_ATTEMPTS = 3;
const LOBBY_CLICK_RETRY_DELAY_MS = 2000;
const LOBBY_CLICK_ATTEMPT_TIMEOUT_MS = 5000;

/** Thrown when the headless auto-click exhausts every attempt/strategy with no human to fall back on. */
class HeadlessLobbyJoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeadlessLobbyJoinError";
  }
}

/**
 * One click attempt against a single locator, bounded to a short per-attempt timeout (short
 * because this runs inside a retry loop — no point waiting long on a locator that isn't there).
 * Returns true on success, false on any failure (never throws) so the caller can just try the
 * next strategy/attempt.
 */
async function tryClick(locator, logger, label) {
  try {
    // click() starts its own actionability wait (visible, stable, receives events, etc.) with
    // Playwright's default 30s timeout if not given one explicitly — a visible-but-covered or
    // detached element would otherwise stall each retry far past LOBBY_CLICK_ATTEMPT_TIMEOUT_MS
    // (PR #42 review). Bounding it here keeps every attempt actually bounded to that window.
    await locator.click({ timeout: LOBBY_CLICK_ATTEMPT_TIMEOUT_MS });
    return true;
  } catch (err) {
    logger.warn(`[MockDraft] "${label}" click attempt failed: ${err.message}`);
    return false;
  }
}

/**
 * Navigates to the mock draft lobby and starts a brand-new practice draft, since practice draft
 * rooms are ephemeral and there's nothing durable to link to ahead of time.
 *
 * Retries the "Practice Draft" auto-click a few times across selector strategies (role=button
 * first — see below for why — then role=link, then plain text as a last resort) before giving up.
 * What happens after that split on `headless`: headless has no human to fall back on, so it throws
 * `HeadlessLobbyJoinError` immediately rather than idling out the full activePagePromise wait
 * below, which can only ever succeed with someone present to click manually. Headed keeps today's
 * behavior — log and let a person click it.
 *
 * role=button tried FIRST, confirmed live against a real practice-draft lobby (2026-08-21, stored
 * session, headless): the lobby's "League Specific Practice Draft" section heading is a plain
 * `<div>` that ALSO matches /practice draft/i — `getByText(...).first()` grabs that heading over
 * the actual `<button>Practice Draft</button>` a few nodes later. The click "succeeds" (a heading
 * is a valid click target, so no error is thrown) but navigates nowhere, which is exactly the
 * mystery 150s activePagePromise timeout this ordering fixes. Confirmed via a direct DOM query:
 * `getByText(/practice draft/i)` had 3 matches (the heading, a table caption, and the button);
 * `getByRole("button", { name: /practice draft/i })` had exactly 1 (the button).
 *
 * WORKER-17 LIVE-RUN FINDING (2026-08-21, refines rather than supersedes the 2026-08-10
 * reCAPTCHA/DisneyID finding in draft_sync.js's DRAFT_ROOM_URL doc comment — traced all the way
 * through, it's the SAME root cause manifesting differently for this flow): clicking the correct
 * button (role=button, confirmed above) still does NOT navigate to a draft room in headless mode.
 * Traced the full chain:
 *   1. The lobby always embeds an invisible reCAPTCHA Enterprise iframe (`www.google.com/
 *      recaptcha/enterprise/anchor?...&size=invisible`) alongside the DisneyID identity iframe —
 *      present on page load, not something the click triggers.
 *   2. Without any permission grant, that reCAPTCHA iframe calls `document.requestStorageAccess()`
 *      (confirmed via an injected wrapper logging caller origin: `https://www.google.com`) and
 *      Chromium headless denies it (`requestStorageAccess: Permission denied.`), which crashes the
 *      surrounding page's own React app (`Cannot read properties of undefined (reading
 *      'currentSeason')` / `'pageName'`) — the SPA doesn't handle that rejection.
 *   3. Granting it via CDP (`Browser.setPermission({ permission: { name: "storage-access" },
 *      setting: "granted", origin: "https://www.google.com", embeddingOrigin:
 *      "https://fantasy.espn.com" })` — note the permission name is kebab-case `"storage-access"`,
 *      not `"storageAccess"`, which the CDP command otherwise rejects as invalid) DOES stop the
 *      crash — no more denial, no more React error. But the click still never navigates anywhere,
 *      silently, even after a 25s wait, with `navigator.webdriver` already `false` (this file's
 *      `--disable-blink-features=AutomationControlled` flag is working as intended).
 *   4. That silent no-op — no error, no crash, just inert — is exactly the documented signature of
 *      invisible reCAPTCHA Enterprise: it scores the session as automated via deeper
 *      behavioral/fingerprint signals than `navigator.webdriver` and simply never completes its
 *      challenge or releases whatever callback would trigger navigation. This is the SAME
 *      mechanism already confirmed blocking automated login (see this repo's
 *      docs/espn-reverse-engineering.md) — just discovered here via a different symptom (a
 *      storage-access crash) before the underlying reCAPTCHA block became visible.
 * This is NOT a selector problem and no further retry/selector/permission-grant hardening in this
 * file is expected to fix it — reCAPTCHA Enterprise is specifically designed to resist exactly
 * this kind of workaround. Keep relying on `DRAFT_ROOM_URL` (a human joins a room once, headless
 * only ever resumes/observes it) rather than spending more time on headless auto-join here.
 *
 * Returns `{ url, page }` — NOT just a URL string (changed 2026-08-17). ESPN sometimes opens the
 * actual draft room in a brand-new tab/window rather than navigating the current page in place
 * (confirmed via draft_recon.js diagnostics: a new page appeared carrying the draft URL while the
 * original page stayed on the lobby; the old code only ever watched the original page for a URL
 * change that could never come there, which eventually timed out and tore down the whole
 * session). Callers MUST use the returned `page`, not whatever page they originally passed in —
 * it may be a different object.
 */
async function startFreshPracticeDraft(page, logger = console, { headless = false } = {}) {
  logger.log("[MockDraft] Navigating to mock draft lobby to start a fresh practice draft...");
  await page.goto(MOCK_LOBBY_URL, { waitUntil: "load", timeout: 60000 });

  const context = page.context();

  // Race both possibilities — the original page navigating in place, or a new page opening and
  // navigating there — set up BEFORE attempting the click, so it's already listening no matter
  // who ends up clicking "Practice Draft" (our auto-click, or a human, in a headed session).
  const activePagePromise = Promise.race([
    page.waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 150000 }).then(() => page),
    new Promise((resolve, reject) => {
      context.once("page", (newPage) => {
        newPage
          .waitForURL(DRAFT_ROOM_URL_PATTERN, { timeout: 150000 })
          .then(() => resolve(newPage))
          .catch(reject);
      });
    }),
  ]);
  // Marks the race as handled immediately, independent of whatever later actually awaits it —
  // matters because the headless-exhausted branch below can throw before that `await
  // activePagePromise` ever runs. Left unhandled, the caller then closes the browser (per its own
  // catch/finally), which rejects the abandoned page.waitForURL()/context "page" listener with no
  // handler in sight, and Node's unhandled-rejection behavior can crash the process outright
  // instead of the intended HeadlessLobbyJoinError propagating cleanly (PR #42 review).
  activePagePromise.catch(() => {});

  let clicked = false;
  for (let attempt = 1; attempt <= LOBBY_CLICK_ATTEMPTS && !clicked; attempt += 1) {
    if (attempt > 1) {
      await page.waitForTimeout(LOBBY_CLICK_RETRY_DELAY_MS);
    }
    // role=button tried FIRST and confirmed live 2026-08-21: the lobby's "League Specific
    // Practice Draft" section heading (a plain <div>) ALSO matches /practice draft/i, and
    // getByText's .first() grabs that heading over the actual <button>Practice Draft</button> a
    // few nodes later — the click "succeeds" (a heading is a valid click target) but navigates
    // nowhere, which is exactly the mystery 150s activePagePromise timeout this ordering fixes.
    // getByText/role=link stay only as fallbacks for a markup change that removes the button.
    clicked =
      (await tryClick(
        page.getByRole("button", { name: PRACTICE_DRAFT_LINK_TEXT }),
        logger,
        "role=button",
      )) ||
      (await tryClick(
        page.getByRole("link", { name: PRACTICE_DRAFT_LINK_TEXT }),
        logger,
        "role=link",
      )) ||
      (await tryClick(page.getByText(PRACTICE_DRAFT_LINK_TEXT).first(), logger, "text"));
  }

  if (!clicked) {
    if (headless) {
      throw new HeadlessLobbyJoinError(
        `[MockDraft] Headless auto-click exhausted ${LOBBY_CLICK_ATTEMPTS} attempts across all ` +
          "selector strategies — no human available to click manually. Aborting practice-draft join.",
      );
    }
    logger.warn(
      `[MockDraft] Couldn't auto-click "Practice Draft" after ${LOBBY_CLICK_ATTEMPTS} attempts. ` +
        "If this is a headed session, click it yourself now — waiting up to 2.5 minutes for the " +
        "draft room to load (either the current tab or a new one)...",
    );
  }

  const activePage = await activePagePromise;
  logger.log(`[MockDraft] In a fresh practice draft room: ${activePage.url()}`);
  return { url: activePage.url(), page: activePage };
}

/** Pulls leagueId/seasonId/teamId/memberId back out of a draft room URL. */
function parseDraftRoomUrl(url) {
  const parsed = new URL(url);
  return {
    leagueId: parsed.searchParams.get("leagueId"),
    seasonId: parsed.searchParams.get("seasonId"),
    teamId: parsed.searchParams.get("teamId"),
    memberId: parsed.searchParams.get("memberId"),
  };
}

module.exports = {
  MOCK_LOBBY_URL,
  PRACTICE_DRAFT_LINK_TEXT,
  DRAFT_ROOM_URL_PATTERN,
  HeadlessLobbyJoinError,
  startFreshPracticeDraft,
  parseDraftRoomUrl,
};
