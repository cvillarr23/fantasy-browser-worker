const { CORE_PIPELINE_URL } = require("./core_pipeline");
const { classifyHttpStatusError, withRetryDelay } = require("../errors");

/**
 * Deterministic scoring for generated outgoing offers, on fantasy-core-pipeline's league trade
 * context (GET /v1/trade/context) and schedule-aware scorer (POST /v1/trade/score). Every number
 * that ranks a package or appears in a pitch comes from core; the LLM only proposes packages and
 * words a pitch from the evidence handed to it.
 *
 * Every id crossing this boundary is an ESPN id kept as a string. Internal player ids appear in
 * core's responses but are never sent back or used for matching, since the two id spaces collide
 * numerically.
 */

// Core's default horizon. Later weeks usually lack metrics and come back unscored, which ranking
// tolerates rather than treating as zero.
const SCORE_HORIZON_WEEKS = 4;
// Core reads ESPN on a context-cache miss and then solves two lineups per team per week.
const DEFAULT_TRADE_SCORE_TIMEOUT_MS = 30_000;
const DEFAULT_TRADE_CONTEXT_TIMEOUT_MS = 30_000;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const ERROR_BODY_PREVIEW_CHARS = 300;
// A 4-week TradeScore is a few KB. The cap keeps a runaway response out of execution_log; going
// over it stages nothing rather than storing evidence that was quietly trimmed.
const MAX_EVALUATION_BYTES = 64 * 1024;
const MAX_PITCH_CHARS = 1000;
const DELTA_DECIMALS = 1;
const EVALUATION_VERSION = "proposal-evaluation-v1";
// Evidence ids read e1, e2, ... so the first item is 1, not 0.
const FIRST_EVIDENCE_NUMBER = 1;
// An RFC 6901 pointer starts with "/", so splitting it yields an empty leading segment.
const POINTER_LEADING_SEGMENTS = 1;

function timeoutMs(name, fallback) {
  return Number(process.env[name]) || fallback;
}

async function fetchTradeContext({ leagueId, season, week, horizon }) {
  const query = new URLSearchParams({
    league_id: leagueId,
    season: String(season),
    week: String(week),
    horizon: String(horizon),
  });
  const label = "[Trade Scoring] GET /v1/trade/context";
  let response;
  try {
    response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/context?${query}`, {
      signal: AbortSignal.timeout(
        timeoutMs("TRADE_CONTEXT_TIMEOUT_MS", DEFAULT_TRADE_CONTEXT_TIMEOUT_MS),
      ),
    });
  } catch (networkError) {
    throw withRetryDelay(new Error(`${label} failed: ${networkError.message}`, { cause: networkError }));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw withRetryDelay(
      classifyHttpStatusError(
        response.status,
        `${label} failed with HTTP ${response.status}: ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
      ),
    );
  }
  try {
    return await response.json();
  } catch (parseError) {
    throw withRetryDelay(new Error(`${label} returned invalid JSON`, { cause: parseError }));
  }
}

/**
 * One team's NFL bye outlook (GET /v1/roster/bye-outlook): crunch weeks where byes leave a starter
 * seat empty or force a below-replacement starter. Prompt grounding only, so it is best-effort: a
 * failure returns null and the caller carries on without it.
 */
async function fetchByeOutlook({ leagueId, season, week, horizon, teamId }) {
  const query = new URLSearchParams({
    league_id: leagueId,
    team_id: String(teamId),
    season: String(season),
    week: String(week),
    horizon: String(horizon),
  });
  try {
    const response = await fetch(`${CORE_PIPELINE_URL}/v1/roster/bye-outlook?${query}`, {
      signal: AbortSignal.timeout(
        timeoutMs("TRADE_CONTEXT_TIMEOUT_MS", DEFAULT_TRADE_CONTEXT_TIMEOUT_MS),
      ),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Prompt-sized view of a bye outlook (core's TeamByeOutlook, or a trade-context team's
 * bye_outlook): the crunch weeks plus every week someone is on bye, by player name. Returns null
 * for anything that isn't an outlook, so callers never ground a prompt in a malformed one.
 */
function summarizeByeOutlook(outlook, nameByEspnId = {}) {
  if (!outlook || !Array.isArray(outlook.weeks) || !Array.isArray(outlook.crunch_weeks)) return null;
  return {
    crunch_weeks: outlook.crunch_weeks,
    weeks_with_byes: outlook.weeks
      .filter((week) => Array.isArray(week.on_bye) && week.on_bye.length)
      .map((week) => ({
        week: week.week,
        on_bye: week.on_bye.map((id) => nameByEspnId[id] || `ESPN player ${id}`),
        empty_starter_slots: week.unfilled_slots || [],
        crunch: Boolean(week.crunch),
      })),
  };
}

function rejectionForStatus(status) {
  if (status === HTTP_CONFLICT) return "ownership_changed";
  if (status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN && status !== HTTP_TOO_MANY_REQUESTS)
    return "invalid_request";
  return "score_unavailable";
}

/** Scores one package. Never throws: a package that can't be scored is dropped with a reason, and
 * the caller decides whether the scan as a whole failed. */
async function scoreTradePackage({ leagueId, season, week, horizon, ourTeamId, tradePackage }) {
  const request = {
    league_id: leagueId,
    season,
    week,
    horizon,
    our_team_id: ourTeamId,
    counterparty_team_id: tradePackage.to_team_id,
    send_espn_ids: tradePackage.outgoing_player_ids,
    receive_espn_ids: tradePackage.incoming_player_ids,
  };
  const rejected = (reason, detail) => ({ status: "rejected", reason, detail, request });
  let response;
  try {
    response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(
        timeoutMs("TRADE_SCORE_TIMEOUT_MS", DEFAULT_TRADE_SCORE_TIMEOUT_MS),
      ),
    });
  } catch (networkError) {
    return rejected("score_unavailable", networkError.message);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return rejected(
      rejectionForStatus(response.status),
      `HTTP ${response.status}: ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  try {
    return { status: "scored", request, score: await response.json() };
  } catch (parseError) {
    return rejected("score_unavailable", `invalid JSON: ${parseError.message}`);
  }
}

// Ids sort as strings: ESPN ids are opaque here, and D/ST ids are negative.
function packageKey(tradePackage) {
  return JSON.stringify([
    tradePackage.to_team_id,
    [...tradePackage.incoming_player_ids].sort(),
    [...tradePackage.outgoing_player_ids].sort(),
  ]);
}

function eligibilityReasons(score) {
  const reasons = [];
  const terms = score.score;
  if (!score.horizon.scored_weeks.length) reasons.push("no_scored_weeks");
  if (terms.our_lineup_gain === null || !(terms.our_lineup_gain > 0)) reasons.push("no_gain_for_us");
  // A trade that makes their lineup worse is one they'd have no reason to accept.
  if (terms.counterparty_lineup_change === null || terms.counterparty_lineup_change < 0)
    reasons.push("hurts_counterparty");
  // Going over the limit needs a drop the offer doesn't contain.
  if (score.roster_impact.us.exceeds_roster_limit || score.roster_impact.counterparty.exceeds_roster_limit)
    reasons.push("exceeds_roster_limit");
  if (score.coverage.unmapped_traded_espn_ids.length) reasons.push("unmapped_traded_player");
  return reasons;
}

/**
 * Keeps the useful packages and orders them. final_score (schedule-weighted) and our_lineup_gain
 * (unweighted) are on different scales, so a weighted package always outranks an unweighted one
 * instead of the two being compared. Values are per scored week because packages can leave
 * different weeks unscored, and an unscored week is unknown, not zero.
 */
function rankScoredPackages(entries) {
  const rejections = [];
  const eligible = [];
  for (const scored of entries) {
    const reasons = eligibilityReasons(scored.score);
    if (reasons.length) {
      rejections.push({ package: scored.package, reasons });
      continue;
    }
    const terms = scored.score.score;
    const basis = terms.final_score === null ? "our_lineup_gain" : "final_score";
    const weeks = scored.score.horizon.scored_weeks.length;
    eligible.push({
      ...scored,
      basis,
      value_per_scored_week: terms[basis] / weeks,
      key: packageKey(scored.package),
    });
  }
  const tier = (entry) => (entry.basis === "final_score" ? 0 : 1);
  eligible.sort(
    (a, b) =>
      tier(a) - tier(b) ||
      b.value_per_scored_week - a.value_per_scored_week ||
      b.score.horizon.scored_weeks.length - a.score.horizon.scored_weeks.length ||
      Number(b.score.horizon.complete_horizon) - Number(a.score.horizon.complete_horizon) ||
      b.score.score.counterparty_lineup_change - a.score.score.counterparty_lineup_change ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { ranked: eligible, rejections };
}

function signed(value) {
  const text = value.toFixed(DELTA_DECIMALS);
  return value >= 0 ? `+${text}` : text;
}

function playerLabel(player) {
  const details = [player.position, player.nfl_team].filter(Boolean).join(", ");
  const name = player.name || `ESPN player ${player.espn_id}`;
  return details ? `${name} (${details})` : name;
}

/**
 * Facts the pitch may use, each pointing (RFC 6901) at the value in the score it states. Only the
 * counterparty's side is included: our own gain and final_score are our valuation, not something
 * to hand the manager we're negotiating with.
 */
function buildPitchEvidence(score) {
  const evidence = [];
  const add = (path, text) => evidence.push({ id: `e${evidence.length + FIRST_EVIDENCE_NUMBER}`, path, text });
  score.send.forEach((player, index) => add(`/send/${index}`, `You would receive ${playerLabel(player)}`));
  score.receive.forEach((player, index) => add(`/receive/${index}`, `You would send ${playerLabel(player)}`));
  const sentIds = new Set(score.send.map((player) => player.espn_id));
  const theirs = score.roster_impact.counterparty;
  theirs.weeks.forEach((week, index) => {
    const base = `/roster_impact/counterparty/weeks/${index}`;
    add(`${base}/delta`, `Your week ${week.week} starting lineup changes by ${signed(week.delta)}`);
    week.starters_after.forEach((starter, starterIndex) => {
      if (sentIds.has(starter.espn_id))
        add(
          `${base}/starters_after/${starterIndex}`,
          `${starter.name || `ESPN player ${starter.espn_id}`} would start for you in week ${week.week}`,
        );
    });
  });
  if (theirs.total_delta !== null)
    add(
      "/roster_impact/counterparty/total_delta",
      `Across the evaluated weeks your starting lineup changes by ${signed(theirs.total_delta)}`,
    );
  // Weeks where the counterparty's byes would leave a hole that this trade fills.
  (score.bye_coverage?.counterparty?.fixed || []).forEach((week, index) =>
    add(`/bye_coverage/counterparty/fixed/${index}`, `This trade covers your week ${week} bye crunch`),
  );
  score.horizon.unscored_weeks.forEach((week, index) =>
    add(`/horizon/unscored_weeks/${index}`, `Week ${week.week} could not be evaluated (${week.reasons.join(", ")})`),
  );
  return evidence;
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g;

/** A pitch may only repeat numbers that appear in its evidence, and must cite what it uses. */
function validatePitch(pitch, evidence) {
  const message = pitch?.message;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_PITCH_CHARS)
    throw new Error(`[Trade Scoring] Pitch must be 1-${MAX_PITCH_CHARS} characters.`);
  const cited = pitch.cited_evidence_ids;
  const known = new Set(evidence.map((item) => item.id));
  if (
    !Array.isArray(cited) ||
    !cited.length ||
    new Set(cited).size !== cited.length ||
    !cited.every((id) => known.has(id))
  )
    throw new Error("[Trade Scoring] Pitch must cite supplied evidence ids.");
  const allowed = new Set(evidence.flatMap((item) => item.text.match(NUMBER_TOKEN) || []));
  const invented = (message.match(NUMBER_TOKEN) || []).filter((token) => !allowed.has(token));
  if (invented.length)
    throw new Error(`[Trade Scoring] Pitch states numbers not in its evidence: ${invented.join(", ")}`);
  return { message, cited_evidence_ids: cited };
}

/**
 * Whether a negotiated counter is worth staging, from its scoreTradePackage result. A counter that
 * scores below zero for us over the horizon (byes included) is never staged. One that can't be
 * scored is staged as before, since a human still reviews every counter.
 */
function counterVerdict(result) {
  const terms = result?.status === "scored" ? result.score?.score : null;
  const value = terms ? (terms.final_score ?? terms.our_lineup_gain) : null;
  if (typeof value !== "number") return { stage: true, scored: false };
  return { stage: value >= 0, scored: true, value };
}

function buildEvaluation({ request, score, target, ranking, pitch, evidence, evaluatedAt }) {
  return {
    version: EVALUATION_VERSION,
    evaluated_at: evaluatedAt,
    request,
    score,
    target,
    ranking,
    pitch: { message: pitch.message, evidence, cited_evidence_ids: pitch.cited_evidence_ids },
  };
}

function evaluationFits(evaluation) {
  return Buffer.byteLength(JSON.stringify(evaluation), "utf8") <= MAX_EVALUATION_BYTES;
}

function resolvePointer(document, pointer) {
  return pointer
    .split("/")
    .slice(POINTER_LEADING_SEGMENTS)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((value, part) => (value === undefined || value === null ? undefined : value[part]), document);
}

module.exports = {
  SCORE_HORIZON_WEEKS,
  MAX_EVALUATION_BYTES,
  MAX_PITCH_CHARS,
  EVALUATION_VERSION,
  packageKey,
  fetchTradeContext,
  fetchByeOutlook,
  summarizeByeOutlook,
  scoreTradePackage,
  rankScoredPackages,
  counterVerdict,
  buildPitchEvidence,
  validatePitch,
  buildEvaluation,
  evaluationFits,
  resolvePointer,
};
