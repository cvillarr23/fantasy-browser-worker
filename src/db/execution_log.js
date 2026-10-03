const { Pool } = require("pg");
const { logger } = require("../telemetry/logger");

// Same env var names fantasy-core-pipeline's src/database.py already uses, so the
// convention is consistent across languages against the same fantasy-db instance.
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 2,
});

pool.on("error", (err) => {
  logger.error("[Execution Log] Idle client error on connection pool", {
    err,
  });
});

// Best-effort write for Grafana's worker execution health panel (INFRA-06). Never throws --
// a logging hiccup must not fail or requeue a real transaction (see src/index.js caller).
// trace_id/bot_name let a Grafana panel row jump straight into the matching Tempo trace and
// give standalone (non-queue) entrypoints a real identity instead of a null transaction_type.
async function recordExecution({
  transactionType,
  botName,
  status,
  durationMs,
  errorMessage,
  traceId,
}) {
  try {
    await pool.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, duration_ms, error_message, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        transactionType,
        botName || null,
        status,
        durationMs,
        errorMessage || null,
        traceId || null,
      ],
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to record execution outcome", {
      err,
    });
  }
}

// Per-pick confirmation for the draft-day clicker (WORKER-06/#43) - a dedicated write rather
// than routing through recordExecution/withInstrumentation, since that wrapper only ever knows
// "the draft_targets message succeeded or failed" as a whole, not which player/league/season it
// was for. fantasy-core-pipeline's `/v1/draft/status` reads the most recent row per
// (league_id, season) back into `last_clicker_action` - season matters because a reactivated
// league keeps the same league_id year over year. Same best-effort, never-throw contract as
// recordExecution. roundNumber is nullable and frequently null: the WS SELECTED confirmation
// carries a lineup slot id, not a round (see draft_room_socket.js's parseSelectedFrame), so the
// clicker has no round to report. Only ingest tiers that genuinely parse one (the DOM board's
// "1.04" labels, the REST feed's roundId) can populate this.
async function recordDraftPickClick({
  leagueId,
  season,
  playerId,
  playerName,
  roundNumber,
  status,
  errorMessage,
}) {
  try {
    await pool.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, error_message, league_id, season, player_id, player_name, round_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "draft_pick_click",
        "draft_clicker",
        status,
        errorMessage || null,
        leagueId || null,
        season || null,
        playerId || null,
        playerName || null,
        roundNumber || null,
      ],
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to record draft pick click outcome", {
      err,
    });
  }
}

// Per-negotiation confirmation for trade_bot.js's negotiateTradeProposal (WORKER-04/#4), same
// rationale and never-throw contract as recordDraftPickClick: recordExecution/withInstrumentation
// only knows "the trade_negotiations message succeeded or failed" as a whole, not which manager
// or counter-offer it was for. counterOffer is stored as JSON text (jsonb column) so a Grafana
// panel or ad-hoc query can inspect what was actually proposed, including on a dry-run.
//
// CROSS-REPO DEPENDENCY, same category as trade_bot.js's fetchRosterDeficits: offering_team_id,
// counter_offer, and dry_run are NEW columns on execution_log, whose DDL lives in
// fantasy-core-pipeline (this repo has no migrations of its own — see CLAUDE.md). They do not
// exist there as of this change. Until that migration lands, every insert here fails — silently,
// per this function's own never-throws contract, so there's no loud signal that it's happening.
// Confirm the migration is in place before relying on this in production.
async function recordTradeNegotiation({
  leagueId,
  season,
  offeringTeamId,
  counterOffer,
  dryRun,
  status,
  errorMessage,
}) {
  try {
    await pool.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, error_message, league_id, season, offering_team_id, counter_offer, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "trade_negotiation",
        "trade_bot",
        status,
        errorMessage || null,
        leagueId || null,
        season || null,
        offeringTeamId || null,
        counterOffer ? JSON.stringify(counterOffer) : null,
        dryRun === null || dryRun === undefined ? null : dryRun,
      ],
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to record trade negotiation outcome", {
      err,
    });
  }
}

// --- Trade-builder submissions (#90) ---------------------------------------------------------
//
// Every trade_builder.js outcome is a transaction_type='trade_offer_submit' row. The offer itself
// (plus its offer_key, the sha256 idempotency/approval key from trade_builder.computeOfferKey)
// lives in the existing counter_offer JSONB column, and offering_team_id is set only when the
// offer is a counter to that team, so no execution_log migration is needed. Statuses:
//   awaiting_approval / submit_blocked / dry_run_filled — a dry fill (recordTradeOfferFill)
//   submitting — a claim taken just before the irreversible click (claimTradeSubmission)
//   submitted / failure — that claim, finalized (finalizeTradeSubmission)
//
// Unlike every other writer in this file, findTradeSubmission and claimTradeSubmission THROW on a
// DB error. They are the only thing standing between a redelivered approval and a duplicate trade
// offer sent to a real manager, so when they can't answer, the caller must not click.

const TRADE_SUBMIT_TYPE = "trade_offer_submit";

function tradeOfferJson(offerKey, row) {
  return JSON.stringify({
    offer_key: offerKey,
    source: row.source || null,
    from_team_id: row.fromTeamId,
    to_team_id: row.toTeamId,
    incoming_player_ids: row.incomingPlayerIds,
    outgoing_player_ids: row.outgoingPlayerIds,
    approved_by: row.approvedBy || null,
    // Part of the offer_key, so an approver must see it: it's what the other manager will read.
    message: row.message || null,
    screenshot_path: row.screenshotPath || null,
    reasons: row.reasons || undefined,
  });
}

// A counter is addressed to the manager who offered; a fresh #93 proposal has no offering team.
function offeringTeamFor(row) {
  return row.source === "counter_offer" ? row.toTeamId : null;
}

// `submitted` sorts ahead of `submitting` so a key that was retried after an unknown outcome and
// then confirmed reads as done.
const FIND_CLAIM_SQL = `SELECT id, status FROM execution_log
       WHERE transaction_type = '${TRADE_SUBMIT_TYPE}'
         AND counter_offer->>'offer_key' = $1
         AND status IN ('submitting', 'submitted')
       ORDER BY (status = 'submitted') DESC, executed_at DESC
       LIMIT 1`;

async function findTradeSubmission(offerKey) {
  const { rows } = await pool.query(FIND_CLAIM_SQL, [offerKey]);
  return rows[0] || null;
}

/**
 * Atomically claims offerKey for a real submit. The advisory lock serializes two workers handed
 * the same approval (a redelivery racing a slow first attempt) without needing a unique index on
 * a JSONB expression in core-pipeline's schema. Returns {claimed: true, id}, or {claimed: false,
 * existing} when a submitting/submitted row already holds the key.
 */
async function claimTradeSubmission(offerKey, row) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [offerKey]);
    const existing = await client.query(FIND_CLAIM_SQL, [offerKey]);
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      return { claimed: false, existing: existing.rows[0].status };
    }
    const inserted = await client.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run)
       VALUES ($1, $2, 'submitting', $3, $4, $5, $6, false)
       RETURNING id`,
      [
        TRADE_SUBMIT_TYPE,
        "trade_builder",
        row.leagueId || null,
        row.season || null,
        offeringTeamFor(row),
        tradeOfferJson(offerKey, row),
      ],
    );
    await client.query("COMMIT");
    return { claimed: true, id: inserted.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Best-effort: if this fails the row stays `submitting`, which fails closed on any redelivery. */
async function finalizeTradeSubmission(id, status, errorMessage) {
  try {
    await pool.query(
      "UPDATE execution_log SET status = $2, error_message = $3 WHERE id = $1",
      [id, status, errorMessage || null],
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to finalize trade submission", { err });
  }
}

/** Best-effort record of a dry fill, same never-throw contract as recordTradeNegotiation. */
async function recordTradeOfferFill({ offerKey, status, dryRun, errorMessage, ...row }) {
  try {
    await pool.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, error_message, league_id, season, offering_team_id, counter_offer, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        TRADE_SUBMIT_TYPE,
        "trade_builder",
        status,
        errorMessage || null,
        row.leagueId || null,
        row.season || null,
        offeringTeamFor(row),
        tradeOfferJson(offerKey, row),
        dryRun,
      ],
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to record trade offer fill", { err });
  }
}

module.exports = {
  recordExecution,
  recordDraftPickClick,
  recordTradeNegotiation,
  findTradeSubmission,
  claimTradeSubmission,
  finalizeTradeSubmission,
  recordTradeOfferFill,
};
