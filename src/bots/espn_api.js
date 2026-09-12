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

const fs = require("fs");
const path = require("path");
const { PermanentError } = require("../errors");
const { isEnabled: isDebugCaptureEnabled } = require("./debug_capture");
const { logger } = require("../telemetry/logger");

const READS_HOST = "https://lm-api-reads.fantasy.espn.com";
const WRITES_HOST = "https://lm-api-writes.fantasy.espn.com";

const WRITE_CAPTURE_DIR =
  process.env.DEBUG_OUTPUT_DIR ||
  path.join(__dirname, "..", "..", "recon-output");

/**
 * Appends one JSONL record of a real write's request/response to recon-output/espn-write-log.jsonl
 * — on by default (DEBUG_CAPTURE=0/false/no to disable), since this is the only ongoing empirical
 * evidence of ESPN's actual write-endpoint behavior. A single growing log, not one file per call
 * (unlike lineup_bot.js's captureFailure, which fires only on failure) — this fires on every write.
 * Never includes cookies: those live on the BrowserContext, not in the headers object built below.
 */
function captureWriteArtifact(record) {
  if (!isDebugCaptureEnabled()) return;
  try {
    fs.mkdirSync(WRITE_CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(WRITE_CAPTURE_DIR, "espn-write-log.jsonl"),
      JSON.stringify({ capturedAt: new Date().toISOString(), ...record }) + "\n",
    );
  } catch (err) {
    logger.error(`[ESPN API] Could not capture write artifact: ${err.message}`, { err });
  }
}

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
 * VERIFIED against a real captured save (2026-09-12, league 1248158344 team 8, a FLEX/Bench swap
 * confirmed live and then reverted): this body and header shape match ESPN's real web client
 * exactly, including `memberId`'s brace-wrapped SWID format. The one correction from the original
 * guess: `x-fantasy-platform` is `"espn-fantasy-web"`, not `"kona-PROD"` (`x-fantasy-source: "kona"`
 * was already correct). The real request also carried a `?platformVersion=<hash>` query param — a
 * frontend build id that appears unstable across ESPN deploys, so it's deliberately not replicated
 * here; the capture succeeded without evidence the server requires it from a non-browser client.
 */
async function submitLineup(
  context,
  { leagueId, seasonId, teamId, memberId, scoringPeriodId, items, trackingId },
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
  const headers = {
    "Content-Type": "application/json",
    "x-fantasy-source": "kona",
    "x-fantasy-platform": "espn-fantasy-web",
  };

  const startedAt = Date.now();
  const response = await context.request.post(url, { headers, data: payload });
  const text = await response.text();

  captureWriteArtifact({
    kind: "lineup",
    trackingId,
    leagueId,
    teamId,
    url,
    requestHeaders: headers,
    requestBody: payload,
    responseStatus: response.status(),
    responseOk: response.ok(),
    responseBodySnippet: text.slice(0, 500),
    durationMs: Date.now() - startedAt,
  });

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
 * PARTIALLY VERIFIED: the shared envelope (host, URL, isLeagueManager/teamId/memberId/
 * scoringPeriodId/executionType, and both headers — `x-fantasy-platform` is now
 * `"espn-fantasy-web"`, confirmed via submitLineup()'s real 2026-09-12 capture) is confirmed by
 * inheritance from that same `transactions/` endpoint. STILL UNVERIFIED: the ADD/DROP item shape and
 * top-level `type: "FREEAGENT"` below, documented only by prior community reverse-engineering of
 * this endpoint family — no real free-agent/waiver capture has been taken yet. `waiver_recon.js
 * --watch-save` exists for that; treat it as a fast-follow.
 *
 * One thing this does NOT attempt to distinguish, open until a real capture exists: an immediate
 * free-agent pickup (outside the waiver period, processed instantly — what `executionType:
 * "EXECUTE"` implies) vs an actual waiver claim (inside the waiver period, queued and processed
 * later, e.g. overnight, possibly needing a `type: "WAIVER"` and a FAAB `bidAmount` instead). This
 * always sends "FREEAGENT"/"EXECUTE"; if the league is mid-waiver period, ESPN's real behavior
 * here is unknown — it may reject this outright, or silently queue it under a shape this function
 * didn't send.
 *
 * `addPlayerId`/`dropPlayerId` are each independently optional (though at least one must be set) —
 * a caller that already knows one half of a claim landed (e.g. re-processing a redelivered queue
 * message) can submit just the remaining item instead of resending a half that's already applied.
 *
 * Failure classification: a non-2xx response in the 4xx range (except 429, a rate limit) is
 * treated as a PermanentError — a rejected claim (player already taken, claim window closed,
 * malformed request) will keep failing identically on retry, and requeuing it forever under
 * connection.js's channel-wide prefetch(1) would starve every other queue. 429/5xx/network
 * failures stay ordinary Errors so connection.js retries them. This is a coarse HTTP-status-only
 * heuristic, not a parse of ESPN's actual rejection reason (its exact error body shape is still
 * unconfirmed) — re-verify against a real rejection once one's been captured.
 *
 * Re-verify by running `node src/bots/waiver_recon.js --watch-save` against a real free-agent add
 * (or an actual waiver claim, to observe whether the shape differs) and diffing the captured body
 * against this one — same recon workflow lineup_recon.js established for submitLineup.
 */
async function submitWaiverClaim(
  context,
  {
    leagueId,
    seasonId,
    teamId,
    memberId,
    scoringPeriodId,
    addPlayerId,
    dropPlayerId,
    trackingId,
  },
) {
  const url = buildTransactionsUrl(leagueId, seasonId);
  const items = [];
  if (addPlayerId) items.push({ playerId: Number(addPlayerId), type: "ADD" });
  if (dropPlayerId) items.push({ playerId: Number(dropPlayerId), type: "DROP" });

  const payload = {
    isLeagueManager: false,
    teamId: Number(teamId),
    type: "FREEAGENT",
    memberId,
    scoringPeriodId,
    executionType: "EXECUTE",
    items,
  };
  const headers = {
    "Content-Type": "application/json",
    "x-fantasy-source": "kona",
    "x-fantasy-platform": "espn-fantasy-web",
  };

  const startedAt = Date.now();
  const response = await context.request.post(url, { headers, data: payload });
  const text = await response.text();

  captureWriteArtifact({
    kind: "waiver",
    trackingId,
    leagueId,
    teamId,
    url,
    requestHeaders: headers,
    requestBody: payload,
    responseStatus: response.status(),
    responseOk: response.ok(),
    responseBodySnippet: text.slice(0, 500),
    durationMs: Date.now() - startedAt,
  });

  if (!response.ok()) {
    const status = response.status();
    const message = `[ESPN API] Waiver claim submit failed with HTTP ${status} — ${text.slice(0, 500)}`;
    if (status >= 400 && status < 500 && status !== 429) {
      throw new PermanentError(message);
    }
    throw new Error(message);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Fetches the draft-room player pool — the same `view=draftInit` call ESPN's own draft room loads
 * on entry (confirmed via draft_recon.js capture, HTTP 200, 2026-08-10/2026-08-16), including each
 * player's `defaultPositionId` (16 = D/ST, 5 = K, among the standard ESPN position ids),
 * `proTeamId` (confirmed present in the raw response, 2026-08-25), and
 * `draftRanksByRankType.STANDARD.rank`. Used by scripts/practice-draft-test.js to pick guaranteed
 * -available low-priority test targets (kickers/D-ST rank far below any position bots draft
 * early) without depending on the draft-pick REST board, which is unreliable for ephemeral
 * practice drafts (see readDraftPicks's header below). Also used by draft_sync.js (issue #31) to
 * resolve a bare AUTOSUGGEST player id into a name/position/team for the published suggestion.
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
      proTeamId: p.proTeamId ?? null,
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
