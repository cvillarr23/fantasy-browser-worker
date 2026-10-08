/**
 * The shape of a trade_response row in execution_log, shared by the claim (trade_inbox.js, which
 * writes it in the same transaction as the inbox entry) and the ledger readers and dry-run
 * recorder (execution_log.js). It has no pool of its own, so either module can load it without
 * opening another connection.
 */

const TRADE_RESPONSE_TYPE = "trade_response";

// A row in any of these states owns its offer: nothing else may be sent for it until a human
// retry supersedes the row. core-pipeline's decision endpoint blocks on the same four, and a
// `superseded` row is deliberately absent. Ordered most settled first, for lookups by key.
const BLOCKING_RESPONSE_STATUSES = Object.freeze(["responded", "responding", "response_unknown", "rejected"]);

function tradeResponseJson(decisionKey, row, extra = {}) {
  return JSON.stringify({
    decision_key: decisionKey,
    espn_transaction_id: row.transactionId,
    action: row.action,
    comment: row.comment ?? null,
    approved_by: row.approvedBy ?? null,
    ...extra,
  });
}

module.exports = { TRADE_RESPONSE_TYPE, BLOCKING_RESPONSE_STATUSES, tradeResponseJson };
