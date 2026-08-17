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

/** Connects and wires up listeners; resolves once the socket closes (evicted or errored). */
async function watchOnce({ leagueId, teamId }) {
  const cookies = resolveEspnCookies();
  const socket = await connectToDraftRoom({ leagueId, teamId, espnS2: cookies.espnS2, swid: cookies.swid });
  console.log("Connected. Waiting for draft activity... (Ctrl+C to stop)");

  socket.onSelected((event) => {
    const mine = String(event.team_id) === String(teamId) ? " (US)" : "";
    console.log(`[pick] round ${event.round}: team ${event.team_id}${mine} took player ${event.player_id}`);
  });

  socket.onMessage((raw) => {
    const line = raw.trim();
    if (!line.startsWith("SELECTING ")) return;
    const [, selectingTeam, clockMs] = line.split(/\s+/);
    if (selectingTeam === String(teamId)) {
      bell();
      console.log(`\n>>> YOUR TURN — team ${teamId} on the clock (${clockMs}ms) <<<\n`);
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

main().catch((err) => {
  console.error(`[Draft Watch] Fatal: ${err.message}`);
  process.exit(1);
});
