/* eslint-env browser */
// The page.evaluate() callback below runs inside the browser page, not Node — document/window
// are real globals there, hence the browser env for this file.
const { createAuthenticatedSession } = require("./auth");
const {
  PermanentError,
  requirePlainObjectPayload,
  classifyHttpStatusError,
} = require("../errors");
const { logger } = require("../telemetry/logger");

// Same cluster-DNS-default convention as OLLAMA_URL in src/lib/llm_client.js — verified against
// fantasy-infra's base/core-pipeline/fastapi-service.yaml (ClusterIP service
// "fantasy-core-pipeline", port 8000, default namespace).
const CORE_PIPELINE_URL =
  process.env.CORE_PIPELINE_URL ||
  "http://fantasy-core-pipeline.default.svc.cluster.local:8000";

const DEFAULT_EVALUATE_TIMEOUT_MS = 10000;

function evaluateTimeoutMs() {
  return Number(process.env.TRADE_EVALUATE_TIMEOUT_MS) || DEFAULT_EVALUATE_TIMEOUT_MS;
}

// Applied to a transient (non-permanent) failure from executeTradeEvaluation before it's thrown.
// Without this, connection.js's default nack(msg, false, true) requeues instantly with no delay —
// since prefetch(1) is channel-wide, a persistently unreachable/degraded core-pipeline would
// otherwise hot-loop retries and block lineup_updates/waiver_actions/draft_targets too, hammering
// the dependency the whole time. Shorter than SessionExpiredError's 30s (src/errors.js): that
// case waits out a credential fix, which takes longer than a REST call recovering from a blip.
const TRANSIENT_RETRY_DELAY_MS = 5000;

function withRetryDelay(error) {
  if (!error.permanent) error.retryDelayMs = TRANSIENT_RETRY_DELAY_MS;
  return error;
}

/**
 * Automated Trade Proposal Scraper
 * Extracts unstructured transaction text to feed into the cloud LLM strategy brain.
 */
async function scrapePendingTradeProposals() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const currentYear = process.env.CURRENT_YEAR || "2026";
  const tradeUrl = `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${currentYear}`;

  logger.info(
    `[Trade Scraper] Scanning portal execution files for incoming offers at: ${tradeUrl}`,
  );

  let session = null;
  try {
    session = await createAuthenticatedSession();
    await session.page.goto(tradeUrl, {
      waitUntil: "networkidle",
      timeout: 20000,
    });

    // Wait for the main trade transaction layout overview component to render
    await session.page.waitForSelector(".trade-container, .no-pending-trades", {
      timeout: 10000,
    });

    // Extract raw block text entries directly from active elements to pass down to Claude over MCP
    const proposalContentText = await session.page.evaluate(() => {
      const tradeCards = document.querySelectorAll(".trade-card-wrapper");
      if (tradeCards.length === 0) return "NO_PENDING_PROPOSALS";

      return Array.from(tradeCards)
        .map((card) => card.innerText.replace(/\s+/g, " ").trim())
        .join(" | ");
    });

    logger.info(
      `[Trade Scraper] Extraction loop finished cleanly. Payload: "${proposalContentText}"`,
    );
    return proposalContentText;
  } catch (error) {
    logger.error(
      `[Trade Scraper] Failed to extract page details from trade matrix portal: ${error.message}`,
      {
        err: error,
      },
    );
    return null;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

/** A queue message here is only useful once it names two non-overlapping sets of player ids
 * plus a season/week to score them against — anything short of that can never succeed on
 * redelivery, so it's rejected as a PermanentError before any network call is made. */
function requireEvaluationPayload(payload) {
  requirePlainObjectPayload(payload, "[Trade Evaluator]");

  const { incoming_player_ids: incoming, outgoing_player_ids: outgoing, season, week } = payload;

  const isNonEmptyIdArray = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === "string" && id.trim() !== "");

  if (!isNonEmptyIdArray(incoming)) {
    throw new PermanentError(
      "[Trade Evaluator] incoming_player_ids must be a non-empty array of string player ids.",
    );
  }
  if (!isNonEmptyIdArray(outgoing)) {
    throw new PermanentError(
      "[Trade Evaluator] outgoing_player_ids must be a non-empty array of string player ids.",
    );
  }
  const overlap = incoming.filter((id) => outgoing.includes(id));
  if (overlap.length > 0) {
    throw new PermanentError(
      `[Trade Evaluator] player_id(s) ${overlap.join(", ")} cannot appear on both sides of a trade.`,
    );
  }
  if (!Number.isInteger(season)) {
    throw new PermanentError("[Trade Evaluator] season must be an integer.");
  }
  if (!Number.isInteger(week)) {
    throw new PermanentError("[Trade Evaluator] week must be an integer.");
  }

  return { incoming, outgoing, season, week };
}

/** Maps a POST /v1/trade/evaluate failure to PermanentError vs plain Error, mirroring
 * espn_api.js's submitWaiverClaim convention: a 4xx (except 429) means this exact payload is
 * doomed (trade.py's 422 covers duplicate/overlapping ids), so redelivery can never help; a 429,
 * 5xx, or network/timeout failure is transient and should requeue as-is. */
function classifyEvaluateError(status, body) {
  const message = `[Trade Evaluator] POST /v1/trade/evaluate failed with HTTP ${status} — ${body.slice(0, 500)}`;
  return withRetryDelay(classifyHttpStatusError(status, message));
}

/**
 * Queue-shaped entrypoint (unlike scrapePendingTradeProposals above): consumes a trade proposal
 * off the "trade_evaluations" queue, scores it via fantasy-core-pipeline's
 * POST /v1/trade/evaluate, and logs the resulting VORP delta. Deliberately scoped to just that —
 * negotiation logic (calling llm_client.js's completeWithFallback to draft a counter-offer) and
 * pasting a response into ESPN's chat box are WORKER-04 (issue #4), not this.
 */
async function executeTradeEvaluation(payload) {
  const { incoming, outgoing, season, week } = requireEvaluationPayload(payload);
  // Nullish, not falsy: an empty string or a literal 0 is still a real tracking id worth keeping
  // in logs, unlike no tracking_id field at all.
  const tracking = payload.tracking_id ?? "no-tracking-id";

  logger.info(
    `[Trade Evaluator][${tracking}] Evaluating ${incoming.length} incoming / ${outgoing.length} ` +
      `outgoing player(s) for season ${season} week ${week}...`,
  );

  let response;
  try {
    response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incoming_player_ids: incoming,
        outgoing_player_ids: outgoing,
        season,
        week,
      }),
      signal: AbortSignal.timeout(evaluateTimeoutMs()),
    });
  } catch (networkError) {
    // fetch itself throws on a network failure or an aborted/timed-out request — both transient.
    // Distinct causes (DNS/ECONNREFUSED vs a timeout AbortError) collapse to the same Error shape
    // here, but `cause` keeps the original error/stack available to anyone inspecting the reject.
    throw withRetryDelay(
      new Error(
        `[Trade Evaluator][${tracking}] Request to ${CORE_PIPELINE_URL} failed: ${networkError.message}`,
        { cause: networkError },
      ),
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw classifyEvaluateError(response.status, body);
  }

  let result;
  try {
    result = await response.json();
  } catch (parseError) {
    // A 200 with a truncated/empty/non-JSON body (proxy hiccup, ingress default-backend page
    // mid-rollout) must not bypass classification as an unhandled SyntaxError — treat it as the
    // same transient condition an ordinary 5xx would be.
    throw withRetryDelay(
      new Error(
        `[Trade Evaluator][${tracking}] Response body was not valid JSON: ${parseError.message}`,
        { cause: parseError },
      ),
    );
  }
  logger.info(
    `[Trade Evaluator][${tracking}] delta_vorp=${result.delta_vorp} ` +
      `(incoming=${result.incoming_total}, outgoing=${result.outgoing_total})` +
      (result.missing_player_ids?.length
        ? ` — missing weekly_stats for: ${result.missing_player_ids.join(", ")}`
        : ""),
  );
  return result;
}

module.exports = {
  scrapePendingTradeProposals,
  executeTradeEvaluation,
  requireEvaluationPayload,
  classifyEvaluateError,
};
