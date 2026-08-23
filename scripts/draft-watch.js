const readline = require("readline");
const { parseDraftRoomUrl } = require("../src/bots/mock_draft");
const { resolveEspnCookies } = require("../src/bots/auth");
const { connectToDraftRoom } = require("../src/bots/draft_room_socket");

/**
 * Worst-case fallback tier for WORKER-06: a read-only advisory watcher. If the automated
 * submission path (draft_room_socket.js's sendPick, or its DOM-click fallback) is ever broken or
 * untrusted, this gives a human a reliable "it's your turn" signal instead of automating the pick
 * at all — connects to the draft room WebSocket in observe-only mode (never calls sendPick),
 * reusing the exact same read path draft_room_socket.js's onSelected/onMessage already expose,
 * which is proven reliable (unlike the REST draft board — see espn_api.js's readDraftPicks header).
 *
 * Deliberately does NOT touch the draft_targets RabbitMQ queue or try to surface CORE-08's actual
 * recommendation: that queue has exactly one real consumer (draft_clicker.js, competing-consumers
 * pattern via channel.consume) — a second listener on the same queue would steal messages from the
 * production bot, not just observe them. A live recommendation display belongs to CORE-10's
 * planned /v1/draft SSE monitoring endpoint, not this tool. This only ever shows what's already
 * happened in the room and whose turn it is now — both purely observed off the WS.
 *
 * NOT actually safe to assume this stays connected indefinitely: confirmed 2026-08-17, ESPN's
 * draft room is single-session per league/team/member — a NEW connection for the same identity
 * evicts any existing one (verified: this script evicted the same user's own already-open browser
 * tab). That cuts both ways here — your own browser reconnecting, or draft_clicker.js briefly
 * connecting to submit a pick, will silently evict THIS script too. Auto-reconnects on eviction
 * (with a short backoff) rather than silently going dark, but expect the connection to bounce.
 *
 * Usage:
 *   node scripts/draft-watch.js
 *   (prompts for the room URL; requires OpenBao connected or ESPN_S2/SWID set; runs until Ctrl+C)
 */

function promptForUrl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Draft room URL to watch: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function bell() {
  // Terminal bell — audible in most terminal emulators without needing a notification library.
  process.stdout.write("\x07");
}

const RECONNECT_DELAY_MS = 3000;
// WORKER-17: how long our own team can sit "on the clock" with no SELECTED before this is treated
// as a stall worth a loud warning. A guess pending real observed pick-latency from a live draft —
// tune after the first live run. Override via DRAFT_WATCH_STALL_MS for that tuning pass.
const STALL_WARN_MS = Number(process.env.DRAFT_WATCH_STALL_MS) || 45000;
const PROGRESS_SUMMARY_EVERY = 10;

/** Pure — no Date.now() inside, so directly testable with fixed timestamps. */
function computePickDurationMs(selectingStartedAt, selectedAt) {
  if (selectingStartedAt == null) return null;
  return selectedAt - selectingStartedAt;
}

/** Pure — same reasoning as computePickDurationMs. */
function hasStalled(selectingStartedAt, now, thresholdMs) {
  if (selectingStartedAt == null) return false;
  return now - selectingStartedAt >= thresholdMs;
}

/**
 * Connects and wires up listeners; resolves once the socket closes (evicted or errored).
 *
 * WORKER-17 addition: tracks per-pick SELECTING->SELECTED timing and flags our own team stalling
 * (armed on our SELECTING, cleared on our SELECTED). This can only observe THAT a pick landed and
 * HOW LONG it took — it has no visibility into whether it came from the automated clicker, a
 * human, or ESPN's own autodraft (draft_targets is intentionally not touched here, see header),
 * so don't mistake a clean run of this watcher for proof the automated pipeline specifically
 * fired every pick. Timing state is local to one watchOnce() call and resets on every reconnect —
 * a gap while disconnected can't be backfilled, so it's logged as a gap rather than papered over.
 */
async function watchOnce({ leagueId, teamId }) {
  const cookies = resolveEspnCookies();
  const socket = await connectToDraftRoom({ leagueId, teamId, espnS2: cookies.espnS2, swid: cookies.swid });
  console.log("Connected. Waiting for draft activity... (Ctrl+C to stop)");
  console.log(
    "[Draft Watch] Timing/stall tracking reset for this connection — any gap from a prior " +
      "disconnect is not backfilled.",
  );

  const selectingStartedAt = new Map();
  let stallTimer = null;
  let pickCount = 0;
  const sessionStartedAt = Date.now();
  let durationSumMs = 0;
  // Separate from pickCount: a SELECTED with no matching SELECTING (e.g. right after
  // reconnecting mid-pick) has no duration to average in. Dividing durationSumMs by pickCount
  // would silently understate the average once any untimed picks are mixed in (PR #42 review).
  let timedPickCount = 0;

  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  socket.onSelected((event) => {
    const isOurs = String(event.team_id) === String(teamId);
    const mine = isOurs ? " (US)" : "";
    const startedAt = selectingStartedAt.get(String(event.team_id));
    const durationMs = computePickDurationMs(startedAt, Date.now());
    selectingStartedAt.delete(String(event.team_id));
    if (isOurs) clearStallTimer();

    const durationNote = durationMs != null ? ` [${durationMs}ms on the clock]` : "";
    console.log(
      `[pick] slot ${event.lineup_slot_id}: team ${event.team_id}${mine} took player ${event.player_id}${durationNote}`,
    );

    pickCount += 1;
    if (durationMs != null) {
      durationSumMs += durationMs;
      timedPickCount += 1;
    }
    if (pickCount % PROGRESS_SUMMARY_EVERY === 0) {
      const elapsedMin = ((Date.now() - sessionStartedAt) / 60000).toFixed(1);
      const avgNote =
        timedPickCount > 0
          ? `avg ${Math.round(durationSumMs / timedPickCount)}ms/pick (${timedPickCount} timed)`
          : "avg n/a (no timed picks yet)";
      console.log(
        `[Draft Watch] Progress: ${pickCount} pick(s) observed, ${elapsedMin}m elapsed, ${avgNote}.`,
      );
    }
  });

  socket.onMessage((raw) => {
    const line = raw.trim();
    if (!line.startsWith("SELECTING ")) return;
    const [, selectingTeam, clockMs] = line.split(/\s+/);
    selectingStartedAt.set(String(selectingTeam), Date.now());

    if (selectingTeam === String(teamId)) {
      bell();
      console.log(`\n>>> YOUR TURN — team ${teamId} on the clock (${clockMs}ms) <<<\n`);
      clearStallTimer();
      stallTimer = setTimeout(() => {
        bell();
        console.warn(
          `\n!!! STALL WARNING: our team has been on the clock for ${STALL_WARN_MS}ms with no ` +
            "pick submitted — the automated clicker may have missed this turn. !!!\n",
        );
      }, STALL_WARN_MS);
    } else {
      console.log(`[clock] team ${selectingTeam} on the clock (${clockMs}ms)`);
    }
  });

  await new Promise((resolve) => {
    let stopping = false;
    const onSigint = () => {
      stopping = true;
      console.log("\nStopping watcher.");
      socket.close();
      process.exit(0);
    };
    socket.onClose(() => {
      // Reconnect loop is expected here (single-session room — see this file's header), so every
      // call to watchOnce() would otherwise register another SIGINT listener that never gets
      // cleaned up on a normal (non-Ctrl+C) close, eventually tripping Node's
      // MaxListenersExceededWarning across a long watch session with many evictions.
      process.off("SIGINT", onSigint);
      clearStallTimer();
      if (!stopping) resolve();
    });
    process.once("SIGINT", onSigint);
  });
}

async function main() {
  const rawUrl = await promptForUrl();

  let leagueId, teamId;
  try {
    ({ leagueId, teamId } = parseDraftRoomUrl(rawUrl));
  } catch (err) {
    console.error(`Could not parse URL: ${err.message}`);
    process.exit(1);
  }
  if (!leagueId || !teamId) {
    console.error(`URL missing leagueId/teamId (got leagueId=${leagueId}, teamId=${teamId}).`);
    process.exit(1);
  }
  console.log(`Watching league ${leagueId}, team ${teamId} — read-only, never submits a pick.`);

  // Reconnect on eviction (single-session room — see this file's header) rather than going dark.
  // Ctrl+C inside watchOnce() exits the process directly, so this loop only ever continues on an
  // unintentional disconnect.
  for (;;) {
    await watchOnce({ leagueId, teamId }).catch((err) => {
      console.error(`[Draft Watch] Connection error: ${err.message}`);
    });
    console.log(`[Draft Watch] Disconnected (evicted by another session?) — reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[Draft Watch] Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { computePickDurationMs, hasStalled, watchOnce, STALL_WARN_MS };
