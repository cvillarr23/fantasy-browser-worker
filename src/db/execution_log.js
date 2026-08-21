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
// recordExecution. roundNumber (not "pick number") because the WS SELECTED confirmation only
// ever carries a round, never an overall pick index - naming it otherwise would misrepresent
// what's actually stored.
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

module.exports = { recordExecution, recordDraftPickClick };
