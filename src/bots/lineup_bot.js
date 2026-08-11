const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession } = require("./auth");
const { readRoster, submitLineup } = require("./espn_api");
const { PermanentError } = require("../errors");
const slotConfig = require("../selectors/lineup_slots.json");

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
 * Executes via ESPN's authenticated REST API rather than by clicking the roster page. See
 * espn_api.js's header for why: the roster DOM carries no per-player identifier whatsoever, only a
 * positional `data-idx`, which WORKER-03 explicitly forbids depending on.
 *
 * Safety rails, all on by default:
 *   - DRY_RUN        — defaults to TRUE; only an explicit DRY_RUN=false submits anything.
 *   - idempotency    — swaps already satisfied are dropped; a requeued message can't double-apply.
 *   - verification   — after submitting, re-read the roster and assert every player actually landed.
 *   - failure capture — dump roster state + a screenshot to DEBUG_OUTPUT_DIR before rethrowing.
 */

const DEBUG_DIR = process.env.DEBUG_OUTPUT_DIR || path.join(__dirname, "..", "..", "recon-output");

// Bounded poll rather than a fixed sleep: REST is authoritative and usually reflects the write
// immediately, so this normally exits on the first read.
const VERIFY_ATTEMPTS = 4;
const VERIFY_DELAY_MS = 1000;

/**
 * Live writes are OPT-IN, not opt-out.
 *
 * submitLineup()'s request body has never been confirmed against a real capture (see espn_api.js
 * and issue #15), so an unset DRY_RUN must not mean "write to the live lineup" — the production
 * queue path sets no env var of its own, and that default would have made every consumed message a
 * live, unverified transaction. Only an explicit DRY_RUN=false opts in.
 *
 * Flip this default once #15 closes and the write shape is verified.
 */
function resolveDryRun() {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return { dryRun: true, defaulted: true };
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
    throw new Error("Swap is missing its target `slot`.");
  }

  const normalized = String(slot).trim().toUpperCase().replace(/\s+/g, "");
  // Strip a trailing ordinal ("RB1" -> "RB"), but never turn "D/ST" into "D/ST" minus something.
  const base = normalized.replace(/\d+$/, "");
  const slotId = slotConfig.slot_ids[normalized] ?? slotConfig.slot_ids[base];

  if (slotId === undefined) {
    throw new Error(
      `Unrecognized lineup slot "${slot}". Known slots: ${Object.keys(slotConfig.slot_ids).join(", ")}`
    );
  }
  return slotId;
}

function describeSlot(slotId) {
  return `${slotConfig.slot_names[String(slotId)] || "?"}(${slotId})`;
}

/** ESPN player ids are numeric; anything else would serialize to a null playerId in the request. */
function requirePlayerId(raw, label, index) {
  const id = String(raw ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new PermanentError(
      `Swap #${index + 1}: ${label} "${raw}" is not a valid numeric ESPN player id.`
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
 * Everything rejected here is a PermanentError: none of it can come good on redelivery.
 */
function planSwaps(swaps, roster, log) {
  if (!Array.isArray(swaps)) {
    throw new PermanentError(`optimized_swaps must be an array, got ${typeof swaps}.`);
  }

  const benchSlotId = slotConfig.bench_slot_id;
  const items = [];
  const intended = new Map(); // playerId -> expected lineupSlotId, used by verification
  const seen = new Map(); // playerId -> swap index, to reject a player appearing in two swaps
  const current = new Map(roster.slotByPlayerId); // working copy, mutated as moves are planned
  let skipped = 0;

  for (const [index, swap] of swaps.entries()) {
    const dropId = requirePlayerId(swap.drop_player_id, "drop_player_id", index);
    const addId = requirePlayerId(swap.add_player_id, "add_player_id", index);
    const targetSlotId = resolveSlotId(swap.slot);

    if (dropId === addId) {
      throw new PermanentError(
        `Swap #${index + 1}: drop_player_id and add_player_id are both ${addId} — a player cannot ` +
          "be benched and promoted in the same swap."
      );
    }
    for (const [id, label] of [[dropId, "drop"], [addId, "add"]]) {
      if (seen.has(id)) {
        throw new PermanentError(
          `Swap #${index + 1}: player ${id} (${label}) already appears in swap #${seen.get(id) + 1}. ` +
            "Chained swaps over the same player are ambiguous; the producer should collapse them."
        );
      }
      seen.set(id, index);
    }

    // lineup_slots.json is a documented reference; the league's live settings are the truth.
    const liveCount = roster.slotCounts[String(targetSlotId)];
    if (!liveCount) {
      throw new PermanentError(
        `Swap #${index + 1}: slot "${swap.slot}" resolves to ${describeSlot(targetSlotId)}, which ` +
          `this league does not field (lineupSlotCounts has ${liveCount === 0 ? "0" : "no entry"} ` +
          "for it). Producer and league settings disagree."
      );
    }

    const dropFrom = current.get(dropId);
    const addFrom = current.get(addId);
    if (dropFrom === undefined) {
      throw new PermanentError(`Swap #${index + 1}: player ${dropId} (drop) is not on team's roster.`);
    }
    if (addFrom === undefined) {
      throw new PermanentError(`Swap #${index + 1}: player ${addId} (add) is not on team's roster.`);
    }

    // Demote before promoting, so the target slot is free by the time the promotion lands.
    const moves = [];
    if (dropFrom !== benchSlotId) moves.push({ id: dropId, from: dropFrom, to: benchSlotId });
    if (addFrom !== targetSlotId) moves.push({ id: addId, from: addFrom, to: targetSlotId });

    // Both halves already hold — nothing to do. This is what makes a redelivered message a no-op.
    if (moves.length === 0) {
      log(`Swap #${index + 1} already satisfied (${addId} in ${describeSlot(targetSlotId)}), skipping.`);
      skipped += 1;
      continue;
    }

    for (const move of moves) {
      log(`Swap #${index + 1}: ${move.id} ${describeSlot(move.from)} -> ${describeSlot(move.to)}`);
      items.push({
        playerId: Number(move.id),
        type: "LINEUP",
        fromLineupSlotId: move.from,
        toLineupSlotId: move.to,
      });
      current.set(move.id, move.to);
    }

    // Record the full intended end state for both players, including any half that was already
    // correct, so verification confirms the whole swap rather than only the part that moved.
    intended.set(addId, targetSlotId);
    intended.set(dropId, benchSlotId);
  }

  assertSlotCapacity(items, current, roster.slotCounts);

  return { items, intended, skipped };
}

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
      overfilled.push(`${describeSlot(slotId)}: ${used} players for ${capacity} spot(s)`);
    }
  }

  if (overfilled.length > 0) {
    throw new PermanentError(
      `Planned lineup overfills ${overfilled.length} slot(s) — ${overfilled.join("; ")}. ` +
        "ESPN would reject or half-apply this transaction."
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
          }`
        );
      }
    }

    if (mismatches.length === 0) {
      log(`Verification passed on attempt ${attempt}: all ${intended.size} placements confirmed.`);
      return;
    }

    if (attempt < VERIFY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    }
  }

  throw new Error(
    `Post-submit verification failed after ${VERIFY_ATTEMPTS} attempts — ${mismatches.join("; ")}`
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
    console.error(`[Lineup Bot][${tracking}] Failure context written to: ${file}`);
  } catch (captureError) {
    console.error(`[Lineup Bot][${tracking}] Could not capture failure context: ${captureError.message}`);
  }
}

async function executeLineupAdjustments(payload) {
  const tracking = payload.tracking_id || "no-tracking-id";
  const log = (message) => console.log(`[Lineup Bot][${tracking}] ${message}`);

  const teamId = payload.team_id;
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const seasonId = process.env.CURRENT_YEAR || "2026";
  const swaps = payload.optimized_swaps ?? [];
  let roster = null;
  let planned = null;

  // All three are permanent: redelivering the same message against the same config cannot help.
  if (!leagueId) {
    throw new PermanentError(
      `[Lineup Bot][${tracking}] ESPN_LEAGUE_ID is not set — cannot identify which league to act on.`
    );
  }
  if (teamId === undefined || teamId === null || teamId === "") {
    throw new PermanentError(`[Lineup Bot][${tracking}] Payload is missing team_id.`);
  }
  if (!Array.isArray(swaps)) {
    throw new PermanentError(
      `[Lineup Bot][${tracking}] optimized_swaps must be an array, got ${typeof swaps}.`
    );
  }
  if (swaps.length === 0) {
    log(`No transaction swaps specified for team ${teamId}. Nothing to do.`);
    return;
  }

  const target = { leagueId, seasonId, teamId };
  const { dryRun, defaulted } = resolveDryRun();
  log(`Starting realignment for team ${teamId} in league ${leagueId} (${seasonId})${dryRun ? " [DRY_RUN]" : ""}.`);
  if (defaulted) {
    // Say this loudly: a silent no-op is its own failure mode, and someone deploying this and
    // wondering why nothing changed deserves to see the reason in the logs.
    log(
      "DRY_RUN is unset, defaulting to TRUE — no changes will be written. Set DRY_RUN=false to " +
        "submit for real (only once the write shape is verified, see issue #15)."
    );
  }

  let session = null;
  try {
    session = await createAuthenticatedSession();

    roster = await readRoster(session.context, target);
    log(`Roster read: ${roster.entryCount} players, scoringPeriodId ${roster.scoringPeriodId}.`);

    // Permanent rather than retriable: a draft is days or weeks away, and hot-looping until then
    // would pin the queue. The producer can republish once there's a roster to realign.
    if (roster.entryCount === 0) {
      throw new PermanentError(
        `[Lineup Bot][${tracking}] Team ${teamId} has an empty roster — the draft likely hasn't ` +
          "happened yet, so there is nothing to realign."
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
      log(`All ${skipped} requested swap(s) already satisfied. No transaction submitted.`);
      return;
    }

    // Permanent: once games kick off the lock holds for hours and this week's optimization is moot.
    if (roster.lineupLocked || roster.rosterLocked) {
      throw new PermanentError(
        `[Lineup Bot][${tracking}] ESPN reports this lineup as locked ` +
          `(lineupLocked=${roster.lineupLocked}, rosterLocked=${roster.rosterLocked}) — games have ` +
          `started and the ${items.length} remaining change(s) will not be accepted.`
      );
    }

    if (dryRun) {
      log(`DRY_RUN set — would submit ${items.length} item(s):\n${JSON.stringify(items, null, 2)}`);
      return;
    }

    log(`Submitting ${items.length} lineup item(s) across ${swaps.length - skipped} swap(s)...`);
    await submitLineup(session.context, {
      ...target,
      memberId: session.swid,
      scoringPeriodId: roster.scoringPeriodId,
      items,
    });
    log("Transaction accepted by ESPN. Verifying against a fresh roster read...");

    await verifyLineup(session.context, target, intended, log);
    log("Lineup realignment complete and verified.");
  } catch (error) {
    console.error(
      `[Lineup Bot][${tracking}] Transaction failed${error.permanent ? " (permanent)" : ""}: ${error.message}`
    );
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
      planned_items: planned ? planned.items : null,
      error: error.message,
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
    console.error(
      "Usage: node src/bots/lineup_bot.js '<lineup_updates JSON payload>'\n" +
        "Example: DRY_RUN=true ESPN_LEAGUE_ID=1248158344 node src/bots/lineup_bot.js \\\n" +
        `  '{"team_id":"8","optimized_swaps":[{"drop_player_id":"3139477","add_player_id":"4259545","slot":"FLEX"}]}'`
    );
    process.exit(1);
  }

  executeLineupAdjustments(JSON.parse(raw)).catch((error) => {
    console.error(`[Lineup Bot] Run failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { executeLineupAdjustments, resolveSlotId, planSwaps };
