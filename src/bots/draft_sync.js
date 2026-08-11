const { createAuthenticatedSession } = require("./auth");
const { startFreshPracticeDraft, parseDraftRoomUrl } = require("./mock_draft");
const redis = require("redis");

const REDIS_HOST = process.env.REDIS_HOST || "fantasy-cache.default.svc.cluster.local";
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
 *
 * DRAFT_MODE=mock (for local/k8s test runs only — never set this against the real draft): instead
 * of navigating straight to ESPN_LEAGUE_ID, joins a fresh ESPN practice draft from the mock draft
 * lobby (see mock_draft.js) and derives leagueId/seasonId/teamId from wherever that lands, since
 * practice draft league IDs are ephemeral and can't be known ahead of time.
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

async function publishPickEvent(redisClient, event, state) {
  if (state.lastPickNumber != null && event.pick_number <= state.lastPickNumber) {
    return; // Already published (or superseded) this pick — REST reconciliation re-sends old picks.
  }
  if (state.lastPickNumber != null && event.pick_number !== state.lastPickNumber + 1) {
    console.warn(
      `[Draft Sync] Pick sequence gap: last published ${state.lastPickNumber}, got ${event.pick_number}.`
    );
  }
  state.lastPickNumber = event.pick_number;

  const payload = JSON.stringify(event);

  await redisClient.publish("draft_picks", payload);
  await redisClient.xAdd(`draft_picks:${state.leagueId}`, "*", { payload });
  await redisClient.hSet(`draft:${state.leagueId}:board`, String(event.pick_number), payload);

  console.log(
    `[Draft Sync] Published pick #${event.pick_number} (${event.source}): player ${event.player_id} -> team ${event.team_id}`
  );
}

/** One-time/periodic authoritative fetch — returns the sorted list of already-made picks. */
async function fetchDraftDetail(context, state) {
  const response = await context.request.get(buildDraftDetailUrl(state.leagueId, state.seasonId));
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

/** Attaches WS + a dead-session watchdog to the page. Returns a handle exposing isDead(). */
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
        console.error(`[Draft Sync] Failed to publish WS pick event: ${err.message}`);
      }
    });

    ws.on("close", () => {
      openSockets = Math.max(0, openSockets - 1);
      console.warn(`[Draft Sync] WebSocket closed: ${ws.url()}`);
    });
  });

  return {
    isDead: () => openSockets === 0 && Date.now() - lastActivityAt > WS_DEAD_GRACE_MS,
  };
}

/** Gets us into a draft room and returns { leagueId, seasonId, teamId }, however DRAFT_MODE dictates. */
async function enterDraftRoom(session) {
  if (process.env.DRAFT_MODE === "mock") {
    console.log("[Draft Sync] DRAFT_MODE=mock — joining a fresh practice draft from the lobby...");
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
    throw new Error(`Could not determine league/season from draft room URL: ${session.page.url()}`);
  }
  return { leagueId, seasonId, teamId };
}

async function connectAndStream(redisClient, state) {
  const session = await createAuthenticatedSession();
  let reconcileInterval;
  try {
    // Attach listeners before navigating so we don't race the page's own WebSocket connect.
    const handle = attachDraftListeners(session.page, redisClient, state);

    const draftContext = await enterDraftRoom(session);
    state.leagueId = draftContext.leagueId;
    state.seasonId = draftContext.seasonId;
    state.teamId = draftContext.teamId;

    // Seed/backfill from the authoritative snapshot, so a worker (re)starting mid-draft doesn't
    // report a bogus pick counter or miss earlier picks.
    await reconcileFromRest(session.context, redisClient, state);
    state.pickCounter = state.lastPickNumber ?? 0;

    reconcileInterval = setInterval(() => {
      reconcileFromRest(session.context, redisClient, state);
    }, REST_RECONCILE_INTERVAL_MS);

    while (!handle.isDead()) {
      await session.page.waitForTimeout(5000);
    }
    console.warn("[Draft Sync] Connection appears dead, will attempt to reconnect.");
  } finally {
    if (reconcileInterval) clearInterval(reconcileInterval);
    if (session.browser) {
      await session.browser.close();
    }
  }
}

async function streamLiveDraftRoom() {
  console.log(`[Draft Sync] Booting live channel listener client. Connecting to Redis node at ${REDIS_HOST}...`);
  const redisClient = redis.createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
  await redisClient.connect();

  const state = { lastPickNumber: null, pickCounter: 0, leagueId: null, seasonId: null, teamId: null };
  let attempt = 0;

  try {
    while (attempt < MAX_RECONNECT_ATTEMPTS) {
      try {
        await connectAndStream(redisClient, state);
        attempt = 0; // Clean disconnect/reconnect cycle, not a failure — reset backoff.
      } catch (error) {
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        console.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Exceeded max reconnect attempts for live draft stream.");
  } catch (error) {
    console.error(`[Draft Sync] Live data sync loop crashed permanently: ${error.message}`);
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
};
