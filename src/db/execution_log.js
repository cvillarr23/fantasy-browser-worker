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

module.exports = { recordExecution, recordDraftPickClick, recordTradeNegotiation };
