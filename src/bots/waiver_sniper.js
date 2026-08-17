const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession } = require("./auth");
const { readRoster, submitWaiverClaim } = require("./espn_api");
const { PermanentError } = require("../errors");

/**
 * High-Speed Waiver Sniper Bot (fix for #14)
 *
 * Was clicking a `tr[data-player-id="..."]` locator that can never match — ESPN's roster/free
 * -agent DOM exposes no per-player identifier at all (see espn_selectors.json's header and
 * src/bots/lineup_recon.js). Rewritten the same way WORKER-03/WORKER-06 fixed this exact problem
 * for lineup_bot.js/draft_clicker.js: drive ESPN's authenticated REST API via espn_api.js instead
 * of clicking anything. See submitWaiverClaim()'s own header for what is and isn't verified about
 * the request shape it sends.
 *
 * Safety rails, mirroring lineup_bot.js for the same reason (an unverified write shape must not
 * default to live):
 *   - DRY_RUN      — defaults to TRUE; only an explicit DRY_RUN=false submits anything.
 *   - idempotency  — a redelivered message that already landed (add already rostered, drop
 *                    already gone) is a no-op, not a duplicate claim.
 */

const DEBUG_DIR = process.env.DEBUG_OUTPUT_DIR || path.join(__dirname, "..", "..", "recon-output");

function resolveDryRun() {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return { dryRun: true, defaulted: true };
  return { dryRun: !/^(0|false|no)$/i.test(raw), defaulted: false };
}

/** ESPN player ids are numeric; anything else would serialize to a null playerId in the request. */
function requirePlayerId(raw, label) {
  const id = String(raw ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new PermanentError(`${label} "${raw}" is not a valid numeric ESPN player id.`);
  }
  return id;
}

function captureFailure(tracking, details) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(DEBUG_DIR, `waiver-fail-${tracking}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(details, null, 2));
    console.error(`[Sniper Bot][${tracking}] Failure context written to: ${file}`);
  } catch (captureError) {
    console.error(`[Sniper Bot][${tracking}] Could not capture failure context: ${captureError.message}`);
  }
}

async function executeInstantWaiverClaim(payload) {
  const tracking = payload.tracking_id || payload.player_id || "no-tracking-id";
  const log = (message) => console.log(`[Sniper Bot][${tracking}] ${message}`);

  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  const nameTarget = payload.name;
  const nflTeam = payload.team;

  // Permanent: none of these can come good on redelivery without a config/payload change.
  if (!leagueId) {
    throw new PermanentError(`[Sniper Bot][${tracking}] ESPN_LEAGUE_ID is not set.`);
  }
  if (!teamId) {
    throw new PermanentError(`[Sniper Bot][${tracking}] ESPN_TEAM_ID is not set.`);
  }
  const addPlayerId = requirePlayerId(payload.player_id, "player_id");
  const dropPlayerId = payload.drop_player_id ? requirePlayerId(payload.drop_player_id, "drop_player_id") : null;

  const target = { leagueId, seasonId, teamId };
  const { dryRun, defaulted } = resolveDryRun();
  log(
    `Evaluating claim for ${nameTarget || addPlayerId} (${nflTeam || "?"}) on team ${teamId}` +
      `${dryRun ? " [DRY_RUN]" : ""}.`
  );
  if (defaulted) {
    log(
      "DRY_RUN is unset, defaulting to TRUE — no changes will be written. Set DRY_RUN=false to " +
        "submit for real (only once submitWaiverClaim's write shape is verified, see espn_api.js)."
    );
  }

  let session = null;
  let roster = null;
  try {
    session = await createAuthenticatedSession();

    roster = await readRoster(session.context, target);

    // Idempotency: a redelivered claim whose add already landed (and whose drop, if any, already
    // left the roster) is fully satisfied already — resubmitting would be a duplicate transaction,
    // not a retry.
    const addSatisfied = roster.slotByPlayerId.has(addPlayerId);
    const dropSatisfied = !dropPlayerId || !roster.slotByPlayerId.has(dropPlayerId);
    if (addSatisfied && dropSatisfied) {
      log(`${addPlayerId} already on roster${dropPlayerId ? " and drop already applied" : ""}. No-op.`);
      return;
    }

    if (dropPlayerId && !roster.slotByPlayerId.has(dropPlayerId)) {
      throw new PermanentError(
        `[Sniper Bot][${tracking}] drop_player_id ${dropPlayerId} is not on team ${teamId}'s roster.`
      );
    }

    if (dryRun) {
      log(
        `DRY_RUN set — would submit add=${addPlayerId}${dropPlayerId ? ` drop=${dropPlayerId}` : ""} ` +
          `(scoringPeriodId ${roster.scoringPeriodId}).`
      );
      return;
    }

    log(`Submitting claim: add=${addPlayerId}${dropPlayerId ? ` drop=${dropPlayerId}` : ""}...`);
    await submitWaiverClaim(session.context, {
      ...target,
      memberId: session.swid,
      scoringPeriodId: roster.scoringPeriodId,
      addPlayerId,
      dropPlayerId,
    });

    // Best-effort only: if this league is mid-waiver-period, a genuine waiver claim (as opposed to
    // an immediate free-agent pickup) is queued and processed later — the roster read right after
    // submit legitimately won't show it yet. So this only confirms the fast path; it does not fail
    // the run when it can't.
    const confirmed = (await readRoster(session.context, target)).slotByPlayerId.has(addPlayerId);
    log(
      confirmed
        ? `Confirmed: ${addPlayerId} now on roster.`
        : `Submitted, but roster doesn't show ${addPlayerId} yet — likely a queued waiver claim ` +
            "rather than an immediate pickup; this does not mean it failed."
    );
  } catch (error) {
    console.error(
      `[Sniper Bot][${tracking}] Claim failed${error.permanent ? " (permanent)" : ""}: ${error.message}`
    );
    captureFailure(tracking, {
      tracking_id: tracking,
      league_id: leagueId,
      team_id: teamId,
      season_id: seasonId,
      dry_run: dryRun,
      permanent: error.permanent === true,
      add_player_id: addPlayerId,
      drop_player_id: dropPlayerId,
      roster_slots: roster ? Object.fromEntries(roster.slotByPlayerId) : null,
      error: error.message,
    });
    throw error;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
      log("Headless Chromium instance terminated.");
    }
  }
}

module.exports = { executeInstantWaiverClaim };
