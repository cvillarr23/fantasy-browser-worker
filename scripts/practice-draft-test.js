const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseDraftRoomUrl } = require("../src/bots/mock_draft");
const { createAuthenticatedSession, resolveEspnCookies } = require("../src/bots/auth");
const { fetchDraftPlayerPool } = require("../src/bots/espn_api");
const { connectToDraftRoom, parseSelectedFrame } = require("../src/bots/draft_room_socket");

/**
 * End-to-end live test of draft_room_socket.js's sendPick() against a real practice draft, without
 * needing to hand-pick a target player id yourself or race to catch your turn manually.
 *
 * Prompts for a room URL, fetches the real player pool (espn_api.js's fetchDraftPlayerPool) to
 * build a prioritized list of guaranteed-low-collision-risk targets — kickers first (rank
 * 2400-2600+, essentially never drafted before the very last rounds), then D/ST (rank ~500s) —
 * sorted worst-ranked first, then waits for the room's `SELECTING <teamId> <clockMs>` broadcast to
 * confirm it's actually your turn (far more reliable than the REST draft board, which doesn't
 * populate for ephemeral practice drafts — see espn_api.js's readDraftPicks header), and submits
 * the first candidate, falling through the list if a candidate turns out to already be taken.
 *
 * Everything is logged to both stdout and a timestamped file under recon-output/, so the run can
 * be inspected afterward without needing to have watched it live.
 *
 * Usage:
 *   node scripts/practice-draft-test.js [--also-test-taken]
 *   (prompts for the room URL; requires OpenBao connected or ESPN_S2/SWID set)
 *
 * --also-test-taken: before working through the normal candidate list, first SELECT the single
 * highest-ranked (rank 1) player in the pool — something virtually certain to already be gone by
 * the time we're on the clock — and logs whatever happens. Exists because the REST idempotency
 * pre-check (espn_api.js's readDraftPicks) is known-unreliable for practice drafts, so a race
 * where two consumers target the same player is a real scenario the WS layer itself needs to fail
 * safely against, and that failure mode had never actually been observed before this flag existed.
 */

const OUTPUT_DIR = path.join(__dirname, "..", "recon-output");
const CANDIDATE_COUNT = 8; // How many fallback targets to line up, worst-ranked first.
const PICK_CONFIRM_TIMEOUT_MS = 5000;
const TURN_WAIT_TIMEOUT_MS = 20 * 60 * 1000; // Generous — team 8 has consistently been slot #8.

function openLog() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(OUTPUT_DIR, `practice-draft-test-${stamp}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    stream.write(line + "\n");
  };
  log(`Log file: ${file}`);
  return log;
}

function promptForUrl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Practice draft room URL: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Worst-ranked kickers first (rank 2400+, essentially never drafted early), then worst D/ST. */
function buildCandidates(players) {
  const byWorstRank = (a, b) => (b.rank ?? -1) - (a.rank ?? -1);
  const kickers = players.filter((p) => p.positionId === 5).sort(byWorstRank);
  const defenses = players.filter((p) => p.positionId === 16).sort(byWorstRank);
  return [...kickers, ...defenses].slice(0, CANDIDATE_COUNT);
}

/** Resolves with the matching SELECTED event for this player+team, or null on timeout. */
function waitForConfirmation(socket, playerId, teamId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.onSelected((event) => {
      if (String(event.player_id) === String(playerId) && String(event.team_id) === String(teamId)) {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
}

/**
 * Resolves with `{ type: "selected", event }` (regardless of which team the SELECTED is
 * attributed to — unlike waitForConfirmation, which only matches our own team),
 * `{ type: "error", error }` if the server sends an explicit ERROR frame (confirmed 2026-08-17:
 * a rejected SELECT is NOT silent), or null on timeout. Used to observe what actually happens
 * when we target a player someone else already has.
 */
function waitForAnySelectedOrError(socket, playerId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.onSelected((event) => {
      if (String(event.player_id) === String(playerId)) {
        clearTimeout(timer);
        resolve({ type: "selected", event });
      }
    });
    socket.onError((error) => {
      clearTimeout(timer);
      resolve({ type: "error", error });
    });
  });
}

/** Resolves once a SELECTING broadcast names our team as on the clock. */
function waitForOurTurn(socket, teamId, timeoutMs, log) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No SELECTING for team ${teamId} within ${timeoutMs}ms.`)), timeoutMs);
    socket.onMessage((raw) => {
      const line = raw.trim();
      if (line.startsWith("SELECTING ")) {
        const [, selectingTeam, clockMs] = line.split(/\s+/);
        if (selectingTeam !== String(teamId)) {
          log(`Team ${selectingTeam} is on the clock (${clockMs}ms) — waiting for our turn (team ${teamId})...`);
        } else {
          log(`Our turn! Team ${teamId} on the clock (${clockMs}ms).`);
          clearTimeout(timer);
          resolve();
        }
        return;
      }
      // Not a SELECTING frame — surface anything else that isn't routine chatter, in case
      // something unexpected shows up worth having in the log. INIT specifically (the initial
      // full draft-state sync sent once per connection) is excluded by size rather than by name:
      // it's a multi-KB base64 blob that would otherwise dominate the log for no benefit here.
      const KNOWN_NOISE = /^(PING|DRAFT_LIST|AUTOSUGGEST|AUTODRAFT|CLOCK|TOKEN)\b/;
      if (line.length < 500 && !KNOWN_NOISE.test(line) && !parseSelectedFrame(line)) {
        log(`[raw frame] ${line}`);
      }
    });
  });
}

async function main() {
  const log = openLog();
  const testTaken = process.argv.includes("--also-test-taken");
  const rawUrl = await promptForUrl();

  let leagueId, seasonId, teamId;
  try {
    ({ leagueId, seasonId, teamId } = parseDraftRoomUrl(rawUrl));
  } catch (err) {
    log(`Could not parse URL: ${err.message}`);
    process.exit(1);
  }
  if (!leagueId || !teamId) {
    log(`URL missing leagueId/teamId (got leagueId=${leagueId}, teamId=${teamId}).`);
    process.exit(1);
  }
  log(`Parsed: league=${leagueId} season=${seasonId || "(default)"} team=${teamId}`);

  log("Fetching player pool (draftInit) for candidate targets...");
  const session = await createAuthenticatedSession();
  let players;
  try {
    players = await fetchDraftPlayerPool(session.context, { leagueId, seasonId: seasonId || "2026" });
  } finally {
    await session.browser.close();
  }
  const candidates = buildCandidates(players);
  log(
    `Candidate order (worst-ranked K then D/ST, first available wins): ` +
      candidates.map((c) => `${c.name}(${c.id},rank ${c.rank})`).join(", "),
  );
  if (candidates.length === 0) {
    log("No K/D-ST candidates found in player pool — aborting.");
    process.exit(1);
  }

  const cookies = resolveEspnCookies();
  log("Connecting to draft room socket...");
  const socket = await connectToDraftRoom({ leagueId, teamId, espnS2: cookies.espnS2, swid: cookies.swid });

  try {
    log(`Waiting for team ${teamId}'s turn (up to ${TURN_WAIT_TIMEOUT_MS / 1000}s)...`);
    await waitForOurTurn(socket, teamId, TURN_WAIT_TIMEOUT_MS, log);

    if (testTaken) {
      const rank1 = [...players].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
      log(
        `--also-test-taken: attempting a deliberately-already-taken pick first: ` +
          `${rank1.name} (${rank1.id}, rank ${rank1.rank})`,
      );
      const anyResult = waitForAnySelectedOrError(socket, rank1.id, PICK_CONFIRM_TIMEOUT_MS);
      socket.sendPick(rank1.id);
      const outcome = await anyResult;
      if (!outcome) {
        log(
          `Failure mode: TIMEOUT — no SELECTED or ERROR frame at all for player ${rank1.id} ` +
            `within ${PICK_CONFIRM_TIMEOUT_MS}ms. Safe: never attributed to us, and our existing ` +
            `confirmation-timeout logic already treats this as "try the next candidate."`,
        );
      } else if (outcome.type === "error") {
        log(
          `Failure mode: REJECTED — server sent ERROR ${outcome.error.code} ` +
            `${outcome.error.message} for player ${rank1.id}. This is the expected, safe outcome ` +
            `(draft_clicker.js now treats this as a PermanentError, not a retryable one).`,
        );
      } else if (String(outcome.event.team_id) !== String(teamId)) {
        log(
          `Failure mode: OBSERVED — player ${rank1.id} is owned by team ${outcome.event.team_id} ` +
            `(round ${outcome.event.round}), not us. Safe: our SELECT produced no attribution to us.`,
        );
      } else {
        log(
          `UNEXPECTED: our SELECT for an already-taken player was confirmed as OURS (team ` +
            `${teamId})! This would be a real bug in the idempotency assumptions — investigate.`,
        );
      }
    }

    let landed = null;
    for (const candidate of candidates) {
      log(`Attempting: ${candidate.name} (${candidate.id})...`);
      const confirmation = waitForConfirmation(socket, candidate.id, teamId, PICK_CONFIRM_TIMEOUT_MS);
      socket.sendPick(candidate.id);
      const result = await confirmation;
      if (result) {
        log(`SUCCESS: ${candidate.name} (${candidate.id}) confirmed, round ${result.round}.`);
        landed = candidate;
        break;
      }
      log(`No confirmation for ${candidate.name} within ${PICK_CONFIRM_TIMEOUT_MS}ms — trying next candidate.`);
    }

    if (!landed) {
      log("All candidates exhausted without a confirmed pick. See log for details.");
      process.exitCode = 1;
    }
  } finally {
    socket.close();
  }
}

main().catch((err) => {
  console.error(`[Practice Draft Test] Fatal: ${err.message}`);
  process.exit(1);
});
