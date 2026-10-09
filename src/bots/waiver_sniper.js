const activity = require("../db/activity");
const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession } = require("./auth");
const { readRoster, submitWaiverClaim } = require("./espn_api");
const { PermanentError, requirePlainObjectPayload } = require("../errors");
const { requirePlayerId } = require("../lib/espn_ids");
const { resolveDryRun: resolveEnvDryRun } = require("../lib/env");
const { logger } = require("../telemetry/logger");
const { updateContext } = require("../telemetry/context");

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
 *   - DRY_RUN      — defaults to TRUE; only an explicit DRY_RUN=false submits anything,
 *                    unless the message itself carries a boolean dry_run (see resolveDryRun).
 *   - idempotency  — a redelivered message that already landed (add already rostered, drop
 *                    already gone) is a no-op, not a duplicate claim.
 */

const DEBUG_DIR =
  process.env.DEBUG_OUTPUT_DIR ||
  path.join(__dirname, "..", "..", "recon-output");

/**
 * A boolean `dry_run` on the message wins over DRY_RUN: the web UI sends one explicitly so a
 * manager's own submission can go live while automated triggers (which omit it) keep the
 * env's opt-in default. Anything that isn't a real boolean is ignored rather than coerced.
 */
function resolveDryRun(payload) {
  if (typeof payload.dry_run === "boolean") {
    return { dryRun: payload.dry_run, defaulted: false };
  }
  return resolveEnvDryRun(true);
}

function captureFailure(tracking, details) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(DEBUG_DIR, `waiver-fail-${tracking}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(details, null, 2));
    logger.error(`Failure context written to: ${file}`);
  } catch (captureError) {
    logger.error(
      `Could not capture failure context: ${captureError.message}`,
      {
        err: captureError,
      },
    );
  }
}

async function executeInstantWaiverClaim(payload) {
  // A syntactically valid queue message can still be `null`, an array, or a bare scalar — none of
  // those are throwable as an ordinary Error here without the whole payload.xxx dereference below
  // throwing a plain TypeError instead, which connection.js requeues forever (only PermanentError
  // and the JSON-parse-failure case are treated as unretryable).
  requirePlainObjectPayload(payload, "[Sniper Bot]");

  const tracking = payload.tracking_id || payload.player_id || "no-tracking-id";
  const log = logger.info;

  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  const nameTarget = payload.name;
  const nflTeam = payload.team;

  // Permanent: none of these can come good on redelivery without a config/payload change.
  if (!leagueId) {
    throw new PermanentError(
      `[Sniper Bot][${tracking}] ESPN_LEAGUE_ID is not set.`,
    );
  }
  if (!teamId) {
    throw new PermanentError(
      `[Sniper Bot][${tracking}] ESPN_TEAM_ID is not set.`,
    );
  }
  // Bound once here (mirroring connection.js's trackingId binding) so every subsequent log
  // line in this transaction carries league/team context automatically via pino's mixin.
  updateContext({ leagueId, teamId });
  const addPlayerId = requirePlayerId(payload.player_id, "player_id");
  const dropPlayerId = payload.drop_player_id
    ? requirePlayerId(payload.drop_player_id, "drop_player_id")
    : null;
  if (dropPlayerId && dropPlayerId === addPlayerId) {
    throw new PermanentError(
      `[Sniper Bot][${tracking}] player_id and drop_player_id are both ${addPlayerId} — a player ` +
        "cannot be added and dropped in the same claim.",
    );
  }

  const target = { leagueId, seasonId, teamId };
  const { dryRun, defaulted } = resolveDryRun(payload);
  log(
    `Evaluating claim for ${nameTarget || addPlayerId} (${nflTeam || "?"}) on team ${teamId}` +
      `${dryRun ? " [DRY_RUN]" : ""}.`,
  );
  if (defaulted) {
    log(
      "DRY_RUN is unset, defaulting to TRUE — no changes will be written. Set DRY_RUN=false to " +
        "submit for real (only once submitWaiverClaim's write shape is verified, see espn_api.js).",
    );
  }

  let session = null;
  let roster = null;
  try {
    session = await createAuthenticatedSession();

    roster = await readRoster(session.context, target);

    // Idempotency: figure out which half(ves) of the claim still need submitting, rather than an
    // all-or-nothing check. A redelivered message can land between the two halves being satisfied
    // (e.g. the add already landed but the drop hasn't) — treating that as "needs everything" would
    // resubmit an ADD for a player already on the roster, which ESPN would reject or, worse, pair
    // with a DROP that then goes out alone against a since-changed roster. Only ever ask for the
    // piece that's still missing.
    //
    // KNOWN GAP: this only catches redelivery *after* the roster reflects a change. A genuine
    // in-window waiver claim (as opposed to an immediate pickup) is queued and doesn't land on the
    // roster until processed later — so a redelivery in that gap still looks unsatisfied here and
    // will resubmit. Closing that requires durable per-request tracking (a pending-transactions
    // table keyed by tracking_id), which doesn't exist yet; left as a follow-up rather than
    // guessed at here.
    const needsAdd = !roster.slotByPlayerId.has(addPlayerId);
    const needsDrop =
      Boolean(dropPlayerId) && roster.slotByPlayerId.has(dropPlayerId);

    if (!needsAdd && !needsDrop) {
      await activity.event(
        "verified_complete",
        { addPlayerId, dropPlayerId, source: "ESPN roster" },
        "submitted",
        "verified_complete",
      );
      log(
        `${addPlayerId} already on roster${dropPlayerId ? " and drop already applied" : ""}. No-op.`,
      );
      return;
    }

    // Only a problem when the add hasn't landed either — i.e. this looks like a fresh claim, not a
    // redelivery that already applied the drop. If the add already landed, a missing drop target is
    // just treated as already-satisfied above rather than as an error.
    if (dropPlayerId && needsAdd && !roster.slotByPlayerId.has(dropPlayerId)) {
      throw new PermanentError(
        `[Sniper Bot][${tracking}] drop_player_id ${dropPlayerId} is not on team ${teamId}'s roster.`,
      );
    }

    const describeItems = () =>
      `${needsAdd ? ` add=${addPlayerId}` : ""}${needsDrop ? ` drop=${dropPlayerId}` : ""}`;

    if (dryRun) {
      await activity.event("dry_run", { addPlayerId, dropPlayerId }, "skipped", "unknown");
      log(
        `DRY_RUN set — would submit${describeItems()} (scoringPeriodId ${roster.scoringPeriodId}).`,
      );
      return;
    }

    log(`Submitting claim:${describeItems()}...`);
    await activity.beforeExternalWrite();
    await submitWaiverClaim(session.context, {
      ...target,
      memberId: session.swid,
      scoringPeriodId: roster.scoringPeriodId,
      addPlayerId: needsAdd ? addPlayerId : null,
      dropPlayerId: needsDrop ? dropPlayerId : null,
      trackingId: tracking,
    });

    await activity.event(
      "submitted_to_espn",
      { addPlayerId, dropPlayerId },
      "submitted",
      "awaiting_processing",
    );

    // Best-effort only: if this league is mid-waiver-period, a genuine waiver claim (as opposed to
    // an immediate free-agent pickup) is queued and processed later — the roster read right after
    // submit legitimately won't show it yet. So this only confirms the fast path; it does not fail
    // the run when it can't.
    const confirmed = (await readRoster(session.context, target)).slotByPlayerId.has(addPlayerId);
    if (confirmed && !dropPlayerId)
      await activity.event(
        "verified_complete",
        { addPlayerId, source: "ESPN roster" },
        "submitted",
        "verified_complete",
      );
    log(
      confirmed
        ? `Confirmed: ${addPlayerId} now on roster.`
        : `Submitted, but roster doesn't show ${addPlayerId} yet — likely a queued waiver claim ` +
            "rather than an immediate pickup; this does not mean it failed.",
    );
  } catch (error) {
    logger.error(`Claim failed${error.permanent ? " (permanent)" : ""}: ${error.message}`, {
      err: error,
      permanent: error.permanent === true,
    });
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
      err: error,
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
