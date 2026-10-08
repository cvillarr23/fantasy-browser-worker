/**
 * Storage for the incoming-trade inbox: one execution_log row per ESPN transaction id, with
 * transaction_type='trade_inbox'. The entry lives in the counter_offer JSONB column. Its inbox
 * status lives in the status column, and offering_team_id is the proposer. This follows how
 * trade_offer_submit and trade_scan_claim rows reuse execution_log, so core-pipeline needs no
 * migration.
 *
 * Every change runs under an advisory lock on the offer, with the stored row re-read FOR UPDATE.
 * The refresh job, the response executor and a triage write therefore can't overwrite each
 * other's fields. Writes touch only status, counter_offer and offering_team_id: core-pipeline keeps
 * its publication claims in the same row's outcome_details, and those must survive every write. There is no unique index on the JSONB expression to lean on. Unlike the
 * best-effort writers in execution_log.js, these functions throw: an inbox that can't be read or
 * saved must stop the caller rather than let it act on a stale view.
 */

const { Pool } = require("pg");
const { PermanentError } = require("../errors");
const { logger } = require("../telemetry/logger");
const { STATUS } = require("../lib/trade_inbox");
const { TRADE_RESPONSE_TYPE, BLOCKING_RESPONSE_STATUSES, tradeResponseJson } = require("./trade_response_rows");

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
// core-pipeline's inbox endpoints take this exact lock, so they serialize with every write here.
const offerLock = (leagueId, transactionId) => `trade-inbox:${leagueId}:${transactionId}`;

const UPDATE_ENTRY_SQL = `UPDATE execution_log SET status = $2, counter_offer = $3::jsonb, offering_team_id = $4
            WHERE id = $1`;

async function writeEntry(client, stored, next) {
  await client.query(UPDATE_ENTRY_SQL, [stored.ledger_id, next.status, toJson(next), next.proposing_team_id ?? null]);
}

async function updateEntry(transactionId, { leagueId, season }, mutate) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [offerLock(leagueId, transactionId)]);
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
        await writeEntry(client, stored, next);
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

// --- Response claims ----------------------------------------------------------------------
//
// Lock order: the offer lock, then the decision-key lock. Nothing takes them the other way round:
// refresh, triage, core-pipeline and settling take only the offer lock. Waiters therefore can't
// form a cycle. The key lock adds nothing while every claimer goes through here first. It is kept
// so a worker still running the older key-only claim during a rolling deploy waits as well.

const SETTLE_ALLOWED_FROM = Object.freeze({
  // A later read can still confirm an outcome first recorded as unknown.
  responded: ["responding", "response_unknown"],
  // Repeating an unknown keeps its verification current. responded is final, so a slow
  // reconciler can't turn a confirmed response back into an unknown one.
  response_unknown: ["responding", "response_unknown"],
  rejected: ["responding"],
});

function lockedEntry(rows, transactionId) {
  if (rows.length === 0) throw new PermanentError(`[Trade Inbox] Offer ${transactionId} is not in the inbox.`);
  if (rows.length > 1) {
    throw new PermanentError(`[Trade Inbox] Offer ${transactionId} is stored more than once; reconcile the inbox first.`);
  }
  return toEntry(rows[0]);
}

function requireClaimable(entry, { decisionKey, expectedFingerprint, supersedes, transactionId }) {
  // A retry of an unknown outcome finds its own claim still marking the entry responding.
  const ownRetry = supersedes && entry.status === STATUS.RESPONDING && entry.decision?.decision_key === decisionKey;
  if (entry.status !== STATUS.OPEN && !ownRetry) {
    throw new PermanentError(`[Trade Inbox] Offer ${transactionId} is not open (${entry.status}); it can't be answered now.`);
  }
  if ((entry.parse_issues || []).length > 0) {
    throw new PermanentError(`[Trade Inbox] Offer ${transactionId} didn't parse cleanly, so it can't be answered.`);
  }
  if (entry.fingerprint !== expectedFingerprint) {
    throw new PermanentError(
      `[Trade Inbox] Offer ${transactionId} changed since it was read; refresh the inbox and approve it again.`,
    );
  }
}

/**
 * Claims one offer for one decision, or reports the claim the key already has. Under the offer
 * lock it re-reads the entry and every blocking response row for the offer, so the checks the
 * caller made on an earlier snapshot are repeated against what is stored now:
 * - Another key's claim on the offer refuses, so two different actions can't both be sent.
 * - This key's claim comes back unwritten as {claimed: false, existing, id} for the caller to
 *   reconcile, unless `supersedes` names it for a human retry.
 * - The entry must be open, parsed and still at the fingerprint the decision key was computed
 *   from, and `validate(entry)` (the accept checks on its stored score) must pass.
 * The response row and the entry's `responding` status are written in the same transaction, so a
 * crash leaves both or neither. Any refusal rolls back with nothing written.
 */
async function claimOfferResponse(
  transactionId,
  { leagueId, season },
  { decisionKey, expectedFingerprint, row, decision, validate, supersedes, now = new Date() },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [offerLock(leagueId, transactionId)]);
    const { rows: inboxRows } = await client.query(
      `SELECT id, status, counter_offer FROM execution_log
        WHERE transaction_type = '${INBOX_TYPE}' AND league_id = $1
          AND counter_offer->>'espn_transaction_id' = $2
        ORDER BY id DESC FOR UPDATE`,
      [String(leagueId), String(transactionId)],
    );
    const entry = lockedEntry(inboxRows, transactionId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [decisionKey]);
    const { rows: claims } = await client.query(
      `SELECT id, status, counter_offer->>'decision_key' AS decision_key FROM execution_log
        WHERE transaction_type = '${TRADE_RESPONSE_TYPE}' AND league_id = $1
          AND counter_offer->>'espn_transaction_id' = $2
          AND status = ANY($3)
        ORDER BY id DESC`,
      [String(leagueId), String(transactionId), [...BLOCKING_RESPONSE_STATUSES]],
    );

    if (claims.some((c) => c.decision_key !== decisionKey)) {
      throw new PermanentError(
        `[Trade Inbox] Another response to offer ${transactionId} is already claimed or settled; reconcile it first.`,
      );
    }
    const mostSettled = (a, b) =>
      BLOCKING_RESPONSE_STATUSES.indexOf(a.status) - BLOCKING_RESPONSE_STATUSES.indexOf(b.status);
    const own = [...claims].sort(mostSettled)[0];
    if (own && !supersedes) {
      await client.query("COMMIT");
      return { claimed: false, existing: own.status, id: own.id };
    }

    requireClaimable(entry, { decisionKey, expectedFingerprint, supersedes, transactionId });
    if (validate) validate(entry);

    if (supersedes) {
      const stale =
        claims.length !== 1 ||
        String(own.id) !== String(supersedes.id) ||
        own.status !== supersedes.status;
      const superseded =
        !stale &&
        (
          await client.query(
            `UPDATE execution_log SET status = 'superseded', counter_offer = counter_offer || $3::jsonb
              WHERE id = $1 AND transaction_type = '${TRADE_RESPONSE_TYPE}' AND status = $2
              RETURNING id`,
            [
              own.id,
              supersedes.status,
              JSON.stringify({
                superseded_by_tracking_id: supersedes.trackingId ?? null,
                retried_by: supersedes.retriedBy,
                verified_not_answered: supersedes.verifiedNotAnswered ?? false,
                retried_at: now.toISOString(),
              }),
            ],
          )
        ).rows.length === 1;
      if (!superseded) {
        throw new PermanentError(
          `[Trade Inbox] The response being retried for offer ${transactionId} has changed since the retry was requested; check it again.`,
        );
      }
    }

    const inserted = await client.query(
      `INSERT INTO execution_log (transaction_type, bot_name, status, league_id, season, offering_team_id, counter_offer, dry_run)
       VALUES ($1, $2, 'responding', $3, $4, $5, $6, false)
       RETURNING id`,
      [
        TRADE_RESPONSE_TYPE,
        "trade_response",
        String(leagueId),
        season ?? null,
        row.proposingTeamId ?? null,
        tradeResponseJson(decisionKey, row),
      ],
    );
    await writeEntry(client, entry, { ...entry, status: STATUS.RESPONDING, decision });
    await client.query("COMMIT");
    return { claimed: true, id: inserted.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Settles a response claim and its inbox entry together under the offer lock. The claim moves
 * only from a state SETTLE_ALLOWED_FROM permits. When it has already moved on (another reconcile
 * settled it first), nothing is written and {settled: false} comes back. Throws on a DB error:
 * the caller has to know the outcome wasn't recorded.
 */
async function settleOfferResponse(transactionId, { leagueId }, { claimId, ledgerStatus, errorMessage, mutate }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [offerLock(leagueId, transactionId)]);
    const moved = await client.query(
      `UPDATE execution_log SET status = $2, error_message = $3
        WHERE id = $1 AND transaction_type = '${TRADE_RESPONSE_TYPE}' AND status = ANY($4)
        RETURNING id`,
      [claimId, ledgerStatus, errorMessage ?? null, SETTLE_ALLOWED_FROM[ledgerStatus]],
    );
    if (moved.rows.length === 0) {
      await client.query("COMMIT");
      return { settled: false };
    }
    const { rows } = await client.query(
      `SELECT id, status, counter_offer FROM execution_log
        WHERE transaction_type = '${INBOX_TYPE}' AND league_id = $1
          AND counter_offer->>'espn_transaction_id' = $2
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [String(leagueId), String(transactionId)],
    );
    const stored = rows[0] ? toEntry(rows[0]) : null;
    const next = stored && mutate(stored);
    if (next) await writeEntry(client, stored, next);
    await client.query("COMMIT");
    return { settled: true, entry: next ?? stored };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { INBOX_TYPE, loadInbox, updateEntry, setTriage, claimOfferResponse, settleOfferResponse };
