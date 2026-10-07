const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { generateTradeProposal } = require("./trade_proposal");
const { logger } = require("../telemetry/logger");

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

// Use the CronJob timezone, including DST, so manual and scheduled runs share
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
  try {
    if (!(await claim(pool || ownedPool, key, trackingId)))
      return { status: "duplicate", ...period, scanKey: key };
    // Retain the claim even on errors/timeouts: a generated pitch changes offer_key,
    // so blind retries could stage a different offer. The next scheduled day's scan can proceed.
    const excluded = await openOfferTeams(refreshInbox);
    const result = await generate({
      ...period,
      tracking_id: trackingId,
      ...(excluded.length ? { exclude_team_ids: excluded } : {}),
    });
    if (result.submission?.status === "fill_failed")
      throw new Error(`Trade scan staging failed: ${result.submission.error}`);
    return {
      status: result.status || "proposal",
      ...period,
      scanKey: key,
      submissionStatus: result.submission?.status,
    };
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

module.exports = { readSeason, resolvePeriod, claimScan, runTradeScan, main };
