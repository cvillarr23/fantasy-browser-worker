const { parseDraftRoomUrl } = require("../src/bots/mock_draft");
const { executeAutomatedDraftSelection } = require("../src/bots/draft_clicker");

/**
 * Convenience wrapper for manually testing draft_clicker.js (WORKER-06) against a real draft
 * room, without hand-deriving ESPN_LEAGUE_ID/CURRENT_YEAR or building the JSON payload yourself.
 *
 * Takes the room URL you'd copy out of the browser address bar directly and reuses
 * mock_draft.js's parseDraftRoomUrl (the same parser draft_sync.js's enterDraftRoom uses) to pull
 * leagueId/seasonId/teamId/memberId out of it.
 *
 * Requires OpenBao already connected (`eval "$(scripts/openbao-connect.sh)"` in the same shell,
 * or ESPN_S2/SWID set directly) — this script does not do that part for you.
 *
 * Usage:
 *   node scripts/test-draft-pick.js <room-url> <player_id> "<name>" [--live]
 *
 * Without --live this is a DRY_RUN: validates payload, reads the draft board, checks
 * idempotency/conflict, and logs what it would submit — no WS connection, no real pick. With
 * --live it actually calls draft_room_socket.js's sendPick and waits for the SELECTED
 * confirmation. --live only ever makes sense against a room where it's genuinely your team's
 * turn; sending SELECT off-turn is unconfirmed behavior (see draft_room_socket.js's header).
 *
 * Example (synthetic league and member IDs; replace with your own):
 *   node scripts/test-draft-pick.js \
 *     'https://fantasy.espn.com/football/draft?leagueId=1234567891&seasonId=2026&teamId=8&memberId={00000000-0000-0000-0000-000000000000}' \
 *     4362249 "Test Player" --live
 */

function usageAndExit(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node scripts/test-draft-pick.js <room-url> <player_id> "<name>" [--live]\n' +
      "  Omit --live for a DRY_RUN (default) — validates and logs without submitting.",
  );
  process.exit(1);
}

const [, , rawUrl, playerId, name, ...rest] = process.argv;
if (!rawUrl || !playerId || !name) {
  usageAndExit("room URL, player_id, and name are all required.");
}
const live = rest.includes("--live");

let parsed;
try {
  parsed = parseDraftRoomUrl(rawUrl);
} catch (err) {
  usageAndExit(`could not parse "${rawUrl}" as a URL: ${err.message}`);
}
const { leagueId, seasonId, teamId } = parsed;
if (!leagueId || !teamId) {
  usageAndExit(
    `URL is missing leagueId/teamId query params (got leagueId=${leagueId}, teamId=${teamId}). ` +
      "Make sure this is a real draft room URL, not the mock draft lobby.",
  );
}

process.env.ESPN_LEAGUE_ID = leagueId;
if (seasonId) process.env.CURRENT_YEAR = seasonId;
process.env.DRY_RUN = live ? "false" : "true";

console.log(
  `[Test Draft Pick] league=${leagueId} season=${seasonId || "(default)"} team=${teamId} ` +
    `player=${playerId} name="${name}" ${live ? "[LIVE]" : "[DRY_RUN]"}`,
);

executeAutomatedDraftSelection({
  tracking_id: "test-draft-pick-script",
  team_id: teamId,
  player_id: playerId,
  name,
}).catch((err) => {
  console.error(`[Test Draft Pick] Failed: ${err.message}`);
  process.exit(1);
});
