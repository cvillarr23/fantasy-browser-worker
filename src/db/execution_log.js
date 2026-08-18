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
    error: err.message,
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
      [transactionType, botName || null, status, durationMs, errorMessage || null, traceId || null]
    );
  } catch (err) {
    logger.error("[Execution Log] Failed to record execution outcome", {
      error: err.message,
    });
  }
}

module.exports = { recordExecution };
