const redis = require("redis");
const { buildPicksStreamKey } = require("../src/bots/draft_sync");

/**
 * Local inspection tool for draft_sync.js — subscribes to the `draft_picks` pub/sub channel and
 * prints each pick as it's published, so you can watch the pipeline work end-to-end (k8s test Job
 * -> Redis -> here) without needing a real consumer service running yet.
 *
 * Usage (typically after `kubectl port-forward svc/fantasy-cache 6379:6379`):
 *   node scripts/watch_draft_picks.js [leagueId] [seasonId]
 *
 * Pass leagueId and seasonId to also dump the full pick history so far (from the
 * `draft_picks:{leagueId}:{seasonId}` stream) before switching to live-tail mode — useful if you
 * attach after the draft's already in progress. Without them, this only shows picks published
 * from the moment it connects onward.
 */

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT || 6379;

function formatPick(event) {
  const round = event.round != null ? `R${event.round}` : "R?";
  const roundPick = event.round_pick_number != null ? `.${event.round_pick_number}` : "";
  return (
    `#${String(event.pick_number).padStart(3, " ")} [${round}${roundPick}] ` +
    `team ${event.team_id} -> player ${event.player_id} (${event.source ?? "unknown"})`
  );
}

async function dumpHistory(client, leagueId, seasonId) {
  const streamKey = buildPicksStreamKey(leagueId, seasonId);
  const entries = await client.xRange(streamKey, "-", "+");
  if (entries.length === 0) {
    console.log(`[Watch] No history yet on ${streamKey}.`);
    return;
  }
  console.log(`[Watch] Replaying ${entries.length} pick(s) already on ${streamKey}:`);
  for (const entry of entries) {
    try {
      console.log("  " + formatPick(JSON.parse(entry.message.payload)));
    } catch {
      console.warn(`  [Watch] Could not parse stream entry ${entry.id}`);
    }
  }
}

async function main() {
  const [leagueId, seasonId] = process.argv.slice(2);
  if (leagueId && !seasonId) {
    console.error(
      "[Watch] leagueId given without seasonId — the picks stream is keyed by both. " +
        "Usage: node scripts/watch_draft_picks.js [leagueId] [seasonId]",
    );
    process.exit(1);
  }

  const client = redis.createClient({ url: `redis://${REDIS_HOST}:${REDIS_PORT}` });
  client.on("error", (err) => console.error(`[Watch] Redis client error: ${err.message}`));
  await client.connect();
  console.log(`[Watch] Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);

  if (leagueId) {
    await dumpHistory(client, leagueId, seasonId);
  }

  const subscriber = client.duplicate();
  await subscriber.connect();
  await subscriber.subscribe("draft_picks", (message) => {
    try {
      console.log("[Watch] " + formatPick(JSON.parse(message)));
    } catch {
      console.warn(`[Watch] Could not parse pub/sub message: ${message}`);
    }
  });

  console.log("[Watch] Subscribed to draft_picks. Waiting for picks... (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    await subscriber.quit();
    await client.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[Watch] Fatal error: ${err.message}`);
  process.exit(1);
});
