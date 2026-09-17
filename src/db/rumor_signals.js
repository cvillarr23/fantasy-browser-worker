const { Pool } = require("pg");
const { logger } = require("../telemetry/logger");

// Same pool shape as execution_log.js/llm_client.js, but unlike those, errors here propagate
// rather than being swallowed -- this table is the deliverable, not a best-effort side channel.
// Safe to retry: nothing here is non-idempotent, and the watermark only advances on a commit.
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});

pool.on("error", (err) => {
  logger.error("[Rumor Signals] Idle client error on connection pool", { err });
});

/** The digest's watermark: the highest raw_signals.id considered by any completed digest run.
 * A digest run stamps every row it writes -- including no_op verdicts -- with its batch's own
 * max raw_signals.id (see rumor_digest_bot.js), so MAX(max_raw_signal_id) here always reflects
 * everything already considered, with no separate cursor/state table needed. Returns null when
 * the table is empty (first-ever run), which fetchNewRawSignals treats as "process everything". */
async function fetchWatermark() {
  const { rows } = await pool.query(
    "SELECT MAX(max_raw_signal_id) AS watermark FROM rumor_signals",
  );
  const watermark = rows[0] && rows[0].watermark;
  return watermark === null || watermark === undefined ? null : Number(watermark);
}

/** New raw_signals rows to interpret this run. Skips rows the upstream fuzzy matcher couldn't
 * resolve to a player -- nothing to attach a per-player signal to. player_id is the internal
 * (Sleeper) id space, same as raw_signals/players -- not an ESPN id. */
async function fetchNewRawSignals(sinceId) {
  const { rows } = await pool.query(
    `SELECT id, player_id, source, raw_text, published_at
       FROM raw_signals
      WHERE id > $1 AND player_id IS NOT NULL
      ORDER BY id`,
    [sinceId || 0],
  );
  return rows;
}

/** Persists one digest run's verdicts as a single all-or-nothing transaction -- either every
 * player this run produced a valid verdict for lands, or none do, so a partial-insert failure
 * never leaves the watermark in a state that's inconsistent with what's actually in the table. */
async function persistRumorSignals(rows) {
  if (!rows || rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        `INSERT INTO rumor_signals
           (player_id, sentiment, confidence, suggested_action, source_raw_signal_ids, max_raw_signal_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          row.playerId,
          row.sentiment,
          row.confidence,
          row.suggestedAction,
          row.sourceRawSignalIds,
          row.maxRawSignalId,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fetchWatermark, fetchNewRawSignals, persistRumorSignals };
