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
 *      the other manager changed or replaced, to the other action, or to a different note.
 *   4. The action is in espn_api.js's VERIFIED_TRADE_RESPONSE_ACTIONS, which starts out empty: no
 *      accept or decline request has been captured yet.
 *   5. espn_api.js's PENDING_TRADE_SHAPE_VERIFIED is true, which needs a captured pending trade.
 * With any of them closed, the run is dry: it builds and records the body it would have sent, and
 * posts nothing.
 *
 * Before any of that, these always refuse with a PermanentError, whatever the switches say:
 * - an offer that is gone or about to expire;
 * - an offer not in the inbox, or already being responded to;
 * - an approval that doesn't match;
 * - for an accept, a locked roster, no current score, or a trade that takes us over the roster
 *   limit (core doesn't simulate the drop that would need).
 *
 * Idempotency follows trade_builder.js. The decision key is claimed in execution_log under an
 * advisory lock before the POST, and the activity is marked as an external write. After the POST,
 * or when its outcome is unknown, ESPN is read back and only a confirming read settles it. A
 * redelivery of a responded key does nothing. A key left `responding` is reconciled by reading.
 * Nothing here ever posts a second time. Anything the reads can't confirm stops for manual
 * verification in ESPN.
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
const { loadInbox, updateEntry } = require("../db/trade_inbox");
const { claimTradeResponse, finalizeTradeResponse, recordTradeResponseBlocked } = require("../db/execution_log");
const activity = require("../db/activity");
const { PermanentError, SessionExpiredError, requirePlainObjectPayload } = require("../errors");
const { STATUS, toInboxEntry, computeDecisionKey, verifyResponse } = require("../lib/trade_inbox");
const { logger } = require("../telemetry/logger");

const LABEL = "[Trade Response]";
const ACTIONS = ["accept", "decline"];
// ESPN may process an expiry before ours, so a response this close to it could cross with the
// expiry and leave an unknowable outcome.
const RESPONSE_EXPIRY_MARGIN_MS = 5 * 60_000;
// Same value and reason as trade_bot.js's TRANSIENT_RETRY_DELAY_MS: a bare nack would hot-loop a
// Chromium launch under connection.js's channel-wide prefetch(1).
const TRANSIENT_RETRY_DELAY_MS = 5000;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const PAYLOAD_ARGUMENT_INDEX = 2;
const CONFIRMED_OUTCOMES = new Set([STATUS.DECLINED, STATUS.ACCEPTED, STATUS.ACCEPTED_PENDING_PROCESSING]);

function resolveDryRun() {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return true;
  return !/^(0|false|no)$/i.test(raw);
}

function isResponseArmed() {
  return /^(1|true|yes)$/i.test((process.env.TRADE_RESPONSE_ENABLED || "").trim());
}

function requireResponsePayload(payload) {
  requirePlainObjectPayload(payload, LABEL);
  const { espn_transaction_id: transactionId, action, comment, approval } = payload;
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
      typeof approval.approved_by === "string" &&
      approval.approved_by.trim() !== "";
    if (!valid) throw new PermanentError(`${LABEL} approval needs a 64-hex decision_key and approved_by.`);
  }
  return { transactionId, action, comment: comment ?? null, approval: approval ?? null };
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
  claim: claimTradeResponse,
  finalize: finalizeTradeResponse,
  recordBlocked: recordTradeResponseBlocked,
  beforeExternalWrite: activity.beforeExternalWrite,
  submit: submitTradeResponse,
  activityEvent: (stage, detail) => activity.event(stage, detail, "failed", "unknown"),
  verifiedActions: VERIFIED_TRADE_RESPONSE_ACTIONS,
  shapeVerified: PENDING_TRADE_SHAPE_VERIFIED,
});

function closedLocks({ approval, action }, deps) {
  const locks = [];
  if (resolveDryRun()) locks.push("dry_run");
  if (!isResponseArmed()) locks.push("not_armed");
  if (!approval) locks.push("no_approval");
  if (!deps.verifiedActions.includes(action)) locks.push("request_shape_unverified");
  if (!deps.shapeVerified) locks.push("pending_shape_unverified");
  return locks;
}

function preflightAccept(stored, fresh, roster, transactionId) {
  if (roster.rosterLocked) {
    throw new PermanentError(`${LABEL} Our roster is locked, so offer ${transactionId} can't be accepted now.`);
  }
  const score = stored.score;
  if (!score || score.scored_fingerprint !== fresh.fingerprint) {
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

/**
 * Reads ESPN back and settles the claim. Only a confirming read finalizes it as responded.
 * Anything else stops for a human: the response may or may not have landed, and resending could
 * answer the offer twice.
 */
async function settle({ context, claimId, transactionId, action, scope, deps, reason }) {
  let verdict;
  try {
    const [{ trades }, history] = await Promise.all([
      deps.readPending(context, { leagueId: scope.leagueId, seasonId: String(scope.season), teamId: scope.teamId }),
      deps.readHistory(context, { leagueId: scope.leagueId, seasonId: String(scope.season) }),
    ]);
    verdict = verifyResponse({ action, transactionId, trades, history });
  } catch (error) {
    verdict = { status: "unknown", observed: `verification read failed: ${error.message}` };
  }

  if (CONFIRMED_OUTCOMES.has(verdict.status)) {
    await deps.finalize(claimId, "responded", null);
    await deps.updateEntry(transactionId, scope, (current) =>
      current && { ...current, status: verdict.status, decision: { ...current.decision, outcome: verdict.status } },
    );
    return verdict.status;
  }

  const message =
    `${LABEL} Could not confirm the ${action} of offer ${transactionId} (${verdict.status}` +
    `${verdict.observed ? `: ${verdict.observed}` : ""}${reason ? `; ${reason}` : ""}). ` +
    "It needs manual verification in ESPN before anything else is sent.";
  await deps.finalize(claimId, "response_unknown", message);
  await deps.updateEntry(transactionId, scope, (current) =>
    current && { ...current, decision: { ...current.decision, outcome: "unknown", verification: verdict } },
  );
  await deps.activityEvent("manual_verification_required", { transactionId, action, verdict });
  throw new PermanentError(message);
}

async function executeTradeResponse(payload, overrides = {}) {
  const request = requireResponsePayload(payload);
  const { transactionId, action, comment, approval } = request;
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

    session = await deps.openSession();
    const { trades } = await deps.readPending(session.context, { leagueId, seasonId: String(season), teamId });
    const offer = trades.find((t) => String(t.id) === transactionId && t.type === "TRADE_PROPOSAL");
    if (!offer || offer.proposingTeamId === String(teamId)) {
      throw new PermanentError(`${LABEL} Offer ${transactionId} is no longer pending to us.`);
    }
    const stored = await deps.loadEntry(transactionId, { leagueId });
    if (!stored) throw new PermanentError(`${LABEL} Offer ${transactionId} is not in the inbox.`);
    if (stored.status === STATUS.RESPONDING) {
      throw new PermanentError(`${LABEL} Offer ${transactionId} is already being responded to; reconcile it first.`);
    }

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
    if (new Date(fresh.expiration_date ?? NaN).getTime() - now.getTime() <= RESPONSE_EXPIRY_MARGIN_MS) {
      throw new PermanentError(`${LABEL} Offer ${transactionId} expires too soon to respond safely.`);
    }

    const roster = await deps.readRoster(session.context, { leagueId, seasonId: String(season), teamId });
    if (action === "accept") preflightAccept(stored, fresh, roster, transactionId);

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
      await deps.updateEntry(transactionId, scope, (current) =>
        current && { ...current, decision: { ...decision, outcome: "blocked", closed_locks: locks, at: now.toISOString() } },
      );
      return { status: "response_blocked", closedLocks: locks, decisionKey, wouldSend };
    }

    const claim = await deps.claim(decisionKey, {
      leagueId,
      season,
      transactionId,
      proposingTeamId: fresh.proposing_team_id,
      action,
      comment,
      approvedBy: approval.approved_by,
    });
    if (!claim.claimed && claim.existing === "responded") {
      logger.info(`${LABEL} Decision ${decisionKey} was already sent; nothing to do.`);
      return { status: "duplicate", decisionKey };
    }
    if (!claim.claimed) {
      const outcome = await settle({ context: session.context, claimId: claim.id, transactionId, action, scope, deps, reason: "found a claim left responding" });
      return { status: "responded", outcome, decisionKey, reconciled: true };
    }

    const previousStatus = stored.status;
    await deps.updateEntry(transactionId, scope, (current) =>
      current && { ...current, status: STATUS.RESPONDING, decision: { ...decision, outcome: "pending", claimed_at: now.toISOString() } },
    );
    await deps.beforeExternalWrite();

    const reopen = (outcome, extra) =>
      deps.updateEntry(transactionId, scope, (current) =>
        current && { ...current, status: previousStatus, decision: { ...current.decision, outcome, ...extra } },
      );

    let unknownReason = null;
    try {
      await deps.submit(session.context, submission);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        // ESPN refused the session, so the response wasn't processed. A fresh approval is needed,
        // because this claim's activity is already marked as an external write.
        await deps.finalize(claim.id, "rejected", error.message);
        await reopen("rejected", { error: "session expired" });
        throw new PermanentError(`${LABEL} ESPN rejected the session; refresh it and approve the response again.`);
      }
      if (error.permanent) {
        await deps.finalize(claim.id, "rejected", error.message);
        await reopen("rejected", { error: error.message, details: error.details ?? [] });
        throw error;
      }
      unknownReason = `send outcome unknown: ${error.message}`;
      logger.warn(`${LABEL} ${unknownReason}; reading ESPN back instead of retrying.`);
    }

    const outcome = await settle({ context: session.context, claimId: claim.id, transactionId, action, scope, deps, reason: unknownReason });
    logger.info(`${LABEL} Offer ${transactionId}: ${action} confirmed as ${outcome}.`);
    return { status: "responded", outcome, decisionKey };
  } catch (error) {
    if (!error.permanent && error.retryDelayMs === undefined) error.retryDelayMs = TRANSIENT_RETRY_DELAY_MS;
    throw error;
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
        `'{"espn_transaction_id":"...","action":"decline","approval":{"decision_key":"<64 hex>","approved_by":"you"}}'`,
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
