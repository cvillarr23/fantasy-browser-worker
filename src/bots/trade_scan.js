const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const { generateTradeProposal } = require("./trade_proposal");
const { logger } = require("../telemetry/logger");

// Sleeper's NFL state is calendar metadata only; player/team ids remain ESPN ids.
async function readSeason() {
  const response = await fetch("https://api.sleeper.app/v1/state/nfl", {
    signal: AbortSignal.timeout(10000),
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
    season < 2000 ||
    !Number.isInteger(week) ||
    week < 0 ||
    week > 18
  )
    throw new Error("Invalid NFL season/week");
  // Fail closed on stale regular-season metadata during spring/summer. January
  // belongs to the previous season; never derive the season from CURRENT_YEAR.
  const month = now.getUTCMonth();
  if (month > 0 && month < 8) return null;
  if (season !== now.getUTCFullYear() - (month === 0 ? 1 : 0))
    throw new Error("Stale NFL season");
  return week === 0 ? null : { season, week };
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

async function runTradeScan(
  { stage = false, trackingId = randomUUID() } = {},
  {
    readState = readSeason,
    now = new Date(),
    claim = claimScan,
    generate = generateTradeProposal,
    pool,
  } = {},
) {
  const period = resolvePeriod(await readState(), now);
  if (!period) return { status: "off_season" };
  const league = process.env.ESPN_LEAGUE_ID;
  const team = process.env.ESPN_TEAM_ID;
  if (![league, team].every((id) => /^[1-9]\d*$/.test(id || "")))
    throw new Error("ESPN_LEAGUE_ID and ESPN_TEAM_ID must be positive ids");
  const key = `trade-scan:${league}:${team}:${period.season}:${period.week}`;
  if (!stage) return { status: "check_only", ...period, scanKey: key };
  const ownedPool = pool
    ? null
    : new Pool({
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 1,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
      });
  try {
    if (!(await claim(pool || ownedPool, key, trackingId)))
      return { status: "duplicate", ...period, scanKey: key };
    // Retain the claim even on errors/timeouts: a generated pitch changes offer_key,
    // so blind retries could stage a different offer. Next week's scan can proceed.
    const result = await generate({ ...period, tracking_id: trackingId });
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

async function main(args = process.argv.slice(2)) {
  if (
    args.length > 1 ||
    (args.length && !["--check", "--stage"].includes(args[0]))
  )
    throw new Error("Usage: node src/bots/trade_scan.js [--check|--stage]");
  const trackingId = randomUUID();
  const { withInstrumentation } = require("../telemetry/instrument");
  const run = async () => {
    const result = await runTradeScan({
      stage: args[0] === "--stage",
      trackingId,
    });
    logger.info("[Trade Scan] Completed", { ...result, trackingId });
    return result;
  };
  // Read-only check does not even write execution telemetry to Postgres.
  return args[0] === "--stage"
    ? withInstrumentation("trade_scan", { trackingId }, run)
    : run();
}

if (require.main === module) {
  // Also bounds manual CLI runs, including browser/DB/telemetry hangs.
  const deadline = setTimeout(
    () => {
      logger.error("[Trade Scan] Runtime exceeded 15 minutes");
      process.exit(1);
    },
    15 * 60 * 1000,
  );
  main()
    .catch((err) => {
      logger.error("[Trade Scan] Failed", { err });
      process.exitCode = 1;
    })
    .finally(async () => {
      await require("../telemetry/init").shutdownTelemetry();
      clearTimeout(deadline);
      process.exit(process.exitCode || 0);
    });
}

module.exports = { resolvePeriod, claimScan, runTradeScan, main };
