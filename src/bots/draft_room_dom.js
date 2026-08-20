const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("./auth");
const { buildDraftUrl } = require("./draft_sync");
const { captureDebugSnapshot } = require("./debug_capture");

/**
 * DOM-click fallback tier for WORKER-06 — used only if the primary WebSocket submission path
 * (draft_room_socket.js's sendPick) fails or is untrusted. Issue #14 only ever confirmed the
 * *roster* page has no per-player DOM identifier; the draft room was never actually probed there.
 *
 * VERIFIED (recon-output/dom-snapshot-4.html, captured 2026-08-16 against a real practice draft):
 * the draft room DOES carry `data-player-id`, on the "Queue" button —
 * `button.Button--queue.action-btn[data-player-id="..."]` — not on a `tr` the way the original
 * issue #6 spec (and the now-fixed waiver_sniper.js/old draft_clicker.js) assumed.
 *
 * VERIFIED (recon-output/dom-snapshot-our-turn-1.html through -6.html, captured 2026-08-17 via
 * draft_recon.js's captureOurTurnSnapshot against a real practice draft, five real "our turn"
 * events): the actual "Draft" button also carries `data-player-id` directly on itself —
 * `button.Button--draft[data-player-id="..."]` (full observed class:
 * `"Button Button--alt ttu Button--draft"`) — no row/ancestor traversal needed, it can be
 * targeted the same direct way as the Queue button.
 *
 * OPEN RISK, found 2026-08-17, MITIGATED 2026-08-20 (WORKER-11): `createAuthenticatedSession()`
 * only injects espn_s2/SWID cookies — it does not perform a real interactive login. That's proven
 * sufficient for draft_room_socket.js (REST + the raw WS protocol both work fine on cookies
 * alone), but the *rendered browser page* additionally gates on a separate Disney/MyDisney
 * identity SDK session (BAM SDK, espn.connections.edge.bamgrid.com — a JWT-based session only
 * obtainable via real interactive login), which cookie injection never establishes. In practice
 * this showed up as the draft room page displaying "Log in Required" even while the exact same
 * cookies kept the REST/WS layer working perfectly.
 *
 * WORKER-11's remote VNC login tool (`remote_login.js`) now saves a full Playwright
 * `storageState()` (cookies AND localStorage, capturing the Disney SDK tokens too) after a real
 * interactive login. `clickPickViaDom` below prefers loading that via
 * `createSessionFromStoredState()`, falling back to bare cookie injection only if no stored state
 * exists in OpenBao yet. This is expected to resolve the login gate, but is still UNVERIFIED
 * against a real production draft — DEBUG_CAPTURE=1 (see debug_capture.js) will dump the page's
 * DOM/screenshot on load and on any failure here, which would show the gate directly if it's still
 * the cause of a failure.
 */
// Bounded wait for the Draft button to disappear/detach after clicking — the only DOM-observable
// signal that the click actually landed (ESPN removes/updates a drafted player's row). Without
// this, clickPickViaDom returning normally only proves Playwright dispatched a DOM click event,
// not that ESPN accepted the pick — and draft_clicker.js's caller treats a normal return as
// success, which acks and permanently removes the queue message either way.
const CLICK_CONFIRM_TIMEOUT_MS = 8000;

async function clickPickViaDom({ leagueId, seasonId, teamId }, playerId) {
  const session =
    (await createSessionFromStoredState()) ??
    (await createAuthenticatedSession());
  try {
    const draftUrl = buildDraftUrl(leagueId, seasonId, teamId, session.swid);
    await session.page.goto(draftUrl, { waitUntil: "load", timeout: 60000 });
    await captureDebugSnapshot(session.page, "draft-room-dom-loaded");

    // Verified selector (see this file's header) — the Draft button carries data-player-id
    // directly, same as the Queue button, no row/ancestor traversal needed.
    const draftButton = session.page.locator(
      `button.Button--draft[data-player-id="${playerId}"]`,
    );
    await draftButton.waitFor({ state: "visible", timeout: 15000 });
    await draftButton.click({ timeout: 10000 });

    // Confirmation, not just a dispatched click: "hidden" covers both detached-from-DOM and
    // still-present-but-invisible, the observable signal that the row actually updated. If it's
    // still sitting there visible and clickable, we don't actually know the pick landed.
    await draftButton.waitFor({
      state: "hidden",
      timeout: CLICK_CONFIRM_TIMEOUT_MS,
    });

    return { method: "dom", playerId };
  } catch (err) {
    await captureDebugSnapshot(session.page, "draft-room-dom-failure");
    throw err;
  } finally {
    if (session.browser) {
      await session.browser.close();
    }
  }
}

module.exports = { clickPickViaDom };
