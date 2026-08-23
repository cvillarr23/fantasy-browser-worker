const { createAuthenticatedSession } = require("./auth");
const { startFreshPracticeDraft, parseDraftRoomUrl } = require("./mock_draft");
const {
  assertCookieSessionValid,
  assertRenderedSessionValid,
} = require("./session_health");
const { SessionExpiredError } = require("../errors");
const { DraftPickLedger, pickIdentity } = require("./draft_pick_ledger");
const { attachDraftDomObserver } = require("./draft_dom_observer");
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
 *      SELECTED <teamId> <playerId> <round> [<memberId>]
 *    memberId is only present when a human (not autodraft) makes the pick. There's no overall pick
 *    number on this frame, only round — so pick_number is derived locally (see assignPickNumber).
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

/** Parses a raw WS text frame, returning a SELECTED event or null for anything else (CLOCK, JOINED, etc). */
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
    const boardKey = `draft:${state.leagueId}:board`;
    const multi = redisClient
      .multi()
      .xAdd(`draft_picks:${state.leagueId}`, "*", { payload })
      .hSet(boardKey, String(decision.event.pick_number), payload);

    // A correction that also changes the pick NUMBER (REST supplying a true overallPickNumber for
    // a pick first seen via WS's locally-counted guess) would otherwise leave the original number
    // behind as a phantom board entry pointing at the same player.
    if (
      decision.action === "correct" &&
      decision.previous &&
      decision.previous.pick_number != null &&
      String(decision.previous.pick_number) !==
        String(decision.event.pick_number)
    ) {
      multi.hDel(boardKey, String(decision.previous.pick_number));
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
 * Rehydrates the ledger from the durable board hash before any ingest happens.
 *
 * Without this, a mid-draft worker restart starts with an empty ledger while Redis still holds the
 * full board. The DOM observer's seed scan then reports every pick on the page, none of which the
 * ledger recognizes, so the entire draft is re-emitted downstream as brand-new picks — and worse,
 * assignPickNumber mints fresh numbers 1..N in DOM scan order, overwriting the board hash's
 * correct pick->player mapping. REST can't prevent that: for practice drafts it returns nothing.
 *
 * Best-effort: a failure here means the ledger starts cold, which is degraded but not fatal, so it
 * must not block the draft sync from coming up.
 */
async function seedLedgerFromBoard(redisClient, state) {
  const boardKey = `draft:${state.leagueId}:board`;
  let seeded = 0;
  try {
    const board = await redisClient.hGetAll(boardKey);
    for (const raw of Object.values(board || {})) {
      try {
        if (state.ledger.seed(JSON.parse(raw))) seeded += 1;
      } catch {
        // One unparseable board entry shouldn't cost us the rest of the seed.
        state.health.seed_parse_errors += 1;
      }
    }
    if (state.ledger.highestPickNumber != null) {
      state.lastPickNumber = state.ledger.highestPickNumber;
    }
    state.health.seeded_from_board = seeded;
    logger.info(
      `[Draft Sync] Seeded ledger with ${seeded} already-published pick(s) from ${boardKey} ` +
        `(highest pick #${state.ledger.highestPickNumber ?? "none"}).`,
      { component: "draft_ingest", seeded },
    );
  } catch (err) {
    logger.error(
      `[Draft Sync] Could not seed ledger from ${boardKey} — starting cold, which risks ` +
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
        throw new Error(
          `Draft room league ${state.leagueId} no longer exists (LEAGUE_NOT_FOUND_DELETED). ` +
            "Set DRAFT_ROOM_URL to a newly joined active mock draft room URL and retry.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("LEAGUE_NOT_FOUND_DELETED")
      ) {
        throw error;
      }
    }
    throw new Error(`mDraftDetail fetch failed: HTTP ${response.status()}`);
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
      source: "rest",
      timestamp: new Date().toISOString(),
    }))
    .sort((a, b) => a.pick_number - b.pick_number);
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
    logger.error(`[Draft Sync] REST reconciliation failed: ${err.message}`, {
      component: "draft_ingest",
      source: "rest",
      err,
    });
  }
}

async function handleSelectedFrame(parsed, redisClient, state) {
  const event = {
    league_id: state.leagueId,
    player_id: parsed.player_id,
    // Deliberately left null: WS frames carry no overall pick number, so assignPickNumber() owns
    // deriving one (and reusing an existing one for an already-known player).
    pick_number: null,
    team_id: parsed.team_id,
    round: parsed.round,
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
function attachDraftListeners(page, redisClient, state, hooks = {}) {
  let openSockets = 0;
  let lastActivityAt = Date.now();

  page.on("websocket", (ws) => {
    const socketId = (state.health.ws.sockets_opened += 1);
    logger.info(`[Draft Sync] WebSocket opened: ${ws.url()}`, {
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

      const parsed = parseSelectedFrame(line);
      if (!parsed) return;
      picksOnThisSocket += 1;

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
  };
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
async function emitHealthHeartbeat(redisClient, state, { wsConnected, dom }) {
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
  let reconcileInterval;
  let heartbeatInterval;
  let domObserver = null;
  state.ready = false;
  state.pendingFrames = [];
  state.sessionExpiredError = null;

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
    }
    state.leagueId = draftContext.leagueId;
    state.seasonId = draftContext.seasonId;
    state.teamId = draftContext.teamId;

    // Rehydrate from the durable board BEFORE anything can ingest. On a mid-draft restart Redis
    // still holds every pick published so far, and without this the DOM observer's first full
    // scan would re-publish all of them as new picks (REST can't cover for it — practice drafts
    // return nothing).
    await seedLedgerFromBoard(redisClient, state);

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

    while (!handle.isDead()) {
      // Retrying REST reconciliation forever against an expired session is pointless the same way
      // retrying a doomed pick is — throw out to streamLiveDraftRoom's reconnect-with-backoff
      // rather than spinning here until the outer WS_DEAD_GRACE_MS watchdog eventually notices.
      if (state.sessionExpiredError) {
        throw state.sessionExpiredError;
      }
      await session.page.waitForTimeout(5000);
    }
    logger.warn(
      "[Draft Sync] Connection appears dead, will attempt to reconnect.",
    );
  } finally {
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (domObserver) domObserver.stop();
    if (session.browser) {
      await session.browser.close();
    }
  }
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

  const state = {
    lastPickNumber: null,
    pickCounter: 0,
    leagueId: null,
    seasonId: null,
    teamId: null,
    ready: false,
    pendingFrames: [],
    // Shared across reconnects on purpose: the ledger is what stops a reconnect from re-publishing
    // the entire board as brand-new picks. It's only reset when the LEAGUE changes (a fresh
    // practice draft), which connectAndStream handles.
    ledger: new DraftPickLedger(),
    health: createIngestHealth(),
    // Serializes ingest so evaluate -> write -> commit is atomic per pick (see withIngestLock).
    ingestChain: Promise.resolve(),
  };
  let attempt = 0;

  try {
    while (attempt < MAX_RECONNECT_ATTEMPTS) {
      try {
        await connectAndStream(redisClient, state);
        attempt = 0; // Clean disconnect/reconnect cycle, not a failure — reset backoff.
      } catch (error) {
        attempt += 1;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        logger.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${delay}ms...`,
          { err: error, attempt },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Exceeded max reconnect attempts for live draft stream.");
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
  withInstrumentation(
    "draft_sync",
    { trackingId: require("crypto").randomUUID() },
    streamLiveDraftRoom,
  ).catch(async () => {
    // withInstrumentation's own catch has already recorded the span/execution_log failure by
    // the time this runs -- only flushing and exiting is left to do. In a try/finally because
    // shutdown() can itself reject.
    const { sdk } = require("../telemetry/init");
    try {
      await sdk.shutdown();
    } finally {
      process.exit(1);
    }
  });
}

module.exports = {
  streamLiveDraftRoom,
  parseSelectedFrame,
  buildDraftUrl,
  buildDraftDetailUrl,
  fetchDraftDetail,
  ingestPickEvent,
  assignPickNumber,
  handleDomRecords,
  seedLedgerFromBoard,
  createIngestHealth,
  emitHealthHeartbeat,
};
