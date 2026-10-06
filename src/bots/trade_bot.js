const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("./auth");
const { readPendingTrades, readLeagueChat } = require("./espn_api");
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
// error page, not the clubhouse — teamId is required, not optional. No longer read by the bot
// (see readTradeContext); trade_recon.js still opens it.
function buildTradePortalUrl(leagueId, seasonId, teamId) {
  return `https://fantasy.espn.com/football/team?leagueId=${leagueId}&seasonId=${seasonId}&teamId=${teamId}`;
}

/** Prompt text for readPendingTrades' trades. Names only, never ESPN ids: those collide with
 * core-pipeline's internal ids, the space the LLM's counter-offer is in (see
 * resolveEspnPlayerIds), so an ESPN id in the prompt could come back as a counter id naming a
 * different player. */
function formatPendingTrades(trades) {
  if (trades.length === 0) return "NO_PENDING_PROPOSALS";

  return trades
    .map((trade) => {
      const sentByTeam = new Map();
      for (const item of trade.items) {
        if (!sentByTeam.has(item.fromTeamId)) sentByTeam.set(item.fromTeamId, []);
        sentByTeam.get(item.fromTeamId).push(item.playerName ?? "an unnamed player");
      }
      const sides = Array.from(sentByTeam, ([teamId, names]) => `team ${teamId} sends ${names.join(", ")}`);
      return `${trade.type} from team ${trade.proposingTeamId} (${trade.status}): ${sides.join("; ")}`;
    })
    .join(" | ");
}

/** Prompt text for readLeagueChat's posts, attributed to a team where the author owns one. */
function formatLeagueChat(messages, teamIdByMemberId) {
  if (messages.length === 0) return "NO_RECENT_CHAT";

  return messages
    .map(({ authorId, date, content }) => {
      const teamId = teamIdByMemberId.get(authorId);
      const who =
        authorId === "LM" ? "League Manager" : teamId ? `team ${teamId}` : "a league member";
      return `${new Date(date).toISOString()} ${who}: ${content}`;
    })
    .join("\n");
}

/**
 * The pending trade(s) and recent league chat, as prompt text. Shared by
 * scrapePendingTradeProposals (standalone read-only entrypoint) and negotiateTradeProposal.
 *
 * REST, not DOM (#101): the clubhouse page has no trade markup to scrape (the old
 * `.trade-container`/`.no-pending-trades` selectors never existed), and the chat iframe opens on a
 * room list rather than messages. Both reads are GETs on the session's context. The chat read is
 * best-effort; a failed pending-trade read throws, since the negotiation has nothing to work from.
 *
 * `offeringTeamId` narrows the proposals to trades with that team, so the negotiator's prompt
 * can't describe a different team's offer than the one its counter is staged against.
 */
async function readTradeContext(context, { leagueId, seasonId, teamId, offeringTeamId }) {
  const { trades: allTrades, teamIdByMemberId } = await readPendingTrades(context, {
    leagueId,
    seasonId,
    teamId,
  });
  const trades = offeringTeamId
    ? allTrades.filter(
        (trade) =>
          trade.proposingTeamId === String(offeringTeamId) ||
          trade.items.some(
            (i) => i.fromTeamId === String(offeringTeamId) || i.toTeamId === String(offeringTeamId),
          ),
      )
    : allTrades;

  let chatLog = "CHAT_LOG_UNAVAILABLE";
  try {
    chatLog = formatLeagueChat(await readLeagueChat(context, { leagueId, seasonId }), teamIdByMemberId);
  } catch (chatError) {
    logger.warn(
      `[Trade Scraper] Could not read the league chat feed — leaving proposals-only: ${chatError.message}`,
    );
  }

  return { proposals: formatPendingTrades(trades), chatLog };
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

  logger.info(
    `[Trade Scraper] Reading pending trades for team ${teamId} in league ${leagueId}...`,
  );

  let session = null;
  try {
    session =
      (await createSessionFromStoredState()) ?? (await createAuthenticatedSession());
    const content = await readTradeContext(session.context, {
      leagueId,
      seasonId: currentYear,
      teamId,
    });

    logger.info(
      `[Trade Scraper] Extraction loop finished cleanly. Payload: "${content.proposals}"`,
    );
    return content;
  } catch (error) {
    logger.error(
      `[Trade Scraper] Failed to read pending trades: ${error.message}`,
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

/**
 * Translates core-pipeline internal (Sleeper) player ids to ESPN ids for trade_builder.js.
 *
 * negotiateTradeProposal's ids, and so the LLM's counter, live in core-pipeline's internal id
 * space (the one /v1/trade/evaluate takes), NOT ESPN's. The two spaces collide numerically:
 * internal 12483 is Jack Bech, ESPN 12483 is Matthew Stafford. So forwarding them untranslated
 * would silently target real, different players. See core-pipeline's README "id-space contract".
 *
 * /v1/players/{id}/summary carries players.espn_id. A null there means core-pipeline has no
 * resolved ESPN id for that player (a few unrostered kickers, and some fringe skill players), so
 * this fails closed with a PermanentError, as it does for an unknown id. A D/ST's ESPN id is
 * negative (-(16000 + proTeamId), e.g. Eagles -16021), which requirePlayerId accepts.
 *
 * A /summary with no espn_id field at all comes from a core-pipeline deploy that predates it
 * (core-pipeline#214). Only then does this fall back to searching the name and taking the result
 * whose player_id is exactly ours, which also fails closed when the player falls outside the
 * (limited) search results. Remove the fallback once that deploy is everywhere.
 */
async function resolveEspnPlayerIds(internalIds) {
  const espnIds = [];
  for (const internalId of internalIds) {
    const summaryUrl = `${CORE_PIPELINE_URL}/v1/players/${encodeURIComponent(internalId)}/summary`;
    const summaryResponse = await fetch(summaryUrl, {
      signal: AbortSignal.timeout(evaluateTimeoutMs()),
    });
    if (!summaryResponse.ok) {
      throw new PermanentError(
        `[Trade Negotiator] Internal player ${internalId} could not be looked up ` +
          `(GET /v1/players/${internalId}/summary -> HTTP ${summaryResponse.status}).`,
      );
    }
    const summary = await summaryResponse.json();
    const { name } = summary;
    if (Object.hasOwn(summary, "espn_id")) {
      espnIds.push(requireEspnId(internalId, name, summary.espn_id));
      continue;
    }

    const searchUrl = `${CORE_PIPELINE_URL}/v1/players/search?q=${encodeURIComponent(name)}`;
    const searchResponse = await fetch(searchUrl, {
      signal: AbortSignal.timeout(evaluateTimeoutMs()),
    });
    if (!searchResponse.ok) {
      throw new Error(
        `[Trade Negotiator] Player search for "${name}" failed with HTTP ${searchResponse.status}.`,
      );
    }
    const match = (await searchResponse.json()).find(
      (result) => String(result.player_id) === String(internalId),
    );
    espnIds.push(requireEspnId(internalId, name, match?.espn_id));
  }
  return espnIds;
}

function requireEspnId(internalId, name, espnId) {
  if (espnId === null || espnId === undefined || espnId === "") {
    throw new PermanentError(
      `[Trade Negotiator] Internal player ${internalId} ("${name}") has no ESPN id in ` +
        "core-pipeline's crosswalk, so the counter can't be staged.",
    );
  }
  return String(espnId);
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
 * Queue-shaped entrypoint for WORKER-04/#4: reads the pending trade + league chat, grounds it
 * against fantasy-core-pipeline's roster-deficit and VORP-evaluation data, and asks the LLM (via
 * WORKER-12's completeWithFallback) for a structured counter-offer.
 *
 * It never sends anything to ESPN itself, and no AI-drafted message is generated. Since #90 it
 * STAGES the counter in ESPN's trade builder via trade_builder.js's submitTradeOffer (after
 * translating its internal player ids to ESPN ids, see resolveEspnPlayerIds), which ticks
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
    const { proposals, chatLog } = await readTradeContext(session.context, {
      leagueId,
      seasonId: season,
      teamId: process.env.ESPN_TEAM_ID,
      offeringTeamId,
    });

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
    status = "computed";

    // Staging failures (an LLM-invented id, a selector miss) must not fail the negotiation: a
    // requeue would re-run the LLM call for a counter we already have. The counter still stands;
    // it just has no staged offer to approve yet.
    let submission;
    try {
      const [incomingEspnIds, outgoingEspnIds] = [
        await resolveEspnPlayerIds(counterOffer.incomingPlayerIds),
        await resolveEspnPlayerIds(counterOffer.outgoingPlayerIds),
      ];
      submission = await submitTradeOffer(
        {
          leagueId,
          seasonId: String(season),
          fromTeamId: process.env.ESPN_TEAM_ID,
          toTeamId: offeringTeamId,
          incomingPlayerIds: incomingEspnIds,
          outgoingPlayerIds: outgoingEspnIds,
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
    // Every throw site above this point — session creation, the pending-trade read, completeWithFallback
    // exhausting every provider, a flaky non-JSON LLM response — is a novel failure mode this
    // function introduces beyond the two REST calls that already opt into withRetryDelay
    // individually. Without this, any of them nacks with an instant requeue under connection.js's
    // channel-wide prefetch(1), hot-looping a fresh Chromium launch exactly the way PR #42 already
    // fixed once for SessionExpiredError.
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
  resolveEspnPlayerIds,
  buildTradePortalUrl,
  formatPendingTrades,
  formatLeagueChat,
};
