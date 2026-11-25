const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { generateTradeProposal } = require("./trade_proposal");
const { logger } = require("../telemetry/logger");
const { addSummary, supersedeApprovals, triggerFromEnv } = require("../db/run_log");
const { getContext } = require("../telemetry/context");

const NFL_STATE_TIMEOUT_MS = 10_000;
const MIN_SUPPORTED_SEASON = 2000;
const PRESEASON_WEEK = 0;
const LAST_REGULAR_SEASON_WEEK = 18;
// Date.getUTCMonth() uses zero-based month indexes.
const JANUARY_MONTH_INDEX = 0;
const SEPTEMBER_MONTH_INDEX = 8;
const PREVIOUS_SEASON_YEAR_OFFSET = 1;
const CURRENT_SEASON_YEAR_OFFSET = 0;
const CLAIM_POOL_MAX_CONNECTIONS = 1;
const CLAIM_DB_TIMEOUT_MS = 10_000;
const NODE_CLI_ARGUMENT_OFFSET = 2;
const MAX_CLI_ARGUMENTS = 1;
const CLI_OPTION_INDEX = 0;
const MAX_RUNTIME_MINUTES = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

// Sleeper's NFL state is calendar metadata only; player/team ids remain ESPN ids.
async function readSeason() {
  const response = await fetch("https://api.sleeper.app/v1/state/nfl", {
    signal: AbortSignal.timeout(NFL_STATE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`NFL state HTTP ${response.status}`);
  return response.json();
}

function resolvePeriod(state, now = new Date()) {
  if (!state || !["pre", "post", "regular", "off"].includes(state.season_type))
    throw new Error("Invalid NFL season state");
  if (state.season_type !== "regular") return null;
  const season = Number(state.season);
  const week = state.week;
  if (
    !Number.isInteger(season) ||
    season < MIN_SUPPORTED_SEASON ||
    !Number.isInteger(week) ||
    week < PRESEASON_WEEK ||
    week > LAST_REGULAR_SEASON_WEEK
  )
    throw new Error("Invalid NFL season/week");
  // Fail closed on stale regular-season metadata during spring/summer. January
  // belongs to the previous season; never derive the season from CURRENT_YEAR.
  const month = now.getUTCMonth();
  if (month > JANUARY_MONTH_INDEX && month < SEPTEMBER_MONTH_INDEX) return null;
  if (
    season !==
    now.getUTCFullYear() -
      (month === JANUARY_MONTH_INDEX
        ? PREVIOUS_SEASON_YEAR_OFFSET
        : CURRENT_SEASON_YEAR_OFFSET)
  )
    throw new Error("Stale NFL season");
  return week === PRESEASON_WEEK ? null : { season, week };
}

// Use the scheduled job's timezone, including DST, so manual and scheduled runs share
// one daily claim even across UTC midnight. Week changes cannot bypass this cap.
function scanDate(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

// Durable claims use existing execution_log columns (no new schema). Redis here is
// an evictable cache, unsuitable for preventing repeated LLM-generated pitches.
async function claimScan(pool, key, trackingId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const previous = await client.query(
      "SELECT 1 FROM execution_log WHERE transaction_type = 'trade_scan_claim' AND counter_offer->>'scan_key' = $1 LIMIT 1",
      [key],
    );
    if (previous.rowCount) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "INSERT INTO execution_log (transaction_type, bot_name, status, counter_offer, dry_run) VALUES ('trade_scan_claim', 'trade_scan', 'claimed', $1::jsonb, true)",
      [JSON.stringify({ scan_key: key, tracking_id: trackingId })],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// A scan that failed without staging anything gives its claim back, so a retry the same day is
// not locked out by an outage. Best-effort: a release error must not mask the original failure.
async function releaseClaim(pool, key) {
  await pool.query(
    "DELETE FROM execution_log WHERE transaction_type = 'trade_scan_claim' AND counter_offer->>'scan_key' = $1",
    [key],
  );
}

// Proposals still awaiting approval that an earlier scan staged for us. A counter-offer is not a
// proposal: it answers an incoming offer, so a new scan does not replace it.
const REPLACED_PROPOSAL_KEYS_SQL = `SELECT DISTINCT counter_offer->>'offer_key' AS offer_key FROM execution_log
       WHERE transaction_type = 'trade_offer_submit' AND status = 'awaiting_approval'
         AND counter_offer->>'source' = 'proposal' AND league_id = $1 AND season = $2
         AND counter_offer->>'from_team_id' = $3 AND executed_at < $4`;

// Every awaiting copy goes, because core's approval falls back to any awaiting row. A key that
// was approved in the meantime is left alone so its latest row keeps showing its real state.
const DISMISS_REPLACED_SQL = `UPDATE execution_log SET status = 'dismissed', outcome_details =
         COALESCE(outcome_details, '{}'::jsonb) || jsonb_build_object('dismissal', $3::jsonb)
       WHERE transaction_type = 'trade_offer_submit' AND counter_offer->>'offer_key' = $1
         AND status = 'awaiting_approval' AND executed_at < $2
         AND NOT EXISTS (SELECT 1 FROM execution_log approved
           WHERE approved.transaction_type = 'trade_offer_submit'
             AND approved.counter_offer->>'offer_key' = $1
             AND approved.status IN ('approval_pending', 'approved', 'submitting', 'submitted'))`;

function scanDismissal(trackingId) {
  return { reason: "replaced_by_scan", dismissed_by: "trade_scan", dismissed_at: new Date().toISOString(), tracking_id: trackingId };
}

// One key at a time under the same advisory lock core's approval takes, so an approval that
// lands mid-scan either wins outright or finds the offer already dismissed. The earlier scans'
// approval runs for the key are superseded in the same transaction, so the Runs tab stops
// showing them as waiting; a key approved meanwhile has no waiting approval left to supersede.
async function dismissReplacedProposal(pool, offerKey, before, dismissal) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [offerKey]);
    const updated = await client.query(DISMISS_REPLACED_SQL, [offerKey, before, JSON.stringify(dismissal)]);
    if (updated.rowCount > 0) await supersedeApprovals(client, offerKey, before);
    await client.query("COMMIT");
    return updated.rowCount > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retires the unapproved proposals earlier scans staged, so the approval list shows only the
 * latest scan's. Anything staged at or after `before` belongs to this scan and stays. Returns
 * how many offers were dismissed.
 */
async function retireReplacedProposals(pool, { leagueId, season, fromTeamId, before, trackingId }) {
  const { rows } = await pool.query(REPLACED_PROPOSAL_KEYS_SQL, [leagueId, season, String(fromTeamId), before]);
  const dismissal = scanDismissal(trackingId);
  let retired = 0;
  for (const { offer_key: offerKey } of rows) {
    if (await dismissReplacedProposal(pool, offerKey, before, dismissal)) retired += 1;
  }
  return retired;
}

// Best-effort: the new batch is already staged, so a failure here only leaves old proposals
// listed until the next scan.
async function retireQuietly(retire, pool, scope) {
  try {
    return await retire(pool, scope);
  } catch (error) {
    logger.warn("[Trade Scan] Could not retire the previous scan's proposals", { err: error });
    return 0;
  }
}

// The scan refreshes the inbox first so a new pitch never crosses an offer from that same manager
// that we haven't answered yet. Best-effort: the inbox has its own schedule, so an ESPN or core
// hiccup here shouldn't cost the twice-weekly pitch.
async function openOfferTeams(refreshInbox) {
  try {
    const inbox = await refreshInbox({ persist: true });
    return inbox.openOfferTeamIds || [];
  } catch (error) {
    logger.warn("[Trade Scan] Inbox refresh failed; scanning without offer exclusions", { err: error });
    return [];
  }
}

async function runTradeScan(
  { stage = false, trackingId = randomUUID() } = {},
  {
    readState = readSeason,
    now = new Date(),
    claim = claimScan,
    release = releaseClaim,
    retire = retireReplacedProposals,
    generate = generateTradeProposal,
    // Required lazily: trade_inbox.js reads this module's period helpers.
    refreshInbox = (options) => require("./trade_inbox").refreshTradeInbox(options),
    pool,
  } = {},
) {
  const period = resolvePeriod(await readState(), now);
  if (!period) return { status: "off_season" };
  const league = process.env.ESPN_LEAGUE_ID;
  const team = process.env.ESPN_TEAM_ID;
  if (![league, team].every((id) => /^[1-9]\d*$/.test(id || "")))
    throw new Error("ESPN_LEAGUE_ID and ESPN_TEAM_ID must be positive ids");
  const key = `trade-scan:${league}:${team}:${scanDate(now)}`;
  if (!stage) return { status: "check_only", ...period, scanKey: key };
  const scheduled = triggerFromEnv().triggerType === "schedule";
  const ownedPool = pool
    ? null
    : new Pool({
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: CLAIM_POOL_MAX_CONNECTIONS,
        connectionTimeoutMillis: CLAIM_DB_TIMEOUT_MS,
        statement_timeout: CLAIM_DB_TIMEOUT_MS,
      });
  let releasable = false;
  try {
    if (scheduled) {
      if (!(await claim(pool || ownedPool, key, trackingId)))
        return { status: "duplicate", ...period, scanKey: key };
      releasable = true;
    }
    // The claim is kept once any offer is staged (a retry would generate a different pitch and
    // offer_key), but released when the scan fails before staging anything.
    const excluded = await openOfferTeams(refreshInbox);
    const scanRunId = getContext().runId;
    const result = await generate({
      ...period,
      tracking_id: trackingId,
      // This scan's run, recorded on each staged offer so the send it leads to is its child.
      ...(scanRunId ? { scan_run_id: scanRunId } : {}),
      ...(excluded.length ? { exclude_team_ids: excluded } : {}),
    });
    const offers = result.offers ?? (result.submission ? [result] : []);
    const failures = offers.filter((offer) => offer.submission?.status === "fill_failed");
    const offersFailed = failures.length;
    const offersStaged = offers.length - offersFailed;
    if (offersStaged) releasable = false;
    const failureSummaries = failures.map((offer) => ({
      team_id: offer.target?.team_id ?? offer.offer?.toTeamId,
      classification: offer.submission.classification || "fill_error",
      reason: offer.submission.reason || offer.submission.error,
    }));
    for (const failure of failureSummaries) {
      logger.warn("[Trade Scan] An offer could not be staged; continuing with the rest", { ...failure, trackingId });
    }
    const rejectedSelections = offers.flatMap((offer) =>
      (offer.rejectedAttempts || []).map((attempt) => ({ team_id: offer.target?.team_id, ...attempt })));
    // Packages dropped for repeating an open offer or sending a committed player are not failures.
    const skippedPackages = result.skipped || [];
    if (offers.length || skippedPackages.length) {
      addSummary({
        offersStaged,
        offersFailed,
        ...(skippedPackages.length ? { skippedPackages } : {}),
        ...(failureSummaries.length ? { failures: failureSummaries } : {}),
        ...(rejectedSelections.length ? { rejectedSelections } : {}),
      });
    }
    // Partial success is a success: the staged offers are waiting for review. Only a scan that
    // stages nothing while something failed should page.
    if (offersFailed && !offersStaged) {
      throw new Error(`Trade scan staging failed: ${failureSummaries.map((f) => `team ${f.team_id}: ${f.reason}`).join("; ")}`);
    }
    const proposalsRetired = await retireQuietly(retire, pool || ownedPool, {
      leagueId: league, season: period.season, fromTeamId: team, before: now, trackingId,
    });
    if (proposalsRetired) addSummary({ proposalsRetired });
    return {
      status: result.status || "proposal",
      ...(result.reason ? { reason: result.reason } : {}),
      ...period,
      scanKey: key,
      submissionStatus: result.submission?.status,
      offersStaged,
      offersFailed,
      proposalsRetired,
      ...(failureSummaries.length ? { failures: failureSummaries } : {}),
    };
  } catch (error) {
    if (releasable) {
      await release(pool || ownedPool, key).catch((releaseError) =>
        logger.warn("[Trade Scan] Could not release the claim after a failed scan", { err: releaseError }));
    }
    throw error;
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

async function main(args = process.argv.slice(NODE_CLI_ARGUMENT_OFFSET)) {
  if (
    args.length > MAX_CLI_ARGUMENTS ||
    (args.length && !["--check", "--stage"].includes(args[CLI_OPTION_INDEX]))
  )
    throw new Error("Usage: node src/bots/trade_scan.js [--check|--stage]");
  const trackingId = randomUUID();
  const { withInstrumentation } = require("../telemetry/instrument");
  const run = async () => {
    const result = await runTradeScan({
      stage: args[CLI_OPTION_INDEX] === "--stage",
      trackingId,
    });
    logger.info("[Trade Scan] Completed", { ...result, trackingId });
    return result;
  };
  // Read-only check does not even write execution telemetry to Postgres.
  return args[CLI_OPTION_INDEX] === "--stage"
    ? withInstrumentation("trade_scan", { trackingId }, run)
    : run();
}

if (require.main === module) {
  // Also bounds manual CLI runs, including browser/DB/telemetry hangs.
  const deadline = setTimeout(() => {
    logger.error(
      `[Trade Scan] Runtime exceeded ${MAX_RUNTIME_MINUTES} minutes`,
    );
    process.exit(EXIT_FAILURE);
  }, MAX_RUNTIME_MINUTES * MILLISECONDS_PER_MINUTE);
  main()
    .catch((err) => {
      logger.error("[Trade Scan] Failed", { err });
      process.exitCode = EXIT_FAILURE;
    })
    .finally(async () => {
      await require("../telemetry/init").shutdownTelemetry();
      clearTimeout(deadline);
      process.exit(process.exitCode || EXIT_SUCCESS);
    });
}

module.exports = { readSeason, resolvePeriod, claimScan, retireReplacedProposals, runTradeScan, main };
