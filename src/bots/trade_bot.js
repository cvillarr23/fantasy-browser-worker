/* eslint-env browser */
// The page.evaluate() callback below runs inside the browser page, not Node — document/window
// are real globals there, hence the browser env for this file.
const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("./auth");
const { captureDebugSnapshot } = require("./debug_capture");
const {
  PermanentError,
  requirePlainObjectPayload,
  classifyHttpStatusError,
} = require("../errors");
const { completeWithFallback } = require("../lib/llm_client");
const { submitTradeOffer } = require("./trade_builder");
const { recordTradeNegotiation } = require("../db/execution_log");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");

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

// Confirmed live 2026-09-22: /football/team without a teamId renders ESPN's "Invalid Team ID"
// error page, not the clubhouse — teamId is required, not optional.
function buildTradePortalUrl(leagueId, seasonId, teamId) {
  return `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${seasonId}&teamId=${teamId}`;
}

// Cross-origin iframe hosting the entire "Fantasy Chat" widget (room list, message feed, compose
// box) — confirmed live 2026-09-16 against a real league (see the plan's recon findings). Neither
// a top-level page.locator() nor page.evaluate() can reach inside it; Playwright's frameLocator
// is required.
const CHAT_IFRAME_SELECTOR = "iframe.chat--container--iframe";

/**
 * Page-level scrape shared by scrapePendingTradeProposals (standalone read-only entrypoint) and
 * negotiateTradeProposal (WORKER-04's queue entrypoint), so both draw on the same selectors
 * instead of duplicating them. Assumes `page` is already navigated to the trade portal URL.
 *
 * The `.trade-container`/`.no-pending-trades`/`.trade-card-wrapper` selectors are still
 * UNVERIFIED — recon 2026-09-16 confirmed the auth surface and the chat mechanism live, but found
 * no pending trade in the test league to check these against. captureDebugSnapshot calls below
 * exist so the first live run against a real trade can correct them from the captured DOM.
 */
async function scrapeTradePortalContent(page) {
  await page.waitForSelector(".trade-container, .no-pending-trades", {
    timeout: 10000,
  });
  await captureDebugSnapshot(page, "trade-portal-loaded");

  const proposals = await page.evaluate(() => {
    const tradeCards = document.querySelectorAll(".trade-card-wrapper");
    if (tradeCards.length === 0) return "NO_PENDING_PROPOSALS";

    return Array.from(tradeCards)
      .map((card) => card.innerText.replace(/\s+/g, " ").trim())
      .join(" | ");
  });

  // UNVERIFIED — recon pending: the chat widget is collapsed by default and its toggle's
  // selector wasn't confirmed live (only its rough screen position was, via a coordinate click,
  // which isn't something automation should rely on). Text-based, matching the role-locator
  // lesson mock_draft.js already learned the hard way for a similarly ambiguous button.
  let chatLog = "CHAT_LOG_UNAVAILABLE";
  try {
    await page
      .getByText(/fantasy chat/i)
      .first()
      .click({ timeout: 5000 });
    chatLog = await page
      .frameLocator(CHAT_IFRAME_SELECTOR)
      .locator("body")
      .innerText({ timeout: 5000 });
  } catch (chatError) {
    logger.warn(
      `[Trade Scraper] Could not read the league chat feed — leaving proposals-only: ${chatError.message}`,
    );
  }

  return { proposals, chatLog };
}

/**
 * Automated Trade Proposal Scraper
 * Extracts unstructured transaction text (plus recent league chat) to feed into the cloud LLM
 * strategy brain.
 */
async function scrapePendingTradeProposals() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  const currentYear = process.env.CURRENT_YEAR || "2026";
  const tradeUrl = buildTradePortalUrl(leagueId, currentYear, teamId);

  logger.info(
    `[Trade Scraper] Scanning portal execution files for incoming offers at: ${tradeUrl}`,
  );

  let session = null;
  try {
    // Cookie-only auth (createAuthenticatedSession) shows ESPN's client-side "Log in Required"
    // gate on a rendered page like this one — see docs/espn-reverse-engineering.md's auth-surface
    // split — so prefer a real stored login session first, same as draft_room_dom.js.
    session =
      (await createSessionFromStoredState()) ?? (await createAuthenticatedSession());
    await session.page.goto(tradeUrl, {
      waitUntil: "networkidle",
      timeout: 20000,
    });

    const content = await scrapeTradePortalContent(session.page);

    logger.info(
      `[Trade Scraper] Extraction loop finished cleanly. Payload: "${content.proposals}"`,
    );
    return content;
  } catch (error) {
    logger.error(
      `[Trade Scraper] Failed to extract page details from trade matrix portal: ${error.message}`,
      {
        err: error,
      },
    );
    if (session && session.page) {
      await captureDebugSnapshot(session.page, "trade-portal-failure");
    }
    return null;
  } finally {
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

const isNonEmptyIdArray = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((id) => typeof id === "string" && id.trim() !== "");

/** Shared by requireEvaluationPayload and requireNegotiationPayload: both need a non-overlapping
 * incoming/outgoing player id pair plus a season/week, and this validation can never succeed on
 * redelivery if it fails once, so both callers throw PermanentError with the given label. */
function requireTradeIdFields(payload, label) {
  const { incoming_player_ids: incoming, outgoing_player_ids: outgoing, season, week } = payload;

  if (!isNonEmptyIdArray(incoming)) {
    throw new PermanentError(
      `${label} incoming_player_ids must be a non-empty array of string player ids.`,
    );
  }
  if (!isNonEmptyIdArray(outgoing)) {
    throw new PermanentError(
      `${label} outgoing_player_ids must be a non-empty array of string player ids.`,
    );
  }
  const overlap = incoming.filter((id) => outgoing.includes(id));
  if (overlap.length > 0) {
    throw new PermanentError(
      `${label} player_id(s) ${overlap.join(", ")} cannot appear on both sides of a trade.`,
    );
  }
  if (!Number.isInteger(season)) {
    throw new PermanentError(`${label} season must be an integer.`);
  }
  if (!Number.isInteger(week)) {
    throw new PermanentError(`${label} week must be an integer.`);
  }

  return { incoming, outgoing, season, week };
}

/** A queue message here is only useful once it names two non-overlapping sets of player ids
 * plus a season/week to score them against — anything short of that can never succeed on
 * redelivery, so it's rejected as a PermanentError before any network call is made. */
function requireEvaluationPayload(payload) {
  requirePlainObjectPayload(payload, "[Trade Evaluator]");
  return requireTradeIdFields(payload, "[Trade Evaluator]");
}

/** Same id-pair/season/week validation as requireEvaluationPayload, plus offering_team_id —
 * negotiateTradeProposal needs it to know which manager's chat DM to open, so a message missing
 * it can never succeed on redelivery either. */
function requireNegotiationPayload(payload) {
  requirePlainObjectPayload(payload, "[Trade Negotiator]");
  const fields = requireTradeIdFields(payload, "[Trade Negotiator]");

  const { offering_team_id: offeringTeamId } = payload;
  if (typeof offeringTeamId !== "string" || offeringTeamId.trim() === "") {
    throw new PermanentError(
      "[Trade Negotiator] offering_team_id must be a non-empty string.",
    );
  }

  return { ...fields, offeringTeamId };
}

/** Maps a POST /v1/trade/evaluate failure to PermanentError vs plain Error, mirroring
 * espn_api.js's submitWaiverClaim convention: a 4xx (except 429) means this exact payload is
 * doomed (trade.py's 422 covers duplicate/overlapping ids), so redelivery can never help; a 429,
 * 5xx, or network/timeout failure is transient and should requeue as-is. `label` defaults to this
 * function's original caller (executeTradeEvaluation); postTradeEvaluation's other caller,
 * negotiateTradeProposal, passes its own so a failure there isn't mislabeled "[Trade Evaluator]"
 * in logs even though it happened on the trade_negotiations queue. */
function classifyEvaluateError(status, body, label = "[Trade Evaluator]") {
  const message = `${label} POST /v1/trade/evaluate failed with HTTP ${status} — ${body.slice(0, 500)}`;
  return withRetryDelay(classifyHttpStatusError(status, message));
}

/** The actual POST /v1/trade/evaluate call, shared by executeTradeEvaluation (the
 * "trade_evaluations" queue entrypoint) and negotiateTradeProposal (WORKER-04's grounding-data
 * fetch) — pulled out so the negotiator doesn't duplicate this fetch/classify logic. */
async function postTradeEvaluation({ incoming, outgoing, season, week }, label = "[Trade Evaluator]") {
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
        `${label} Request to ${CORE_PIPELINE_URL} failed: ${networkError.message}`,
        { cause: networkError },
      ),
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw classifyEvaluateError(response.status, body, label);
  }

  try {
    return await response.json();
  } catch (parseError) {
    // A 200 with a truncated/empty/non-JSON body (proxy hiccup, ingress default-backend page
    // mid-rollout) must not bypass classification as an unhandled SyntaxError — treat it as the
    // same transient condition an ordinary 5xx would be.
    throw withRetryDelay(
      new Error(
        `${label} Response body was not valid JSON: ${parseError.message}`,
        { cause: parseError },
      ),
    );
  }
}

/** Maps a GET /v1/roster/deficits failure the same way classifyEvaluateError does for
 * /v1/trade/evaluate: a 4xx (except 429) means this season/week can never resolve on
 * redelivery, everything else is transient. */
function classifyRosterDeficitsError(status, body) {
  const message = `[Trade Negotiator] GET /v1/roster/deficits failed with HTTP ${status} — ${body.slice(0, 500)}`;
  return withRetryDelay(classifyHttpStatusError(status, message));
}

/** Grounding data for negotiateTradeProposal's LLM prompt: which roster positions each of this
 * league's teams are thin at, so the model can judge leverage instead of guessing. Hits
 * fantasy-core-pipeline's GET /v1/roster/deficits (src/api/roster.py) — that endpoint has no
 * league-scoping param (this system tracks exactly one league) and requires season+week, not
 * season alone. */
async function fetchRosterDeficits({ season, week }) {
  const url = `${CORE_PIPELINE_URL}/v1/roster/deficits?season=${encodeURIComponent(season)}&week=${encodeURIComponent(week)}`;

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(evaluateTimeoutMs()) });
  } catch (networkError) {
    throw withRetryDelay(
      new Error(
        `[Trade Negotiator] Request to ${CORE_PIPELINE_URL} failed: ${networkError.message}`,
        { cause: networkError },
      ),
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw classifyRosterDeficitsError(response.status, body);
  }

  try {
    return await response.json();
  } catch (parseError) {
    throw withRetryDelay(
      new Error(
        `[Trade Negotiator] Response body was not valid JSON: ${parseError.message}`,
        { cause: parseError },
      ),
    );
  }
}

/** Builds the system prompt for negotiateTradeProposal's completeWithFallback call.
 * completeWithFallback (src/lib/llm_client.js) has no native JSON-mode opts field, so strict-JSON
 * output can only be enforced by instruction — parseNegotiationResponse below is the other half
 * of that contract, defensively handling a model that ignores it anyway. */
function buildNegotiationSystemPrompt({ deficits, evaluation, proposals, chatLog }) {
  return [
    "You are a fantasy football trade negotiation assistant. You will be given a pending trade",
    "proposal, recent league chat, this league's roster deficits by team, and a VORP-based",
    "evaluation of the proposed trade. Use the roster deficits to judge how much leverage the",
    "offering manager has (a team with a severe deficit at a position is more likely to accept a",
    "lopsided deal to fill it), and use the evaluation's delta_vorp to judge whether the proposal",
    "already favors us or needs to be countered.",
    "",
    "Respond with STRICT JSON ONLY — no markdown code fences, no commentary before or after — in",
    'exactly this shape: {"counter_offer": {"incoming_player_ids": ["..."], ' +
      '"outgoing_player_ids": ["..."]}}.',
    "counter_offer.incoming_player_ids and counter_offer.outgoing_player_ids are the player ids",
    "for the counter-trade you propose. Do not draft any message to the offering manager — the",
    "counter-offer is staged in ESPN's trade builder for a human to review, and is only ever sent",
    "after that human explicitly approves it.",
    "",
    `Roster deficits: ${JSON.stringify(deficits)}`,
    `Trade evaluation: ${JSON.stringify(evaluation)}`,
    `Pending trade proposal(s): ${proposals}`,
    `Recent league chat: ${chatLog}`,
  ].join("\n");
}

// Strips a ```json ... ``` or ``` ... ``` fence some models wrap JSON output in despite being
// told not to — parseNegotiationResponse tries the raw text first, this is only a fallback.
function stripCodeFence(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

/** Defensive counterpart to buildNegotiationSystemPrompt's strict-JSON instruction: a model can
 * ignore that instruction, so this parses defensively and throws a plain (non-permanent) Error on
 * any failure — a different attempt or provider might produce a parseable response, so this is a
 * flaky-output problem for connection.js to requeue, not a doomed-payload PermanentError. */
function parseNegotiationResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (parseError) {
    throw new Error(
      `[Trade Negotiator] LLM response was not valid JSON: ${parseError.message}`,
      { cause: parseError },
    );
  }

  const counterOffer = parsed && parsed.counter_offer;
  if (!counterOffer || typeof counterOffer !== "object") {
    throw new Error(
      "[Trade Negotiator] LLM response missing a counter_offer object.",
    );
  }
  if (!isNonEmptyIdArray(counterOffer.incoming_player_ids)) {
    throw new Error(
      "[Trade Negotiator] LLM response's counter_offer.incoming_player_ids must be a non-empty array of string player ids.",
    );
  }
  if (!isNonEmptyIdArray(counterOffer.outgoing_player_ids)) {
    throw new Error(
      "[Trade Negotiator] LLM response's counter_offer.outgoing_player_ids must be a non-empty array of string player ids.",
    );
  }

  return {
    counterOffer: {
      incomingPlayerIds: counterOffer.incoming_player_ids,
      outgoingPlayerIds: counterOffer.outgoing_player_ids,
    },
  };
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

  const result = await postTradeEvaluation({ incoming, outgoing, season, week });

  logger.info(
    `[Trade Evaluator][${tracking}] delta_vorp=${result.delta_vorp} ` +
      `(incoming=${result.incoming_total}, outgoing=${result.outgoing_total})` +
      (result.missing_player_ids?.length
        ? ` — missing weekly_stats for: ${result.missing_player_ids.join(", ")}`
        : ""),
  );
  return result;
}

/**
 * Queue-shaped entrypoint for WORKER-04/#4: scrapes the pending trade + league chat, grounds it
 * against fantasy-core-pipeline's roster-deficit and VORP-evaluation data, and asks the LLM (via
 * WORKER-12's completeWithFallback) for a structured counter-offer.
 *
 * It never sends anything to ESPN itself, and no AI-drafted message is generated. Since #90 it
 * STAGES the counter in ESPN's trade builder via trade_builder.js's submitTradeOffer, which ticks
 * the boxes, screenshots them, and records an `awaiting_approval` execution_log row with the
 * offer's offer_key. It does that WITHOUT an approval, so submitTradeOffer's gate can't open here
 * whatever DRY_RUN/TRADE_SUBMIT_ENABLED say. The real send is a separate, human-approved
 * "trade_submissions" message carrying that offer_key (see trade_builder.js's header).
 */
async function negotiateTradeProposal(payload) {
  const { incoming, outgoing, season, week, offeringTeamId } =
    requireNegotiationPayload(payload);
  const tracking = payload.tracking_id ?? "no-tracking-id";
  const leagueId = process.env.ESPN_LEAGUE_ID;

  logger.info(
    `[Trade Negotiator][${tracking}] Negotiating trade from team ${offeringTeamId} ` +
      `for season ${season} week ${week}...`,
  );

  let session = null;
  let counterOffer;
  let status = "failure";
  let errorMessage;
  try {
    session =
      (await createSessionFromStoredState()) ?? (await createAuthenticatedSession());
    await session.page.goto(buildTradePortalUrl(leagueId, season, process.env.ESPN_TEAM_ID), {
      waitUntil: "networkidle",
      timeout: 20000,
    });

    const { proposals, chatLog } = await scrapeTradePortalContent(session.page);

    const [deficits, evaluation] = await Promise.all([
      fetchRosterDeficits({ season, week }),
      postTradeEvaluation({ incoming, outgoing, season, week }, "[Trade Negotiator]"),
    ]);

    const systemPrompt = buildNegotiationSystemPrompt({
      deficits,
      evaluation,
      proposals,
      chatLog,
    });
    const { text } = await completeWithFallback(
      "Propose a counter-offer for the pending trade described above.",
      { systemPrompt, callSite: "trade_negotiation" },
    );
    const negotiation = parseNegotiationResponse(text);
    counterOffer = negotiation.counterOffer;

    logger.info(
      `[Trade Negotiator][${tracking}] Computed counter-offer ${JSON.stringify(counterOffer)} — ` +
        "staging it for approval, nothing sent.",
    );
    await captureDebugSnapshot(session.page, "trade-negotiation-computed");
    status = "computed";

    // Staging failures (an LLM-invented id, a selector miss) must not fail the negotiation: a
    // requeue would re-run the LLM call for a counter we already have. The counter still stands;
    // it just has no staged offer to approve yet.
    let submission;
    try {
      submission = await submitTradeOffer(
        {
          leagueId,
          seasonId: String(season),
          fromTeamId: process.env.ESPN_TEAM_ID,
          toTeamId: offeringTeamId,
          incomingPlayerIds: counterOffer.incomingPlayerIds,
          outgoingPlayerIds: counterOffer.outgoingPlayerIds,
        },
        { source: "counter_offer", trackingId: tracking, session },
      );
    } catch (stageError) {
      logger.warn(
        `[Trade Negotiator][${tracking}] Could not stage the counter-offer in ESPN's trade ` +
          `builder: ${stageError.message}`,
      );
      submission = { status: "fill_failed", error: stageError.message };
    }
    return { ...negotiation, submission };
  } catch (error) {
    errorMessage = error.message;
    if (session && session.page) {
      await captureDebugSnapshot(session.page, "trade-negotiation-failure");
    }
    // Every throw site above this point — session/navigation, the scrape, completeWithFallback
    // exhausting every provider, a flaky non-JSON LLM response — is a novel failure mode this
    // function introduces beyond the two REST calls that already opt into withRetryDelay
    // individually. Without this, any of them nacks with an instant requeue under connection.js's
    // channel-wide prefetch(1), hot-looping a fresh Chromium launch exactly the way PR #42 already
    // fixed once for SessionExpiredError — and since the trade-card selectors are still UNVERIFIED
    // (see scrapeTradePortalContent), a selector miss on the first live run is a realistic
    // trigger, not just a rare edge case.
    if (!error.permanent && error.retryDelayMs === undefined) {
      withRetryDelay(error);
    }
    throw error;
  } finally {
    await recordTradeNegotiation({
      leagueId,
      season,
      offeringTeamId,
      counterOffer,
      dryRun: true, // never sends: staging is approval-less, see the function doc comment
      status,
      errorMessage,
    });
    if (session && session.browser) {
      await session.browser.close();
    }
  }
}

// Local/manual runs: node src/bots/trade_bot.js '{"incoming_player_ids":[...], ...}'
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    logger.error(
      "Usage: node src/bots/trade_bot.js '<trade_negotiations JSON payload>'\n" +
        "Example: ESPN_LEAGUE_ID=1248158344 node src/bots/trade_bot.js \\\n" +
        `  '{"incoming_player_ids":["101"],"outgoing_player_ids":["202"],"season":2026,"week":3,"offering_team_id":"7"}'`,
    );
    process.exit(1);
  }

  const payload = JSON.parse(raw);
  withInstrumentation(
    "trade_bot",
    { trackingId: payload.tracking_id || require("crypto").randomUUID() },
    () => negotiateTradeProposal(payload),
  ).catch(async (error) => {
    logger.error(`[Trade Bot] Run failed: ${error.message}`, { err: error });
    const { shutdownTelemetry } = require("../telemetry/init");
    try {
      await shutdownTelemetry();
    } finally {
      process.exit(1);
    }
  });
}

module.exports = {
  scrapePendingTradeProposals,
  executeTradeEvaluation,
  requireEvaluationPayload,
  classifyEvaluateError,
  requireNegotiationPayload,
  fetchRosterDeficits,
  buildNegotiationSystemPrompt,
  parseNegotiationResponse,
  negotiateTradeProposal,
  buildTradePortalUrl,
};
