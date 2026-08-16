const WebSocket = require("ws");

/**
 * Sidecar WebSocket client for ESPN's live draft room (WORKER-06).
 *
 * CONFIRMED against a real capture on 2026-08-15/16 (recon-output/websockets.jsonl, via
 * draft_recon.js against a live practice draft — the user actually drafted several players): the
 * client submits a pick by sending a plain text frame `SELECT <playerId>\n` on the same socket
 * draft_sync.js (WORKER-05) already reads `SELECTED <teamId> <playerId> <round> [<memberId>]`
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
 * This is a standalone `ws` client rather than reusing Playwright's page-observed socket
 * (draft_sync.js's approach) because Playwright's WebSocket handle is observation-only —
 * framesent/framereceived events exist, but there's no .send(). Sending would require
 * monkey-patching window.WebSocket via page.addInitScript and reaching in with page.evaluate,
 * which is fragile and doesn't need a full rendered draft-room page just to get a socket.
 * draft_clicker.js only needs cookies (from auth.js's resolveEspnCookies()) to authenticate the
 * raw socket — no browser context needed for this part, which is faster than launching Chromium
 * per queue message (matters against a 60-90s draft clock).
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
  return trimmed.startsWith("{") ? trimmed : `{${trimmed.replace(/[{}]/g, "")}}`;
}

/** Parses a raw WS text frame — same SELECTED format draft_sync.js's parseSelectedFrame handles. */
function parseSelectedFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("SELECTED ")) return null;

  const [, teamId, playerId, round] = line.split(/\s+/);
  if (teamId == null || playerId == null || round == null) return null;

  return {
    team_id: Number(teamId),
    player_id: Number(playerId),
    round: Number(round),
  };
}

/**
 * Opens the sidecar socket and resolves once it's connected. Caller owns the returned handle's
 * lifecycle (call close() when done — this does not auto-close on idle).
 */
// A bare Cookie header alone got a 403 on the WS upgrade (2026-08-16, real attempt) — before any
// app-level response, so almost certainly an edge/WAF check. Two likely causes, both addressed
// below: no Origin header (every real browser sends one automatically on a cross-origin WS
// connection; Node's `ws` client doesn't by default), and Node's self-identifying default
// User-Agent giving away a non-browser client. Unconfirmed which one (or both) the 403 was
// actually about — this is the fix attempt, not yet verified against a live retry.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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
    });

    const onOpen = () => {
      ws.off("error", onError);
      resolve(handleFor(ws));
    };
    const onError = (err) => {
      ws.off("open", onOpen);
      reject(new Error(`[Draft Room Socket] Failed to connect to ${url}: ${err.message}`));
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
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

    /** Submits a pick — confirmed format, see this file's header comment. */
    sendPick(playerId) {
      ws.send(`SELECT ${playerId}\n`);
    },

    close() {
      ws.close();
    },
  };
}

module.exports = { connectToDraftRoom, parseSelectedFrame, buildDraftSocketUrl, normalizeSwid };
