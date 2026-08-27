const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession, resolveEspnCookies } = require("./auth");
const { readDraftPicks } = require("./espn_api");
const { connectToDraftRoom } = require("./draft_room_socket");
const { clickPickViaDom } = require("./draft_room_dom");
const { assertCookieSessionValid } = require("./session_health");
const { PermanentError } = require("../errors");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");
const { recordDraftPickClick } = require("../db/execution_log");

/**
 * 1-Click Automated Draft Execution Bot (WORKER-06)
 *
 * Consumes `draft_targets` messages published by fantasy-core-pipeline's
 * `POST /v1/trigger/draft-pick` gateway (per CORE-08's update on issue #6):
 *
 *   { "tracking_id": "...", "team_id": "8", "player_id": "4360438", "name": "Breece Hall" }
 *
 * Does NOT click the draft room DOM (issue #6's original spec) — issue #14 found that pattern
 * (`tr[data-player-id]`) already dead on the roster page, and very likely dead here too. Also does
 * NOT submit via REST as the primary path, despite that being WORKER-03's fix for the same DOM
 * problem: picks go out as a `SELECT <playerId>` frame over the same raw WebSocket draft_sync.js
 * already reads `SELECTED` broadcasts from — confirmed end-to-end 2026-08-16 by running this exact
 * WS path (draft_room_socket.js) against a real practice draft (scripts/practice-draft-test.js),
 * not just observed in a browser. See draft_room_socket.js's header for the full protocol writeup.
 *
 * KNOWN GAP, not fixed here: `player_id` in the payload is Sleeper-namespaced (players.player_id
 * per core-pipeline's crosswalk), but every ESPN draft API — and this bot's own idempotency check
 * — is keyed on ESPN's native playerId. This code assumes payload.player_id is already an ESPN id
 * (matching draft_sync.js's own existing assumption for its picks), which will misfire until
 * core-pipeline exposes a Sleeper->ESPN lookup. Flagged for follow-up: request `position`/
 * `pro_team` be added to the draft_targets payload (CORE-08) so a name+position+team stopgap match
 * against ESPN's player pool is possible without a full crosswalk.
 *
 * Safety rails, mirroring lineup_bot.js:
 *   - DRY_RUN      — defaults to TRUE; only an explicit DRY_RUN=false attempts a live submission.
 *   - idempotency  — a player already drafted by our own team is treated as already satisfied.
 *   - conflict     — a player drafted by someone else is a PermanentError (retrying can't help).
 *   - failure capture — dump payload + last-known draft board to DEBUG_OUTPUT_DIR before rethrowing.
 *
 * Every real submission attempt (WS success, DOM fallback success, or a failure after either)
 * writes a `draft_pick_click` row to execution_log via recordDraftPickClick (#43) - so does a
 * DRY_RUN skip (status "skipped_dry_run"), so that mode is visible in
 * fantasy-core-pipeline's `/v1/draft/status`/`last_clicker_action` instead of only existing in
 * pod logs. An already-drafted no-op still writes nothing, since no target was ever assigned
 * for a real click.
 */

const DEBUG_DIR =
  process.env.DEBUG_OUTPUT_DIR ||
  path.join(__dirname, "..", "..", "recon-output");

// The real capture showed a SELECTED confirmation land ~0.2s after its SELECT — generous
// headroom over that before treating a live submission as unconfirmed.
const CONFIRM_TIMEOUT_MS = 5000;

/**
 * Small randomized delay applied only to setup steps (the draft-board read, opening the socket) —
 * never between deciding to pick and calling sendPick(), which stays immediate. A fixed-latency
 * bot firing every request at an identical cadence is its own signal; jittering the parts that
 * aren't racing the draft clock costs nothing against the 60-90s window.
 */
function jitter(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Live writes are OPT-IN, not opt-out — same reasoning as lineup_bot.js's resolveDryRun: the
 * production queue path sets no env var of its own, and an unset DRY_RUN must not mean "submit to
 * the live draft."
 *
 * `mode` is the practice/live tag fantasy-core-pipeline already stamps on every draft_targets
 * message (sourced from the listener Job's own `mode=practice`/`mode=live` label — never
 * inferred here). Only an *unset* DRY_RUN is mode-aware: `mode === "practice"` flips that one
 * case to submit for real, since a practice room is consequence-free and the whole point of
 * this bot silently no-op'ing there is lost observability, not safety. An explicit DRY_RUN
 * env var — true or false — always wins over mode, live or practice, so an operator's
 * explicit intent is never second-guessed.
 */
function resolveDryRun(mode) {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return { dryRun: mode !== "practice", defaulted: true };
  return { dryRun: !/^(0|false|no)$/i.test(raw), defaulted: false };
}

function requirePlayerId(raw, tracking) {
  const id = String(raw ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new PermanentError(
      `[Draft Clicker][${tracking}] payload.player_id "${raw}" is not a valid numeric id.`,
    );
  }
  return id;
}

/**
 * team_id gets interpolated directly into the hand-built JOIN query string
 * (draft_room_socket.js's buildDraftSocketUrl) — an unvalidated value could both alter that query
 * (e.g. an embedded `&`) and, being non-numeric, can never match anything ESPN accepts, so this is
 * a permanent payload error the same way an invalid player_id is, not a runtime failure to retry.
 */
function requireTeamId(raw, tracking) {
  const id = String(raw ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new PermanentError(
      `[Draft Clicker][${tracking}] payload.team_id "${raw}" is not a valid numeric id.`,
    );
  }
  return id;
}

/**
 * Checks the current draft board for this target: already ours (no-op, safe on redelivery),
 * taken by someone else (PermanentError, retrying can't help), or still open (proceed).
 */
function checkTarget(picks, playerId, teamId, tracking, log) {
  const existing = picks.find((pick) => String(pick.player_id) === playerId);
  if (!existing) return { alreadyDrafted: false };

  if (String(existing.team_id) === String(teamId)) {
    log(
      `Player ${playerId} already drafted by our team (pick #${existing.pick_number}) — no-op.`,
    );
    return { alreadyDrafted: true };
  }

  throw new PermanentError(
    `[Draft Clicker][${tracking}] Player ${playerId} was already drafted by team ${existing.team_id} ` +
      `(pick #${existing.pick_number}), not us (team ${teamId}). Target is gone; retrying can't help.`,
  );
}

/**
 * Resolves with the matching SELECTED event, or null if none arrives within timeoutMs. Rejects
 * with a PermanentError if the server sends an explicit ERROR frame first (confirmed 2026-08-17:
 * a rejected SELECT — e.g. targeting an already-drafted player — gets `ERROR <code> <message>`,
 * not silence). That's a definitive "this can never succeed," unlike a plain timeout, which is
 * ambiguous (could be a network blip) — the PermanentError distinction matters because
 * connection.js requeues an ordinary Error forever with no backoff.
 */
function waitForConfirmation(socket, playerId, teamId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.onSelected((event) => {
      if (
        String(event.player_id) === String(playerId) &&
        String(event.team_id) === String(teamId)
      ) {
        clearTimeout(timer);
        resolve(event);
      }
    });
    socket.onError((err) => {
      clearTimeout(timer);
      reject(
        new PermanentError(
          `[Draft Clicker] Pick for player ${playerId} rejected by server: ERROR ${err.code} ${err.message}`,
        ),
      );
    });
  });
}

function captureFailure(tracking, details) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(
      DEBUG_DIR,
      `draft-pick-fail-${tracking}-${stamp}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(details, null, 2));
    logger.error(
      `[Draft Clicker][${tracking}] Failure context written to: ${file}`,
    );
  } catch (captureError) {
    logger.error(
      `[Draft Clicker][${tracking}] Could not capture failure context: ${captureError.message}`,
      { err: captureError },
    );
  }
}

async function executeAutomatedDraftSelection(payload) {
  // Valid JSON can still parse to null/a non-object (e.g. the literal message body `null`, or an
  // array). Dereferencing payload.tracking_id below would then throw a plain TypeError — before
  // any PermanentError classification exists — which connection.js treats as transient and
  // requeues forever under its channel-wide prefetch(1), starving every consumer. Must be the
  // very first thing checked.
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new PermanentError(
      `[Draft Clicker] draft_targets payload is not an object: ${JSON.stringify(payload)}`,
    );
  }

  const tracking = payload.tracking_id || "no-tracking-id";
  const log = logger.info;

  const targetName = payload.name;
  // The message's own league_id (fantasy-core-pipeline already knows it and now includes it,
  // see routes.py's trigger_draft_pick) is preferred over ESPN_LEAGUE_ID: this pod's env var
  // is a single static value, so a shared/standing worker acting on a practice league's target
  // would otherwise silently read and click against whichever league ESPN_LEAGUE_ID happens to
  // point at instead — confirmed live during a practice run, where this logged the operator's
  // real live league id while actually processing a practice room's message. The env var
  // remains the fallback for the local/manual CLI entrypoint below, which has no payload.
  const leagueId = payload.league_id || process.env.ESPN_LEAGUE_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  const mode = payload.mode || null;

  if (!leagueId) {
    throw new PermanentError(
      `[Draft Clicker][${tracking}] Neither payload.league_id nor ESPN_LEAGUE_ID is set — cannot identify the league.`,
    );
  }
  const teamId = requireTeamId(payload.team_id, tracking);
  const playerId = requirePlayerId(payload.player_id, tracking);
  if (!targetName) {
    throw new PermanentError(
      `[Draft Clicker][${tracking}] Payload is missing name.`,
    );
  }

  const { dryRun, defaulted } = resolveDryRun(mode);
  log(
    `Target assigned: "${targetName}" (id ${playerId}) for team ${teamId} in league ${leagueId} ` +
      `(${seasonId})${dryRun ? " [DRY_RUN]" : ""}.`,
  );
  if (defaulted) {
    // resolveDryRun already flips this to FALSE for mode === "practice" - this log used to
    // unconditionally claim "defaulting to TRUE" regardless of which way it actually resolved,
    // which read as "nothing will happen" in every practice-run log right before a real
    // WS/DOM submission was attempted.
    log(
      dryRun
        ? "DRY_RUN is unset, defaulting to TRUE — no submission will be attempted. Set DRY_RUN=false to " +
            "submit for real."
        : `DRY_RUN is unset but mode is "practice", defaulting to FALSE — a live submission WILL be ` +
            "attempted. Set DRY_RUN=true to force a dry run.",
    );
  }

  let session = null;
  let picks = null;
  // Flips true only once a real WS/DOM submission is about to be attempted - a conflict
  // caught earlier (checkTarget: player already drafted by someone else) or any other
  // pre-submission error must NOT write a draft_pick_click row, since no click was ever
  // attempted for it.
  let submissionAttempted = false;
  try {
    session = await createAuthenticatedSession();

    // Pre-flight, right after the session exists and before ANY authenticated call — including
    // the draft-board read below. Checking after readDraftPicks would be too late: a stale-cookie
    // 401/403 there throws a plain "mDraftDetail fetch failed" error first, so this check would
    // never run and the failure would stay opaque (PR #42 review).
    await assertCookieSessionValid(session.context, { leagueId, seasonId });

    await jitter(150, 600);
    picks = await readDraftPicks(session.context, { leagueId, seasonId });
    log(`Draft board read: ${picks.length} pick(s) recorded so far.`);

    const { alreadyDrafted } = checkTarget(
      picks,
      playerId,
      teamId,
      tracking,
      log,
    );
    if (alreadyDrafted) return;

    if (dryRun) {
      log(
        `DRY_RUN set — would submit pick: player ${playerId} ("${targetName}") for team ${teamId}.`,
      );
      // Otherwise this is invisible outside raw pod logs: no draft_pick_click row means
      // fantasy-core-pipeline's /v1/draft/status (last_clicker_action) and /v1/draft/logs
      // show nothing happened at all, which is exactly what looked like a silent timeout
      // during a practice run where DRY_RUN defaulted true.
      await recordDraftPickClick({
        leagueId,
        season: seasonId,
        playerId,
        playerName: targetName,
        status: "skipped_dry_run",
      });
      return;
    }

    submissionAttempted = true;
    log("Connecting to draft room socket to submit pick...");
    await jitter(100, 400);
    const cookies = resolveEspnCookies();

    try {
      const socket = await connectToDraftRoom({
        leagueId,
        teamId,
        espnS2: cookies.espnS2,
        swid: cookies.swid,
      });
      try {
        // Registered before sending — the real capture showed a SELECTED confirmation land
        // ~0.2s after SELECT, so the listener must already be attached when the frame goes out.
        // No jitter between here and sendPick(): this is the one step that's actually racing the
        // draft clock, so it fires the instant the socket is ready.
        const confirmation = waitForConfirmation(
          socket,
          playerId,
          teamId,
          CONFIRM_TIMEOUT_MS,
        );
        socket.sendPick(playerId);
        const result = await confirmation;
        if (!result) {
          throw new Error(
            `No SELECTED confirmation for player ${playerId}/team ${teamId} within ${CONFIRM_TIMEOUT_MS}ms.`,
          );
        }
        log(
          `SUCCESS: Pick submitted and confirmed for ${targetName} (lineup slot ${result.lineup_slot_id}).`,
        );
        await recordDraftPickClick({
          leagueId,
          season: seasonId,
          playerId,
          playerName: targetName,
          // The SELECTED frame's third token is a lineup slot id, not a round (see
          // parseSelectedFrame). Passing it as roundNumber wrote slot ids into
          // execution_log.round_number; null is the honest value until a round is available.
          roundNumber: null,
          status: "success",
        });
      } finally {
        socket.close();
      }
    } catch (wsError) {
      // A PermanentError here means the server explicitly rejected the pick (ERROR frame) — a
      // definitive "this can never succeed," not an ambiguous timeout/connection failure. The DOM
      // fallback can't change that outcome (clicking a pick ESPN just rejected won't succeed
      // either), so skip straight to reporting it rather than wasting a fallback attempt.
      if (wsError.permanent) {
        throw wsError;
      }

      // Fallback tier only — never raced in parallel with the WS attempt above. sendPick's
      // selector is still unverified (draft_room_dom.js's header), so this is a last resort, not
      // an equal alternative; if it also throws, the original wsError is what gets reported (it's
      // the primary path and the more informative failure).
      log(
        `WS submission failed (${wsError.message}) — attempting DOM-click fallback...`,
      );

      // clickPickViaDom launches its own separate Chromium instance — close this one first rather
      // than running two at once. Under the 1200MiB pod limit that's real OOM risk, and this
      // session (opened only to read the draft board) has nothing left to do anyway.
      if (session && session.browser) {
        await session.browser.close();
        session.browser = null;
      }

      try {
        await clickPickViaDom({ leagueId, seasonId, teamId }, playerId);
        log(
          `SUCCESS (DOM fallback): pick submitted and confirmed for ${targetName}.`,
        );
        await recordDraftPickClick({
          leagueId,
          season: seasonId,
          playerId,
          playerName: targetName,
          status: "success",
        });
      } catch (domError) {
        log(`DOM fallback also failed: ${domError.message}`);
        throw wsError;
      }
    }
  } catch (error) {
    logger.error(
      `[Draft Clicker][${tracking}] Selection failed${error.permanent ? " (permanent)" : ""}: ${error.message}`,
      { err: error, permanent: error.permanent === true },
    );
    captureFailure(tracking, {
      tracking_id: tracking,
      league_id: leagueId,
      team_id: teamId,
      season_id: seasonId,
      player_id: playerId,
      name: targetName,
      dry_run: dryRun,
      permanent: error.permanent === true,
      draft_board: picks,
      err: error,
    });
    if (submissionAttempted) {
      await recordDraftPickClick({
        leagueId,
        season: seasonId,
        playerId,
        playerName: targetName,
        status: "failure",
        errorMessage: error.message,
      });
    }
    throw error;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

// Local/manual runs: node src/bots/draft_clicker.js '{"team_id":"8","player_id":"4360438","name":"Breece Hall"}'
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    logger.error(
      "Usage: node src/bots/draft_clicker.js '<draft_targets JSON payload>'\n" +
        "Example: DRY_RUN=true ESPN_LEAGUE_ID=1248158344 node src/bots/draft_clicker.js \\\n" +
        `  '{"team_id":"8","player_id":"4360438","name":"Breece Hall"}'`,
    );
    process.exit(1);
  }

  const payload = JSON.parse(raw);
  withInstrumentation(
    "draft_clicker",
    { trackingId: payload.tracking_id || require("crypto").randomUUID() },
    () => executeAutomatedDraftSelection(payload),
  ).catch(async (error) => {
    logger.error(`[Draft Clicker] Run failed: ${error.message}`, {
      err: error,
    });
    const { shutdownTelemetry } = require("../telemetry/init");
    try {
      await shutdownTelemetry();
    } finally {
      process.exit(1);
    }
  });
}

module.exports = { executeAutomatedDraftSelection };
