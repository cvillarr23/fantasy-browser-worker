const fs = require("fs");
const path = require("path");
const { createAuthenticatedSession } = require("./auth");
const { readRoster, submitLineup } = require("./espn_api");
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
 * Safety rails, all on by default except DRY_RUN:
 *   - DRY_RUN=true   — do every read, validation and plan step, log the exact items, submit nothing.
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

/**
 * Turns the payload's swaps into a flat list of LINEUP items, dropping anything already satisfied.
 * Throws on a swap that references a player who isn't rostered — submitting that would produce a
 * meaningless transaction, and it almost certainly signals producer/consumer drift worth requeuing.
 */
function planSwaps(swaps, roster, log) {
  const benchSlotId = slotConfig.bench_slot_id;
  const items = [];
  const intended = new Map(); // playerId -> expected lineupSlotId, used by verification
  let skipped = 0;

  for (const [index, swap] of swaps.entries()) {
    const dropId = String(swap.drop_player_id);
    const addId = String(swap.add_player_id);
    const targetSlotId = resolveSlotId(swap.slot);

    // lineup_slots.json is a documented reference; the league's live settings are the truth. A slot
    // the league doesn't actually field (count 0 or absent) would otherwise be submitted anyway and
    // come back as an opaque API rejection that requeues forever — catch it here as a clear,
    // permanent configuration error instead.
    const liveCount = roster.slotCounts[String(targetSlotId)];
    if (!liveCount) {
      throw new Error(
        `Swap #${index + 1}: slot "${swap.slot}" resolves to ${describeSlot(targetSlotId)}, which ` +
          `this league does not field (lineupSlotCounts has ${liveCount === 0 ? "0" : "no entry"} ` +
          "for it). Producer and league settings disagree."
      );
    }

    const dropFrom = roster.slotByPlayerId.get(dropId);
    const addFrom = roster.slotByPlayerId.get(addId);

    if (dropFrom === undefined) {
      throw new Error(`Swap #${index + 1}: player ${dropId} (drop) is not on team's roster.`);
    }
    if (addFrom === undefined) {
      throw new Error(`Swap #${index + 1}: player ${addId} (add) is not on team's roster.`);
    }

    // Already-satisfied: the promoted player sits in the target slot and the demoted one is benched.
    if (addFrom === targetSlotId && dropFrom === benchSlotId) {
      log(`Swap #${index + 1} already satisfied (${addId} in ${describeSlot(targetSlotId)}), skipping.`);
      skipped += 1;
      continue;
    }

    log(
      `Swap #${index + 1}: ${addId} ${describeSlot(addFrom)} -> ${describeSlot(targetSlotId)}, ` +
        `${dropId} ${describeSlot(dropFrom)} -> ${describeSlot(benchSlotId)}`
    );

    items.push(
      { playerId: Number(addId), type: "LINEUP", fromLineupSlotId: addFrom, toLineupSlotId: targetSlotId },
      { playerId: Number(dropId), type: "LINEUP", fromLineupSlotId: dropFrom, toLineupSlotId: benchSlotId }
    );
    intended.set(addId, targetSlotId);
    intended.set(dropId, benchSlotId);
  }

  return { items, intended, skipped };
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

/** Best-effort forensics before rethrowing; never allowed to mask the original error. */
async function captureFailure(session, tracking, details) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(DEBUG_DIR, `lineup-fail-${tracking}-${stamp}`);

    const written = [`${base}.json`];
    fs.writeFileSync(`${base}.json`, JSON.stringify(details, null, 2));

    // No page when the failure happened before/while the browser was coming up (bad cookies, for
    // instance) — report only what was actually captured rather than pointing at a missing file.
    if (session?.page) {
      await session.page.screenshot({ path: `${base}.png`, fullPage: true });
      written.push(`${base}.png`);
    }
    console.error(`[Lineup Bot][${tracking}] Failure context written to: ${written.join(", ")}`);
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
  const swaps = payload.optimized_swaps || [];

  if (!leagueId) {
    throw new Error(
      `[Lineup Bot][${tracking}] ESPN_LEAGUE_ID is not set — cannot identify which league to act on.`
    );
  }
  if (teamId === undefined || teamId === null || teamId === "") {
    throw new Error(`[Lineup Bot][${tracking}] Payload is missing team_id.`);
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

    const roster = await readRoster(session.context, target);
    log(`Roster read: ${roster.entryCount} players, scoringPeriodId ${roster.scoringPeriodId}.`);

    if (roster.entryCount === 0) {
      throw new Error(
        `[Lineup Bot][${tracking}] Team ${teamId} has an empty roster — the draft likely hasn't ` +
          "happened yet, so there is nothing to realign."
      );
    }
    const { items, intended, skipped } = planSwaps(swaps, roster, log);

    // Plan BEFORE checking the lock. If a submit succeeded but verification failed transiently, the
    // message gets requeued; should the lineup lock before redelivery, a lock-check-first ordering
    // would throw forever on work that is in fact already done — an infinite requeue loop that
    // blocks the whole queue under connection.js's prefetch(1). A retry with nothing left to do
    // must succeed.
    if (items.length === 0) {
      log(`All ${skipped} requested swap(s) already satisfied. No transaction submitted.`);
      return;
    }

    if (roster.lineupLocked || roster.rosterLocked) {
      throw new Error(
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
    console.error(`[Lineup Bot][${tracking}] Transaction failed: ${error.message}`);
    await captureFailure(session, tracking, {
      tracking_id: tracking,
      league_id: leagueId,
      team_id: teamId,
      season_id: seasonId,
      dry_run: dryRun,
      swaps,
      error: error.message,
    });
    throw error; // Bubble up so connection.js nacks and RabbitMQ requeues.
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
