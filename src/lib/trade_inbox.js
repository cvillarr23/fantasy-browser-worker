/**
 * Pure model for the incoming-trade inbox: turning ESPN's pending trades into inbox entries,
 * fingerprints and decision keys, mapping core-pipeline's trade score, ranking, the shadow
 * policy, and working out why an offer left the pending list. No I/O.
 *
 * Every number shown or ranked on comes from core-pipeline's deterministic POST /v1/trade/score.
 * Nothing here estimates a value, and an LLM never does either: an offer core cannot score is
 * ranked below every scored one rather than given a guess.
 *
 * The populated mPendingTransactions shape is UNVERIFIED (see espn_api.js readPendingTrades), so
 * anything unexpected is recorded in `parse_issues`. An entry with issues is `unparsed`: visible,
 * but never actionable.
 */

const { createHash } = require("crypto");
const { PermanentError } = require("../errors");

const STATUS = Object.freeze({
  OPEN: "open",
  UNPARSED: "unparsed",
  RESPONDING: "responding",
  ACCEPTED_PENDING_PROCESSING: "accepted_pending_processing",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  COUNTERED: "countered",
  VETOED: "vetoed",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
  CLOSED_UNKNOWN: "closed_unknown",
});

// Shown in the inbox by default. Every other status is history.
const LIVE_STATUSES = new Set([STATUS.OPEN, STATUS.UNPARSED, STATUS.RESPONDING]);

const FINISHED_STATUSES = new Set([
  STATUS.ACCEPTED,
  STATUS.DECLINED,
  STATUS.COUNTERED,
  STATUS.VETOED,
  STATUS.EXPIRED,
  STATUS.WITHDRAWN,
  STATUS.CLOSED_UNKNOWN,
]);

// An offer can vanish from one read for reasons we can't see (ESPN lag, a read between a counter
// and its replacement). Closing on the first miss would hide a live offer.
const MISSED_READS_BEFORE_CLOSE = 2;

// "PENDING" is presumed, not observed: no populated pending read has been captured yet.
const KNOWN_PENDING_STATUSES = new Set(["PENDING"]);
const KNOWN_ITEM_TYPES = new Set(["TRADE", "DRAFT_TRADE", "ACQUISITION_BUDGET_TRADE", "DROP"]);
const WITHDRAWN_HISTORY_STATUSES = new Set(["CANCELED", "CANCELLED"]);
const TWO_TEAMS = 2;

const SHADOW_POLICY_VERSION = "shadow-v1";
const DECISION_KEY_VERSION = "trade-response-v1";
const FINGERPRINT_VERSION = "trade-inbox-v1";

const MULTI_TEAM_ISSUE = "more than two teams";

function timestampMs(value) {
  if (value === null || value === undefined) return NaN;
  return new Date(value).getTime();
}

function sha256(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/** readPendingTrades' trades, split into offers to us, our own offers, and pending accepts. */
function splitPendingTrades(trades, ourTeamId) {
  const ours = String(ourTeamId);
  const proposals = trades.filter((t) => t.type === "TRADE_PROPOSAL");
  return {
    incoming: proposals.filter((t) => t.proposingTeamId !== ours),
    outgoing: proposals.filter((t) => t.proposingTeamId === ours),
    accepts: trades.filter((t) => t.type === "TRADE_ACCEPT"),
  };
}

function itemKey(item) {
  return [
    item.type,
    item.playerId ?? "",
    item.acquisitionBudget ?? "",
    item.overallPickNumber ?? "",
    `${item.fromTeamId}>${item.toTeamId}`,
  ].join("|");
}

/**
 * What the offer is, independent of item order. ESPN can't edit an offer in place, but a
 * same-id change would mean a new offer, so it is rescored and a dismissal is undone. The note is
 * left out: it doesn't change what is traded.
 */
function tradeFingerprint(trade) {
  const proposed = timestampMs(trade.proposedDate);
  const expires = timestampMs(trade.expirationDate);
  return sha256([
    FINGERPRINT_VERSION,
    String(trade.proposingTeamId),
    (trade.items || []).map(itemKey).sort(),
    Number.isNaN(proposed) ? null : proposed,
    Number.isNaN(expires) ? null : expires,
  ]);
}

function parseIssues(trade, teams) {
  const issues = [];
  if (trade.id === undefined || trade.id === null) issues.push("no transaction id");
  if (!KNOWN_PENDING_STATUSES.has(trade.status)) issues.push(`unrecognized status ${trade.status}`);
  if (Number.isNaN(timestampMs(trade.expirationDate))) issues.push("no expirationDate");
  if (teams.size > TWO_TEAMS) issues.push(MULTI_TEAM_ISSUE);
  for (const item of trade.items || []) {
    if (!KNOWN_ITEM_TYPES.has(item.type)) issues.push(`unrecognized item type ${item.type}`);
    else if (item.type === "TRADE" && item.playerId === null) issues.push("TRADE item without a playerId");
  }
  return [...new Set(issues)];
}

/**
 * One incoming offer as an inbox entry's ESPN-derived fields. `threadRootOf(relatedId)` returns
 * the first offer of a counter chain when the caller knows it, so a multi-turn negotiation keeps
 * one thread id.
 */
function toInboxEntry(trade, ourTeamId, { threadRootOf } = {}) {
  const ours = String(ourTeamId);
  const items = trade.items || [];
  const teams = new Set([String(trade.proposingTeamId)]);
  for (const item of items) {
    teams.add(item.fromTeamId);
    teams.add(item.toTeamId);
  }
  const players = items.filter((i) => i.type === "TRADE" && i.playerId !== null);
  const related = trade.relatedTransactionId ?? null;
  const id = String(trade.id);
  return {
    espn_transaction_id: id,
    related_transaction_id: related === null ? null : String(related),
    thread_root_id: related === null ? id : (threadRootOf?.(String(related)) ?? String(related)),
    proposing_team_id: String(trade.proposingTeamId),
    our_team_id: ours,
    espn_type: trade.type,
    espn_status: trade.status ?? null,
    send_espn_ids: players.filter((i) => i.fromTeamId === ours).map((i) => i.playerId),
    receive_espn_ids: players.filter((i) => i.toTeamId === ours).map((i) => i.playerId),
    other_items: items.filter((i) => !players.includes(i)),
    // ESPN's roster names, so the inbox can be read before (or without) a score.
    player_names: Object.fromEntries(players.map((i) => [i.playerId, i.playerName ?? null])),
    proposed_date: trade.proposedDate ?? null,
    expiration_date: trade.expirationDate ?? null,
    comment: trade.comment ?? null,
    fingerprint: tradeFingerprint(trade),
    parse_issues: parseIssues(trade, teams),
  };
}

// Fields a refresh overwrites from ESPN's read. Triage, decisions, scores and timestamps are ours.
const ESPN_FIELDS = [
  "related_transaction_id",
  "thread_root_id",
  "proposing_team_id",
  "our_team_id",
  "espn_type",
  "espn_status",
  "send_espn_ids",
  "receive_espn_ids",
  "other_items",
  "player_names",
  "proposed_date",
  "expiration_date",
  "comment",
  "fingerprint",
  "parse_issues",
];

/** A stored entry updated from a fresh read (stored is null for a never-seen offer). */
function mergeEntry(stored, fresh, now) {
  const seenAt = now.toISOString();
  const liveStatus = fresh.parse_issues.length > 0 ? STATUS.UNPARSED : STATUS.OPEN;
  if (!stored) {
    return {
      espn_transaction_id: fresh.espn_transaction_id,
      ...Object.fromEntries(ESPN_FIELDS.map((k) => [k, fresh[k]])),
      status: liveStatus,
      triage: { state: "new" },
      decision: null,
      score: null,
      shadow_policy: null,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
      missed_reads: 0,
    };
  }
  const changed = stored.fingerprint !== fresh.fingerprint;
  return {
    ...stored,
    ...Object.fromEntries(ESPN_FIELDS.map((k) => [k, fresh[k]])),
    status: stored.status === STATUS.RESPONDING ? STATUS.RESPONDING : liveStatus,
    triage: changed && stored.triage?.state === "dismissed" ? { state: "new" } : stored.triage,
    last_seen_at: seenAt,
    missed_reads: 0,
  };
}

function normalizeComment(comment) {
  const text = typeof comment === "string" ? comment.trim() : "";
  return text === "" ? null : text;
}

/**
 * The approval key for one response to one version of one offer. core-pipeline's decision
 * endpoint must compute the same digest, as compute_offer_key mirrors trade_builder.js's
 * computeOfferKey. The executor recomputes it from a fresh read, so an approval can't carry over
 * to an offer the other manager changed or replaced.
 */
function computeDecisionKey({ leagueId, seasonId, ourTeamId, transactionId, action, fingerprint, comment }) {
  return sha256([
    DECISION_KEY_VERSION,
    String(leagueId),
    String(seasonId),
    String(ourTeamId),
    String(transactionId),
    action,
    fingerprint,
    normalizeComment(comment),
  ]);
}

/**
 * The POST /v1/trade/score body for an entry, scored from our side. The scorer needs at least
 * one player each way and two teams. Draft picks and FAAB are outside its model, so they are
 * reported as `partialReasons` rather than silently ignored.
 */
function buildScoreRequest(entry, { leagueId, season, week }) {
  if (entry.parse_issues.includes(MULTI_TEAM_ISSUE)) return { unscorable: "multi_team_trade" };
  if (entry.send_espn_ids.length === 0 || entry.receive_espn_ids.length === 0) {
    return { unscorable: "one_sided_trade" };
  }
  return {
    request: {
      league_id: String(leagueId),
      season,
      week,
      our_team_id: entry.our_team_id,
      counterparty_team_id: entry.proposing_team_id,
      send_espn_ids: entry.send_espn_ids,
      receive_espn_ids: entry.receive_espn_ids,
    },
    partialReasons: entry.other_items.length > 0 ? ["non_player_items_not_scored"] : [],
  };
}

function emptyScore(state, { fingerprint, scoredAt, week, retry, error = null, reasons = [] }) {
  return {
    state,
    scoring_version: null,
    as_of_week: week,
    final_score: null,
    complete_horizon: null,
    unavailable_reasons: reasons,
    raw_delta_vorp: null,
    exceeds_roster_limit: null,
    unmapped_espn_ids: [],
    partial_reasons: [],
    players: {},
    scored_fingerprint: fingerprint,
    scored_at: scoredAt,
    retry,
    stale: false,
    error,
  };
}

/** An entry buildScoreRequest refused. Rescored only when the offer or the week changes. */
function unscorableScore(reason, meta) {
  return emptyScore("unscorable", { ...meta, retry: false, reasons: [reason] });
}

/**
 * A 200 from POST /v1/trade/score, kept as the evidence the inbox ranks and shows. A missing
 * final score is core's deterministic answer for this week, not a failure, so it isn't retried
 * until the offer or the week changes.
 */
function scoreFromResponse(body, { fingerprint, scoredAt, partialReasons }) {
  const finalScore = body.score?.final_score ?? null;
  const unmapped = body.coverage?.unmapped_traded_espn_ids ?? [];
  const complete = body.horizon?.complete_horizon === true;
  const players = {};
  for (const player of [...(body.send || []), ...(body.receive || [])]) {
    players[player.espn_id] = { player_id: player.player_id ?? null, name: player.name ?? null };
  }
  let state = "unavailable";
  if (finalScore !== null) {
    state = complete && unmapped.length === 0 && partialReasons.length === 0 ? "scored" : "incomplete";
  }
  return {
    state,
    scoring_version: body.scoring_version ?? null,
    as_of_week: body.as_of_week ?? null,
    final_score: finalScore,
    complete_horizon: complete,
    unavailable_reasons: body.score?.final_score_unavailable_reasons ?? [],
    raw_delta_vorp: body.raw_vorp?.delta_vorp ?? null,
    exceeds_roster_limit: body.roster_impact?.us?.exceeds_roster_limit ?? null,
    unmapped_espn_ids: unmapped,
    partial_reasons: partialReasons,
    players,
    scored_fingerprint: fingerprint,
    scored_at: scoredAt,
    retry: false,
    stale: false,
    error: null,
  };
}

const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;

/**
 * A failed score call. `status` is undefined for a network failure, timeout or bad JSON.
 * - 409: a traded player is no longer where the offer says, so ESPN will likely fail the trade.
 * - 422: core rejected the request.
 * - Anything else is transient. The last score for this same offer is kept, marked stale, and
 *   retried on the next refresh.
 */
function scoreAfterFailure(previous, { status, message }, { fingerprint, scoredAt, week }) {
  const meta = { fingerprint, scoredAt, week, error: message };
  if (status === HTTP_CONFLICT) return emptyScore("stale_ownership", { ...meta, retry: false });
  if (status === HTTP_UNPROCESSABLE) return emptyScore("unscorable", { ...meta, retry: false });
  if (previous && previous.scored_fingerprint === fingerprint && typeof previous.final_score === "number") {
    return { ...previous, stale: true, retry: true, error: message };
  }
  return emptyScore("unavailable", { ...meta, retry: true });
}

function needsScore(entry, week) {
  const score = entry.score;
  return (
    !score ||
    score.scored_fingerprint !== entry.fingerprint ||
    score.as_of_week !== week ||
    score.retry === true
  );
}

function isHidden(entry, now) {
  const triage = entry.triage || {};
  if (triage.state === "dismissed") return true;
  if (triage.state === "snoozed") return timestampMs(triage.snooze_until) > now.getTime();
  return false;
}

function sortableTime(value) {
  const ms = timestampMs(value);
  return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * Inbox order. Offers with a final score come first, best first. Every other offer follows,
 * soonest expiry first, since time is all there is to go on. raw_delta_vorp is evidence only and
 * never orders anything: it is a different, single-week measure.
 */
function rankInbox(entries, { now, includeHidden = false }) {
  const visible = includeHidden
    ? entries
    : entries.filter((e) => LIVE_STATUSES.has(e.status) && !isHidden(e, now));
  const scoreOf = (e) => (typeof e.score?.final_score === "number" ? e.score.final_score : null);
  return [...visible].sort((a, b) => {
    const [sa, sb] = [scoreOf(a), scoreOf(b)];
    if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
    if (sa !== null && sa !== sb) return sb - sa;
    return (
      sortableTime(a.expiration_date) - sortableTime(b.expiration_date) ||
      sortableTime(a.proposed_date) - sortableTime(b.proposed_date) ||
      a.espn_transaction_id.localeCompare(b.espn_transaction_id)
    );
  });
}

function isThreshold(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * What a score-threshold policy would do with this offer. It is recorded for calibration and
 * never acted on: nothing reads it to send or queue a response. It abstains whenever the score
 * leaves out something that matters to the trade.
 */
function shadowPolicy(score, { acceptMin, declineMax }) {
  const thresholds = {
    accept_min: isThreshold(acceptMin) ? acceptMin : null,
    decline_max: isThreshold(declineMax) ? declineMax : null,
  };
  const verdict = (would, reason) => ({ would, reason, thresholds, policy_version: SHADOW_POLICY_VERSION });

  if (thresholds.accept_min === null && thresholds.decline_max === null) {
    return verdict("none", "no thresholds configured");
  }
  if (thresholds.accept_min !== null && thresholds.decline_max !== null && thresholds.accept_min <= thresholds.decline_max) {
    return verdict("none", "invalid thresholds");
  }
  if (typeof score?.final_score !== "number") return verdict("none", "no final score");
  if (score.stale) return verdict("none", "score is stale");
  if ((score.unmapped_espn_ids || []).length > 0) return verdict("none", "unmapped traded players");
  if (score.exceeds_roster_limit) return verdict("none", "roster limit exceeded; drops are not simulated");
  if ((score.partial_reasons || []).length > 0) return verdict("none", "non-player items not scored");
  if (thresholds.accept_min !== null && score.final_score >= thresholds.accept_min) {
    return verdict("accept", "final score at or above accept threshold");
  }
  if (thresholds.decline_max !== null && score.final_score <= thresholds.decline_max) {
    return verdict("decline", "final score at or below decline threshold");
  }
  return verdict("none", "between thresholds");
}

function isPendingRow(row) {
  return row.isPending === true || row.status === "PENDING";
}

function statusFromRelated(row) {
  switch (row.type) {
    case "TRADE_ACCEPT":
      if (isPendingRow(row)) return STATUS.ACCEPTED_PENDING_PROCESSING;
      return row.status === "EXECUTED" ? STATUS.ACCEPTED : null;
    case "TRADE_DECLINE":
      return STATUS.DECLINED;
    case "TRADE_VETO":
      return STATUS.VETOED;
    case "TRADE_PROPOSAL":
      return STATUS.COUNTERED;
    default:
      return null;
  }
}

/**
 * Why an entry missing from the latest successful pending read is gone, or null when there is
 * nothing to change. Explicit evidence (a related history row, our counter, the offer's own
 * history row) wins over the expiry clock. An unexplained disappearance only closes the entry
 * after MISSED_READS_BEFORE_CLOSE reads. An entry we are responding to is never retired here:
 * the response executor owns it until it reconciles.
 */
function resolveExit(entry, { now, history, outgoing }) {
  if (entry.status === STATUS.RESPONDING || FINISHED_STATUSES.has(entry.status)) return null;
  const id = entry.espn_transaction_id;
  const related = history.filter((row) => String(row.relatedTransactionId) === id);

  if (entry.status === STATUS.ACCEPTED_PENDING_PROCESSING) {
    const executed = related.some((row) => row.type === "TRADE_ACCEPT" && row.status === "EXECUTED" && !isPendingRow(row));
    return executed ? { status: STATUS.ACCEPTED, missed_reads: 0, exit_reason: "accept executed" } : null;
  }

  for (const row of [...related].reverse()) {
    const status = statusFromRelated(row);
    if (status) return { status, missed_reads: 0, exit_reason: `${row.type} ${row.status ?? ""}`.trim() };
  }
  if (outgoing.some((t) => String(t.relatedTransactionId) === id)) {
    return { status: STATUS.COUNTERED, missed_reads: 0, exit_reason: "our counter is pending" };
  }
  const own = history.find((row) => String(row.id) === id);
  if (own && WITHDRAWN_HISTORY_STATUSES.has(own.status)) {
    return { status: STATUS.WITHDRAWN, missed_reads: 0, exit_reason: `history status ${own.status}` };
  }
  if (sortableTime(entry.expiration_date) <= now.getTime()) {
    return { status: STATUS.EXPIRED, missed_reads: 0, exit_reason: "past expirationDate" };
  }
  const missed = (entry.missed_reads || 0) + 1;
  if (missed >= MISSED_READS_BEFORE_CLOSE) {
    return { status: STATUS.CLOSED_UNKNOWN, missed_reads: missed, exit_reason: "left the pending list unexplained" };
  }
  return { status: entry.status, missed_reads: missed, exit_reason: null };
}

/**
 * A trade_negotiations payload for countering this offer. negotiateTradeProposal works in
 * core-pipeline's internal id space, and ESPN ids collide with it numerically. So the ids come
 * from the score response's own espn_id -> player_id evidence, never from a numeric match. An
 * unmapped player refuses the counter.
 */
function buildNegotiationPayload(entry, { season, week, trackingId }) {
  const players = entry.score?.players || {};
  const internal = (espnId) => {
    const playerId = players[espnId]?.player_id;
    if (!playerId) {
      throw new PermanentError(
        `[Trade Inbox] Player ${espnId} has no internal id in core's score, so a counter can't be negotiated.`,
      );
    }
    return playerId;
  };
  return {
    tracking_id: trackingId,
    season,
    week,
    offering_team_id: entry.proposing_team_id,
    incoming_player_ids: entry.receive_espn_ids.map(internal),
    outgoing_player_ids: entry.send_espn_ids.map(internal),
  };
}

const RESPONSE_OUTCOMES = {
  accept: new Set([STATUS.ACCEPTED, STATUS.ACCEPTED_PENDING_PROCESSING]),
  decline: new Set([STATUS.DECLINED]),
};

/**
 * What ESPN shows after we sent `action` for an offer. The reads are a fresh pending read and the
 * trade history. A related row confirming the action wins. A decline is also confirmed by the
 * offer simply leaving the pending list. An accept needs ESPN's own accept row, because a
 * withdrawn or expired offer leaves the same way. Any other evidence is `conflict`, and no
 * evidence is `still_pending` or `unknown`. A caller must not resend in any of those cases.
 */
function verifyResponse({ action, transactionId, trades, history }) {
  const id = String(transactionId);
  const related = [...history, ...trades.filter((t) => t.type === "TRADE_ACCEPT")].filter(
    (row) => String(row.relatedTransactionId) === id,
  );
  for (const row of [...related].reverse()) {
    const observed = statusFromRelated(row);
    if (!observed) continue;
    if (RESPONSE_OUTCOMES[action].has(observed)) return { status: observed, observed };
    return { status: "conflict", observed };
  }
  if (trades.some((t) => String(t.id) === id && t.type === "TRADE_PROPOSAL")) {
    return { status: "still_pending", observed: null };
  }
  return action === "decline"
    ? { status: STATUS.DECLINED, observed: "left the pending list" }
    : { status: "unknown", observed: "left the pending list without an accept row" };
}

module.exports = {
  verifyResponse,
  STATUS,
  LIVE_STATUSES,
  MISSED_READS_BEFORE_CLOSE,
  splitPendingTrades,
  toInboxEntry,
  tradeFingerprint,
  mergeEntry,
  computeDecisionKey,
  buildScoreRequest,
  scoreFromResponse,
  scoreAfterFailure,
  unscorableScore,
  needsScore,
  rankInbox,
  shadowPolicy,
  resolveExit,
  buildNegotiationPayload,
};
