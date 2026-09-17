const { Pool } = require("pg");
const { logger } = require("../telemetry/logger");

// Same pool shape as src/db/execution_log.js / src/lib/llm_client.js -- small, dedicated.
// UNLIKE those two, this module does NOT swallow errors: rumor_signals is rumor_digest_bot.js's
// actual deliverable output, not a best-effort audit/metrics side-channel, so a read or write
// failure here must fail the run loudly (propagate a plain Error) rather than be logged and
// ignored. That's safe -- nothing this module does is non-idempotent, so a failed run can simply
// be retried on the next scheduled invocation without double-processing anything (the watermark
// only advances once a run's rows are actually committed).
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

/** New raw_signals rows to interpret this run. `player_id IS NOT NULL` skips items CORE-13's
 * fuzzy matcher couldn't resolve to a player -- there is nothing for a per-player signal to
 * attach to. player_id here is the internal (Sleeper) id space, same as raw_signals/players --
 * NOT an ESPN id (see rumor_digest_bot.js's header for why that distinction matters). */
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
