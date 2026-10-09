/**
 * Accepts or declines one incoming offer from the trade inbox: the `trade_responses` queue.
 *
 * THIS ANSWERS REAL TRADE OFFERS FROM OTHER MANAGERS. Accepting moves players on a real roster,
 * and neither action can be undone. A response is sent only when every one of these is true:
 *   1. DRY_RUN is explicitly false. Unset means true, the convention waiver_sniper.js and
 *      trade_builder.js use.
 *   2. TRADE_RESPONSE_ENABLED=true. This is its own switch: arming outgoing offers
 *      (TRADE_SUBMIT_ENABLED) doesn't arm responses.
 *   3. A human approval {decision_key, approved_by} is present, and decision_key equals the key
 *      recomputed from a FRESH pending read. An approval therefore can't carry over to an offer
 *      the other manager changed or replaced, to the other action, or to a different response note.
 *      approval.reviewed_note must also equal the exact proposer note from that fresh read.
 *   4. The action is in espn_api.js's VERIFIED_TRADE_RESPONSE_ACTIONS, which starts out empty: no
 *      accept or decline request has been captured yet.
 *   5. espn_api.js's PENDING_TRADE_SHAPE_VERIFIED is true, which needs a captured pending trade.
 * With any of them closed, the run is dry: it builds and records the body it would have sent, and
 * posts nothing.
 *
 * Before any of that, these always refuse with a PermanentError, whatever the switches say:
 * - an offer that is gone or about to expire;
 * - an offer not in the inbox, not open, or changed since it was read;
 * - an offer another response already claimed, including one ESPN rejected;
 * - an approval that doesn't match;
 * - for an accept, a locked roster, no current score, or a trade that takes us over the roster
 *   limit (core doesn't simulate the drop that would need).
 *
 * Order of work, so nothing is ever sent twice:
 *   1. Reconcile first. If the approval's key already has a claim, settle it from ESPN reads and
 *      stop: a responded key is a duplicate, and a responding or unknown one is read back, never
 *      resent. This runs before any fresh-offer check, because a processed response usually
 *      means the offer has left the pending list.
 *   2. Check the fresh read: the offer, the approval key, expiry and the roster.
 *   3. Claim the offer atomically (db/trade_inbox.js claimOfferResponse). Under the offer's lock
 *      the stored entry is re-read and checked again. Any other key's claim on the offer refuses,
 *      so an accept and a decline can't both go out. The claim row and the entry's `responding`
 *      status are written together.
 *   4. Mark the activity as an external write, POST once, then read ESPN back. Only a confirming
 *      read settles it as responded; anything else stops for manual verification in ESPN.
 *
 * A human can retry a claim that ESPN rejected, or one whose outcome is unknown, by sending the
 * approval again with `retry: {of_claim_id, approved_by, verified_not_answered}` and a new
 * tracking id. An unknown outcome is retried only with verified_not_answered (someone checked ESPN)
 * and when a fresh read still shows the offer pending with no related history row. The retried
 * claim is marked superseded in the same transaction as the new claim.
 */

const { createAuthenticatedSession, createSessionFromStoredState } = require("./auth");
const {
  readPendingTrades,
  readTradeHistory,
  readRoster,
  buildTradeResponseBody,
  submitTradeResponse,
  VERIFIED_TRADE_RESPONSE_ACTIONS,
  PENDING_TRADE_SHAPE_VERIFIED,
} = require("./espn_api");
const { readSeason, resolvePeriod } = require("./trade_scan");
const { loadInbox, updateEntry, claimOfferResponse, settleOfferResponse } = require("../db/trade_inbox");
const { findTradeResponse, recordTradeResponseOutcome, recordTradeResponseBlocked } = require("../db/execution_log");
const activity = require("../db/activity");
const { PermanentError, SessionExpiredError, requirePlainObjectPayload, withRetryDelay } = require("../errors");
const { STATUS, toInboxEntry, computeDecisionKey, verifyResponse } = require("../lib/trade_inbox");
const { resolveDryRun } = require("../lib/env");
const { logger } = require("../telemetry/logger");

const LABEL = "[Trade Response]";
const ACTIONS = ["accept", "decline"];
// ESPN may process an expiry before ours, so a response this close to it could cross with the
// expiry and leave an unknowable outcome.
const RESPONSE_EXPIRY_MARGIN_MS = 5 * 60_000;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const PAYLOAD_ARGUMENT_INDEX = 2;
const CONFIRMED_OUTCOMES = new Set([STATUS.DECLINED, STATUS.ACCEPTED, STATUS.ACCEPTED_PENDING_PROCESSING]);

function isResponseArmed() {
  return /^(1|true|yes)$/i.test((process.env.TRADE_RESPONSE_ENABLED || "").trim());
}

const isNonBlank = (value) => typeof value === "string" && value.trim() !== "";

function requireRetry(retry) {
  const valid =
    typeof retry === "object" &&
    (typeof retry.of_claim_id === "number" || typeof retry.of_claim_id === "string") &&
    /^[1-9]\d*$/.test(String(retry.of_claim_id)) &&
    isNonBlank(retry.approved_by) &&
    (retry.verified_not_answered === undefined || typeof retry.verified_not_answered === "boolean");
  if (!valid) {
    throw new PermanentError(
      `${LABEL} retry needs a positive of_claim_id, approved_by, and a boolean verified_not_answered when given.`,
    );
  }
  return retry;
}

function requireResponsePayload(payload) {
  requirePlainObjectPayload(payload, LABEL);
  const { espn_transaction_id: transactionId, action, comment, approval, retry } = payload;
  if (typeof transactionId !== "string" || transactionId.trim() === "") {
    throw new PermanentError(`${LABEL} espn_transaction_id must be a non-empty string.`);
  }
  if (!ACTIONS.includes(action)) {
    throw new PermanentError(`${LABEL} action must be accept or decline.`);
  }
  if (comment !== undefined && comment !== null && typeof comment !== "string") {
    throw new PermanentError(`${LABEL} comment must be a string when given.`);
  }
  if (approval !== undefined && approval !== null) {
    const valid =
      typeof approval === "object" &&
      typeof approval.decision_key === "string" &&
      /^[0-9a-f]{64}$/.test(approval.decision_key) &&
      isNonBlank(approval.approved_by);
    if (!valid) throw new PermanentError(`${LABEL} approval needs a 64-hex decision_key and approved_by.`);
    if (
      Object.prototype.hasOwnProperty.call(approval, "reviewed_note") &&
      approval.reviewed_note !== null &&
      typeof approval.reviewed_note !== "string"
    ) {
      throw new PermanentError(`${LABEL} approval.reviewed_note must be a string or null.`);
    }
  }
  return {
    transactionId,
    action,
    comment: comment ?? null,
    approval: approval ?? null,
    retry: retry === undefined || retry === null ? null : requireRetry(retry),
  };
}

const defaultDeps = () => ({
  readState: readSeason,
  openSession: async () => (await createSessionFromStoredState()) ?? (await createAuthenticatedSession()),
  readPending: readPendingTrades,
  readHistory: readTradeHistory,
  readRoster,
  loadEntry: async (id, { leagueId }) =>
    (await loadInbox({ leagueId })).find((e) => e.espn_transaction_id === id) ?? null,
  updateEntry,
  findResponse: findTradeResponse,
  claimOffer: claimOfferResponse,
  settleOffer: settleOfferResponse,
  recordOutcome: recordTradeResponseOutcome,
  recordBlocked: recordTradeResponseBlocked,
  beforeExternalWrite: activity.beforeExternalWrite,
  submit: submitTradeResponse,
  activityEvent: (stage, detail) => activity.event(stage, detail, "failed", "unknown"),
  verifiedActions: VERIFIED_TRADE_RESPONSE_ACTIONS,
  shapeVerified: PENDING_TRADE_SHAPE_VERIFIED,
});

function closedLocks({ approval, action }, deps) {
  const locks = [];
  if (resolveDryRun(true).dryRun) locks.push("dry_run");
  if (!isResponseArmed()) locks.push("not_armed");
  if (!approval) locks.push("no_approval");
  if (!deps.verifiedActions.includes(action)) locks.push("request_shape_unverified");
  if (!deps.shapeVerified) locks.push("pending_shape_unverified");
  return locks;
}

/** The accept checks on an entry's stored score. Run on the snapshot, then again under the lock. */
function requireCurrentScore(entry, fingerprint, transactionId) {
  const score = entry.score;
  if (!score || score.scored_fingerprint !== fingerprint) {
    throw new PermanentError(
      `${LABEL} Offer ${transactionId} has no current score; refresh the inbox before accepting.`,
    );
  }
  if (score.exceeds_roster_limit) {
    throw new PermanentError(
      `${LABEL} Accepting offer ${transactionId} would put us over the roster limit, and the drop ESPN would require isn't chosen here.`,
    );
  }
}

// The entry a claim marked responding. Settling never rewrites an entry some other decision owns.
const ownsEntry = (current, decisionKey) =>
  Boolean(current) && (current.status === STATUS.RESPONDING || current.decision?.decision_key === decisionKey);

async function readVerdict({ context, transactionId, action, scope, deps }) {
  try {
    const [{ trades }, history] = await Promise.all([
      deps.readPending(context, { leagueId: scope.leagueId, seasonId: String(scope.season), teamId: scope.teamId }),
      deps.readHistory(context, { leagueId: scope.leagueId, seasonId: String(scope.season) }),
    ]);
    return { verdict: verifyResponse({ action, transactionId, trades, history }), trades, history };
  } catch (error) {
    return { verdict: { status: "unknown", observed: `verification read failed: ${error.message}` }, trades: null, history: null };
  }
}

/**
 * Settles a claim and its inbox entry in one transaction. If that write fails after ESPN gave an
 * answer, the claim stays as it was, which the next run reconciles by reading. The run stops as
 * permanent rather than being requeued.
 */
async function recordSettlement({ claimId, transactionId, action, scope, deps }, ledgerStatus, errorMessage, mutate, observed) {
  let result;
  try {
    result = await deps.settleOffer(transactionId, scope, { claimId, ledgerStatus, errorMessage, mutate });
  } catch (error) {
    const message =
      `${LABEL} The ${action} of offer ${transactionId} settled as ${observed ?? ledgerStatus}, but that couldn't be ` +
      `recorded (${error.message}). A later run reconciles it by reading ESPN; nothing will be resent.`;
    logger.error(message, { err: error });
    await deps.activityEvent("manual_verification_required", { transactionId, action, ledgerStatus, error: error.message });
    throw new PermanentError(message);
  }
  if (result?.settled !== false) await deps.recordOutcome(claimId, ledgerStatus, errorMessage);
}

/**
 * Reads ESPN back, unless `read` already did, and settles the claim. Only a confirming read
 * finalizes it as responded. Anything else stops for a human: the response may or may not have
 * landed, and resending could answer the offer twice.
 */
async function settle(ctx) {
  const { transactionId, action, decisionKey, deps, reason } = ctx;
  const { verdict } = ctx.read ?? (await readVerdict(ctx));

  if (CONFIRMED_OUTCOMES.has(verdict.status)) {
    await recordSettlement(
      ctx,
      "responded",
      null,
      (current) =>
        ownsEntry(current, decisionKey)
          ? { ...current, status: verdict.status, decision: { ...current.decision, outcome: verdict.status } }
          : null,
      verdict.status,
    );
    return verdict.status;
  }

  const message =
    `${LABEL} Could not confirm the ${action} of offer ${transactionId} (${verdict.status}` +
    `${verdict.observed ? `: ${verdict.observed}` : ""}${reason ? `; ${reason}` : ""}). ` +
    "It needs manual verification in ESPN before anything else is sent.";
  await recordSettlement(ctx, "response_unknown", message, (current) =>
    ownsEntry(current, decisionKey)
      ? { ...current, decision: { ...current.decision, outcome: "unknown", verification: verdict } }
      : null,
  );
  await deps.activityEvent("manual_verification_required", { transactionId, action, verdict });
  throw new PermanentError(message);
}

/** Refuses a retry of an unknown outcome unless a human and a fresh read both say it wasn't answered. */
function requireUnknownRetryable({ verdict, history }, retry, transactionId) {
  if (retry.verified_not_answered !== true) {
    throw new PermanentError(
      `${LABEL} Retrying offer ${transactionId} after an unknown outcome needs confirmation that someone checked ESPN and it wasn't answered.`,
    );
  }
  if (history === null) {
    throw new PermanentError(`${LABEL} Couldn't read ESPN to check offer ${transactionId} before a retry: ${verdict.observed}.`);
  }
  if (verdict.status !== "still_pending") {
    throw new PermanentError(
      `${LABEL} ESPN no longer shows offer ${transactionId} plainly pending (${verdict.status}); check it before retrying.`,
    );
  }
  if (history.some((row) => String(row.relatedTransactionId) === transactionId)) {
    throw new PermanentError(
      `${LABEL} ESPN's trade history has a row related to offer ${transactionId}; check it before retrying.`,
    );
  }
}

/**
 * Handles a key that already has a claim, without ever posting. Returns {result} when the run is
 * done, or {retryable: true} when a human retry may supersede the claim.
 */
async function reconcileClaim(ctx, existing, retry) {
  const { transactionId, action, decisionKey } = ctx;
  if (existing.status === "responded") {
    logger.info(`${LABEL} Decision ${decisionKey} was already sent; nothing to do.`);
    return { result: { status: "duplicate", decisionKey } };
  }
  if (existing.status === "rejected") {
    if (retry) return { retryable: true };
    throw new PermanentError(
      `${LABEL} ESPN rejected the earlier ${action} of offer ${transactionId}. It stays blocked until someone retries it from the inbox.`,
    );
  }

  const read = await readVerdict(ctx);
  if (existing.status === "response_unknown" && retry && !CONFIRMED_OUTCOMES.has(read.verdict.status)) {
    requireUnknownRetryable(read, retry, transactionId);
    return { retryable: true };
  }
  const reason = existing.status === "responding" ? "found a claim left responding" : "rechecked an unknown outcome";
  const outcome = await settle({ ...ctx, claimId: existing.id, read, reason });
  return { result: { status: "responded", outcome, decisionKey, reconciled: true } };
}

async function executeTradeResponse(payload, overrides = {}) {
  const request = requireResponsePayload(payload);
  const { transactionId, action, comment, approval, retry } = request;
  const deps = { ...defaultDeps(), ...overrides };
  const now = deps.now ?? new Date();
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const trackingId = payload.tracking_id ?? null;

  let session = null;
  try {
    const period = resolvePeriod(await deps.readState(), now);
    if (!period) throw new PermanentError(`${LABEL} No regular-season week to respond in.`);
    const { season } = period;
    const scope = { leagueId, season, teamId };
    const espnScope = { leagueId, seasonId: String(season), teamId };

    // Reconcile first: a claimed key is settled from reads, before anything that could refuse it
    // as a fresh offer.
    const existing = approval ? await deps.findResponse(approval.decision_key) : null;
    if (existing && (existing.espn_transaction_id !== transactionId || existing.action !== action)) {
      throw new PermanentError(
        `${LABEL} The approval's decision key belongs to a ${existing.action} of offer ${existing.espn_transaction_id}, ` +
          `which doesn't match this ${action} of offer ${transactionId}.`,
      );
    }
    if (existing?.status === "responded") {
      logger.info(`${LABEL} Decision ${approval.decision_key} was already sent; nothing to do.`);
      return { status: "duplicate", decisionKey: approval.decision_key };
    }
    if (existing && retry && String(retry.of_claim_id) !== String(existing.id)) {
      throw new PermanentError(
        `${LABEL} The retry names claim ${retry.of_claim_id}, but this decision's current claim is ${existing.id}; check it again.`,
      );
    }

    session = await deps.openSession();
    const ctx = { context: session.context, transactionId, action, scope, deps };
    let supersedes = null;
    if (existing) {
      const reconciled = await reconcileClaim({ ...ctx, decisionKey: approval.decision_key }, existing, retry);
      if (reconciled.result) return reconciled.result;
      supersedes = {
        id: existing.id,
        status: existing.status,
        trackingId,
        retriedBy: retry.approved_by.trim(),
        verifiedNotAnswered: retry.verified_not_answered === true,
      };
    }

    const { trades } = await deps.readPending(session.context, espnScope);
    const offer = trades.find((t) => String(t.id) === transactionId && t.type === "TRADE_PROPOSAL");
    if (!offer || offer.proposingTeamId === String(teamId)) {
      throw new PermanentError(`${LABEL} Offer ${transactionId} is no longer pending to us.`);
    }
    // An unlocked snapshot: it lets the dry-run path record what it would do. Every check on it
    // is repeated under the offer lock when claiming.
    const stored = await deps.loadEntry(transactionId, { leagueId });
    if (!stored) throw new PermanentError(`${LABEL} Offer ${transactionId} is not in the inbox.`);

    const fresh = toInboxEntry(offer, teamId);
    const decisionKey = computeDecisionKey({
      leagueId,
      seasonId: season,
      ourTeamId: teamId,
      transactionId,
      action,
      fingerprint: fresh.fingerprint,
      comment,
    });
    if (approval && approval.decision_key !== decisionKey) {
      throw new PermanentError(
        `${LABEL} The approval does not match offer ${transactionId} as ESPN shows it now (changed, ` +
          "replaced, or a different action or note). Approve it again from the inbox.",
      );
    }
    // The fingerprint excludes the proposer note. Compare it separately without trimming or
    // treating an empty string as null, so a note-only edit invalidates the human's review.
    if (approval && !Object.prototype.hasOwnProperty.call(approval, "reviewed_note")) {
      throw new PermanentError(`${LABEL} approval.reviewed_note is required before responding. Approve it again from the inbox.`);
    }
    if (approval && approval.reviewed_note !== (offer.comment ?? null)) {
      throw new PermanentError(
        `${LABEL} The proposer note for offer ${transactionId} changed since it was reviewed. Approve it again from the inbox.`,
      );
    }
    if (new Date(fresh.expiration_date ?? NaN).getTime() - now.getTime() <= RESPONSE_EXPIRY_MARGIN_MS) {
      throw new PermanentError(`${LABEL} Offer ${transactionId} expires too soon to respond safely.`);
    }

    const roster = await deps.readRoster(session.context, espnScope);
    if (action === "accept") {
      if (roster.rosterLocked) {
        throw new PermanentError(`${LABEL} Our roster is locked, so offer ${transactionId} can't be accepted now.`);
      }
      requireCurrentScore(stored, fresh.fingerprint, transactionId);
    }

    const submission = {
      leagueId,
      seasonId: String(season),
      teamId,
      memberId: session.swid,
      scoringPeriodId: roster.scoringPeriodId,
      transactionId,
      action,
      comment,
      trackingId,
    };
    const decision = {
      decision_key: decisionKey,
      action,
      comment,
      approved_by: approval?.approved_by ?? null,
      tracking_id: trackingId,
      ...(supersedes ? { retry_of: supersedes.id, retried_by: supersedes.retriedBy } : {}),
    };

    const locks = closedLocks(request, deps);
    if (locks.length > 0) {
      const wouldSend = buildTradeResponseBody(submission);
      logger.info(`${LABEL} Not sending ${action} for offer ${transactionId}: ${locks.join(", ")} closed.`);
      await deps.recordBlocked({
        decisionKey,
        closedLocks: locks,
        body: wouldSend,
        leagueId,
        season,
        transactionId,
        proposingTeamId: fresh.proposing_team_id,
        action,
        comment,
        approvedBy: approval?.approved_by,
      });
      // A dry run never overwrites the decision of a claim in progress.
      await deps.updateEntry(transactionId, scope, (current) =>
        current && current.status !== STATUS.RESPONDING && current.fingerprint === fresh.fingerprint
          ? { ...current, decision: { ...decision, outcome: "blocked", closed_locks: locks, at: now.toISOString() } }
          : null,
      );
      return { status: "response_blocked", closedLocks: locks, decisionKey, wouldSend };
    }

    const claim = await deps.claimOffer(transactionId, scope, {
      decisionKey,
      expectedFingerprint: fresh.fingerprint,
      row: {
        leagueId,
        season,
        transactionId,
        proposingTeamId: fresh.proposing_team_id,
        action,
        comment,
        approvedBy: approval.approved_by,
      },
      decision: { ...decision, outcome: "pending", claimed_at: now.toISOString() },
      validate: action === "accept" ? (entry) => requireCurrentScore(entry, fresh.fingerprint, transactionId) : undefined,
      supersedes,
      now,
    });
    const claimCtx = { ...ctx, decisionKey };
    if (!claim.claimed) {
      // Another delivery of this key claimed it after the lookup above. Settle it; never post.
      const { result } = await reconcileClaim(claimCtx, { id: claim.id, status: claim.existing }, null);
      return result;
    }
    const settleCtx = { ...claimCtx, claimId: claim.id };
    await deps.beforeExternalWrite();

    // ESPN definitely refused, so the offer is open again. This key stays blocked until a human
    // retries it, matching core's gate on rejected responses.
    const reopen = (errorMessage, extra) =>
      recordSettlement(settleCtx, "rejected", errorMessage, (current) =>
        current?.status === STATUS.RESPONDING && current.decision?.decision_key === decisionKey
          ? { ...current, status: STATUS.OPEN, decision: { ...current.decision, outcome: "rejected", ...extra } }
          : null,
      );

    let unknownReason = null;
    try {
      await deps.submit(session.context, submission);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        // ESPN refused the session, so the response wasn't processed. The activity is already
        // marked as an external write, so this delivery can't run again: retry it from the inbox.
        await reopen(error.message, { error: "session expired" });
        throw new PermanentError(`${LABEL} ESPN rejected the session; refresh it and retry the response from the inbox.`);
      }
      if (error.permanent) {
        await reopen(error.message, { error: error.message, details: error.details ?? [] });
        throw error;
      }
      unknownReason = `send outcome unknown: ${error.message}`;
      logger.warn(`${LABEL} ${unknownReason}; reading ESPN back instead of retrying.`);
    }

    const outcome = await settle({ ...settleCtx, reason: unknownReason });
    logger.info(`${LABEL} Offer ${transactionId}: ${action} confirmed as ${outcome}.`);
    return { status: "responded", outcome, decisionKey };
  } catch (error) {
    throw withRetryDelay(error);
  } finally {
    if (session?.browser) await session.browser.close();
  }
}

// Manual runs: node src/bots/trade_response.js '<trade_responses JSON payload>'
if (require.main === module) {
  const raw = process.argv[PAYLOAD_ARGUMENT_INDEX];
  if (!raw) {
    logger.error(
      "Usage: node src/bots/trade_response.js " +
        `'{"espn_transaction_id":"...","action":"decline","approval":{"decision_key":"<64 hex>","approved_by":"you","reviewed_note":null}}'`,
    );
    process.exit(EXIT_FAILURE);
  }
  const parsed = JSON.parse(raw);
  const { withInstrumentation } = require("../telemetry/instrument");
  withInstrumentation(
    "trade_response",
    { trackingId: parsed.tracking_id || require("crypto").randomUUID() },
    () => executeTradeResponse(parsed),
  )
    .then((result) => logger.info(`${LABEL} ${JSON.stringify(result)}`))
    .catch((error) => {
      logger.error(`${LABEL} Run failed: ${error.message}`, { err: error });
      process.exitCode = EXIT_FAILURE;
    })
    .finally(async () => {
      await require("../telemetry/init").shutdownTelemetry();
      process.exit(process.exitCode || EXIT_SUCCESS);
    });
}

module.exports = { executeTradeResponse, requireResponsePayload, RESPONSE_EXPIRY_MARGIN_MS };
