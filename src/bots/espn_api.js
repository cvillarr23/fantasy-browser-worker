/**
 * Authenticated ESPN fantasy REST helpers.
 *
 * Uses the Playwright BrowserContext's own request client (`context.request`), so every call
 * automatically carries the espn_s2/SWID cookies that auth.js injected — same pattern draft_sync.js
 * uses for its mDraftDetail reconciliation, and the reason no cookie plumbing is duplicated here.
 *
 * Why REST instead of clicking the roster page: recon on 2026-08-11 (src/bots/lineup_recon.js)
 * found that ESPN's roster table exposes NO per-player identifier in the DOM at all —
 * `tr[data-player-id]`, `tr[data-playerid]`, and a sweep for any attribute matching /player.?id/i
 * all return zero matches. Rows carry only `data-idx`, a positional index. Since WORKER-03
 * explicitly forbids targeting by positional coordinates, DOM clicking cannot satisfy the
 * requirement, while this API is keyed on real playerId/lineupSlotId values.
 */

const READS_HOST = "https://lm-api-reads.fantasy.espn.com";
const WRITES_HOST = "https://lm-api-writes.fantasy.espn.com";

function buildLeagueReadUrl(leagueId, seasonId, views) {
  const query = views.map((v) => `view=${encodeURIComponent(v)}`).join("&");
  return `${READS_HOST}/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}?${query}`;
}

function buildTransactionsUrl(leagueId, seasonId) {
  return `${WRITES_HOST}/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}/transactions/`;
}

/**
 * Reads the current roster for one team.
 *
 * Returns the live slot assignments plus the league's scoringPeriodId (needed by the write call)
 * and its actual roster shape — read from the API rather than trusted from lineup_slots.json, so a
 * league settings change can't silently invalidate the bot.
 */
async function readRoster(context, { leagueId, seasonId, teamId }) {
  const url = buildLeagueReadUrl(leagueId, seasonId, ["mRoster", "mSettings", "mTeam"]);
  const response = await context.request.get(url);

  if (!response.ok()) {
    throw new Error(
      `[ESPN API] Roster read failed with HTTP ${response.status()} — ${(await response.text()).slice(0, 300)}`
    );
  }

  const body = await response.json();
  const team = (body.teams || []).find((t) => String(t.id) === String(teamId));
  if (!team) {
    throw new Error(
      `[ESPN API] Team ${teamId} not found in league ${leagueId}. Available: ${(body.teams || [])
        .map((t) => t.id)
        .join(", ") || "none"}`
    );
  }

  // playerId -> lineupSlotId for everyone currently rostered.
  const slotByPlayerId = new Map();
  for (const entry of team.roster?.entries || []) {
    slotByPlayerId.set(String(entry.playerId), entry.lineupSlotId);
  }

  return {
    slotByPlayerId,
    scoringPeriodId: body.scoringPeriodId,
    slotCounts: body.settings?.rosterSettings?.lineupSlotCounts || {},
    entryCount: slotByPlayerId.size,
    // Present on the mTeam view. ESPN sets these once games kick off; a submit against a locked
    // lineup fails server-side, so surfacing them lets the bot say *why* rather than relaying an
    // opaque API error.
    lineupLocked: team.lineupLocked === true,
    rosterLocked: team.rosterLocked === true,
  };
}

/**
 * Submits a roster transaction (a batch of LINEUP moves) to ESPN.
 *
 * UNVERIFIED REQUEST SHAPE — this body matches ESPN's documented/observed transactions format, but
 * unlike draft_sync.js's read protocol it has NOT been confirmed against a real capture: doing so
 * requires saving a lineup by hand with actual players on the roster, and league 1248158344 had not
 * drafted as of 2026-08-11 (mRoster returned entries: []). Re-verify post-draft by running
 * `node src/bots/lineup_recon.js --watch-save` and diffing the captured body against this one.
 */
async function submitLineup(context, { leagueId, seasonId, teamId, memberId, scoringPeriodId, items }) {
  const url = buildTransactionsUrl(leagueId, seasonId);
  const payload = {
    isLeagueManager: false,
    teamId: Number(teamId),
    type: "ROSTER",
    memberId,
    scoringPeriodId,
    executionType: "EXECUTE",
    items,
  };

  const response = await context.request.post(url, {
    headers: {
      "Content-Type": "application/json",
      // ESPN's own client stamps these; some write endpoints reject requests without them.
      "x-fantasy-source": "kona",
      "x-fantasy-platform": "kona-PROD",
    },
    data: payload,
  });

  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`[ESPN API] Lineup submit failed with HTTP ${response.status()} — ${text.slice(0, 500)}`);
  }

  return text ? JSON.parse(text) : {};
}

module.exports = {
  readRoster,
  submitLineup,
  buildLeagueReadUrl,
  buildTransactionsUrl,
};
