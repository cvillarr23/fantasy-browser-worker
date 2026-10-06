const activity = require("../db/activity");
const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession } = require("./auth");
const { readRoster, submitLineup } = require("./espn_api");
const { PermanentError } = require("../errors");
const slotConfig = require("../selectors/lineup_slots.json");
const { logger } = require("../telemetry/logger");
const { updateContext } = require("../telemetry/context");
const { withInstrumentation } = require("../telemetry/instrument");

/**
 * Lineup Realignment Automation Bot (WORKER-03)
 *
 * Consumes `lineup_updates` messages published by fantasy-core-pipeline's
 * `POST /trigger/lineup` gateway (src/api/routes.py, LineupTriggerPayload):
 *
 *   { "tracking_id": "...", "team_id": "8",
 *     "optimized_swaps": [ { "drop_player_id": "...", "add_player_id": "...", "slot": "FLEX" } ] }
 *
 * Per that producer's own field descriptions, `drop_player_id` is demoted to the bench and
 * `add_player_id` is elevated into `slot` — so each swap becomes two LINEUP items in one
 * transaction.
 *
 * A swap may instead carry a `kind` that moves one player into or out of IR (lineupSlotId 21):
 *
 *   { "kind": "ir",          "player_id": "...", "slot": "IR" }
 *   { "kind": "activate_ir", "player_id": "...", "slot": "BENCH" }
 *
 * Each is a single LINEUP item with nobody promoted. An entry with no `kind` is `"swap"`.
 *
 * Executes via ESPN's authenticated REST API rather than by clicking the roster page. See
 * espn_api.js's header for why: the roster DOM carries no per-player identifier whatsoever, only a
 * positional `data-idx`, which WORKER-03 explicitly forbids depending on.
 *
 * Safety rails, all on by default:
 *   - DRY_RUN        — defaults to FALSE (live writes) now that #15's write shape is verified;
 *                      set DRY_RUN=true to plan without submitting.
 *   - idempotency    — swaps already satisfied are dropped; a requeued message can't double-apply.
 *   - verification   — after submitting, re-read the roster and assert every player actually landed.
 *   - failure capture — dump roster state + a screenshot to DEBUG_OUTPUT_DIR before rethrowing.
 */

const DEBUG_DIR =
  process.env.DEBUG_OUTPUT_DIR ||
  path.join(__dirname, "..", "..", "recon-output");

// Bounded poll rather than a fixed sleep: REST is authoritative and usually reflects the write
// immediately, so this normally exits on the first read.
const VERIFY_ATTEMPTS = 4;
const VERIFY_DELAY_MS = 1000;

const BENCH_SLOT_ID = slotConfig.bench_slot_id;
const IR_SLOT_ID = slotConfig.slot_ids.IR;

// ESPN injuryStatus values that may sit in IR. ESPN's default rule, which core's
// ir_eligibility.py also assumes; UNCONFIRMED for this league until a live slot-21 capture.
const IR_ELIGIBLE_INJURY_STATUSES = new Set(["OUT", "INJURY_RESERVE"]);

// `optimized_swaps[].kind`. An entry without one is a bench + promote swap.
const SWAP_KIND = "swap";
const IR_KIND = "ir";
const ACTIVATE_IR_KIND = "activate_ir";

/**
 * Live writes are the default.
 *
 * submitLineup()'s request body was confirmed against a real capture and live-tested end-to-end
 * (2026-09-12, see espn_api.js and issue #15) — an unset DRY_RUN now means "write for real," matching
 * the production queue path's own lack of an env var. Set DRY_RUN=true explicitly to plan without
 * submitting.
 */
function resolveDryRun() {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return { dryRun: false, defaulted: true };
  return { dryRun: !/^(0|false|no)$/i.test(raw), defaulted: false };
}

/**
 * Maps a payload slot string to an ESPN lineupSlotId.
 *
 * The producer emits display names like "RB1"/"WR2"/"FLEX". Ordinal suffixes are not distinct
 * ESPN slots — "RB1" and "RB2" are both lineupSlotId 2, a slot that simply has two positions — so
 * the suffix is stripped before lookup. See src/selectors/lineup_slots.json.
 */
function resolveSlotId(slot) {
  if (slot === undefined || slot === null) {
    throw new PermanentError("Swap is missing its target `slot`.");
  }

  const normalized = String(slot).trim().toUpperCase().replace(/\s+/g, "");
  // Strip a trailing ordinal ("RB1" -> "RB"), but never turn "D/ST" into "D/ST" minus something.
  const base = normalized.replace(/\d+$/, "");
  const slotId = slotConfig.slot_ids[normalized] ?? slotConfig.slot_ids[base];

  if (slotId === undefined) {
    throw new PermanentError(
      `Unrecognized lineup slot "${slot}". Known slots: ${Object.keys(slotConfig.slot_ids).join(", ")}`,
    );
  }
  return slotId;
}

function describeSlot(slotId) {
  return `${slotConfig.slot_names[String(slotId)] || "?"}(${slotId})`;
}

/**
 * ESPN player ids are integers; anything else would serialize to a null playerId in the request.
 * A team defense (D/ST) has a NEGATIVE id, one per NFL team (Team 8's Eagles D/ST is -16021), and
 * readRoster keys it by that signed id as a string, so a leading minus is allowed (#116). "-0" and
 * other zero-padded negatives are rejected: Number("-0") would go out as playerId 0.
 */
function requirePlayerId(raw, label, index) {
  const id = String(raw ?? "").trim();
  if (!/^(?:\d+|-[1-9]\d*)$/.test(id)) {
    throw new PermanentError(
      `Swap #${index + 1}: ${label} "${raw}" is not a valid numeric ESPN player id.`,
    );
  }
  return id;
}

/**
 * Turns the payload's swaps into a flat list of LINEUP items.
 *
 * Three things here are subtler than they look:
 *
 * 1. Moves are planned against a *working copy* of the roster that is mutated as each item is
 *    added, not against the original snapshot. Otherwise a payload whose second swap touches a
 *    player the first swap already moved emits a stale fromLineupSlotId, and the second swap
 *    silently undoes the first.
 * 2. Filtering is per-player, not per-swap. Checking only "add is in the target AND drop is on the
 *    bench" leaves the half-satisfied case emitting a from==to self-move, which is the exact state
 *    a partially-applied transaction redelivers in.
 * 3. Slot capacity is enforced. Because `drop` goes to the bench rather than into the vacated slot,
 *    every swap where drop isn't already in the target slot is a net +1 into it — two swaps into a
 *    1-deep FLEX would otherwise be submitted and rejected (or half-applied) by ESPN.
 *
 * An entry with `kind: "ir"` or `kind: "activate_ir"` moves ONE player (`player_id`) into or out of
 * IR, with nobody promoted, and goes in the same ROSTER transaction as any swaps.
 *
 * Everything rejected here is a PermanentError: none of it can come good on redelivery.
 */
function planSwaps(swaps, roster, log) {
  if (!Array.isArray(swaps)) {
    throw new PermanentError(
      `optimized_swaps must be an array, got ${typeof swaps}.`,
    );
  }

  const items = [];
  const intended = new Map(); // playerId -> expected lineupSlotId, used by verification
  const seen = new Map(); // playerId -> swap index, to reject a player appearing in two swaps
  const current = new Map(roster.slotByPlayerId); // working copy, mutated as moves are planned
  let skipped = 0;

  const claimPlayer = (id, label, index) => {
    if (seen.has(id)) {
      throw new PermanentError(
        `Swap #${index + 1}: player ${id} (${label}) already appears in swap #${seen.get(id) + 1}. ` +
          "Chained swaps over the same player are ambiguous; the producer should collapse them.",
      );
    }
    seen.set(id, index);
  };

  const currentSlotOf = (id, label, index) => {
    const slotId = current.get(id);
    if (slotId === undefined) {
      throw new PermanentError(
        `Swap #${index + 1}: player ${id} (${label}) is not on team's roster.`,
      );
    }
    return slotId;
  };

  for (const [index, swap] of swaps.entries()) {
    const kind = swap.kind ?? SWAP_KIND;
    const planEntry = PLANNERS_BY_KIND[kind];
    if (!planEntry) {
      throw new PermanentError(
        `Swap #${index + 1}: unknown kind "${kind}". Expected one of: ` +
          `${Object.keys(PLANNERS_BY_KIND).join(", ")}.`,
      );
    }
    const plan = planEntry(kind, swap, index, roster, { claimPlayer, currentSlotOf });

    // Every half already holds — nothing to do. This is what makes a redelivered message a no-op.
    if (plan.moves.length === 0) {
      log(`Swap #${index + 1} already satisfied (${plan.satisfied}), skipping.`);
      skipped += 1;
      continue;
    }

    for (const move of plan.moves) {
      log(
        `Swap #${index + 1}: ${move.id} ${describeSlot(move.from)} -> ${describeSlot(move.to)}`,
      );
      items.push({
        playerId: Number(move.id),
        type: "LINEUP",
        fromLineupSlotId: move.from,
        toLineupSlotId: move.to,
      });
      current.set(move.id, move.to);
    }

    // Record the full intended end state, including any half that was already correct, so
    // verification confirms the whole swap rather than only the part that moved.
    for (const [id, slotId] of plan.endState) intended.set(id, slotId);
  }

  assertSlotCapacity(items, current, roster.slotCounts);

  // Capacity is checked on the end state, but ESPN may apply items in order. Moving players out of
  // IR first means an `ir` entry listed before the `activate_ir` that frees its spot never puts two
  // players in a 1-deep IR partway through. Leaving IR only ever lands in a slot with room (the
  // check above), so this can't overfill anything else.
  const leavesIr = (item) => item.fromLineupSlotId === IR_SLOT_ID;
  const ordered = [...items.filter(leavesIr), ...items.filter((item) => !leavesIr(item))];

  return { items: ordered, intended, skipped };
}

/** lineup_slots.json is a documented reference; the league's live settings are the truth. */
function requireFieldedSlot(index, slot, slotId, slotCounts) {
  const liveCount = slotCounts[String(slotId)];
  if (!liveCount) {
    throw new PermanentError(
      `Swap #${index + 1}: slot "${slot}" resolves to ${describeSlot(slotId)}, which ` +
        `this league does not field (lineupSlotCounts has ${liveCount === 0 ? "0" : "no entry"} ` +
        "for it). Producer and league settings disagree.",
    );
  }
}

/** A `kind: "swap"` entry: `drop_player_id` to the bench, `add_player_id` into `slot`. */
function planBenchAndPromote(_kind, swap, index, roster, { claimPlayer, currentSlotOf }) {
  const dropId = requirePlayerId(swap.drop_player_id, "drop_player_id", index);
  const addId = requirePlayerId(swap.add_player_id, "add_player_id", index);
  const targetSlotId = resolveSlotId(swap.slot);

  if (dropId === addId) {
    throw new PermanentError(
      `Swap #${index + 1}: drop_player_id and add_player_id are both ${addId} — a player cannot ` +
        "be benched and promoted in the same swap.",
    );
  }
  claimPlayer(dropId, "drop", index);
  claimPlayer(addId, "add", index);
  requireFieldedSlot(index, swap.slot, targetSlotId, roster.slotCounts);

  const dropFrom = currentSlotOf(dropId, "drop", index);
  const addFrom = currentSlotOf(addId, "add", index);

  // Demote before promoting, so the target slot is free by the time the promotion lands.
  const moves = [];
  if (dropFrom !== BENCH_SLOT_ID)
    moves.push({ id: dropId, from: dropFrom, to: BENCH_SLOT_ID });
  if (addFrom !== targetSlotId)
    moves.push({ id: addId, from: addFrom, to: targetSlotId });

  return {
    moves,
    endState: [
      [addId, targetSlotId],
      [dropId, BENCH_SLOT_ID],
    ],
    satisfied: `${addId} in ${describeSlot(targetSlotId)}`,
  };
}

/**
 * A `kind: "ir"` entry moves `player_id` from wherever they are into IR; `kind: "activate_ir"`
 * moves them from IR into `slot` (normally BENCH). A starter moved to IR leaves their starting
 * slot empty: filling it is the producer's job, as an ordinary swap in a later message.
 */
function planIrMove(kind, swap, index, roster, { claimPlayer, currentSlotOf }) {
  const playerId = requirePlayerId(swap.player_id, "player_id", index);
  const targetSlotId = resolveSlotId(swap.slot);

  if (kind === IR_KIND && targetSlotId !== IR_SLOT_ID) {
    throw new PermanentError(
      `Swap #${index + 1}: kind "${IR_KIND}" must target slot IR, got "${swap.slot}".`,
    );
  }
  if (kind === ACTIVATE_IR_KIND && targetSlotId === IR_SLOT_ID) {
    throw new PermanentError(
      `Swap #${index + 1}: kind "${ACTIVATE_IR_KIND}" moves a player out of IR, so its slot ` +
        "cannot be IR.",
    );
  }
  claimPlayer(playerId, "player", index);
  requireFieldedSlot(index, swap.slot, targetSlotId, roster.slotCounts);

  const from = currentSlotOf(playerId, "player", index);
  const satisfied = `${playerId} in ${describeSlot(targetSlotId)}`;
  if (from === targetSlotId) return { moves: [], endState: [], satisfied };

  if (kind === IR_KIND) {
    // Checked here rather than left to ESPN so the failure says why. ESPN still has the final say.
    const status = roster.injuryStatusByPlayerId.get(playerId) ?? null;
    if (!IR_ELIGIBLE_INJURY_STATUSES.has(status)) {
      throw new PermanentError(
        `Swap #${index + 1}: player ${playerId} is not IR-eligible (ESPN injuryStatus ` +
          `${status ?? "not set"}; eligible: ${[...IR_ELIGIBLE_INJURY_STATUSES].join(", ")}).`,
      );
    }
  } else if (from !== IR_SLOT_ID) {
    throw new PermanentError(
      `Swap #${index + 1}: player ${playerId} is not in IR (found in ${describeSlot(from)}), so ` +
        "there is nothing to activate.",
    );
  }

  return {
    moves: [{ id: playerId, from, to: targetSlotId }],
    endState: [[playerId, targetSlotId]],
    satisfied,
  };
}

const PLANNERS_BY_KIND = {
  [SWAP_KIND]: planBenchAndPromote,
  [IR_KIND]: planIrMove,
  [ACTIVATE_IR_KIND]: planIrMove,
};

/** Rejects a plan that would overfill any slot it moves into. */
function assertSlotCapacity(items, finalRoster, slotCounts) {
  const targetSlots = new Set(items.map((item) => item.toLineupSlotId));
  const occupancy = new Map();
  for (const slotId of finalRoster.values()) {
    occupancy.set(slotId, (occupancy.get(slotId) || 0) + 1);
  }

  const overfilled = [];
  for (const slotId of targetSlots) {
    const capacity = slotCounts[String(slotId)] || 0;
    const used = occupancy.get(slotId) || 0;
    if (used > capacity) {
      overfilled.push(
        `${describeSlot(slotId)}: ${used} players for ${capacity} spot(s)`,
      );
    }
  }

  if (overfilled.length > 0) {
    throw new PermanentError(
      `Planned lineup overfills ${overfilled.length} slot(s) — ${overfilled.join("; ")}. ` +
        "ESPN would reject or half-apply this transaction.",
    );
  }
}

/** Re-reads the authoritative roster and asserts every intended move actually landed. */
async function verifyLineup(context, target, intended, log) {
  let mismatches = [];

  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const roster = await readRoster(context, target);
    mismatches = [];

    for (const [playerId, expectedSlotId] of intended) {
      const actual = roster.slotByPlayerId.get(playerId);
      if (actual !== expectedSlotId) {
        mismatches.push(
          `player ${playerId}: expected ${describeSlot(expectedSlotId)}, found ${
            actual === undefined ? "not on roster" : describeSlot(actual)
          }`,
        );
      }
    }

    if (mismatches.length === 0) {
      log(
        `Verification passed on attempt ${attempt}: all ${intended.size} placements confirmed.`,
      );
      return;
    }

    if (attempt < VERIFY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    }
  }

  throw new Error(
    `Post-submit verification failed after ${VERIFY_ATTEMPTS} attempts — ${mismatches.join("; ")}`,
  );
}

/**
 * Best-effort forensics before rethrowing; never allowed to mask the original error.
 *
 * Deliberately no screenshot: this bot drives the REST API and never navigates, so session.page is
 * always about:blank — an image of it would be pure noise. What actually helps when diagnosing a
 * failed transaction is the roster as read and the items that were planned from it.
 */
function captureFailure(tracking, details) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(DEBUG_DIR, `lineup-fail-${tracking}-${stamp}.json`);

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

async function executeLineupAdjustments(payload) {
  const tracking = payload.tracking_id || "no-tracking-id";
  const log = logger.info;

  const teamId = payload.team_id;
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  const swaps = payload.optimized_swaps ?? [];
  let roster = null;
  let planned = null;

  // All three are permanent: redelivering the same message against the same config cannot help.
  if (!leagueId) {
    throw new PermanentError(
      `[Lineup Bot][${tracking}] ESPN_LEAGUE_ID is not set — cannot identify which league to act on.`,
    );
  }
  if (teamId === undefined || teamId === null || teamId === "") {
    throw new PermanentError(
      `[Lineup Bot][${tracking}] Payload is missing team_id.`,
    );
  }
  if (!Array.isArray(swaps)) {
    throw new PermanentError(
      `[Lineup Bot][${tracking}] optimized_swaps must be an array, got ${typeof swaps}.`,
    );
  }
  if (swaps.length === 0) {
    log(`No transaction swaps specified for team ${teamId}. Nothing to do.`);
    return;
  }

  // Bound once here (mirroring connection.js's trackingId binding) so every subsequent log
  // line in this transaction carries league/team context automatically via pino's mixin.
  updateContext({ leagueId, teamId });

  const target = { leagueId, seasonId, teamId };
  const { dryRun, defaulted } = resolveDryRun();
  log(
    `Starting realignment for team ${teamId} in league ${leagueId} (${seasonId})${dryRun ? " [DRY_RUN]" : ""}.`,
  );
  if (defaulted) {
    // Say this loudly: someone expecting the old dry-by-default behavior deserves to see in the
    // logs that this message is about to write for real.
    log(
      "DRY_RUN is unset, defaulting to FALSE — this will submit for real. Set DRY_RUN=true to " +
        "plan without submitting.",
    );
  }

  let session = null;
  try {
    session = await createAuthenticatedSession();

    roster = await readRoster(session.context, target);
    log(
      `Roster read: ${roster.entryCount} players, scoringPeriodId ${roster.scoringPeriodId}.`,
    );

    // Permanent rather than retriable: a draft is days or weeks away, and hot-looping until then
    // would pin the queue. The producer can republish once there's a roster to realign.
    if (roster.entryCount === 0) {
      throw new PermanentError(
        `[Lineup Bot][${tracking}] Team ${teamId} has an empty roster — the draft likely hasn't ` +
          "happened yet, so there is nothing to realign.",
      );
    }

    planned = planSwaps(swaps, roster, log);
    const { items, intended, skipped } = planned;

    // Plan BEFORE checking the lock. If a submit succeeded but verification failed transiently, the
    // message gets requeued; should the lineup lock before redelivery, a lock-check-first ordering
    // would throw forever on work that is in fact already done — an infinite requeue loop that
    // blocks the whole queue under connection.js's prefetch(1). A retry with nothing left to do
    // must succeed.
    if (items.length === 0) {
      await activity.event(
        "verified_complete",
        { source: "ESPN roster; requested slots already satisfied" },
        "submitted",
        "verified_complete",
      );
      log(`All ${skipped} requested swap(s) already satisfied. No transaction submitted.`);
      return;
    }

    // Permanent: once games kick off the lock holds for hours and this week's optimization is moot.
    if (roster.lineupLocked || roster.rosterLocked) {
      throw new PermanentError(
        `[Lineup Bot][${tracking}] ESPN reports this lineup as locked ` +
          `(lineupLocked=${roster.lineupLocked}, rosterLocked=${roster.rosterLocked}) — games have ` +
          `started and the ${items.length} remaining change(s) will not be accepted.`,
      );
    }

    if (dryRun) {
      await activity.event("dry_run", {}, "skipped", "unknown");
      log(`DRY_RUN set — would submit ${items.length} item(s):\n${JSON.stringify(items, null, 2)}`);
      return;
    }

    log(
      `Submitting ${items.length} lineup item(s) across ${swaps.length - skipped} swap(s)...`,
    );
    await submitLineup(session.context, {
      ...target,
      memberId: session.swid,
      scoringPeriodId: roster.scoringPeriodId,
      items,
      trackingId: tracking,
    });
    log("Transaction accepted by ESPN. Verifying against a fresh roster read...");

    await activity.event(
      "submitted_to_espn",
      { items: Array.from(intended.entries()) },
      "submitted",
      "awaiting_processing",
    );
    await verifyLineup(session.context, target, intended, log);
    await activity.event(
      "verified_complete",
      { items: Array.from(intended.entries()), source: "ESPN roster slots" },
      "submitted",
      "verified_complete",
    );
    log("Lineup realignment complete and verified.");
  } catch (error) {
    logger.error(`Transaction failed${error.permanent ? " (permanent)" : ""}: ${error.message}`, {
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
      swaps,
      // The roster as read and the items planned from it — the two things needed to reconstruct
      // what the bot believed when it failed.
      roster_slots: roster ? Object.fromEntries(roster.slotByPlayerId) : null,
      slot_counts: roster ? roster.slotCounts : null,
      // IR eligibility is decided from these, so an IR rejection can be reconstructed. Guarded,
      // because building this object must not throw and mask the original error.
      roster_injury_status: roster?.injuryStatusByPlayerId
        ? Object.fromEntries(roster.injuryStatusByPlayerId)
        : null,
      planned_items: planned ? planned.items : null,
      err: error,
    });
    // Bubble up: connection.js requeues an ordinary Error, and discards a PermanentError.
    throw error;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
      log("Headless Chromium instance terminated.");
    }
  }
}

// Local/manual runs: node src/bots/lineup_bot.js '{"team_id":"8","optimized_swaps":[...]}'
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    logger.error(
      "Usage: node src/bots/lineup_bot.js '<lineup_updates JSON payload>'\n" +
        "Example: DRY_RUN=true ESPN_LEAGUE_ID=1248158344 node src/bots/lineup_bot.js \\\n" +
        `  '{"team_id":"8","optimized_swaps":[{"drop_player_id":"3139477","add_player_id":"4259545","slot":"FLEX"}]}'`,
    );
    process.exit(1);
  }

  const payload = JSON.parse(raw);
  withInstrumentation(
    "lineup_bot",
    { trackingId: payload.tracking_id || require("crypto").randomUUID() },
    () => executeLineupAdjustments(payload),
  ).catch(async (error) => {
    logger.error(`[Lineup Bot] Run failed: ${error.message}`, { err: error });
    const { shutdownTelemetry } = require("../telemetry/init");
    try {
      await shutdownTelemetry();
    } finally {
      process.exit(1);
    }
  });
}

module.exports = { executeLineupAdjustments, resolveSlotId, planSwaps };
