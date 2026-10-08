/**
 * Incoming-trade inbox refresh. It reads every pending offer to our team from ESPN (one REST GET,
 * no navigation), ranks the offers with fantasy-core-pipeline's deterministic POST
 * /v1/trade/score, records what a score-threshold policy would do, and keeps one execution_log
 * row per offer (src/db/trade_inbox.js). Offers that leave ESPN's pending list are retired with a
 * reason.
 *
 * It never writes to ESPN. Accepting or declining is trade_response.js, behind a human approval.
 * Countering hands a trade_negotiations payload to the existing negotiator, which only stages.
 *
 * Usage:
 *   node src/bots/trade_inbox.js [--check]   read and score, print the ranked inbox, write nothing
 *   node src/bots/trade_inbox.js --refresh   the same, persisted (the scheduled job runs this)
 *   node src/bots/trade_inbox.js --list [--all]
 *   node src/bots/trade_inbox.js --triage <espn transaction id> <new|seen|snoozed|dismissed> <by> [snooze until ISO]
 *   node src/bots/trade_inbox.js --counter-payload <espn transaction id>
 */

const { randomUUID } = require("crypto");
const { createAuthenticatedSession, createSessionFromStoredState } = require("./auth");
const { readPendingTrades, readTradeHistory } = require("./espn_api");
const { readSeason, resolvePeriod } = require("./trade_scan");
const { loadInbox, updateEntry, setTriage } = require("../db/trade_inbox");
const {
  STATUS,
  LIVE_STATUSES,
  splitPendingTrades,
  toInboxEntry,
  mergeEntry,
  buildScoreRequest,
  buildIncomingEvaluation,
  incomingEvaluationFor,
  scoreFromResponse,
  scoreAfterFailure,
  unscorableScore,
  needsScore,
  rankInbox,
  shadowPolicy,
  resolveExit,
  buildNegotiationPayload,
} = require("../lib/trade_inbox");
const { CORE_PIPELINE_URL } = require("../lib/core_pipeline");
const { logger } = require("../telemetry/logger");

// The scorer solves both teams' lineups for every horizon week, which takes longer than
// /v1/trade/evaluate's single sum (TRADE_EVALUATE_TIMEOUT_MS defaults to 10s).
const DEFAULT_SCORE_TIMEOUT_MS = 20_000;
// Bounds one refresh's load on core, which re-reads ESPN's league for a cold context. A busy
// week is a handful of offers, so unscored overflow just waits for the next refresh.
const MAX_SCORE_CALLS_PER_REFRESH = 10;
const MAX_ERROR_DETAIL_CHARS = 300;
// Entries a vanished-offer check may move on. Finished entries are history, and an entry being
// responded to belongs to trade_response.js until it reconciles.
const RETIRABLE_STATUSES = new Set([STATUS.OPEN, STATUS.UNPARSED, STATUS.ACCEPTED_PENDING_PROCESSING]);
const MAX_RUNTIME_MINUTES = 10;
const MILLISECONDS_PER_MINUTE = 60_000;
const NODE_CLI_ARGUMENT_OFFSET = 2;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

function scoreTimeoutMs() {
  return Number(process.env.TRADE_SCORE_TIMEOUT_MS) || DEFAULT_SCORE_TIMEOUT_MS;
}

/** Unset or blank means no threshold. Anything non-numeric is ignored loudly, not guessed at. */
function readThreshold(name) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    logger.warn(`[Trade Inbox] Ignoring non-numeric ${name}=${JSON.stringify(raw)}`);
    return undefined;
  }
  return value;
}

/**
 * POST /v1/trade/score. Never throws: a failure is `{ok: false, status, message}`, with `status`
 * undefined for a network failure, timeout or non-JSON body, so lib/trade_inbox.js decides what
 * each failure means for the ranking.
 */
async function postTradeScore(request) {
  let response;
  try {
    response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(scoreTimeoutMs()),
    });
  } catch (error) {
    return { ok: false, status: undefined, message: `Request to core failed: ${error.message}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      message: `HTTP ${response.status} — ${text.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
    };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, status: undefined, message: `Response body was not valid JSON: ${error.message}` };
  }
}

async function openStoredSession() {
  return (await createSessionFromStoredState()) ?? (await createAuthenticatedSession());
}

const defaultDeps = () => ({
  readState: readSeason,
  openSession: openStoredSession,
  readPending: readPendingTrades,
  readHistory: readTradeHistory,
  score: postTradeScore,
  store: { load: loadInbox, update: updateEntry },
});

function requireLeagueAndTeam() {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  if (![leagueId, teamId].every((id) => /^[1-9]\d*$/.test(id || ""))) {
    throw new Error("ESPN_LEAGUE_ID and ESPN_TEAM_ID must be positive ids");
  }
  return { leagueId, teamId };
}

async function scoreEntry(entry, { leagueId, season, week, now }, score) {
  const meta = {
    fingerprint: entry.fingerprint,
    scoredAt: now.toISOString(),
    week,
  };
  const built = buildScoreRequest(entry, { leagueId, season, week });
  if (built.unscorable)
    return {
      score: unscorableScore(built.unscorable, meta),
      evaluation: null,
      called: false,
    };
  const result = await score(built.request);
  if (result.ok) {
    return {
      score: scoreFromResponse(result.body, {
        ...meta,
        partialReasons: built.partialReasons,
      }),
      evaluation: buildIncomingEvaluation({
        request: built.request,
        body: result.body,
        fingerprint: entry.fingerprint,
        evaluatedAt: meta.scoredAt,
      }),
      called: true,
    };
  }
  logger.warn(`[Trade Inbox] Could not score offer ${entry.espn_transaction_id}: ${result.message}`);
  const nextScore = scoreAfterFailure(entry.score, result, meta);
  return {
    score: nextScore,
    evaluation: nextScore.stale ? incomingEvaluationFor({ ...entry, score: nextScore }) : null,
    called: true,
  };
}

const byExpiry = (a, b) =>
  new Date(a.expiration_date ?? Infinity).getTime() - new Date(b.expiration_date ?? Infinity).getTime();

/**
 * One inbox refresh. `persist: false` is a read-only check: ESPN is read and core scores the
 * offers, but nothing is loaded from or written to the database, and nothing is retired.
 *
 * A failed pending read throws before anything is written. Offers are only retired from a
 * successful pending read, and only when the history read also succeeds. An outage therefore
 * never looks like every offer being withdrawn.
 */
async function refreshTradeInbox({ persist = true } = {}, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const now = deps.now ?? new Date();
  const period = resolvePeriod(await deps.readState(), now);
  if (!period) return { status: "off_season" };
  const { season, week } = period;
  const { leagueId, teamId } = requireLeagueAndTeam();
  const scope = { leagueId, season };
  const thresholds = {
    acceptMin: readThreshold("TRADE_INBOX_SHADOW_ACCEPT_MIN_SCORE"),
    declineMax: readThreshold("TRADE_INBOX_SHADOW_DECLINE_MAX_SCORE"),
  };

  const session = await deps.openSession();
  try {
    const { trades } = await deps.readPending(session.context, { leagueId, seasonId: String(season), teamId });
    const { incoming, outgoing, accepts } = splitPendingTrades(trades, teamId);

    const stored = persist ? await deps.store.load({ leagueId }) : [];
    const storedById = new Map(stored.map((e) => [e.espn_transaction_id, e]));
    const threadRootOf = (relatedId) => storedById.get(relatedId)?.thread_root_id ?? relatedId;
    const acceptedIds = new Set(accepts.map((t) => String(t.relatedTransactionId)));

    const fresh = incoming
      .filter((t) => t.id !== undefined && t.id !== null)
      .map((t) => toInboxEntry(t, teamId, { threadRootOf }));
    const freshIds = new Set(fresh.map((e) => e.espn_transaction_id));

    // Scores are worked out from the loaded snapshot, then applied inside each row's lock, so a
    // triage written meanwhile survives.
    const scores = new Map();
    let scoreCalls = 0;
    const merged = fresh.map((e) => mergeEntry(storedById.get(e.espn_transaction_id) ?? null, e, now));
    for (const entry of [...merged].sort(byExpiry)) {
      if (!needsScore(entry, week) || scoreCalls >= MAX_SCORE_CALLS_PER_REFRESH) continue;
      const { score, evaluation, called } = await scoreEntry(entry, { leagueId, season, week, now }, deps.score);
      if (called) scoreCalls += 1;
      scores.set(entry.espn_transaction_id, { score, evaluation });
    }

    const applyRead = (freshEntry) => (current) => {
      const next = mergeEntry(current, freshEntry, now);
      if (acceptedIds.has(next.espn_transaction_id) && next.status !== STATUS.RESPONDING) {
        next.status = STATUS.ACCEPTED_PENDING_PROCESSING;
      }
      if (scores.has(next.espn_transaction_id)) {
        const evaluated = scores.get(next.espn_transaction_id);
        next.score = evaluated.score;
        next.evaluation = incomingEvaluationFor({ ...next, evaluation: evaluated.evaluation });
      }
      next.shadow_policy = shadowPolicy(next.score, thresholds);
      return next;
    };

    const entries = [];
    for (const freshEntry of fresh) {
      const apply = applyRead(freshEntry);
      entries.push(
        persist
          ? await deps.store.update(freshEntry.espn_transaction_id, scope, apply)
          : apply(null),
      );
    }

    const exits = [];
    if (persist) {
      const missing = stored.filter(
        (e) => !freshIds.has(e.espn_transaction_id) && RETIRABLE_STATUSES.has(e.status),
      );
      let history = null;
      if (missing.length > 0) {
        try {
          history = await deps.readHistory(session.context, { leagueId, seasonId: String(season) });
        } catch (error) {
          logger.warn(`[Trade Inbox] Trade history read failed; leaving vanished offers for next time: ${error.message}`);
        }
      }
      for (const gone of history ? missing : []) {
        let exitStatus = null;
        const saved = await deps.store.update(gone.espn_transaction_id, scope, (current) => {
          const exit = current && resolveExit(current, { now, history: [...history, ...accepts], outgoing });
          if (!exit) return null;
          if (exit.status !== current.status) exitStatus = exit.status;
          return { ...current, status: exit.status, missed_reads: exit.missed_reads, exit_reason: exit.exit_reason ?? current.exit_reason ?? null };
        });
        if (exitStatus) exits.push({ id: gone.espn_transaction_id, status: exitStatus });
        if (saved) entries.push(saved);
      }
    }

    const ranked = rankInbox(entries, { now });
    return {
      status: persist ? "refreshed" : "checked",
      season,
      week,
      scoreCalls,
      exits,
      openOfferTeamIds: [...new Set(incoming.map((t) => t.proposingTeamId))],
      ranked,
    };
  } finally {
    if (session?.browser) await session.browser.close();
  }
}

function describeEntry(entry, rank) {
  const name = (id) => entry.player_names?.[id] ?? entry.score?.players?.[id]?.name ?? id;
  const score = entry.score;
  const scoreText =
    typeof score?.final_score === "number"
      ? `score ${score.final_score}${score.stale ? " (stale)" : ""}${score.state === "incomplete" ? " (incomplete)" : ""}`
      : `unscored: ${score?.state ?? "pending"}${score?.unavailable_reasons?.length ? ` [${score.unavailable_reasons.join(", ")}]` : ""}`;
  const expires = entry.expiration_date ? new Date(entry.expiration_date).toISOString() : "unknown";
  return (
    `${rank}. ${entry.espn_transaction_id} from team ${entry.proposing_team_id} [${entry.status}]: ` +
    `get ${entry.receive_espn_ids.map(name).join(", ") || "nothing"}; ` +
    `give ${entry.send_espn_ids.map(name).join(", ") || "nothing"}; ${scoreText}; expires ${expires}` +
    (entry.shadow_policy?.would && entry.shadow_policy.would !== "none" ? `; shadow would ${entry.shadow_policy.would}` : "")
  );
}

const USAGE =
  "Usage: node src/bots/trade_inbox.js [--check|--refresh|--list [--all]|" +
  "--triage <id> <state> <by> [snoozeUntil]|--counter-payload <id>]";

function usage() {
  return new Error(USAGE);
}

function parseArgs(args) {
  const [flag, ...rest] = args;
  switch (flag) {
    case undefined:
    case "--check":
      if (rest.length) throw usage();
      return { mode: "check" };
    case "--refresh":
      if (rest.length) throw usage();
      return { mode: "refresh" };
    case "--list":
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) throw usage();
      return { mode: "list", all: rest[0] === "--all" };
    case "--triage": {
      const [id, state, by, snoozeUntil, ...extra] = rest;
      if (!id || !state || !by || extra.length) throw usage();
      return { mode: "triage", id, state, by, ...(snoozeUntil ? { snoozeUntil } : {}) };
    }
    case "--counter-payload":
      if (rest.length !== 1) throw usage();
      return { mode: "counter-payload", id: rest[0] };
    default:
      throw usage();
  }
}

function logRanked(ranked) {
  if (ranked.length === 0) logger.info("[Trade Inbox] No incoming offers.");
  ranked.forEach((entry, index) => logger.info(`[Trade Inbox] ${describeEntry(entry, index + 1)}`));
}

async function main(args = process.argv.slice(NODE_CLI_ARGUMENT_OFFSET)) {
  const options = parseArgs(args);
  const leagueId = process.env.ESPN_LEAGUE_ID;

  switch (options.mode) {
    case "check": {
      // A read-only check writes no execution telemetry to Postgres either.
      const result = await refreshTradeInbox({ persist: false });
      if (result.ranked) logRanked(result.ranked);
      return result;
    }
    case "refresh": {
      const trackingId = randomUUID();
      const { withInstrumentation } = require("../telemetry/instrument");
      return withInstrumentation("trade_inbox", { trackingId }, async () => {
        const result = await refreshTradeInbox({ persist: true });
        logger.info("[Trade Inbox] Refreshed", {
          status: result.status,
          scoreCalls: result.scoreCalls,
          exits: result.exits,
          trackingId,
        });
        if (result.ranked) logRanked(result.ranked);
        return result;
      });
    }
    case "list": {
      const ranked = rankInbox(await loadInbox({ leagueId }), { now: new Date(), includeHidden: options.all });
      logRanked(ranked);
      return ranked;
    }
    case "triage":
      return setTriage(options.id, { leagueId }, {
        state: options.state,
        by: options.by,
        snoozeUntil: options.snoozeUntil,
      });
    case "counter-payload": {
      const entry = (await loadInbox({ leagueId })).find((e) => e.espn_transaction_id === options.id);
      if (!entry || !LIVE_STATUSES.has(entry.status)) {
        throw new Error(`Offer ${options.id} is not a live inbox entry.`);
      }
      const period = resolvePeriod(await readSeason());
      if (!period) throw new Error("No regular-season week to negotiate in.");
      const payload = buildNegotiationPayload(entry, { ...period, trackingId: randomUUID() });
      logger.info(`[Trade Inbox] trade_negotiations payload: ${JSON.stringify(payload)}`);
      return payload;
    }
    default:
      throw usage();
  }
}

if (require.main === module) {
  // Bounds a hung browser, DB or core call, as trade_scan.js does.
  const deadline = setTimeout(() => {
    logger.error(`[Trade Inbox] Runtime exceeded ${MAX_RUNTIME_MINUTES} minutes`);
    process.exit(EXIT_FAILURE);
  }, MAX_RUNTIME_MINUTES * MILLISECONDS_PER_MINUTE);
  main()
    .catch((err) => {
      logger.error("[Trade Inbox] Failed", { err });
      process.exitCode = EXIT_FAILURE;
    })
    .finally(async () => {
      await require("../telemetry/init").shutdownTelemetry();
      clearTimeout(deadline);
      process.exit(process.exitCode || EXIT_SUCCESS);
    });
}

module.exports = { refreshTradeInbox, postTradeScore, parseArgs, main, describeEntry };
