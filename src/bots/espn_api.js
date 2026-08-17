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
  const url = buildLeagueReadUrl(leagueId, seasonId, [
    "mRoster",
    "mSettings",
    "mTeam",
  ]);
  const response = await context.request.get(url);

  if (!response.ok()) {
    throw new Error(
      `[ESPN API] Roster read failed with HTTP ${response.status()} — ${(await response.text()).slice(0, 300)}`,
    );
  }

  const body = await response.json();
  const team = (body.teams || []).find((t) => String(t.id) === String(teamId));
  if (!team) {
    throw new Error(
      `[ESPN API] Team ${teamId} not found in league ${leagueId}. Available: ${
        (body.teams || []).map((t) => t.id).join(", ") || "none"
      }`,
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
async function submitLineup(
  context,
  { leagueId, seasonId, teamId, memberId, scoringPeriodId, items },
) {
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
    throw new Error(
      `[ESPN API] Lineup submit failed with HTTP ${response.status()} — ${text.slice(0, 500)}`,
    );
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Submits a free-agent/waiver claim (add, optionally paired with a drop) to ESPN.
 *
 * UNVERIFIED REQUEST SHAPE — same caveat as submitLineup() above, and for the same reason: this
 * body has not been confirmed against a real captured save. It's modeled on submitLineup's
 * verified-working `transactions/` shape (same host, same URL, same isLeagueManager/teamId/
 * memberId/scoringPeriodId/executionType envelope) plus the ADD/DROP item `type` values and
 * top-level `type: "FREEAGENT"` documented by prior community reverse-engineering of this same
 * endpoint family — but neither has been checked against this league's actual traffic.
 *
 * Two things this does NOT attempt to distinguish, both open until a real capture exists:
 *   1. An immediate free-agent pickup (outside the waiver period, processed instantly — what
 *      `executionType: "EXECUTE"` implies) vs an actual waiver claim (inside the waiver period,
 *      queued and processed later, e.g. overnight, possibly needing a `type: "WAIVER"` and a FAAB
 *      `bidAmount` instead). This always sends "FREEAGENT"/"EXECUTE"; if the league is mid-waiver
 *      period, ESPN's real behavior here is unknown — it may reject this outright, or silently
 *      queue it under a shape this function didn't send.
 *   2. Why a claim was rejected. A non-2xx response is surfaced as a generic Error (transient, so
 *      connection.js requeues it) — but "player already claimed by someone else" is a permanent,
 *      unwinnable-on-retry condition indistinguishable here from an actual transient failure,
 *      same open gap draft_clicker.js's ERROR-frame handling closed for the WS draft path but this
 *      REST path hasn't. Requeuing a doomed claim forever is the failure mode to watch for.
 *
 * Re-verify by running `node src/bots/waiver_recon.js --watch-save` against a real free-agent add
 * (or an actual waiver claim, to observe whether the shape differs) and diffing the captured body
 * against this one — same recon workflow lineup_recon.js established for submitLineup.
 */
async function submitWaiverClaim(
  context,
  { leagueId, seasonId, teamId, memberId, scoringPeriodId, addPlayerId, dropPlayerId },
) {
  const url = buildTransactionsUrl(leagueId, seasonId);
  const items = [{ playerId: Number(addPlayerId), type: "ADD" }];
  if (dropPlayerId) {
    items.push({ playerId: Number(dropPlayerId), type: "DROP" });
  }

  const payload = {
    isLeagueManager: false,
    teamId: Number(teamId),
    type: "FREEAGENT",
    memberId,
    scoringPeriodId,
    executionType: "EXECUTE",
    items,
  };

  const response = await context.request.post(url, {
    headers: {
      "Content-Type": "application/json",
      "x-fantasy-source": "kona",
      "x-fantasy-platform": "kona-PROD",
    },
    data: payload,
  });

  const text = await response.text();
  if (!response.ok()) {
    throw new Error(
      `[ESPN API] Waiver claim submit failed with HTTP ${response.status()} — ${text.slice(0, 500)}`,
    );
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Fetches the draft-room player pool — the same `view=draftInit` call ESPN's own draft room loads
 * on entry (confirmed via draft_recon.js capture, HTTP 200, 2026-08-10/2026-08-16), including each
 * player's `defaultPositionId` (16 = D/ST, 5 = K, among the standard ESPN position ids) and
 * `draftRanksByRankType.STANDARD.rank`. Used by scripts/practice-draft-test.js to pick guaranteed
 * -available low-priority test targets (kickers/D-ST rank far below any position bots draft
 * early) without depending on the draft-pick REST board, which is unreliable for ephemeral
 * practice drafts (see readDraftPicks's header below).
 *
 * Unlike readDraftPicks, this is NOT draft-instance state — it's the current-season player
 * catalog/rankings, which is why it kept working against these same ephemeral leagues when the
 * pick-history endpoint didn't.
 */
async function fetchDraftPlayerPool(context, { leagueId, seasonId }) {
  const filter = JSON.stringify({ players: { filterStatsForContainerIds: { value: ["002025", "102026"] } } });
  const url =
    `${READS_HOST}/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}` +
    `?filter=${encodeURIComponent(filter)}&view=draftInit&view=mSettings`;

  const response = await context.request.get(url);
  if (!response.ok()) {
    throw new Error(
      `[ESPN API] Draft player pool fetch failed with HTTP ${response.status()} — ${(await response.text()).slice(0, 300)}`,
    );
  }

  const body = await response.json();
  return (body.players || []).map((entry) => {
    const p = entry.player;
    return {
      id: p.id,
      name: p.fullName,
      positionId: p.defaultPositionId,
      rank: p.draftRanksByRankType?.STANDARD?.rank ?? null,
      percentOwned: p.ownership?.percentOwned ?? null,
    };
  });
}

/**
 * Reads the current draft board for a league — thin wrapper around draft_sync.js's
 * fetchDraftDetail so draft_clicker.js's idempotency/conflict check and post-submit verification
 * reuse the same mDraftDetail parsing, instead of re-implementing it here.
 *
 * KNOWN GAP, confirmed 2026-08-16 against a real practice draft (league 284946361): this REST
 * endpoint returned ZERO picks throughout the entire draft despite multiple confirmed real picks
 * landing (verified via the WS SELECTED broadcast, which reflected every pick correctly and
 * immediately) — and after the draft completed, returned a completely empty draftDetail (0 pick
 * slots, no inProgress/drafted flags), not even a final snapshot. Ephemeral mock/practice-draft
 * rooms appear not to be backed by the same persisted-league data this endpoint reads from.
 *
 * This means draft_clicker.js's pre-submit idempotency/conflict check (built on this function)
 * cannot be trusted against a practice draft — it will read as "nothing drafted yet" even when
 * picks have landed. Whether it's reliable against a REAL, persisted league draft (not
 * ephemeral/torn-down the way mock rooms are) is UNVERIFIED — untestable until an actual league
 * draft is available. Left as-is rather than speculatively replaced with a WS-based check: WS has
 * no history query (a freshly-connecting client only sees broadcasts after it joins), so it can't
 * backfill "what's already been picked" the way this is supposed to, and swapping to it on data
 * from ephemeral test rooms alone would trade a possibly-fine mechanism for a more complex one on
 * a guess. Re-verify this against a real league draft before trusting it in production.
 */
async function readDraftPicks(context, { leagueId, seasonId }) {
  // Required at call time, not at module load, to avoid a circular require: draft_sync.js doesn't
  // depend on espn_api.js today, but keeping the edge one-directional (draft_clicker -> espn_api,
  // draft_clicker -> draft_sync) avoids introducing one later by accident.
  const { fetchDraftDetail } = require("./draft_sync");
  return fetchDraftDetail(context, { leagueId, seasonId });
}

/**
 * REST fallback for submitting a draft pick — NOT the primary mechanism and NOT currently called
 * by draft_clicker.js.
 *
 * draft_sync.js's own recon (2026-08-10), confirmed by a 2026-08-15/16 capture of a real submitted
 * pick, found picks go out as a `SELECT <playerId>` frame over the same raw WebSocket
 * draft_sync.js reads `SELECTED` broadcasts from — not REST. WORKER-06's primary path is
 * therefore that WebSocket send (src/bots/draft_room_socket.js's sendPick, now implemented and
 * verified). This function is kept as a documented, unverified fallback only — the body below is
 * a guess mirroring submitLineup's ROSTER shape, never confirmed against a real capture, and
 * should not be wired in unless the WS path is somehow found to stop working.
 */
async function submitDraftPick(
  context,
  { leagueId, seasonId, teamId, memberId, playerId },
) {
  const url = buildTransactionsUrl(leagueId, seasonId);
  const payload = {
    isLeagueManager: false,
    teamId: Number(teamId),
    type: "DRAFT",
    memberId,
    items: [{ playerId: Number(playerId), type: "DRAFT" }],
  };

  const response = await context.request.post(url, {
    headers: {
      "Content-Type": "application/json",
      "x-fantasy-source": "kona",
      "x-fantasy-platform": "kona-PROD",
    },
    data: payload,
  });

  const text = await response.text();
  if (!response.ok()) {
    throw new Error(
      `[ESPN API] Draft pick submit failed with HTTP ${response.status()} — ${text.slice(0, 500)}`,
    );
  }

  return text ? JSON.parse(text) : {};
}

module.exports = {
  readRoster,
  submitLineup,
  submitWaiverClaim,
  readDraftPicks,
  submitDraftPick,
  fetchDraftPlayerPool,
  buildLeagueReadUrl,
  buildTransactionsUrl,
};
