/**
 * Storage for the incoming-trade inbox: one execution_log row per ESPN transaction id, with
 * transaction_type='trade_inbox'. The entry lives in the counter_offer JSONB column. Its inbox
 * status lives in the status column, and offering_team_id is the proposer. This follows how
 * trade_offer_submit and trade_scan_claim rows reuse execution_log, so core-pipeline needs no
 * migration.
 *
 * Every change runs under an advisory lock on the offer, with the stored row re-read FOR UPDATE.
 * The refresh job, the response executor and a triage write therefore can't overwrite each
 * other's fields. There is no unique index on the JSONB expression to lean on. Unlike the
 * best-effort writers in execution_log.js, these functions throw: an inbox that can't be read or
 * saved must stop the caller rather than let it act on a stale view.
 */

const { Pool } = require("pg");
const { PermanentError } = require("../errors");
const { logger } = require("../telemetry/logger");

const INBOX_TYPE = "trade_inbox";
const INBOX_POOL_MAX_CONNECTIONS = 1;
const INBOX_DB_TIMEOUT_MS = 10_000;
const TRIAGE_STATES = ["new", "seen", "snoozed", "dismissed"];

const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: INBOX_POOL_MAX_CONNECTIONS,
  connectionTimeoutMillis: INBOX_DB_TIMEOUT_MS,
  statement_timeout: INBOX_DB_TIMEOUT_MS,
});
pool.on("error", (err) => logger.error("[Trade Inbox] Idle client error on connection pool", { err }));

function toEntry(row) {
  return { ledger_id: row.id, status: row.status, ...row.counter_offer };
}

// The status column is the source of truth; the ledger id is the row's own key.
function toJson(entry) {
  const rest = { ...entry };
  delete rest.status;
  delete rest.ledger_id;
  return JSON.stringify(rest);
}

async function loadInbox({ leagueId }) {
  const { rows } = await pool.query(
    `SELECT id, status, counter_offer FROM execution_log
      WHERE transaction_type = '${INBOX_TYPE}' AND league_id = $1
      ORDER BY id`,
    [String(leagueId)],
  );
  return rows.map(toEntry);
}

/**
 * Locks one offer's entry and replaces it with `mutate(stored)`. stored is null for a never-seen
 * offer. Returning null leaves the row as it is. Returns the entry as saved, or the unchanged
 * stored entry.
 */
async function updateEntry(transactionId, { leagueId, season }, mutate) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `trade-inbox:${leagueId}:${transactionId}`,
    ]);
    const { rows } = await client.query(
      `SELECT id, status, counter_offer FROM execution_log
        WHERE transaction_type = '${INBOX_TYPE}' AND league_id = $1
          AND counter_offer->>'espn_transaction_id' = $2
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [String(leagueId), String(transactionId)],
    );
    const stored = rows[0] ? toEntry(rows[0]) : null;
    const next = mutate(stored);
    if (next) {
      if (stored) {
        await client.query(
          `UPDATE execution_log SET status = $2, counter_offer = $3::jsonb, offering_team_id = $4
            WHERE id = $1`,
          [stored.ledger_id, next.status, toJson(next), next.proposing_team_id ?? null],
        );
      } else {
        await client.query(
          `INSERT INTO execution_log (transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run)
           VALUES ('${INBOX_TYPE}', 'trade_inbox', $1, $2, $3, $4, $5::jsonb, true)`,
          [next.status, String(leagueId), season ?? null, next.proposing_team_id ?? null, toJson(next)],
        );
      }
    }
    await client.query("COMMIT");
    return next ?? stored;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A human's triage of one offer: seen, snoozed until a time, dismissed, or back to new. Purely
 * local: nothing reaches ESPN. A refresh brings a dismissed offer back only if the offer changes.
 */
async function setTriage(transactionId, scope, { state, by, snoozeUntil, now = new Date() }) {
  if (!TRIAGE_STATES.includes(state)) {
    throw new PermanentError(`[Trade Inbox] Triage state must be one of ${TRIAGE_STATES.join(", ")}.`);
  }
  if (typeof by !== "string" || by.trim() === "") {
    throw new PermanentError("[Trade Inbox] Triage by is required.");
  }
  const triage = { state, by: by.trim(), at: now.toISOString() };
  if (state === "snoozed") {
    const until = new Date(snoozeUntil ?? NaN);
    if (Number.isNaN(until.getTime()) || until <= now) {
      throw new PermanentError("[Trade Inbox] Triage snooze_until must be in the future.");
    }
    triage.snooze_until = until.toISOString();
  }
  return updateEntry(transactionId, scope, (stored) => {
    if (!stored) throw new PermanentError(`[Trade Inbox] Offer ${transactionId} is not in the inbox.`);
    return { ...stored, triage };
  });
}

module.exports = { INBOX_TYPE, loadInbox, updateEntry, setTriage };
