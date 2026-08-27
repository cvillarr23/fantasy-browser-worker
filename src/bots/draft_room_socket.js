const WebSocket = require("ws");
const { logger } = require("../telemetry/logger");

/**
 * Sidecar WebSocket client for ESPN's live draft room (WORKER-06).
 *
 * CONFIRMED against a real capture on 2026-08-15/16 (recon-output/websockets.jsonl, via
 * draft_recon.js against a live practice draft — the user actually drafted several players): the
 * client submits a pick by sending a plain text frame `SELECT <playerId>\n` on the same socket
 * draft_sync.js (WORKER-05) already reads `SELECTED <teamId> <playerId> <lineupSlotId> [<memberId>]`
 * broadcasts from. Correlated directly in the capture — a sent `SELECT 4362249` was immediately
 * followed by a received `SELECTED 8 4362249 10 {<our SWID>}`, i.e. our own pick echoed back
 * attributed to our own team. Also observed on the same socket, neither used here:
 *   - `DRAFT_LIST <id> <id> ...` — the "add to queue" feature, sends the full queue on every
 *     change. Not a pick; easy to mistake for one (it's what produced the "player added to
 *     queue" Adobe Analytics beacons during initial capture attempts, before an actual pick).
 *   - `PING PING%20<unixMillis>` — a periodic (~15s) keepalive sent by ESPN's own client. Not a
 *     precondition for SELECT (a real SELECT landed ~12-19s after the prior PING with nothing
 *     else in between), so not replicated here for a short-lived, send-one-pick-and-close socket.
 *
 * The JOIN URL's query string is also now confirmed from the same capture (previously guessed at
 * nothing but the bare path):
 *   wss://fantasydraft.espn.com/game-1/league-{leagueId}/JOIN
 *     ?1=1&2={leagueId}&3={teamId}&4={memberId}&5=1:{leagueId}:{teamId}:{memberId}:-301672673
 *     &6=false&7=false&8=KONA&nocache={random}
 * `-301672673` was identical across two captures against different leagues/sessions (2026-08-10
 * and 2026-08-15), confirming it's a fixed constant, not session-derived. `memberId` is the SWID
 * cookie value including its braces (e.g. `{74F98EAE-F0AD-4E1C-91DC-00EBA32AF50E}`). Fields
 * 1/6/7/8 are left as the literal constants observed (8=KONA matches the `x-fantasy-platform:
 * kona-PROD` header espn_api.js already sends elsewhere) — meaning unchanged, unconfirmed.
 *
 * CONFIRMED end-to-end 2026-08-16 (scripts/practice-draft-test.js against a real practice draft):
 * this standalone `ws` client — Cookie header, Origin: https://fantasy.espn.com, and a browser
 * User-Agent, all required (a bare Cookie header alone 403'd on the upgrade before any app-level
 * response) — connects, waits for team 8's SELECTING turn notification, sends SELECT, and gets a
 * matching SELECTED confirmation back in ~250ms. Not a guess anymore; this is the real mechanism,
 * verified against ESPN's live servers from this exact code path, not just observed in a browser.
 *
 * CONFIRMED 2026-08-17: a rejected SELECT (practice-draft-test.js's --also-test-taken, targeting
 * an already-drafted player) is NOT silent — the server replies with an explicit
 * `ERROR <code> <message>` frame (observed: `ERROR 1 Invalid+Selection.`, spaces sent as literal
 * `+`) rather than just withholding a SELECTED broadcast. draft_clicker.js listens for this via
 * onError and treats it as a PermanentError (the target is definitively gone; redelivery of the
 * same message can never succeed), instead of the ambiguous "no confirmation" timeout case, which
 * — per connection.js's requeue-on-transient-Error, no-backoff behavior — would otherwise retry a
 * doomed pick forever.
 *
 * CONFIRMED 2026-08-17: the draft room is SINGLE-SESSION per league/team/member — a new JOIN for
 * the same identity evicts any existing connection for it. Verified directly: running
 * scripts/draft-watch.js while the same user's own browser tab was already connected to the same
 * room evicted the browser tab (shown ESPN's own reconnect/exit prompt), not the newly-connecting
 * script. Good news for draft_clicker.js specifically — its connection always wins, so it's never
 * the one that fails to join — but it means a brief, deliberate side effect: submitting a pick
 * will momentarily boot the user's own browser tab if they have the draft room open at that
 * moment (recoverable — they just reconnect). It also means a long-lived observer (draft-watch.js)
 * is NOT safe to assume stays connected indefinitely: the user's own browser reconnecting, or
 * draft_clicker.js briefly connecting to submit a pick, will silently evict it too. See this
 * file's onClose handle for detecting that.
 *
 * IMPORTANT distinction confirmed 2026-08-17: cookie-only auth (auth.js's espn_s2/SWID injection,
 * no real interactive login) is sufficient for everything this module does — REST calls AND this
 * WS protocol both keep working fine on cookies alone, proven repeatedly above. The RENDERED
 * BROWSER PAGE is a separate story: it additionally gates on a full Disney/MyDisney identity SDK
 * session (the BAM SDK traffic to espn.connections.edge.bamgrid.com, a JWT-based session obtained
 * only via a real interactive login), which cookie injection never establishes — so a
 * Playwright-rendered draft room page shows "Log in Required" even while this module's raw socket
 * keeps working perfectly against the exact same league/cookies. This is why draft_clicker.js's
 * primary path (this file) is unaffected by that gate — it never renders a page — while anything
 * that DOES render one (draft_recon.js's DOM captures, draft_room_dom.js's fallback tier) hits it.
 *
 * This is a standalone `ws` client rather than reusing Playwright's page-observed socket
 * (draft_sync.js's approach) because Playwright's WebSocket handle is observation-only —
 * framesent/framereceived events exist, but there's no .send(). Sending would require
 * monkey-patching window.WebSocket via page.addInitScript and reaching in with page.evaluate,
 * which is fragile and doesn't need a full rendered draft-room page just to get a socket.
 * draft_clicker.js only needs cookies (from auth.js's resolveEspnCookies()) to authenticate the
 * raw socket — no browser context needed for this part, which is faster than launching Chromium
 * per queue message (matters against a 60-90s draft clock). This remains draft_clicker.js's
 * fallback path for a league with no active connector Job (see session_registry.js) — a brand new
 * JOIN is exactly the right, and only, thing to do when nothing already owns the room.
 *
 * ISSUE #70 UPDATE: for a league WITH an active connector Job, a brand new JOIN is now exactly
 * the wrong thing to do — it evicts draft_sync.js's own long-lived observer session (this is the
 * whole incident #70 exists to fix). draft_sync.js instead submits a delegated pick through
 * installDraftSocketSendHook()/sendPickViaPage() below: the "fragile" page.evaluate() monkeypatch
 * this header used to rule out for draft_clicker.js's use case. The trade-off is different for
 * draft_sync.js specifically — it already has a live rendered page open for the life of the
 * draft, so there's no extra browser cost, and reaching into that existing socket is the *only*
 * way to submit without a new JOIN. draft_clicker.js keeps this file's raw `ws` client as its own
 * path (still faster, still no browser needed) for the no-owner fallback case.
 */

// Constant across every observed capture regardless of league/session — see header comment.
const JOIN_MAGIC_SUFFIX = "-301672673";

/**
 * Builds the query string by hand rather than via URLSearchParams: the latter percent-encodes
 * `{`, `}`, and `:` (e.g. `%7B`...`%7D`), but the captured URL had them literal. Servers normally
 * decode either form to the same value, but this traffic is live (not dry-run gated), so matching
 * the exact captured bytes removes that as a variable rather than relying on the assumption.
 */
function buildDraftSocketUrl({ leagueId, teamId, memberId }) {
  const nocache = Math.floor(Math.random() * 1_000_000);
  const composite = `1:${leagueId}:${teamId}:${memberId}:${JOIN_MAGIC_SUFFIX}`;
  const query = [
    "1=1",
    `2=${leagueId}`,
    `3=${teamId}`,
    `4=${memberId}`,
    `5=${composite}`,
    "6=false",
    "7=false",
    "8=KONA",
    `nocache=${nocache}`,
  ].join("&");
  return `wss://fantasydraft.espn.com/game-1/league-${leagueId}/JOIN?${query}`;
}

/** Ensures a SWID has its braces (the JOIN URL and SELECTED frames both carry them). */
function normalizeSwid(swid) {
  const trimmed = String(swid).trim();
  return trimmed.startsWith("{")
    ? trimmed
    : `{${trimmed.replace(/[{}]/g, "")}}`;
}

/** Parses a raw WS text frame — same SELECTED format draft_sync.js's parseSelectedFrame handles. */
function parseSelectedFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("SELECTED ")) return null;

  const [, teamId, playerId, lineupSlotId] = line.split(/\s+/);
  if (teamId == null || playerId == null || lineupSlotId == null) return null;

  return {
    team_id: Number(teamId),
    player_id: Number(playerId),
    lineup_slot_id: Number(lineupSlotId),
    // Explicitly null, not absent: this frame carries no round, and consumers that used to
    // read the slot id as one must see a deterministic "unknown" rather than undefined.
    round: null,
  };
}

/**
 * Parses a rejection frame — `ERROR <code> <message>`, message space-encoded as literal `+`
 * (observed: `ERROR 1 Invalid+Selection.`). Has no player/team reference of its own; correlating
 * it to a specific SELECT is the caller's responsibility (safe for this module's single-pick-then
 * -close usage — see draft_clicker.js).
 */
function parseErrorFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("ERROR ")) return null;

  const rest = line.slice("ERROR ".length);
  const spaceIdx = rest.indexOf(" ");
  const code = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const message =
    spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).replace(/\+/g, " ");
  return { code: Number(code), message };
}

/**
 * Opens the sidecar socket and resolves once it's connected. Caller owns the returned handle's
 * lifecycle (call close() when done — this does not auto-close on idle).
 */
// A bare Cookie header alone got a 403 on the WS upgrade (2026-08-16) — before any app-level
// response, so almost certainly an edge/WAF check. CONFIRMED FIXED by adding the two headers
// below (Origin, a browser User-Agent): the same request shape then connected successfully and
// submitted real, confirmed picks (see this file's header for the full verification writeup).
// Still unconfirmed which of the two headers the 403 was actually about — both are sent
// regardless, so it's moot for correctness, just noted for anyone trying to strip one down later.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Bounded so a stalled upgrade can't hang connectToDraftRoom() for the OS's full default network
// timeout — this worker's channel-wide prefetch(1) means a hung draft-pick connection would also
// block lineup/waiver processing behind it, on top of blowing the draft clock itself.
const HANDSHAKE_TIMEOUT_MS = 10000;

function connectToDraftRoom({ leagueId, teamId, espnS2, swid }) {
  return new Promise((resolve, reject) => {
    const memberId = normalizeSwid(swid);
    const url = buildDraftSocketUrl({ leagueId, teamId, memberId });
    const ws = new WebSocket(url, {
      headers: {
        Cookie: `espn_s2=${espnS2}; SWID=${memberId}`,
        Origin: "https://fantasy.espn.com",
        "User-Agent": BROWSER_USER_AGENT,
      },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });

    const onOpen = () => {
      ws.off("error", onConnectError);
      // Replace the connect-phase handler with a persistent one: Node's EventEmitter treats an
      // 'error' emission with zero listeners as fatal and crashes the whole process, which a
      // later transport error (post-handshake) would otherwise do the instant onConnectError was
      // removed and nothing replaced it.
      ws.on("error", (err) => {
        logger.error(
          `[Draft Room Socket] Transport error after connect (league ${leagueId}, team ${teamId}): ${err.message}`,
          { err, leagueId, teamId },
        );
      });
      resolve(handleFor(ws));
    };
    const onConnectError = (err) => {
      ws.off("open", onOpen);
      // Deliberately omits `url` from the message: it embeds the caller's SWID (an account
      // identifier), and this error gets logged and persisted to draft-pick-fail-*.json via
      // draft_clicker.js's captureFailure.
      reject(
        new Error(
          `[Draft Room Socket] Failed to connect to draft room (league ${leagueId}, team ${teamId}): ${err.message}`,
        ),
      );
    };

    ws.once("open", onOpen);
    ws.once("error", onConnectError);
  });
}

function handleFor(ws) {
  return {
    onSelected(handler) {
      ws.on("message", (data) => {
        const parsed = parseSelectedFrame(data);
        if (parsed) handler(parsed);
      });
    },

    /** See parseErrorFrame — fires on any ERROR frame from the server. */
    onError(handler) {
      ws.on("message", (data) => {
        const parsed = parseErrorFrame(data);
        if (parsed) handler(parsed);
      });
    },

    /**
     * Raw frame passthrough — for frame types production draft_clicker.js has no need to parse
     * (e.g. `SELECTING <teamId> <clockMs>`, the turn-notification broadcast; `DRAFT_LIST`;
     * `PING`). Kept generic here rather than adding a parser per frame type nobody but a test
     * script needs, since draft_clicker.js only ever reacts to being told what to pick — it
     * never needs to independently detect whose turn it is.
     */
    onMessage(handler) {
      ws.on("message", (data) => handler(data.toString()));
    },

    /**
     * Fires when the socket closes for ANY reason, including eviction: confirmed 2026-08-17 that
     * ESPN's draft room is single-session — a new JOIN for the same league/team/member evicts any
     * existing connection, which sees its socket simply close (own browser tab shown a
     * reconnect/exit prompt; this raw ws client just gets a close event, no distinguishing close
     * code observed). Matters for any long-lived listener (scripts/draft-watch.js) — a second
     * connection to the same room (your own browser reconnecting, or draft_clicker.js briefly
     * connecting to submit a pick) will silently kill it without this.
     */
    onClose(handler) {
      ws.on("close", handler);
    },

    /** Submits a pick — confirmed format, see this file's header comment. */
    sendPick(playerId) {
      ws.send(`SELECT ${playerId}\n`);
    },

    close() {
      ws.close();
    },
  };
}

/**
 * Draft-room-socket send hook (issue #70, Option A).
 *
 * Patches window.WebSocket in the PAGE (via context.addInitScript, so it runs before any page
 * script — including ESPN's own client — ever runs) to keep a live reference to whichever socket
 * connects to the draft room's JOIN endpoint. draft_sync.js's own WebSocket handle
 * (page.on("websocket")) is observation-only — no .send() — so this is the only way to submit a
 * pick through the SAME already-open connection instead of opening a second, colliding JOIN (see
 * this file's header for why a second JOIN is unacceptable for draft_sync.js specifically: it
 * would evict its own observer socket, reproducing the incident this exists to fix).
 *
 * Must be registered on the browser CONTEXT (not a single page) and before enterDraftRoom
 * navigates: an addInitScript added after the target page already started loading would miss the
 * page's own WebSocket construction, which happens during that same script evaluation. Applying
 * it at the context level also covers DRAFT_MODE=mock's lobby-click flow opening the draft room
 * in a brand-new tab (see draft_sync.js's connectAndStream for the same reasoning about its own
 * page.on("websocket") listener).
 */
async function installDraftSocketSendHook(context) {
  await context.addInitScript(() => {
    /* eslint-env browser */
    // Runs inside the page, not this Node process — `window` here is the browser global.
    const NativeWebSocket = window.WebSocket;
    window.__espnDraftSocket = null;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = new target(...args);
        const url = String(args[0] || "");
        if (url.includes("fantasydraft.espn.com") && url.includes("/JOIN")) {
          window.__espnDraftSocket = socket;
          socket.addEventListener("close", () => {
            if (window.__espnDraftSocket === socket) {
              window.__espnDraftSocket = null;
            }
          });
        }
        return socket;
      },
    });
  });
}

/**
 * Submits a pick through the page's own already-open draft-room socket (installed by
 * installDraftSocketSendHook above) rather than opening a second, colliding connection. Throws a
 * plain Error (not a PermanentError — a missing/not-yet-open socket is plausibly transient, e.g.
 * a reconnect in progress) if no live socket is currently captured, so the caller reports a
 * definitive failure rather than silently no-op'ing.
 */
async function sendPickViaPage(page, playerId) {
  const sent = await page.evaluate((id) => {
    /* eslint-env browser */
    // Runs inside the page, not this Node process — `window` here is the browser global.
    // readyState 1 === OPEN — matches the standard WebSocket constant without relying on it
    // existing on whatever this environment's window.WebSocket happens to be.
    if (!window.__espnDraftSocket || window.__espnDraftSocket.readyState !== 1) {
      return false;
    }
    window.__espnDraftSocket.send(`SELECT ${id}\n`);
    return true;
  }, playerId);
  if (!sent) {
    throw new Error(
      `[Draft Room Socket] No live draft-room socket captured in the page — cannot submit ` +
        `pick ${playerId} via sendPickViaPage.`,
    );
  }
}

module.exports = {
  connectToDraftRoom,
  parseSelectedFrame,
  parseErrorFrame,
  buildDraftSocketUrl,
  normalizeSwid,
  installDraftSocketSendHook,
  sendPickViaPage,
};
