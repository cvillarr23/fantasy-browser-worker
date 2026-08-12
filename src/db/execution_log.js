const { Pool } = require("pg");

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
  console.error(`[Execution Log] Idle client error on connection pool: ${err.message}`);
});

// Best-effort write for Grafana's worker execution health panel (INFRA-06). Never throws --
// a logging hiccup must not fail or requeue a real transaction (see src/index.js caller).
async function recordExecution({ transactionType, status, durationMs, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO execution_log (transaction_type, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4)`,
      [transactionType, status, durationMs, errorMessage || null]
    );
  } catch (err) {
    console.error(`[Execution Log] Failed to record execution outcome: ${err.message}`);
  }
}

module.exports = { recordExecution };
