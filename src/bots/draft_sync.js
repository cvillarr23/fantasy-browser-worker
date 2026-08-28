const { createAuthenticatedSession } = require("./auth");
const { startFreshPracticeDraft, parseDraftRoomUrl } = require("./mock_draft");
const {
  assertCookieSessionValid,
  assertRenderedSessionValid,
} = require("./session_health");
const { PermanentError, SessionExpiredError } = require("../errors");
const {
  DraftPickLedger,
  pickIdentity,
  isUsablePlayerId,
} = require("./draft_pick_ledger");
const { attachDraftDomObserver } = require("./draft_dom_observer");
const {
  normalizeSwid,
  parseErrorFrame,
  installDraftSocketSendHook,
  sendPickViaPage,
} = require("./draft_room_socket");
const {
  buildOwnershipFields,
  generateOwnerIdentity,
  consumeCommandsOnce,
  publishCommandResult,
  DEFAULT_LEASE_GRACE_MULTIPLIER,
} = require("./session_registry");
const redis = require("redis");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");

const REDIS_HOST =
  process.env.REDIS_HOST || "fantasy-cache.default.svc.cluster.local";
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
// ESPN's own client reconnects its draft-room WebSocket on its own (observed 12 opens / 5 closes
// in a single ~10min recon session) — only treat the session as dead if nothing has been open for
// this long, rather than restarting the whole browser on every individual close.
const WS_DEAD_GRACE_MS = 30000;
// How often to reconcile against the authoritative REST snapshot (mDraftDetail) between/alongside
// WebSocket push events.
const REST_RECONCILE_INTERVAL_MS = 15000;
// Cadence for the health heartbeat (issue #52). Deliberately faster than the reconcile interval:
// its whole job is to make "the feed has gone quiet" visible in pod logs/Redis BEFORE anyone
// notices missing picks downstream.
const HEALTH_HEARTBEAT_INTERVAL_MS = Number(
  process.env.DRAFT_HEALTH_INTERVAL_MS || 10000,
);
// How long the feed can go with no NEW pick from any source before the heartbeat escalates from
// info to warn. Longer than a typical 60-90s pick clock so a slow human drafter isn't flagged,
// short enough that a genuinely dead feed surfaces within a couple of picks.
const PICK_SILENCE_WARN_MS = Number(
  process.env.DRAFT_PICK_SILENCE_WARN_MS || 180000,
);
// Issue #62: how many consecutive reconnect cycles can produce zero new picks across all three
// ingest tiers before the sync escalates its "still retrying" log line from warn to error. NOT a
// terminal/exit-clean trigger on its own — silence alone (no STATE 2 frame, no learned total
// reached) is never treated as proof the draft finished, since a sustained ESPN/network outage on
// a still-active draft looks identical to a finished one at this layer. Purely a visibility knob;
// the actual bound on retries is MAX_RECONNECT_ATTEMPTS below.
const DRAFT_STALL_TERMINAL_CYCLES = Number(
  process.env.DRAFT_STALL_TERMINAL_CYCLES || 3,
);
// Issue #70: how often draft_sync.js polls draft_commands:{leagueId} for a delegated pick to
// execute. Deliberately much faster than the health heartbeat — a delegated submission is racing
// the same draft clock a direct WS submission would, so this can't wait out a 10s heartbeat tick.
const COMMAND_POLL_INTERVAL_MS = Number(
  process.env.DRAFT_COMMAND_POLL_INTERVAL_MS || 1000,
);
// Issue #70: how long draft_sync.js waits for its own SELECTED/ERROR echo after sending a
// delegated pick via sendPickViaPage before reporting the command as timed out. Mirrors
// draft_clicker.js's own CONFIRM_TIMEOUT_MS class of budget for the same SELECT/SELECTED round
// trip, just through the page's socket instead of a raw ws client.
const COMMAND_CONFIRM_TIMEOUT_MS = Number(
  process.env.DRAFT_COMMAND_CONFIRM_TIMEOUT_MS || 5000,
);
// Issue #70: the ownership lease's apparent-freshness window, as a multiple of the heartbeat
// cadence above — see session_registry.js's header for why this is deliberately much shorter
// than the health key's own EX 3600.
const OWNERSHIP_LEASE_TTL_MS =
  HEALTH_HEARTBEAT_INTERVAL_MS * DEFAULT_LEASE_GRACE_MULTIPLIER;

/**
 * Live Draft Room Network Interceptor Daemon
 *
 * Ingests every pick made in a draft — by our own bot, by other participants, or manually by the
 * user in the ESPN UI — and republishes it to Redis (stream + board hash + pub/sub) for
 * fantasy-core-pipeline.
 *
 * THREE INGEST TIERS (issue #52). Originally two; the DOM tier was added because the first two
 * have a confirmed simultaneous blind spot:
 *
 * 1. WebSocket (wss://fantasydraft.espn.com/game-1/league-{id}/JOIN?...), opened by the draft room
 *    page itself once loaded — NOT JSON. Plain space-delimited text frames, the relevant one being:
 *      SELECTED <teamId> <playerId> <lineupSlotId> [<memberId>]
 *    memberId is only present when a human (not autodraft) makes the pick. The third token was
 *    long read as a round; it is ESPN's lineup slot id (1=QB, 2/3=RB, 4/5=WR, 6=TE, 7=FLEX,
 *    8/9=D-ST and K, 10+ bench), verified by joining a full 160-pick practice draft against
 *    player positions. It is easy to mistake for a round because a 10-team, 16-slot league
 *    yields exactly ten of every value either way. There's no overall pick number and no round
 *    on this frame — so pick_number is derived locally (see assignPickNumber) and round is left
 *    for the consumer to derive from it.
 *    FASTEST and most precise, but not continuously reliable here: the draft room is
 *    SINGLE-SESSION per league/team/member, so any second connection for the same identity (the
 *    user's own browser tab, or draft_clicker.js submitting a pick) silently EVICTS this one, and
 *    the protocol has no replay — every pick broadcast during the gap is simply never seen.
 *
 * 2. REST (https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/
 *    leagues/{id}?view=mDraftDetail), which returns draftDetail.picks[] — the full draft board
 *    including overallPickNumber, roundId, roundPickNumber, teamId, playerId (-1 for not-yet-
 *    drafted slots). The natural backfill for tier 1's gap, EXCEPT that it is confirmed to return
 *    zero picks for the entire duration of a practice/mock draft (see espn_api.js's readDraftPicks
 *    header). So for practice drafts specifically, tiers 1 and 2 fail together — which is exactly
 *    the bug #52 was opened about.
 *
 * 3. DOM observer + poller over the rendered draft board (draft_dom_observer.js). The only surface
 *    that always shows the FULL history regardless of when we connected or who made the pick, so
 *    it's what actually closes the eviction gap for practice drafts. Slower and selector-dependent
 *    (see that module's header — the board selectors are explicitly unverified and log their
 *    misses), so it's a recovery tier, not the primary one.
 *
 * All three funnel through ingestPickEvent -> draft_pick_ledger.js, which owns dedup and source
 * precedence (rest > dom > init > ws) so overlapping observations of the same pick collapse into
 * one publish plus, at most, later corrections. Overlap is the NORMAL case here — a DOM rescan
 * re-reports the whole visible board every few seconds — not an error condition.
 *
 * Health/heartbeat: emitHealthHeartbeat publishes per-tier counters, `last_pick_seen_at`, and WS
 * connectivity to both the log and `draft:{leagueId}:health` on a fixed cadence, because a silent
 * feed is otherwise indistinguishable from a healthy one during a slow drafter's turn.
 *
 * DRAFT_ROOM_URL (for local/k8s test runs only — never set this against the real draft): navigates
 * directly to a specific, already-open draft room URL instead of building one or joining fresh.
 * Needed because DRAFT_MODE=mock's auto-join doesn't work headlessly. The original 2026-08-10
 * finding here (a DisneyID/reCAPTCHA identity-verification gate) is confirmed still correct as of
 * 2026-08-21 — see mock_draft.js's startFreshPracticeDraft header for the full traced chain: the
 * lobby's always-embedded invisible reCAPTCHA Enterprise iframe hits a Storage Access API denial
 * first (crashing the SPA's route), and even after granting that via CDP to get past the crash,
 * the click still silently never navigates — the documented signature of reCAPTCHA Enterprise
 * scoring the session as automated and never releasing its callback. So join a mock draft yourself
 * in a real browser and pass its URL here. Takes priority over DRAFT_MODE=mock if both are set.
 *
 * DRAFT_MODE=mock is left in place (mock_draft.js) in case a future fix (granting storage access
 * some other way — see mock_draft.js) unblocks headless auto-join, but don't rely on it now.
 */
function buildDraftUrl(leagueId, seasonId, teamId, memberId) {
  return `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&seasonId=${seasonId}&teamId=${teamId}&memberId=${memberId}`;
}

function buildDraftDetailUrl(leagueId, seasonId) {
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mDraftDetail`;
}

// Same view set espn_api.js's readRoster already reads successfully post-draft (mSettings for
// rosterSettings.lineupSlotCounts, mTeam to populate body.teams). Built locally rather than
// importing espn_api.js's buildLeagueReadUrl to keep the require edge one-directional (see
// readDraftPicks's header in espn_api.js) — draft_sync.js is not meant to depend on espn_api.js.
function buildLeagueSettingsUrl(leagueId, seasonId) {
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${seasonId}/segments/0/leagues/${leagueId}?view=mSettings&view=mTeam`;
}

/** Parses a raw WS text frame, returning a SELECTED event or null for anything else (CLOCK, JOINED, etc). */
function parseSelectedFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("SELECTED ")) return null;

  const [, teamId, playerId, lineupSlotId, memberId] = line.split(/\s+/);
  if (teamId == null || playerId == null || lineupSlotId == null) return null;

  return {
    team_id: Number(teamId),
    player_id: Number(playerId),
    lineup_slot_id: Number(lineupSlotId),
    member_id: memberId ?? null,
  };
}

/**
 * Parses ESPN's own best-available-player suggestion — `AUTOSUGGEST <playerId>`, confirmed via a
 * real capture (issue #31, 2026-08-25: 154 instances in recon-output/websockets.jsonl, one per pick
 * cycle). Carries only a bare player id, no name/position/team — handleAutosuggestFrame resolves
 * those against state.playerPool.
 */
function parseAutosuggestFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("AUTOSUGGEST ")) return null;

  const [, playerId] = line.split(/\s+/);
  // Strictly a positive integer, not just Number()-coercible: a malformed token (e.g. "abc") would
  // otherwise become NaN, which JSON.stringify silently renders as null — overwriting the last
  // valid suggestion in Redis with a garbage status instead of leaving it alone (PR #65 review).
  if (!playerId || !/^\d+$/.test(playerId)) return null;

  return { player_id: Number(playerId) };
}

/**
 * Parses ESPN's own turn-notification broadcast — `SELECTING <teamId> <clockMs>`, documented in
 * draft_room_socket.js's header and confirmed live 2026-08-16 (scripts/practice-draft-test.js
 * waited on exactly this frame before sending SELECT). Never parsed anywhere until now — nothing
 * consumed it, so fantasy-core-pipeline's on_the_clock_team_id had to be derived from snake-draft
 * math instead, which can't resolve a team's own first-round pick before that pick has already
 * happened (chicken-and-egg: the slot map is only populated from an observed round-1 pick). This
 * is the fix: ESPN tells us directly, in real time, so no derivation is needed at all.
 */
function parseSelectingFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("SELECTING ")) return null;

  const [, teamId, clockMs] = line.split(/\s+/);
  if (!teamId || !/^\d+$/.test(teamId)) return null;

  return {
    team_id: Number(teamId),
    // clockMs is best-effort context, not load-bearing the way team_id is - a malformed or
    // absent token degrades to "unknown remaining time," not a dropped frame.
    clock_ms: clockMs && /^\d+$/.test(clockMs) ? Number(clockMs) : null,
  };
}

/**
 * Parses ESPN's own periodic countdown broadcast — `CLOCK <slot> <msRemaining> <teamId>`,
 * documented in docs/espn-reverse-engineering.md. Confirmed live 2026-08-28 (league
 * 1986717528): this room never sent a single SELECTING frame for its whole session (checked
 * against 287 log lines) - CLOCK ticks roughly once a second and was the ONLY on-the-clock
 * signal this room ever emitted, so relying on SELECTING alone left fantasy-core-pipeline
 * with zero real clock visibility here, falling back to DRAFT_PICK_CLOCK_SECONDS's
 * hardcoded per-mode guess instead of ESPN's own authoritative remaining-time value. Returns
 * the exact same {team_id, clock_ms} shape parseSelectingFrame does, deliberately, so both
 * frame types can feed the identical downstream handler/Redis key - "whoever's turn it
 * really is, and how much real time is left" is the same fact regardless of which of ESPN's
 * two frame types happened to carry it in a given room.
 */
function parseClockFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("CLOCK ")) return null;

  const [, , msRemaining, teamId] = line.split(/\s+/);
  if (!teamId || !/^\d+$/.test(teamId)) return null;

  return {
    team_id: Number(teamId),
    clock_ms: msRemaining && /^\d+$/.test(msRemaining) ? Number(msRemaining) : null,
  };
}

/**
 * Parses ESPN's own autodraft-toggle broadcast — `AUTODRAFT <teamId> <bool>`, documented in
 * docs/espn-reverse-engineering.md but previously discarded as noise (scripts/practice-draft-test.js's
 * KNOWN_NOISE regex). This is the only live signal for "this team's autodraft is currently
 * engaged" - draft_pick_ledger.js's classifyPickOrigin only tells you a pick already happened via
 * autodraft, after the fact, which is too late for a UI banner meant to warn a user before their
 * own clock runs out.
 */
function parseAutodraftFrame(raw) {
  const line = raw.toString().trim();
  if (!line.startsWith("AUTODRAFT ")) return null;

  const [, teamId, boolToken] = line.split(/\s+/);
  if (!teamId || !/^\d+$/.test(teamId) || boolToken == null) return null;

  return {
    team_id: Number(teamId),
    active: /^(1|true)$/i.test(boolToken),
  };
}

/**
 * Attributes a SELECTED frame to us, another manager, or ESPN's autodraft.
 *
 * The frame's optional 4th token is the drafting member's SWID (see draft_room_socket.js's
 * header: `SELECTED 8 4362249 10 {<our SWID>}`, correlated in a real capture against a pick we
 * sent ourselves). ESPN attributes server-side autodraft fallbacks to no member at all, so an
 * absent token is the only signal distinguishing "our bot picked" from "we ran out of clock".
 *
 * Both sides are pushed through normalizeSwid because the two SWIDs reach us by different
 * routes: ours comes from the ESPN_S2/SWID env var or OpenBao (which may or may not carry the
 * braces, depending on how it was pasted in), while the frame's always carries them. Comparing
 * them raw silently reports every one of our own picks as `other`, which is exactly the
 * misattribution this classification exists to prevent. Case is folded for the same reason —
 * the value is a GUID whose casing is not guaranteed to survive a round-trip through storage.
 */
function classifyPickOrigin(frameMemberId, ourMemberId) {
  if (frameMemberId == null) return "autodraft";
  if (ourMemberId == null) return "other";
  const frame = normalizeSwid(frameMemberId).toUpperCase();
  const ours = normalizeSwid(ourMemberId).toUpperCase();
  return frame === ours ? "us" : "other";
}

/**
 * Durably records a pick, then notifies subscribers — durability first, so by the time anyone
 * is notified via pub/sub, XRANGE/HGET against this pick already reflects it.
 *
 * Issue #52: the dedup/precedence decision itself no longer lives here. Three sources now feed
 * this function (WS `SELECTED`, the DOM board observer, and the REST snapshot), so
 * "publish / correct / drop" is decided in one shared place — draft_pick_ledger.js — instead of
 * being re-derived per call site. See that module's header for why the identity is keyed on
 * player_id rather than the untrustworthy pick_number.
 *
 * This function's remaining job is purely the I/O: write, publish, and emit the telemetry that
 * makes each decision reconstructable from pod logs after the fact.
 */
async function ingestPickEvent(redisClient, rawEvent, state) {
  // Serialized against every other ingest for this draft. Without it, two tiers observing the
  // same pick concurrently (a WS frame and a DOM scan, both async) could each evaluate() to
  // "publish" before either committed, and both would write — the exact duplicate emission this
  // whole change exists to prevent. Volume here is a few hundred picks per draft, so a plain
  // mutex costs nothing and removes the interleaving entirely.
  return withIngestLock(state, async () => {
    const event = assignPickNumber(state, rawEvent);
    const decision = state.ledger.evaluate(event);
    const identity = pickIdentity(decision.event);

    if (decision.action !== "publish" && decision.action !== "correct") {
      // Dropped events are logged only when they're interesting: a routine duplicate (every DOM
      // rescan re-reports every pick it can see) would otherwise dominate the logs. "stale" and
      // "invalid" always get a line — they mean a source disagreed with, or sent garbage to, an
      // already-published pick.
      if (decision.action !== "duplicate") {
        logger.warn(
          `[Draft Sync] Dropped ${decision.action} pick (${identity}): ${decision.reason}`,
          {
            component: "draft_ingest",
            decision: decision.action,
            source: rawEvent.source,
            pick_identity: identity,
            previous_source: decision.previous && decision.previous.source,
          },
        );
      }
      state.health.dropped[decision.action] =
        (state.health.dropped[decision.action] || 0) + 1;
      return decision;
    }

    const payload = JSON.stringify(decision.event);
    const ledgerKey = `draft:${state.leagueId}:picks`;
    const multi = redisClient
      .multi()
      .xAdd(`draft_picks:${state.leagueId}`, "*", { payload })
      .hSet(ledgerKey, String(decision.event.pick_number), payload);

    // A correction that also changes the pick NUMBER (REST supplying a true overallPickNumber for
    // a pick first seen via WS's locally-counted guess) would otherwise leave the original number
    // behind as a phantom ledger entry pointing at the same player.
    if (
      decision.action === "correct" &&
      decision.previous &&
      decision.previous.pick_number != null &&
      String(decision.previous.pick_number) !==
        String(decision.event.pick_number)
    ) {
      multi.hDel(ledgerKey, String(decision.previous.pick_number));
    }

    await multi.exec();
    await redisClient.publish("draft_picks", payload);

    // Committed to the ledger ONLY now, after the durable write actually landed. Recording it any
    // earlier would mean a failed Redis write leaves the pick marked as published while nothing
    // was ever emitted — and since this ledger is the only dedup gate, every later observation of
    // that pick would be dropped as a duplicate, losing it permanently. Committing here instead
    // means a throw above leaves no trace, so the next observation (WS re-delivery, the DOM
    // poller's next pass, the next REST reconcile) retries it naturally.
    state.ledger.commit(decision);

    if (
      state.lastPickNumber == null ||
      decision.event.pick_number > state.lastPickNumber
    ) {
      state.lastPickNumber = decision.event.pick_number;
    }

    state.health.last_pick_seen_at = new Date().toISOString();
    state.health.published_by_source[rawEvent.source] =
      (state.health.published_by_source[rawEvent.source] || 0) + 1;

    logger.info(
      `[Draft Sync] ${decision.action === "correct" ? "Corrected" : "Published"} pick ` +
        `#${decision.event.pick_number} (${rawEvent.source}): player ${decision.event.player_id} ` +
        `-> team ${decision.event.team_id}`,
      {
        component: "draft_ingest",
        decision: decision.action,
        source: rawEvent.source,
        pick_identity: identity,
        league_id: state.leagueId,
        player_id: decision.event.player_id,
        team_id: decision.event.team_id,
        pick_number: decision.event.pick_number,
        corrected_from: decision.event.corrected_from,
      },
    );
    return decision;
  });
}

/**
 * Runs `fn` after every previously-queued ingest has settled, so evaluate -> write -> commit is
 * never interleaved with another pick's. Failures are isolated: the chain continues regardless of
 * whether any individual ingest threw, and the rejection still propagates to that call's own
 * caller.
 */
function withIngestLock(state, fn) {
  const result = state.ingestChain.then(fn, fn);
  state.ingestChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * Rehydrates the ledger from the durable pick hash before any ingest happens.
 *
 * Without this, a mid-draft worker restart starts with an empty ledger while Redis still holds the
 * full pick history. The DOM observer's seed scan then reports every pick on the page, none of which
 * the ledger recognizes, so the entire draft is re-emitted downstream as brand-new picks — and worse,
 * assignPickNumber mints fresh numbers 1..N in DOM scan order, overwriting the hash's
 * correct pick->player mapping. REST can't prevent that: for practice drafts it returns nothing.
 *
 * Best-effort: a failure here means the ledger starts cold, which is degraded but not fatal, so it
 * must not block the draft sync from coming up.
 */
async function seedLedgerFromBoard(redisClient, state) {
  const ledgerKey = `draft:${state.leagueId}:picks`;
  let seeded = 0;
  try {
    const board = await redisClient.hGetAll(ledgerKey);
    for (const raw of Object.values(board || {})) {
      try {
        if (state.ledger.seed(JSON.parse(raw))) seeded += 1;
      } catch {
        // One unparseable ledger entry shouldn't cost us the rest of the seed.
        state.health.seed_parse_errors += 1;
      }
    }
    if (state.ledger.highestPickNumber != null) {
      state.lastPickNumber = state.ledger.highestPickNumber;
    }
    state.health.seeded_from_board = seeded;
    logger.info(
      `[Draft Sync] Seeded ledger with ${seeded} already-published pick(s) from ${ledgerKey} ` +
        `(highest pick #${state.ledger.highestPickNumber ?? "none"}).`,
      { component: "draft_ingest", seeded },
    );
  } catch (err) {
    logger.error(
      `[Draft Sync] Could not seed ledger from ${ledgerKey} — starting cold, which risks ` +
        `re-publishing picks already on the board: ${err.message}`,
      { component: "draft_ingest", err },
    );
  }
  return seeded;
}

/**
 * Gives an event a pick_number when its source doesn't carry one.
 *
 * Only REST reports a true `overallPickNumber`. WS carries none at all, and the DOM board may show
 * a round-relative label ("1.04") or nothing usable. But the Redis board hash is keyed by pick
 * number — that's an existing contract with fantasy-core-pipeline's consumers — so every event
 * needs one.
 *
 * The important part is the already-seen branch: a player we've already published REUSES the
 * number we gave them the first time, rather than being handed a fresh one. Without that, every
 * DOM rescan (which re-reports the full visible board each pass) would mint a new pick number for
 * the same player and be published as a brand-new pick — turning the recovery tier into a
 * duplicate generator, which is exactly what #52 asks to prevent.
 */
function assignPickNumber(state, event) {
  if (event.pick_number != null) return event;

  // Bail before touching the counter if the record can't be published anyway. evaluate() would
  // reject it as "invalid" moments later, and minting a number for it would permanently skew
  // every subsequent locally-numbered WS/DOM pick by one.
  if (!isUsablePlayerId(event.player_id)) return event;

  const existing = state.ledger.byPlayer.get(String(event.player_id));
  if (existing && existing.pick_number != null) {
    return { ...event, pick_number: existing.pick_number };
  }

  state.pickCounter += 1;
  return { ...event, pick_number: state.pickCounter };
}

/** One-time/periodic authoritative fetch — returns the sorted list of already-made picks. */
async function fetchDraftDetail(context, state) {
  const response = await context.request.get(
    buildDraftDetailUrl(state.leagueId, state.seasonId),
  );
  if (!response.ok()) {
    try {
      const body = await response.json();
      if (body?.type === "LEAGUE_NOT_FOUND_DELETED") {
        throw new PermanentError(
          `Draft room league ${state.leagueId} no longer exists (LEAGUE_NOT_FOUND_DELETED). ` +
            "Set DRAFT_ROOM_URL to a newly joined active mock draft room URL and retry.",
        );
      }
    } catch (error) {
      if (error instanceof PermanentError) {
        throw error;
      }
    }
    // Every other non-ok mDraftDetail response (404, 5xx, etc.) is treated as permanent for THIS
    // league too: confirmed live (2026-08-27) that a room's mDraftDetail keeps 404ing identically
    // on every ~15s reconcile tick once the room ends — there is no status code this endpoint
    // returns that recovers on retry once the practice room itself is gone (see this function's
    // header re: mDraftDetail's known behavior for ephemeral rooms). A transient network blip
    // would throw before reaching this line (a rejected fetch, not an ok()-false response), so
    // this branch is specifically "the server answered and said no" — which for this endpoint has
    // no observed transient case.
    throw new PermanentError(
      `mDraftDetail fetch failed: HTTP ${response.status()}`,
    );
  }
  const body = await response.json();
  const picks = body?.draftDetail?.picks ?? [];

  return picks
    .filter((pick) => pick.playerId !== -1) // -1 = not yet drafted
    .map((pick) => ({
      league_id: state.leagueId,
      player_id: pick.playerId,
      pick_number: pick.overallPickNumber,
      team_id: pick.teamId,
      round: pick.roundId,
      round_pick_number: pick.roundPickNumber,
      member_id: null,
      pick_origin: null,
      source: "rest",
      timestamp: new Date().toISOString(),
    }))
    .sort((a, b) => a.pick_number - b.pick_number);
}

// ESPN's rosterSettings.lineupSlotCounts is keyed by its standard positional-slot-id enum (0=QB,
// 2=RB, 4=WR, 6=TE, 16=D/ST, 17=K, 20=Bench, 21=IR, 23=FLEX, ...) — NOT the same numbering as the
// WS SELECTED frame's lineupSlotId (see parseSelectedFrame's header). Slot 21 (IR) is allocated
// roster space but never filled during the draft itself — it's a free-agency/waiver-only slot.
// CONFIRMED 2026-08-25: a real 10-team practice draft reported rosterSlotsPerTeam=17 (16 draftable
// + 1 IR) via this endpoint but only ever produced 160 picks (10 x 16), not the naively-summed
// 170 — so the fast path below would silently never fire without this exclusion.
const NON_DRAFTABLE_LINEUP_SLOT_IDS = new Set([21]);

/**
 * Best-effort fetch of the expected total pick count (teams x draftable roster slots) for issue
 * #62's proactive terminal-detection fast path — lets connectAndStream exit the instant the
 * ledger reaches this size, instead of waiting for the WS_DEAD_GRACE_MS watchdog.
 *
 * CONFIRMED 2026-08-25 against a real ephemeral practice draft (league 20050783, 10 teams, 160
 * picks): returns real teams/rosterSettings data while the draft is in progress — unlike its
 * sibling mDraftDetail, which never worked for practice drafts at all. AFTER the draft completes,
 * the league is torn down (`LEAGUE_NOT_FOUND_DELETED`, same as mDraftDetail's confirmed
 * post-completion behavior) — so a null return here on a later reconnect is expected, not a bug:
 * the caller preserves whatever total was already learned on an earlier cycle rather than
 * clobbering it (see connectAndStream) — this call is a refresh, not a per-cycle source of truth.
 */
async function fetchDraftTotals(context, state) {
  try {
    const response = await context.request.get(
      buildLeagueSettingsUrl(state.leagueId, state.seasonId),
    );
    if (!response.ok()) {
      throw new Error(
        `mSettings/mTeam fetch failed: HTTP ${response.status()}`,
      );
    }
    const body = await response.json();
    const teamCount = Array.isArray(body?.teams) ? body.teams.length : 0;
    const slotCounts = body?.settings?.rosterSettings?.lineupSlotCounts || {};
    const rosterSlotsPerTeam = Object.entries(slotCounts)
      .filter(([slotId]) => !NON_DRAFTABLE_LINEUP_SLOT_IDS.has(Number(slotId)))
      .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
    if (teamCount === 0 || rosterSlotsPerTeam === 0) {
      throw new Error(
        `mSettings/mTeam response missing usable team/roster data (teams=${teamCount}, ` +
          `rosterSlotsPerTeam=${rosterSlotsPerTeam})`,
      );
    }
    const totalExpectedPicks = teamCount * rosterSlotsPerTeam;
    logger.info(
      `[Draft Sync] Learned expected total picks: ${teamCount} teams x ` +
        `${rosterSlotsPerTeam} roster slots = ${totalExpectedPicks}.`,
      {
        component: "draft_ingest",
        teamCount,
        rosterSlotsPerTeam,
        totalExpectedPicks,
      },
    );
    return { teamCount, rosterSlotsPerTeam, totalExpectedPicks };
  } catch (err) {
    // Non-fatal by design (mirrors reconcileFromRest): this is a best-effort fast path, not a
    // required one. A null return just means this fast path is unavailable this cycle — the
    // caller preserves any total already learned earlier, and the STATE 2 completion frame (plus
    // the reconnect cap as an ultimate bound) still governs terminal detection either way.
    logger.warn(
      `[Draft Sync] Could not learn expected total picks: ${err.message}`,
      { component: "draft_ingest", err },
    );
    return null;
  }
}

/**
 * Fetches and caches the current-season player catalog (issue #31) so AUTOSUGGEST's bare player id
 * can be resolved to a name/position/team. Lazily requires espn_api.js — mirrors the pattern
 * espn_api.js's own readDraftPicks already uses in reverse (lazily requiring draft_sync.js) to keep
 * the dependency edge from becoming a real top-level cycle (see buildLeagueSettingsUrl's header
 * above: draft_sync.js is deliberately not meant to depend on espn_api.js at module load).
 *
 * Best-effort, mirrors fetchDraftTotals: a failure leaves state.playerPool null rather than
 * throwing, which just means published suggestions degrade to a bare player_id until the next
 * league (re)connect retries this.
 */
async function loadPlayerPool(context, state) {
  try {
    const { fetchDraftPlayerPool } = require("./espn_api");
    const players = await fetchDraftPlayerPool(context, {
      leagueId: state.leagueId,
      seasonId: state.seasonId,
    });
    state.playerPool = new Map(players.map((p) => [String(p.id), p]));
    logger.info(
      `[Draft Sync] Loaded player pool: ${state.playerPool.size} players.`,
      { component: "draft_ingest", player_count: state.playerPool.size },
    );
  } catch (err) {
    logger.warn(
      `[Draft Sync] Could not load player pool — suggested picks will carry only a player_id ` +
        `until this succeeds: ${err.message}`,
      { component: "draft_ingest", err },
    );
  }
}

async function reconcileFromRest(context, redisClient, state) {
  try {
    const picks = await fetchDraftDetail(context, state);
    state.health.rest.polls += 1;
    state.health.rest.last_poll_at = new Date().toISOString();
    state.health.rest.last_pick_count = picks.length;
    // Worth its own signal rather than being invisible: for practice/mock drafts this endpoint is
    // confirmed to return zero picks for the entire draft (espn_api.js's readDraftPicks header),
    // and that is precisely when the DOM tier is carrying recovery on its own. Seeing "REST
    // returned 0 while the board shows 40 picks" in the logs is what tells you which tier is
    // actually doing the work.
    if (picks.length === 0) {
      state.health.rest.empty_polls += 1;
    }
    for (const event of picks) {
      await ingestPickEvent(redisClient, event, state);
    }
  } catch (err) {
    state.health.rest.failed_polls += 1;
    if (err instanceof PermanentError) {
      state.permanentError = err;
    }
    logger.error(`[Draft Sync] REST reconciliation failed: ${err.message}`, {
      component: "draft_ingest",
      source: "rest",
      err,
    });
  }
}

async function handleSelectedFrame(parsed, redisClient, state) {
  const memberId = parsed.member_id ?? null;
  const event = {
    league_id: state.leagueId,
    player_id: parsed.player_id,
    // Deliberately left null: WS frames carry no overall pick number, so assignPickNumber() owns
    // deriving one (and reusing an existing one for an already-known player).
    pick_number: null,
    team_id: parsed.team_id,
    // Deliberately NOT a round: the frame's third token is ESPN's lineup slot id, and WS
    // frames carry no round at all. Emitting it as `round` made every consumer's round
    // wrong (see parseSelectedFrame). Consumers derive round from pick_number instead.
    lineup_slot_id: parsed.lineup_slot_id,
    round: null,
    member_id: memberId,
    pick_origin: classifyPickOrigin(memberId, state.memberId),
    source: "ws",
    timestamp: new Date().toISOString(),
  };
  try {
    await ingestPickEvent(redisClient, event, state);
  } catch (err) {
    logger.error(
      `[Draft Sync] Failed to publish WS pick event: ${err.message}`,
      {
        component: "draft_ingest",
        source: "ws",
        player_id: parsed.player_id,
        err,
      },
    );
  }
}

/**
 * Publishes ESPN's own suggested-next-pick (issue #31) to `draft:{leagueId}:suggested`.
 *
 * Deliberately NOT routed through ingestPickEvent/the ledger: this isn't a pick, has no dedup
 * semantics, and feeding it through assignPickNumber would corrupt pick numbering for every real
 * pick behind it. It's a single overwritten status snapshot instead — same durability shape as
 * `draft:{leagueId}:health`/`:connected` (SET, no stream, no pub/sub), not the append/publish shape
 * picks get.
 *
 * Resolves the bare player id against state.playerPool (populated once per draft by
 * loadPlayerPool). A cold/failed pool lookup degrades to a suggestion carrying only player_id —
 * still directly draftable, just missing display fields — rather than dropping the suggestion.
 */
async function handleAutosuggestFrame(parsed, redisClient, state) {
  const player = state.playerPool?.get(String(parsed.player_id)) ?? null;
  const payload = {
    league_id: state.leagueId,
    player_id: parsed.player_id,
    name: player?.name ?? null,
    position_id: player?.positionId ?? null,
    pro_team_id: player?.proTeamId ?? null,
    timestamp: new Date().toISOString(),
  };
  try {
    await redisClient.set(
      `draft:${state.leagueId}:suggested`,
      JSON.stringify(payload),
    );
  } catch (err) {
    logger.error(
      `[Draft Sync] Failed to publish suggested pick: ${err.message}`,
      {
        component: "draft_ingest",
        source: "ws",
        player_id: parsed.player_id,
        err,
      },
    );
  }
}

/**
 * Publishes ESPN's own live turn notification to `draft:{leagueId}:selecting` - same
 * overwritten-status shape as handleAutosuggestFrame, for the same reason: this isn't a pick and
 * has no dedup semantics, just "whoever's turn it is right now."
 */
async function handleSelectingFrame(parsed, redisClient, state) {
  const payload = {
    league_id: state.leagueId,
    team_id: parsed.team_id,
    clock_ms: parsed.clock_ms,
    timestamp: new Date().toISOString(),
  };
  try {
    await redisClient.set(
      `draft:${state.leagueId}:selecting`,
      JSON.stringify(payload),
    );
  } catch (err) {
    logger.error(
      `[Draft Sync] Failed to publish on-the-clock team: ${err.message}`,
      {
        component: "draft_ingest",
        source: "ws",
        team_id: parsed.team_id,
        err,
      },
    );
  }
}

/**
 * Publishes ESPN's own autodraft-toggle state to `draft:{leagueId}:autodraft` - same
 * overwritten-status shape as handleSelectingFrame/handleAutosuggestFrame. A UI banner meant to
 * warn a user their own team is about to be autodrafted needs this to be the same "whoever it is
 * right now" snapshot, not an append-only log of every toggle.
 */
async function handleAutodraftFrame(parsed, redisClient, state) {
  const payload = {
    league_id: state.leagueId,
    team_id: parsed.team_id,
    active: parsed.active,
    timestamp: new Date().toISOString(),
  };
  try {
    await redisClient.set(
      `draft:${state.leagueId}:autodraft`,
      JSON.stringify(payload),
    );
  } catch (err) {
    logger.error(
      `[Draft Sync] Failed to publish autodraft state: ${err.message}`,
      {
        component: "draft_ingest",
        source: "ws",
        team_id: parsed.team_id,
        err,
      },
    );
  }
}

/**
 * Feeds DOM-observed board records through the same ingest pipeline as WS and REST.
 *
 * A DOM record is a RECOVERY observation, not a live event: a full board scan re-reports every
 * pick it can see on every pass, so the overwhelming majority of these are already-known picks
 * that the ledger collapses into "duplicate." The ones that matter are the few that aren't —
 * picks made by other participants (or manually by the user) while our WebSocket was evicted, the
 * exact gap issue #52 is about.
 *
 * Records with no team attribution are skipped rather than published with a null team: a pick
 * whose owner is unknown is not useful to the downstream feed, and publishing it would burn its
 * player_id in the ledger, which would then suppress the correct copy when a better source
 * reports it.
 */
async function handleDomRecords(records, redisClient, state, meta) {
  if (!state.ready) {
    // Same buffering rule the WS path uses — publishing before league context/counters are seeded
    // would attribute picks to a null league and corrupt the board.
    return;
  }

  let newPicks = 0;
  for (const record of records) {
    if (record.team_id == null) {
      state.health.dom.records_without_team += 1;
      continue;
    }
    const known = state.ledger.hasPlayer(record.player_id);
    const event = {
      league_id: state.leagueId,
      player_id: record.player_id,
      pick_number: null,
      team_id: record.team_id,
      round: record.round ?? null,
      round_pick_number: record.round_pick_number ?? null,
      member_id: null,
      pick_origin: null,
      source: "dom",
      timestamp: new Date().toISOString(),
    };
    try {
      const decision = await ingestPickEvent(redisClient, event, state);
      if (!known && decision.action === "publish") newPicks += 1;
    } catch (err) {
      logger.error(
        `[Draft Sync] Failed to publish DOM pick event: ${err.message}`,
        {
          component: "draft_ingest",
          source: "dom",
          player_id: record.player_id,
          err,
        },
      );
    }
  }

  state.health.dom.scans_ingested += 1;
  if (newPicks > 0) {
    state.health.dom.recovered_picks += newPicks;
    // The headline signal for #52: the DOM tier caught picks the WebSocket never delivered. If
    // this line never appears in a live draft, the WS tier was sufficient on its own; if it
    // appears often, the socket is being evicted more than expected and that's worth knowing.
    logger.warn(
      `[Draft Sync] DOM tier recovered ${newPicks} pick(s) the WebSocket never delivered ` +
        `(trigger=${meta.trigger}, strategy=${meta.matched_strategy}).`,
      {
        component: "draft_ingest",
        source: "dom",
        recovered: newPicks,
        total_recovered: state.health.dom.recovered_picks,
        trigger: meta.trigger,
      },
    );
  }
}

/**
 * Attaches WS + a dead-session watchdog to the page. Returns a handle exposing isDead().
 *
 * Listeners are attached before navigation (so we don't race the page's own WebSocket connect),
 * but league context and pickCounter aren't seeded until after the initial REST reconciliation
 * completes. Any SELECTED frame arriving before that point gets buffered (state.ready stays
 * false) and drained in order once connectAndStream flips it — otherwise an early pick would be
 * numbered from 1 against a null league ID and corrupt the board.
 *
 * Issue #52 additions:
 *   - `INIT` frames trigger a recovery sweep. INIT is the server's full draft-state sync, sent
 *     once per connection — its arrival is the definitive marker that a socket just (re)joined
 *     the room, which is exactly the moment picks may have been missed while we were disconnected
 *     or evicted. Its payload is a multi-KB base64 blob whose internal structure has never been
 *     captured, so it is deliberately NOT parsed here: guessing at that encoding would be
 *     unverifiable, and it isn't necessary. The frame is used as a SIGNAL to re-scan the sources
 *     that are already known-good (the rendered board, and REST), which recovers the same picks
 *     without inventing a parser.
 *   - Socket lifecycle (open/close, per-socket frame counts) is logged with structured fields, so
 *     an eviction gap can be located in pod logs after the fact rather than inferred.
 */
/**
 * Distinguishes the real ESPN draft-room feed socket from any other WebSocket the page happens to
 * open — critically, Disney/BAM's identity-SDK socket (wss://espn.connections.edge.bamgrid.com/...),
 * which the rendered fantasy.espn.com page opens and reconnects independently of the draft itself
 * (observed reconnecting on its own ~30min cadence throughout a session with the draft-room socket
 * long dead). page.on("websocket") fires for EVERY socket the page opens, not just the draft
 * feed — attachDraftListeners must only count this one toward liveness/health, or the BAM socket's
 * unrelated churn permanently masks a dead draft-room connection (confirmed root cause of the
 * "connector goes silent forever" incident: isDead() and the ws_connected health field never
 * reflected the real socket's death because the BAM socket kept openSockets > 0).
 */
function isDraftRoomSocketUrl(url) {
  if (!url) return false;
  return url.includes("fantasydraft.espn.com") && url.includes("/JOIN");
}

function attachDraftListeners(page, redisClient, state, hooks = {}) {
  let openSockets = 0;
  let lastActivityAt = Date.now();

  // Diagnostic for the "connector goes silent forever" investigation: this closure (and its
  // openSockets/lastActivityAt) is recreated every time this is called, including from the
  // context.on("page", ...) reassignment below — a page that never opens a websocket of its own
  // leaves this handle's isDead() clock silently running from here with no other trace of it.
  logger.debug("[Draft Sync] attachDraftListeners: new handle created.", {
    component: "draft_ws",
    page_url: page.url(),
  });

  page.on("websocket", (ws) => {
    const url = ws.url();
    if (!isDraftRoomSocketUrl(url)) {
      // Not the draft-room feed (e.g. Disney/BAM's identity-SDK socket, which the rendered page
      // opens/reconnects independently of the draft) — logged at debug for visibility, but must
      // NOT touch openSockets/lastActivityAt/state.health.ws.*, or its own reconnect churn masks
      // a genuinely dead draft-room socket forever (confirmed root cause, see this function's
      // header comment and isDraftRoomSocketUrl's).
      logger.debug(`[Draft Sync] Ignoring non-draft-room WebSocket: ${url}`, {
        component: "draft_ws",
      });
      return;
    }

    const socketId = (state.health.ws.sockets_opened += 1);
    logger.info(`[Draft Sync] WebSocket opened: ${url}`, {
      component: "draft_ws",
      socket_id: socketId,
    });
    openSockets += 1;
    lastActivityAt = Date.now();
    let framesOnThisSocket = 0;
    let picksOnThisSocket = 0;

    ws.on("framereceived", async (frame) => {
      lastActivityAt = Date.now();
      framesOnThisSocket += 1;
      state.health.ws.frames_received += 1;
      const line = frame.payload ? frame.payload.toString() : "";

      if (line.startsWith("INIT ")) {
        state.health.ws.init_frames += 1;
        logger.info(
          `[Draft Sync] INIT frame received (${line.length} bytes) — treating as a room (re)join; ` +
            "triggering a recovery sweep of the board + REST.",
          { component: "draft_ws", socket_id: socketId },
        );
        if (hooks.onRejoin) {
          // Never awaited inside the frame handler: a recovery sweep does page evaluation and a
          // REST round trip, and blocking here would stall processing of the SELECTED frames
          // arriving right behind it.
          hooks
            .onRejoin("init")
            .catch((err) =>
              logger.error(
                `[Draft Sync] INIT-triggered recovery sweep failed: ${err.message}`,
                { component: "draft_ws", err },
              ),
            );
        }
        return;
      }

      // Issue #70: a rejected delegated SELECT gets this frame (see draft_room_socket.js's header)
      // instead of an ordinary SELECTED — checked before AUTOSUGGEST/SELECTING/AUTODRAFT since a
      // pending delegated command needs a definitive answer as fast as any other frame here. Only
      // short-circuits when a pending delegated command actually consumes it — an ERROR frame
      // with nothing awaiting it (e.g. a rejection surfacing after this bot's own confirm timeout
      // already gave up) falls through to the generic frame-type accounting below instead of
      // vanishing with no trace, same as any other non-SELECTED frame.
      if (line.startsWith("ERROR ")) {
        const errorFrame = parseErrorFrame(line);
        if (errorFrame && state.pendingCommand) {
          state.pendingCommand.onError(errorFrame);
          return;
        }
      }

      if (line.startsWith("AUTOSUGGEST ")) {
        const suggestion = parseAutosuggestFrame(line);
        if (!suggestion) return;
        if (!state.ready) {
          // Buffered rather than dropped (PR #65 review): a socket that opens/reconnects can emit
          // AUTOSUGGEST before league context is seeded, and without this a consumer would see no
          // suggestion — or a stale one for an already-drafted player — for an entire pick cycle,
          // since the next AUTOSUGGEST only fires on the next pick. Only the LATEST one is kept
          // (unlike state.pendingFrames, which keeps every SELECTED): it's an overwritten status
          // snapshot, not an append-only log, so an earlier buffered value is already stale the
          // instant a newer one arrives. Published once state.ready flips, right after the
          // pendingFrames drain below.
          state.pendingAutosuggest = suggestion;
          return;
        }
        await handleAutosuggestFrame(suggestion, redisClient, state);
        return;
      }

      if (line.startsWith("SELECTING ") || line.startsWith("CLOCK ")) {
        // Same handler/Redis key either way - see parseClockFrame's header for why some
        // rooms only ever emit one of these two frame types for on-the-clock state.
        const selecting = line.startsWith("SELECTING ")
          ? parseSelectingFrame(line)
          : parseClockFrame(line);
        if (!selecting) return;
        if (!state.ready) {
          state.pendingSelecting = selecting;
          return;
        }
        await handleSelectingFrame(selecting, redisClient, state);
        return;
      }

      if (line.startsWith("AUTODRAFT ")) {
        const autodraft = parseAutodraftFrame(line);
        if (!autodraft) return;
        if (!state.ready) {
          state.pendingAutodraft = autodraft;
          return;
        }
        await handleAutodraftFrame(autodraft, redisClient, state);
        return;
      }

      const parsed = parseSelectedFrame(line);
      if (!parsed) {
        // Issue #62 proposal #4: every non-SELECTED, non-INIT frame was previously discarded with
        // no trace at all, so a draft-completion frame (if ESPN sends one) would never be
        // noticed. Cheap capture: count by type, log only the first occurrence per type per run
        // (CLOCK alone would otherwise spam a line roughly once a second).
        const tokens = line.split(/\s+/);
        const type = tokens[0] || "EMPTY";

        // CONFIRMED 2026-08-25 (real practice draft, league 20050783, 10 teams/160 picks): `STATE`
        // carries 1 at connection start (draft in progress) and 2 exactly once, immediately after
        // the final SELECTED — the terminal frame docs/espn-reverse-engineering.md flagged as
        // unconfirmed. The socket did NOT close afterward (plain PING/PONG continued), so this is
        // strictly more useful than WS closure ever was for detecting completion. Treated as the
        // fastest of the three terminal signals — see the isTerminal computation below.
        if (type === "STATE" && tokens[1] === "2") {
          state.draftCompleted = true;
          logger.info(
            "[Draft Sync] STATE 2 frame received — ESPN's own signal that the draft has finished.",
            { component: "draft_ws", socket_id: socketId },
          );
        }

        if (!(type in state.health.ws.other_frames)) {
          logger.info(`[Draft Sync] First-seen frame type this run: ${type}`, {
            component: "draft_ws",
            frame_type: type,
            socket_id: socketId,
          });
        }
        state.health.ws.other_frames[type] =
          (state.health.ws.other_frames[type] || 0) + 1;
        return;
      }
      picksOnThisSocket += 1;

      // Issue #70: resolve a delegated command the instant its own SELECTED echo arrives, same
      // as draft_clicker.js's waitForConfirmation correlates by player_id/team_id — regardless of
      // state.ready, since a delegated pick is only ever sent once this socket is already fully
      // up (the command consumer loop below never fires before then).
      if (
        state.pendingCommand &&
        String(parsed.player_id) === String(state.pendingCommand.playerId) &&
        String(parsed.team_id) === String(state.pendingCommand.teamId)
      ) {
        state.pendingCommand.onSelected(parsed);
      }

      if (!state.ready) {
        state.pendingFrames.push(parsed);
        return;
      }
      await handleSelectedFrame(parsed, redisClient, state);
    });

    ws.on("close", () => {
      openSockets = Math.max(0, openSockets - 1);
      state.health.ws.sockets_closed += 1;
      state.health.ws.last_close_at = new Date().toISOString();
      // ESPN's draft room is single-session: a close here is very often an EVICTION (the user's
      // own tab reconnecting, or draft_clicker.js connecting to submit a pick), not a network
      // fault — and every pick broadcast until we're back is lost, since the WS protocol has no
      // replay. Logged at warn with the frame counts so the size of the gap is reconstructable.
      logger.warn(
        `[Draft Sync] WebSocket closed after ${framesOnThisSocket} frame(s), ` +
          `${picksOnThisSocket} pick(s): ${ws.url()}. Picks broadcast while disconnected can only ` +
          "be recovered by the DOM board scan or REST.",
        {
          component: "draft_ws",
          socket_id: socketId,
          frames: framesOnThisSocket,
          picks: picksOnThisSocket,
          open_sockets: openSockets,
        },
      );
      // A close is the highest-value moment to re-scan: whatever we missed is already sitting on
      // the rendered board.
      if (hooks.onRejoin) {
        hooks.onRejoin("ws-close").catch(() => {});
      }
    });
  });

  return {
    isDead: () =>
      openSockets === 0 && Date.now() - lastActivityAt > WS_DEAD_GRACE_MS,
    hasOpenSocket: () => openSockets > 0,
    // Diagnostic for the "connector goes silent forever" investigation: exposes the raw operands
    // isDead() computes from, so the reconnect loop can log them instead of just the boolean.
    debugSnapshot: () => ({
      openSockets,
      lastActivityAt,
      idleMs: Date.now() - lastActivityAt,
    }),
  };
}

/**
 * Issue #70: executes exactly one delegated `submit_pick` command through the page's own
 * already-open draft-room socket (sendPickViaPage — see draft_room_socket.js), and reports the
 * outcome back over the command's result channel.
 *
 * Registers state.pendingCommand's onSelected/onError callbacks BEFORE calling sendPickViaPage,
 * same ordering discipline as draft_clicker.js's waitForConfirmation/sendPick — the real capture
 * that module's header documents showed a SELECTED confirmation land ~0.2s after SELECT, so the
 * listener must already be attached when the frame goes out.
 */
async function executeSubmitPickCommand(session, redisClient, state, command) {
  const { command_id: commandId, player_id: playerId, team_id: teamId } = command;
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.pendingCommand = null;
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ status: "timeout" }),
      COMMAND_CONFIRM_TIMEOUT_MS,
    );

    state.pendingCommand = {
      playerId,
      teamId,
      onSelected: (parsed) =>
        settle({ status: "success", lineup_slot_id: parsed.lineup_slot_id }),
      onError: (errorFrame) =>
        settle({
          status: "error",
          error_code: errorFrame.code,
          error_message: errorFrame.message,
        }),
    };

    sendPickViaPage(session.page, playerId).catch((err) => {
      settle({ status: "error", error_message: err.message });
    });
  });

  logger.info(
    `[Draft Sync] Delegated command ${commandId} (player ${playerId}, team ${teamId}) ` +
      `resolved: ${result.status}.`,
    { component: "draft_commands", command_id: commandId, ...result },
  );

  await publishCommandResult(redisClient, state.leagueId, commandId, result).catch(
    (err) =>
      logger.error(
        `[Draft Sync] Could not publish result for delegated command ${commandId}: ${err.message}`,
        { component: "draft_commands", err },
      ),
  );
}

/**
 * Issue #70: polls draft_commands:{leagueId} for delegated pick submissions and executes them one
 * at a time — a draft's pick clock only ever has one live submission in flight, so commands are
 * handled sequentially rather than raced against each other.
 */
async function pollDraftCommands(redisClient, state, session, lastIdRef) {
  if (!state.leagueId) return;
  const commands = await consumeCommandsOnce(redisClient, state.leagueId, lastIdRef);
  for (const command of commands) {
    if (command.command !== "submit_pick") continue;
    try {
      await executeSubmitPickCommand(session, redisClient, state, command);
    } catch (err) {
      logger.error(
        `[Draft Sync] Failed to execute delegated command ${command.command_id}: ${err.message}`,
        { component: "draft_commands", err },
      );
    }
  }
}

/** Gets us into a draft room and returns { leagueId, seasonId, teamId }, however DRAFT_MODE dictates. */
async function enterDraftRoom(session) {
  // DRAFT_MODE=mock can end up with the draft room open in a brand-new tab rather than the
  // current page navigating in place (see mock_draft.js's startFreshPracticeDraft header) — the
  // other two paths always navigate session.page itself, so this only ever differs for that mode.
  let activePage = session.page;

  if (process.env.DRAFT_ROOM_URL) {
    logger.info(
      `[Draft Sync] DRAFT_ROOM_URL set — navigating directly: ${process.env.DRAFT_ROOM_URL}`,
    );
    await session.page.goto(process.env.DRAFT_ROOM_URL, {
      waitUntil: "load",
      timeout: 60000,
    });
  } else if (process.env.DRAFT_MODE === "mock") {
    logger.info(
      "[Draft Sync] DRAFT_MODE=mock — joining a fresh practice draft from the lobby...",
    );
    ({ page: activePage } = await startFreshPracticeDraft(
      session.page,
      console,
      {
        headless: session.headless,
      },
    ));
  } else {
    const leagueId = process.env.ESPN_LEAGUE_ID;
    const seasonId = process.env.CURRENT_YEAR || "2026";
    const teamId = process.env.ESPN_TEAM_ID;
    if (!leagueId || !teamId) {
      throw new Error(
        "DRAFT_ROOM_URL is not set. For manual draft_sync test runs, set DRAFT_ROOM_URL to an active ESPN mock draft room URL.",
      );
    }
    const draftUrl = buildDraftUrl(leagueId, seasonId, teamId, session.swid);
    logger.info(`[Draft Sync] Navigating to live draft room: ${draftUrl}`);
    await session.page.goto(draftUrl, { waitUntil: "load", timeout: 60000 });
  }

  const { leagueId, seasonId, teamId } = parseDraftRoomUrl(activePage.url());
  if (!leagueId || !seasonId) {
    throw new Error(
      `Could not determine league/season from draft room URL: ${activePage.url()}`,
    );
  }
  return { leagueId, seasonId, teamId, page: activePage };
}

/**
 * Pre-flight session check, run once per (re)connect before spending a browser navigation on a
 * session that's already dead. Uses ESPN_LEAGUE_ID/ESPN_TEAM_ID (the account's home
 * league/team — the identity being checked, not necessarily the ephemeral practice draft about to
 * be joined under DRAFT_MODE=mock) the same way check_espn_session.js's scheduled check does.
 * Only runs when those env vars are actually set — DRAFT_MODE=mock deployments that don't set
 * them have no leagueId to check against yet, so this step is skipped and staleness is instead
 * caught by the periodic in-draft check below (state.leagueId exists by then).
 */
async function preflightSessionCheck(session) {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  if (!leagueId || !teamId) return;

  await assertCookieSessionValid(session.context, { leagueId, seasonId });
  if (process.env.DRAFT_MODE === "mock") {
    // The lobby-join flow (mock_draft.js) renders a page — confirm the BAM SDK gate is clear
    // before fighting it with the headless auto-click added for WORKER-17.
    await assertRenderedSessionValid(session.page, {
      leagueId,
      teamId,
      seasonId,
    });
  }
}

/**
 * The whole mutable ingest state for one draft-sync run.
 *
 * Exists as a factory rather than an object literal at the call site so tests and the real entry
 * point can't drift apart: every field below is dereferenced unconditionally somewhere in the
 * ingest path, so a hand-rolled partial state fails at runtime rather than at construction.
 */
function createDraftState() {
  return {
    lastPickNumber: null,
    pickCounter: 0,
    leagueId: null,
    seasonId: null,
    teamId: null,
    memberId: null,
    ready: false,
    pendingFrames: [],
    // Issue #31 (PR #65 review): the latest AUTOSUGGEST seen while !ready, published once ready
    // flips. Only the latest, unlike pendingFrames — see attachDraftListeners' AUTOSUGGEST branch.
    pendingAutosuggest: null,
    // Same "only the latest, published once ready flips" shape as pendingAutosuggest, for the
    // SELECTING/AUTODRAFT frames — see attachDraftListeners' branches for each.
    pendingSelecting: null,
    pendingAutodraft: null,
    // Shared across reconnects on purpose: the ledger is what stops a reconnect from
    // re-publishing the entire board as brand-new picks. It's only reset when the LEAGUE changes
    // (a fresh practice draft), which connectAndStream handles.
    ledger: new DraftPickLedger(),
    health: createIngestHealth(),
    // Serializes ingest so evaluate -> write -> commit is atomic per pick (see withIngestLock).
    ingestChain: Promise.resolve(),
    sessionExpiredError: null,
    // Set when a definitively-unrecoverable error is observed from any ingest tier (REST 404s
    // that will never resolve, ESPN confirming the room is gone) — parallel to
    // sessionExpiredError, but for errors a session refresh can never fix. Checked by the same
    // reconnect-loop guard; see connectAndStream's main while loop and streamLiveDraftRoom's
    // outer catch for how the two differ in retry behavior.
    permanentError: null,
    // Issue #62: consecutive connectAndStream cycles that produced zero new picks across every
    // tier. Persists across reconnects on purpose (like the ledger) — reset only on real progress
    // or a league change, never on a mere reconnect.
    consecutiveEmptyCycles: 0,
    // Issue #62: best-effort teams x roster-slots total, from fetchDraftTotals. Null means
    // "unknown" (fetch not yet run, or failed) — terminal detection falls back to
    // consecutiveEmptyCycles in that case. Per-draft, like the ledger/health.
    expectedTotalPicks: null,
    // Issue #62: set true the instant a WS `STATE 2` frame is observed — ESPN's own confirmed
    // (2026-08-25) completion signal, the fastest and most authoritative of the three terminal
    // checks. Per-draft, like the above.
    draftCompleted: false,
    // Issue #31: Map<String(playerId), {id, name, positionId, proTeamId, rank, percentOwned}>,
    // populated once per draft by loadPlayerPool — resolves AUTOSUGGEST's bare player id into a
    // display-ready suggestion. Null until loaded (or if the catalog fetch failed); per-draft, like
    // the ledger/health, so a league change (a fresh practice draft) must refetch it.
    playerPool: null,
    // Issue #70: this process's ownership identity, generated once and kept stable across
    // reconnects (a reconnect is still the same owning pod/session, not a new owner) — only a
    // brand-new streamLiveDraftRoom() process (a pod restart) gets a fresh sessionId.
    ...generateOwnerIdentity(),
    // Issue #70: the delegated command currently awaiting its SELECTED/ERROR echo, or null.
    // Exactly one at a time — a draft's pick clock only ever has one live submission in flight,
    // so this is a single slot rather than a map keyed by command_id.
    pendingCommand: null,
    // Issue #70: cursor into draft_commands:{leagueId}, shared across reconnects on purpose (like
    // ledger/consecutiveEmptyCycles above) — a fresh connectAndStream() cycle must not reset this,
    // or it would silently skip any command published during the reconnect window between the old
    // socket dying and the new one coming up, permanently dropping that delegated pick. Left unset
    // (not primed with the literal string "$" as before) so consumeCommandsOnce's own
    // resolveInitialCursor resolves a real starting cursor via XREVRANGE on its first poll — "$"
    // only ever picks up new entries going forward inside a *blocking* XREAD; the non-blocking
    // XREAD this codebase deliberately uses would resolve "$" to "now" and then return nothing,
    // forever (this was a confirmed production bug: draft_sync.js never processed a single
    // delegated command). A plain `{ current: string }` box (not a bare string) so
    // consumeCommandsOnce can mutate the cursor in place without this module reaching back into
    // state after every poll.
    commandLastIdRef: { current: undefined },
  };
}

/**
 * Initial shape of the ingest health record (issue #52).
 *
 * Everything a pod-log/Grafana investigation needs to answer "why is a pick missing" without a
 * live reproduction: which tier published what, which tier dropped what and why, and when the
 * feed last actually moved. Kept as one plain object so the heartbeat can serialize it wholesale
 * to Redis rather than assembling a snapshot from scattered counters.
 */
function createIngestHealth() {
  return {
    started_at: new Date().toISOString(),
    last_pick_seen_at: null,
    recovery_sweeps: 0,
    seeded_from_board: 0,
    seed_parse_errors: 0,
    published_by_source: {},
    dropped: {},
    ws: {
      sockets_opened: 0,
      sockets_closed: 0,
      frames_received: 0,
      init_frames: 0,
      last_close_at: null,
      // Issue #62 proposal #4: counts of every non-INIT, non-SELECTED frame type seen this run,
      // keyed by its first token (e.g. "CLOCK", "STATE", "AUTOSUGGEST").
      other_frames: {},
    },
    dom: {
      scans_ingested: 0,
      recovered_picks: 0,
      records_without_team: 0,
    },
    rest: {
      polls: 0,
      empty_polls: 0,
      failed_polls: 0,
      last_poll_at: null,
      last_pick_count: null,
    },
  };
}

/**
 * Publishes a heartbeat describing the ingest tiers' health — to the log (for Loki) and to Redis
 * (for fantasy-core-pipeline's status endpoints and any dashboard).
 *
 * The point is that SILENCE IS AMBIGUOUS. A feed with no picks for two minutes looks identical to
 * a healthy feed during a slow drafter's turn, a WebSocket that was evicted, an expired session,
 * and a stale DOM selector. This emits state on a fixed cadence regardless of activity, so the
 * difference is visible in a pod's logs at the time it matters rather than being reconstructed
 * afterwards from an absence of lines.
 *
 * Redis write failures are swallowed deliberately: a heartbeat must never be the thing that takes
 * down a working draft sync.
 */
async function emitHealthHeartbeat(
  redisClient,
  state,
  { wsConnected, dom, terminal = false, terminalReason = null },
) {
  const now = Date.now();
  const lastPickAt = state.health.last_pick_seen_at
    ? new Date(state.health.last_pick_seen_at).getTime()
    : null;
  const silenceMs = lastPickAt == null ? null : now - lastPickAt;

  const snapshot = {
    ...state.health,
    league_id: state.leagueId,
    season_id: state.seasonId,
    team_id: state.teamId,
    ws_connected: wsConnected,
    dom_observer: dom,
    picks_known: state.ledger.size(),
    ledger_stats: state.ledger.stats,
    pick_silence_ms: silenceMs,
    // Issue #62: surfaced on every heartbeat (not just a final one) so the progression toward
    // DRAFT_STALL_TERMINAL_CYCLES, and whether an authoritative total was ever learned, is visible
    // in logs/Grafana before a terminal event fires.
    consecutive_empty_cycles: state.consecutiveEmptyCycles,
    expected_total_picks: state.expectedTotalPicks,
    terminal,
    terminal_reason: terminalReason,
    // Issue #70: folded into this same existing heartbeat/key rather than a new parallel one —
    // session_registry.js's decideOwnership() reads these fields back out of this exact snapshot.
    // Cleared (not renewed) on a terminal heartbeat below: a finished draft must stop looking like
    // it has a live owner immediately, not linger until lease_expires_at naturally lapses.
    ...(terminal
      ? { owner_pod: null, owner_session_id: null, lease_expires_at: null }
      : buildOwnershipFields({
          podName: state.podName,
          sessionId: state.sessionId,
          leaseTtlMs: OWNERSHIP_LEASE_TTL_MS,
        })),
    emitted_at: new Date().toISOString(),
  };

  // Warn when the feed has gone quiet for longer than a plausible pick clock, or when the socket
  // is down — both are conditions where picks are actively at risk of being missed, and both are
  // otherwise invisible until someone notices a gap downstream.
  const quiet = silenceMs != null && silenceMs > PICK_SILENCE_WARN_MS;
  const level = quiet || !wsConnected ? "warn" : "info";
  logger[level](
    `[Draft Sync] Health: ws=${wsConnected ? "connected" : "DOWN"} ` +
      `picks=${snapshot.picks_known} ` +
      `last_pick=${state.health.last_pick_seen_at || "none yet"} ` +
      `dom_recovered=${state.health.dom.recovered_picks} ` +
      `rest_empty=${state.health.rest.empty_polls}/${state.health.rest.polls}`,
    { component: "draft_health", ...snapshot },
  );

  if (!state.leagueId) return snapshot;
  try {
    const key = `draft:${state.leagueId}:health`;
    await redisClient.set(key, JSON.stringify(snapshot), { EX: 3600 });
  } catch (err) {
    logger.warn(
      `[Draft Sync] Could not write health snapshot to Redis: ${err.message}`,
      { component: "draft_health", err },
    );
  }
  return snapshot;
}

async function connectAndStream(redisClient, state) {
  const session = await createAuthenticatedSession();
  state.memberId = session.swid;
  let reconcileInterval;
  let heartbeatInterval;
  let commandPollInterval;
  let domObserver = null;
  state.ready = false;
  state.pendingFrames = [];
  state.pendingAutosuggest = null;
  state.pendingSelecting = null;
  state.pendingAutodraft = null;
  state.sessionExpiredError = null;
  // Issue #70: reuses state.commandLastIdRef (persisted across reconnects) rather than resetting
  // to "$" here — see createDraftState's comment for why a per-reconnect reset would drop
  // commands published during the reconnect window.

  // Issue #70: installed on the CONTEXT, before enterDraftRoom navigates anywhere — see
  // installDraftSocketSendHook's own header for why this ordering matters (a page that already
  // started loading before the init script is registered would never get its WebSocket patched).
  await installDraftSocketSendHook(session.context);

  // Recovery sweep, shared by every trigger that means "we may have missed picks": an INIT frame
  // (a room re-join) and a socket close. Re-scans the two sources that can see history the WS
  // can't replay. Guarded against overlap because a close and the INIT of the replacement socket
  // arrive close together and would otherwise run two identical sweeps back to back.
  let sweeping = false;
  const runRecoverySweep = async (trigger) => {
    if (sweeping || !state.ready) return;
    sweeping = true;
    state.health.recovery_sweeps += 1;
    try {
      logger.info(`[Draft Sync] Recovery sweep (${trigger}) starting.`, {
        component: "draft_ingest",
        trigger,
      });
      if (domObserver) await domObserver.scanNow(`recovery:${trigger}`);
      await reconcileFromRest(session.context, redisClient, state);
    } finally {
      sweeping = false;
    }
  };

  try {
    await preflightSessionCheck(session);

    // Attach to the original page immediately, AND register a context-level listener that
    // attaches to any brand-new page/tab the INSTANT it's created (not after enterDraftRoom
    // returns): DRAFT_MODE=mock's lobby-click flow can open the real draft room in a new tab (see
    // mock_draft.js's header), and that new page can open and finish connecting its own
    // WebSocket during its own navigation — attaching reactively only after enterDraftRoom
    // resolves is too late, since Playwright's page.on("websocket") never replays a socket that
    // already opened before the listener was registered, causing this to silently miss every
    // pick in the new tab.
    const hooks = { onRejoin: runRecoverySweep };
    let handle = attachDraftListeners(session.page, redisClient, state, hooks);
    session.context.on("page", (newPage) => {
      if (newPage !== session.page) {
        // Diagnostic for the "connector goes silent forever" investigation: this was previously
        // completely silent, so there was no way to tell from logs whether a stray new Page ever
        // fires mid-draft (resetting the isDead() handle/clock out from under the reconnect loop)
        // versus not firing at all.
        logger.info(
          "[Draft Sync] context 'page' event fired — reassigning WebSocket listener handle to " +
            "the new page.",
          { component: "draft_ws", new_page_url: newPage.url() },
        );
        handle = attachDraftListeners(newPage, redisClient, state, hooks);
      }
    });

    const draftContext = await enterDraftRoom(session);

    // enterDraftRoom's page can differ from session.page (DRAFT_MODE=mock opening a new tab) —
    // listeners for it are already attached above; just point session.page at it so the rest of
    // this function (the isDead() poll loop below) watches the actually-active page.
    if (draftContext.page && draftContext.page !== session.page) {
      logger.info(
        "[Draft Sync] Draft room opened in a new tab — listeners were already attached to it.",
      );
      session.page = draftContext.page;
    }

    // DRAFT_MODE=mock joins a brand-new ephemeral league on every reconnect — carrying over the
    // previous draft's counters would misnumber (or skip) every pick in the new one.
    if (state.leagueId && state.leagueId !== draftContext.leagueId) {
      logger.info(
        `[Draft Sync] League changed (${state.leagueId} -> ${draftContext.leagueId}), resetting pick counters.`,
      );
      state.lastPickNumber = null;
      state.pickCounter = 0;
      // The ledger is per-draft: keeping the previous practice draft's players would make every
      // pick of the new one look like a duplicate and suppress the entire feed.
      state.ledger.reset();
      // Health is per-draft for the same reason — carrying started_at, last_pick_seen_at and the
      // per-tier counters across leagues would make the new draft's heartbeat describe a mixture
      // of two drafts (recovered_picks and WS frame counts spanning both).
      state.health = createIngestHealth();
      // Issue #62: same reasoning — a stall streak, a learned total, or a completion signal from
      // the PREVIOUS league's draft has no bearing on this one.
      state.consecutiveEmptyCycles = 0;
      state.expectedTotalPicks = null;
      state.draftCompleted = false;
      // Issue #31: the previous league's player catalog is meaningless for a fresh draft — a stale
      // pool would resolve AUTOSUGGEST ids from the wrong league (or miss them entirely).
      state.playerPool = null;
    }
    state.leagueId = draftContext.leagueId;
    await redisClient.set(`draft:${state.leagueId}:connected`, "1", { EX: 60 });
    state.seasonId = draftContext.seasonId;
    state.teamId = draftContext.teamId;

    // Issue #62 proposal #1: best-effort — see fetchDraftTotals' header. Confirmed working
    // mid-draft even for ephemeral practice drafts (2026-08-25); a null result here just means
    // this reconnect landed after the league was already torn down (confirmed post-completion
    // behavior, same as mDraftDetail) — which is exactly the reconnect where an already-learned
    // total matters most. So a failed refresh PRESERVES whatever was already learned on an
    // earlier cycle rather than clobbering it back to null.
    const totals = await fetchDraftTotals(session.context, state);
    if (totals) {
      state.expectedTotalPicks = totals.totalExpectedPicks;
    }

    // Issue #31: best-effort, once per draft (skipped on a mere reconnect if already loaded — see
    // the league-change reset above for when it's cleared). A failed fetch leaves playerPool null,
    // which degrades published suggestions to a bare player_id rather than blocking the sync.
    if (!state.playerPool) {
      await loadPlayerPool(session.context, state);
    }

    // Rehydrate from the durable board BEFORE anything can ingest. On a mid-draft restart Redis
    // still holds every pick published so far, and without this the DOM observer's first full
    // scan would re-publish all of them as new picks (REST can't cover for it — practice drafts
    // return nothing).
    await seedLedgerFromBoard(redisClient, state);

    // Issue #62: snapshotted here — right after the durable-board rehydrate, before REST
    // reconcile, the buffered-frame drain, and the DOM observer's first scan — so picks any of
    // those startup steps recover count as real progress for THIS cycle's newPicksThisCycle.
    // Capturing it any later (after those steps) would make a reconnect that successfully
    // recovers picks during startup look like a stall, since the recovery would already be
    // baked into the "start" snapshot.
    const picksAtCycleStart = state.ledger.size();

    // Seed/backfill from the authoritative snapshot, so a worker (re)starting mid-draft doesn't
    // report a bogus pick counter or miss earlier picks.
    await reconcileFromRest(session.context, redisClient, state);
    state.pickCounter = state.lastPickNumber ?? 0;

    // Drain anything that arrived while we were still initializing, in order. New frames pushed
    // onto pendingFrames while this loop runs (state.ready is still false) get drained too, since
    // we keep re-checking the array's length rather than snapshotting it up front.
    while (state.pendingFrames.length > 0) {
      const parsed = state.pendingFrames.shift();
      await handleSelectedFrame(parsed, redisClient, state);
    }
    state.ready = true;

    // Issue #31 (PR #65 review): publish whatever AUTOSUGGEST arrived during startup/reconnect so
    // consumers aren't left with no suggestion — or a stale one for an already-drafted player — for
    // an entire pick cycle, since the next AUTOSUGGEST only fires on the next pick.
    if (state.pendingAutosuggest) {
      await handleAutosuggestFrame(state.pendingAutosuggest, redisClient, state);
      state.pendingAutosuggest = null;
    }
    if (state.pendingSelecting) {
      await handleSelectingFrame(state.pendingSelecting, redisClient, state);
      state.pendingSelecting = null;
    }
    if (state.pendingAutodraft) {
      await handleAutodraftFrame(state.pendingAutodraft, redisClient, state);
      state.pendingAutodraft = null;
    }

    // DOM tier comes up only after state.ready — its very first scan reports the whole visible
    // board at once, which would be dropped by handleDomRecords' not-ready guard otherwise.
    // Non-fatal: a failure here leaves WS+REST running rather than killing the sync.
    try {
      domObserver = await attachDraftDomObserver(session.page, {
        onRecords: (records, meta) =>
          handleDomRecords(records, redisClient, state, meta),
      });
    } catch (err) {
      logger.error(
        `[Draft Sync] DOM observer failed to attach — continuing with WS + REST only: ${err.message}`,
        { component: "draft_dom_observer", err },
      );
    }

    reconcileInterval = setInterval(async () => {
      await reconcileFromRest(session.context, redisClient, state);
      await redisClient.set(`draft:${state.leagueId}:connected`, "1", {
        EX: 60,
      });

      // Piggybacks on this same 15s cadence rather than a separate timer — a mid-draft cookie
      // expiry is then caught within one reconcile interval instead of only surfacing when a
      // pick attempt itself fails. Stored on state (not thrown here) since a rejected setInterval
      // callback can't propagate to the while loop below; that loop checks it every 5s instead.
      try {
        await assertCookieSessionValid(session.context, {
          leagueId: state.leagueId,
          seasonId: state.seasonId,
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          logger.error(
            `[Draft Sync] ESPN session appears to have expired mid-draft: ${err.message}`,
            { err },
          );
          state.sessionExpiredError = err;
        } else if (err instanceof PermanentError) {
          // Confirmed live 2026-08-27: without this branch, a room that has ended keeps 404ing
          // this same check every REST_RECONCILE_INTERVAL_MS (15s) forever — logged 60+ times
          // over 17+ minutes with zero effect, since only SessionExpiredError was ever escalated
          // out of this catch. A PermanentError here can never resolve on retry (the room is
          // gone), so it gets the same "stop looping, surface it" treatment.
          logger.error(
            `[Draft Sync] Periodic session check found an unrecoverable condition: ${err.message}`,
            { err },
          );
          state.permanentError = err;
        } else {
          logger.error(
            `[Draft Sync] Periodic session check failed: ${err.message}`,
            { err },
          );
        }
      }
    }, REST_RECONCILE_INTERVAL_MS);

    heartbeatInterval = setInterval(() => {
      emitHealthHeartbeat(redisClient, state, {
        wsConnected: handle.hasOpenSocket(),
        dom: domObserver ? domObserver.getHealth() : null,
      }).catch((err) =>
        logger.error(`[Draft Sync] Health heartbeat failed: ${err.message}`, {
          component: "draft_health",
          err,
        }),
      );
    }, HEALTH_HEARTBEAT_INTERVAL_MS);

    // Issue #70: polls independently of the heartbeat above — a delegated pick is racing the
    // draft clock, not the much coarser heartbeat cadence. Guarded by commandPollInFlight since a
    // single delegated command can take up to COMMAND_CONFIRM_TIMEOUT_MS to resolve (longer than
    // COMMAND_POLL_INTERVAL_MS) — without the guard, an overlapping tick could start a second
    // pollDraftCommands() call that overwrites state.pendingCommand mid-flight and breaks
    // SELECTED/ERROR correlation for the in-progress command.
    let commandPollInFlight = false;
    commandPollInterval = setInterval(() => {
      if (commandPollInFlight) return;
      commandPollInFlight = true;
      pollDraftCommands(redisClient, state, session, state.commandLastIdRef)
        .catch((err) =>
          logger.error(
            `[Draft Sync] Draft command poll failed: ${err.message}`,
            { component: "draft_commands", err },
          ),
        )
        .finally(() => {
          commandPollInFlight = false;
        });
    }, COMMAND_POLL_INTERVAL_MS);

    const totalPicksReached = () =>
      state.expectedTotalPicks != null &&
      state.ledger.size() >= state.expectedTotalPicks;

    // Issue #62: the loop now also exits proactively the instant either the learned total is
    // reached or ESPN's own STATE 2 completion frame arrives — no need to wait out
    // WS_DEAD_GRACE_MS once we're already confident the draft is over.
    while (!handle.isDead() && !totalPicksReached() && !state.draftCompleted) {
      // Retrying REST reconciliation forever against an expired session is pointless the same way
      // retrying a doomed pick is — throw out to streamLiveDraftRoom's reconnect-with-backoff
      // rather than spinning here until the outer WS_DEAD_GRACE_MS watchdog eventually notices.
      if (state.sessionExpiredError) {
        throw state.sessionExpiredError;
      }
      // A permanent error (room confirmed gone, e.g. HTTP 404 "LEAGUE_NOT_FOUND_DELETED") can
      // never resolve on any retry — throw out immediately rather than waiting for isDead()'s
      // 30s grace window or looping this check every 15s. streamLiveDraftRoom's outer catch
      // recognizes PermanentError and exits without backoff/retry (see that function's changes).
      if (state.permanentError) {
        throw state.permanentError;
      }
      // Diagnostic for the "connector goes silent forever" investigation: this loop was
      // previously silent on every tick, so there was no way to distinguish "correctly waiting"
      // from "stuck" — logs the raw operands behind isDead() (not just its boolean) plus the
      // delegated-command state, since a stuck command is a candidate root cause worth ruling
      // in/out from the same trace point.
      const snap = handle.debugSnapshot();
      logger.debug("[Draft Sync] Reconnect-loop tick.", {
        component: "draft_ingest",
        open_sockets: snap.openSockets,
        idle_ms: snap.idleMs,
        ws_dead_grace_ms: WS_DEAD_GRACE_MS,
        total_picks_reached: totalPicksReached(),
        draft_completed: state.draftCompleted,
        pending_command: state.pendingCommand
          ? {
              player_id: state.pendingCommand.playerId,
              team_id: state.pendingCommand.teamId,
            }
          : null,
        command_poll_in_flight: commandPollInFlight,
      });
      await session.page.waitForTimeout(5000);
    }

    // The while loop's own permanentError check only runs at the top of each iteration — if the
    // periodic session-check interval sets state.permanentError during the loop's final
    // iteration's waitForTimeout(), and that same tick also flips isDead() true (or reaches the
    // learned total), the while condition ends the loop before the top-of-loop check runs again.
    // Re-check here so a permanent error is never silently swallowed by a coincident isDead()/
    // totalPicksReached() exit.
    if (state.permanentError) {
      throw state.permanentError;
    }

    const newPicksThisCycle = state.ledger.size() - picksAtCycleStart;
    if (newPicksThisCycle > 0) {
      state.consecutiveEmptyCycles = 0;
    } else {
      state.consecutiveEmptyCycles += 1;
    }
    // Issue #62: terminal (exit 0, "draft complete") is decided ONLY by the two confirmed-
    // authoritative signals — ESPN's own STATE 2 completion frame, or the learned total being
    // reached. A stall streak (consecutiveEmptyCycles) is deliberately NOT a third way to call
    // this terminal: silence is ambiguous — a sustained ESPN/network outage on a still-active
    // draft looks identical to a finished one at this layer, and wrongly declaring "complete"
    // would permanently stop syncing a draft that's still going. A stall instead escalates
    // logging (see below) and rides the existing reconnect-cap/backoff machinery
    // (decideReconnectAction) to a bounded, honest FAILURE exit if it never resolves — "I don't
    // know if this finished, I gave up" rather than a false "it's done."
    const isTerminal = state.draftCompleted || totalPicksReached();
    const terminalReason = state.draftCompleted
      ? "state_2_frame"
      : totalPicksReached()
        ? "total_picks_reached"
        : null;
    // Purely diagnostic escalation: makes a sync that's been silent for a while louder in pod
    // logs/alerting well before the reconnect cap is exhausted, without that silence alone ever
    // being read as proof the draft is done.
    const concerning =
      !isTerminal &&
      state.consecutiveEmptyCycles >= DRAFT_STALL_TERMINAL_CYCLES;

    await emitHealthHeartbeat(redisClient, state, {
      wsConnected: handle.hasOpenSocket(),
      dom: domObserver ? domObserver.getHealth() : null,
      terminal: isTerminal,
      terminalReason,
    }).catch(() => {});

    if (isTerminal && state.leagueId) {
      // Downstream liveness consumers should see "not connected" immediately, not wait out the
      // 60s TTL — the sync is deliberately done, not merely quiet.
      await redisClient
        .del(`draft:${state.leagueId}:connected`)
        .catch(() => {});
    }

    logger[isTerminal ? "info" : concerning ? "error" : "warn"](
      isTerminal
        ? `[Draft Sync] Draft appears complete (${terminalReason}) — exiting cleanly.`
        : concerning
          ? `[Draft Sync] ${state.consecutiveEmptyCycles} consecutive reconnect cycles with no ` +
            "new picks and no completion signal — connection may be stuck (still retrying up to " +
            "the reconnect cap)."
          : "[Draft Sync] Connection appears dead, will attempt to reconnect.",
      {
        component: "draft_ingest",
        consecutive_empty_cycles: state.consecutiveEmptyCycles,
        expected_total_picks: state.expectedTotalPicks,
      },
    );
    return { terminal: isTerminal, newPicksThisCycle };
  } finally {
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (commandPollInterval) clearInterval(commandPollInterval);
    // Awaited so the in-page observer is actually disconnected before the browser closes — and
    // never allowed to throw, since this runs in a finally guarding the browser teardown.
    if (domObserver) {
      await domObserver.stop().catch(() => {});
    }
    if (session.browser) {
      await session.browser.close();
    }
  }
}

/**
 * Pure decision of what streamLiveDraftRoom should do after one connectAndStream cycle —
 * extracted so this logic (issue #62's actual fix) is unit-testable without mocking a browser.
 *
 * `terminal` (from connectAndStream) always wins: a confirmed-finished draft exits clean
 * regardless of `attempt`. Otherwise, real progress (`newPicksThisCycle > 0`) resets backoff to
 * immediate retry — same as today's behavior for a live, healthy reconnect. A cycle with no new
 * picks now goes through the SAME backoff/cap machinery a thrown error already used, which it
 * previously never did (a clean-but-dead connectAndStream return isn't a thrown error, so it
 * always fell through as if attempt were reset to 0 — the actual root cause of #62's unbounded
 * loop).
 */
/**
 * Pure decision of what streamLiveDraftRoom should do after connectAndStream *throws* — extracted
 * the same way decideReconnectAction was, so this is unit-testable without mocking Redis/browser.
 *
 * A PermanentError (room confirmed gone) can never resolve on any retry, at any delay — exit
 * immediately rather than burning through the reconnect-attempt budget (and its backoff delays)
 * on a doomed room. Any other thrown error keeps today's generic crash-retry-with-backoff
 * behavior.
 */
function decideCrashRecoveryAction({ error, attempt }) {
  if (error instanceof PermanentError) {
    return { action: "exit_permanent" };
  }
  const nextAttempt = attempt + 1;
  if (nextAttempt >= MAX_RECONNECT_ATTEMPTS) return { action: "exit_failed" };
  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (nextAttempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  return { action: "retry_after_delay", nextAttempt, delayMs };
}

function decideReconnectAction({ terminal, newPicksThisCycle, attempt }) {
  if (terminal) return { action: "exit_clean" };
  if (newPicksThisCycle > 0)
    return { action: "retry_immediate", nextAttempt: 0 };
  const nextAttempt = attempt + 1;
  // >= , not >: the original `while (attempt < MAX_RECONNECT_ATTEMPTS)` loop allowed exactly
  // MAX_RECONNECT_ATTEMPTS connectAndStream() calls (attempts 0..9) before giving up. `>` here
  // would let an (MAX_RECONNECT_ATTEMPTS + 1)th browser launch happen before the cap engages.
  if (nextAttempt >= MAX_RECONNECT_ATTEMPTS) return { action: "exit_failed" };
  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (nextAttempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  return { action: "retry_after_delay", nextAttempt, delayMs };
}

async function streamLiveDraftRoom() {
  logger.info(
    `[Draft Sync] Booting live channel listener client. Connecting to Redis node at ${REDIS_HOST}...`,
  );
  const redisClient = redis.createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
  });
  // Without this, an unhandled 'error' event (Node Redis emits connection errors through the
  // EventEmitter) would crash the process outright instead of letting the client's own
  // reconnect strategy recover.
  redisClient.on("error", (err) =>
    logger.error(`[Draft Sync] Redis client error: ${err.message}`, {
      err,
    }),
  );
  await redisClient.connect();

  const state = createDraftState();
  let attempt = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result;
      try {
        result = await connectAndStream(redisClient, state);
      } catch (error) {
        const crashDecision = decideCrashRecoveryAction({ error, attempt });
        if (crashDecision.action === "exit_permanent") {
          // Confirmed live 2026-08-27: without this branch, a thrown PermanentError fell into
          // the generic retry-with-backoff path below and burned through all
          // MAX_RECONNECT_ATTEMPTS (each with its own growing delay) against a room that had
          // already 404'd — 17+ minutes of pointless retries in the incident this fixes.
          logger.error(
            `[Draft Sync] Unrecoverable condition, exiting without further reconnect attempts: ${error.message}`,
            { err: error },
          );
          return;
        }
        attempt = crashDecision.nextAttempt ?? attempt + 1;
        // >= , not > — see decideReconnectAction's matching comment; keeps this path's boundary
        // consistent with it (both cap at exactly MAX_RECONNECT_ATTEMPTS connectAndStream calls).
        if (crashDecision.action === "exit_failed") {
          throw new Error(
            "Exceeded max reconnect attempts for live draft stream.",
          );
        }
        logger.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${crashDecision.delayMs}ms...`,
          { err: error, attempt },
        );
        await new Promise((resolve) =>
          setTimeout(resolve, crashDecision.delayMs),
        );
        continue;
      }

      // Issue #62: a clean connectAndStream return is no longer automatically "reset and retry
      // immediately" — decideReconnectAction routes a stalled-but-clean cycle through the same
      // backoff/cap logic a thrown error uses, and a terminal cycle (draft actually finished)
      // exits the process instead of looping at all.
      const decision = decideReconnectAction({ ...result, attempt });
      if (decision.action === "exit_clean") {
        logger.info(
          "[Draft Sync] Draft sync complete — no more reconnect attempts needed, exiting.",
        );
        return;
      }
      if (decision.action === "exit_failed") {
        throw new Error(
          "Exceeded max reconnect attempts for live draft stream.",
        );
      }
      attempt = decision.nextAttempt;
      if (decision.action === "retry_after_delay") {
        logger.warn(
          `[Draft Sync] Stalled cycle with no new picks (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}), ` +
            `reconnecting in ${decision.delayMs}ms...`,
          { attempt },
        );
        await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
      }
    }
  } catch (error) {
    logger.error(
      `[Draft Sync] Live data sync loop crashed permanently: ${error.message}`,
      { err: error },
    );
    // Rethrow rather than shutting down/exiting here -- this runs inside withInstrumentation's
    // handler (see require.main below), so exiting here would skip its own catch, which is what
    // records the failed span and execution_log row. Shutdown/exit happens after that wrapper
    // settles instead.
    throw error;
  } finally {
    await redisClient.quit();
  }
}

if (require.main === module) {
  // fantasy-core-pipeline's teardown (_teardown_practice_run) deletes this Job and polls for it
  // to actually disappear within a fixed budget before proceeding. Without this handler, Node
  // running as container PID 1 does not get the default terminate-on-SIGTERM disposition, so
  // Kubernetes' graceful SIGTERM here was being silently ignored and the pod only died once
  // kubelet escalated to SIGKILL at the very end of the grace period — reliably racing (and
  // usually losing against) that poll budget. Nothing here needs a graceful flush (see
  // fantasy-core-pipeline#103's reasoning for the matching grace_period_seconds fix), so an
  // immediate exit is sufficient — this just makes that exit happen on the graceful signal
  // instead of waiting for the forceful one.
  process.on("SIGTERM", () => process.exit(0));

  withInstrumentation(
    "draft_sync",
    { trackingId: require("crypto").randomUUID() },
    streamLiveDraftRoom,
  ).then(
    async () => {
      // Issue #62: previously there was no success branch at all, so even a fully-fixed
      // reconnect loop would leave the pod hanging — telemetry/init.js's NodeSDK keeps
      // background timers alive, so a bare resolved promise doesn't let the process exit on its
      // own. This mirrors the .catch() branch below exactly, just with exit code 0.
      const { shutdownTelemetry } = require("../telemetry/init");
      try {
        await shutdownTelemetry();
      } finally {
        process.exit(0);
      }
    },
    async () => {
      // withInstrumentation's own catch has already recorded the span/execution_log failure by
      // the time this runs -- only flushing and exiting is left to do. shutdownTelemetry never
      // rejects, so the try/finally is belt-and-braces: process.exit(1) must run no matter what.
      const { shutdownTelemetry } = require("../telemetry/init");
      try {
        await shutdownTelemetry();
      } finally {
        process.exit(1);
      }
    },
  );
}

module.exports = {
  streamLiveDraftRoom,
  connectAndStream,
  parseSelectedFrame,
  parseAutosuggestFrame,
  parseSelectingFrame,
  parseClockFrame,
  parseAutodraftFrame,
  buildDraftUrl,
  buildDraftDetailUrl,
  buildLeagueSettingsUrl,
  fetchDraftDetail,
  fetchDraftTotals,
  loadPlayerPool,
  ingestPickEvent,
  assignPickNumber,
  handleSelectedFrame,
  handleAutosuggestFrame,
  handleSelectingFrame,
  handleAutodraftFrame,
  classifyPickOrigin,
  handleDomRecords,
  seedLedgerFromBoard,
  createDraftState,
  createIngestHealth,
  emitHealthHeartbeat,
  decideReconnectAction,
  decideCrashRecoveryAction,
  attachDraftListeners,
  isDraftRoomSocketUrl,
  executeSubmitPickCommand,
  pollDraftCommands,
  reconcileFromRest,
};
