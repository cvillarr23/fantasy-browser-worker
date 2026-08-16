const { createAuthenticatedSession } = require("./auth");
const { startFreshPracticeDraft, parseDraftRoomUrl } = require("./mock_draft");
const redis = require("redis");

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

/**
 * Live Draft Room Network Interceptor Daemon
 *
 * Verified against a real ESPN mock/practice draft via src/bots/draft_recon.js on 2026-08-10
 * (see recon-output/websockets.jsonl, http-responses.jsonl for raw captures). Two data sources:
 *
 * 1. WebSocket (wss://fantasydraft.espn.com/game-1/league-{id}/JOIN?...), opened by the draft room
 *    page itself once loaded — NOT JSON. Plain space-delimited text frames, the relevant one being:
 *      SELECTED <teamId> <playerId> <round> [<memberId>]
 *    memberId is only present when a human (not autodraft) makes the pick. There's no overall pick
 *    number on this frame, only round — so it's used as a low-latency nudge with a locally-tracked
 *    running pick counter, not as the source of truth for pick_number.
 *
 * 2. REST (https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/
 *    leagues/{id}?view=mDraftDetail), which returns draftDetail.picks[] — the full, authoritative
 *    draft board including overallPickNumber, roundId, roundPickNumber, teamId, playerId (-1 for
 *    not-yet-drafted slots). Polled on startup (to seed/backfill state for a worker joining
 *    mid-draft) and periodically thereafter to reconcile/correct anything the WebSocket missed.
 *    REST always wins on conflict — it's authoritative; WS is just the low-latency nudge.
 *
 * DRAFT_ROOM_URL (for local/k8s test runs only — never set this against the real draft): navigates
 * directly to a specific, already-open draft room URL instead of building one or joining fresh.
 * Needed because DRAFT_MODE=mock's auto-join doesn't work headlessly — ESPN's mock lobby has no
 * anonymous "instant start": the "League Specific Practice Draft" button (the closest thing to
 * one) triggers a DisneyID identity-verification flow gated by the same invisible reCAPTCHA
 * Enterprise that blocks automated login, confirmed via live debugging on 2026-08-10. So for
 * testing, join/create a mock draft yourself in a real browser and pass its URL here. Takes
 * priority over DRAFT_MODE=mock if both are set.
 *
 * DRAFT_MODE=mock is left in place (mock_draft.js) in case a future recon finds an unrestricted
 * join path (e.g. one of the pre-scheduled public room links, untested), but don't rely on it now.
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
 * REST events are authoritative and always win; a WS-derived event never overwrites whatever's
 * already recorded for that pick_number (it can only fill an empty slot), since WS has no true
 * overall pick number of its own — it's a locally-computed guess that a missed frame can throw
 * off, and only REST's next reconciliation pass can actually correct that.
 */
async function publishPickEvent(redisClient, event, state) {
  const boardKey = `draft:${state.leagueId}:board`;
  const existingRaw = await redisClient.hGet(
    boardKey,
    String(event.pick_number),
  );

  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    const alreadyCorrect =
      existing.player_id === event.player_id &&
      existing.team_id === event.team_id;
    if (event.source !== "rest" || alreadyCorrect) {
      return;
    }
    console.warn(
      `[Draft Sync] Correcting pick #${event.pick_number} from REST (was ${JSON.stringify(existing)}, now ${JSON.stringify(event)})`,
    );
  }

  const payload = JSON.stringify(event);
  await redisClient
    .multi()
    .xAdd(`draft_picks:${state.leagueId}`, "*", { payload })
    .hSet(boardKey, String(event.pick_number), payload)
    .exec();
  await redisClient.publish("draft_picks", payload);

  // Only advance in-memory state once the durable writes above have actually succeeded — if they
  // threw, this line never runs, so a retry (WS re-delivery or the next REST poll) naturally
  // reattempts instead of the pick being silently treated as already handled.
  if (
    state.lastPickNumber == null ||
    event.pick_number > state.lastPickNumber
  ) {
    state.lastPickNumber = event.pick_number;
  }

  console.log(
    `[Draft Sync] Published pick #${event.pick_number} (${event.source}): player ${event.player_id} -> team ${event.team_id}`,
  );
}

/** One-time/periodic authoritative fetch — returns the sorted list of already-made picks. */
async function fetchDraftDetail(context, state) {
  const response = await context.request.get(
    buildDraftDetailUrl(state.leagueId, state.seasonId),
  );
  if (!response.ok()) {
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
    for (const event of picks) {
      await publishPickEvent(redisClient, event, state);
    }
  } catch (err) {
    console.error(`[Draft Sync] REST reconciliation failed: ${err.message}`);
  }
}

async function handleSelectedFrame(parsed, redisClient, state) {
  state.pickCounter += 1;
  const event = {
    league_id: state.leagueId,
    player_id: parsed.player_id,
    pick_number: state.pickCounter,
    team_id: parsed.team_id,
    round: parsed.round,
    source: "ws",
    timestamp: new Date().toISOString(),
  };
  try {
    await publishPickEvent(redisClient, event, state);
  } catch (err) {
    console.error(
      `[Draft Sync] Failed to publish WS pick event: ${err.message}`,
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
 */
function attachDraftListeners(page, redisClient, state) {
  let openSockets = 0;
  let lastActivityAt = Date.now();

  page.on("websocket", (ws) => {
    console.log(`[Draft Sync] WebSocket opened: ${ws.url()}`);
    openSockets += 1;
    lastActivityAt = Date.now();

    ws.on("framereceived", async (frame) => {
      lastActivityAt = Date.now();
      const parsed = parseSelectedFrame(frame.payload);
      if (!parsed) return;

      if (!state.ready) {
        state.pendingFrames.push(parsed);
        return;
      }
      await handleSelectedFrame(parsed, redisClient, state);
    });

    ws.on("close", () => {
      openSockets = Math.max(0, openSockets - 1);
      console.warn(`[Draft Sync] WebSocket closed: ${ws.url()}`);
    });
  });

  return {
    isDead: () =>
      openSockets === 0 && Date.now() - lastActivityAt > WS_DEAD_GRACE_MS,
  };
}

/** Gets us into a draft room and returns { leagueId, seasonId, teamId }, however DRAFT_MODE dictates. */
async function enterDraftRoom(session) {
  if (process.env.DRAFT_ROOM_URL) {
    console.log(
      `[Draft Sync] DRAFT_ROOM_URL set — navigating directly: ${process.env.DRAFT_ROOM_URL}`,
    );
    await session.page.goto(process.env.DRAFT_ROOM_URL, {
      waitUntil: "load",
      timeout: 60000,
    });
  } else if (process.env.DRAFT_MODE === "mock") {
    console.log(
      "[Draft Sync] DRAFT_MODE=mock — joining a fresh practice draft from the lobby...",
    );
    await startFreshPracticeDraft(session.page);
  } else {
    const leagueId = process.env.ESPN_LEAGUE_ID;
    const seasonId = process.env.CURRENT_YEAR || "2026";
    const teamId = process.env.ESPN_TEAM_ID;
    const draftUrl = buildDraftUrl(leagueId, seasonId, teamId, session.swid);
    console.log(`[Draft Sync] Navigating to live draft room: ${draftUrl}`);
    await session.page.goto(draftUrl, { waitUntil: "load", timeout: 60000 });
  }

  const { leagueId, seasonId, teamId } = parseDraftRoomUrl(session.page.url());
  if (!leagueId || !seasonId) {
    throw new Error(
      `Could not determine league/season from draft room URL: ${session.page.url()}`,
    );
  }
  return { leagueId, seasonId, teamId };
}

async function connectAndStream(redisClient, state) {
  const session = await createAuthenticatedSession();
  let reconcileInterval;
  state.ready = false;
  state.pendingFrames = [];

  try {
    // Attach listeners before navigating so we don't race the page's own WebSocket connect.
    const handle = attachDraftListeners(session.page, redisClient, state);

    const draftContext = await enterDraftRoom(session);

    // DRAFT_MODE=mock joins a brand-new ephemeral league on every reconnect — carrying over the
    // previous draft's counters would misnumber (or skip) every pick in the new one.
    if (state.leagueId && state.leagueId !== draftContext.leagueId) {
      console.log(
        `[Draft Sync] League changed (${state.leagueId} -> ${draftContext.leagueId}), resetting pick counters.`,
      );
      state.lastPickNumber = null;
      state.pickCounter = 0;
    }
    state.leagueId = draftContext.leagueId;
    state.seasonId = draftContext.seasonId;
    state.teamId = draftContext.teamId;

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

    reconcileInterval = setInterval(() => {
      reconcileFromRest(session.context, redisClient, state);
    }, REST_RECONCILE_INTERVAL_MS);

    while (!handle.isDead()) {
      await session.page.waitForTimeout(5000);
    }
    console.warn(
      "[Draft Sync] Connection appears dead, will attempt to reconnect.",
    );
  } finally {
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (session.browser) {
      await session.browser.close();
    }
  }
}

async function streamLiveDraftRoom() {
  console.log(
    `[Draft Sync] Booting live channel listener client. Connecting to Redis node at ${REDIS_HOST}...`,
  );
  const redisClient = redis.createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
  });
  // Without this, an unhandled 'error' event (Node Redis emits connection errors through the
  // EventEmitter) would crash the process outright instead of letting the client's own
  // reconnect strategy recover.
  redisClient.on("error", (err) =>
    console.error(`[Draft Sync] Redis client error: ${err.message}`),
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
        console.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Exceeded max reconnect attempts for live draft stream.");
  } catch (error) {
    console.error(
      `[Draft Sync] Live data sync loop crashed permanently: ${error.message}`,
    );
    process.exit(1);
  } finally {
    await redisClient.quit();
  }
}

if (require.main === module) {
  streamLiveDraftRoom();
}

module.exports = {
  streamLiveDraftRoom,
  parseSelectedFrame,
  buildDraftUrl,
  buildDraftDetailUrl,
  fetchDraftDetail,
};
