/**
 * The notifications the worker sends, one builder per event. Each returns the argument for
 * notify() (see ./notify), so wording, links and dedupe windows are tested without the network.
 */
const { resolveDryRun, resolveTradeDryRun } = require("./env");
const { PRIORITY_HIGH, PRIORITY_URGENT, truncate } = require("./notify");

const MS_PER_HOUR = 60 * 60 * 1000;
// A failing bot is retried by the queue and rerun by its CronJob; one ping per hour per distinct
// error is enough to know it's broken.
const RUN_FAILURE_DEDUPE_TTL_MS = MS_PER_HOUR;
// A staged or incoming offer is announced once; ESPN trade offers expire within a couple of days.
const TRADE_DEDUPE_TTL_MS = 24 * MS_PER_HOUR;
const MAX_ERROR_CHARS = 300;
// The dedupe key carries the error text so a different failure of the same bot still pings.
const MAX_ERROR_KEY_CHARS = 120;

const ESPN_SESSION_BOT = "check_espn_session";

// Only an explicit DRY_RUN=true marks titles; unset means production.
function titled(title) {
  return resolveDryRun(false).dryRun ? `[dry run] ${title}` : title;
}

// Trade-builder notifications follow the trade dry-run switch, so a trade that TRADE_DRY_RUN=false
// arms isn't labelled dry run just because the shared DRY_RUN is true.
function tradeTitled(title) {
  return resolveTradeDryRun(false).dryRun ? `[dry run] ${title}` : title;
}

function runFailed({ botName, runId, error }) {
  const reason = truncate(error?.message || "Unknown error", MAX_ERROR_CHARS);
  if (botName === ESPN_SESSION_BOT) {
    return {
      title: titled("ESPN session expired"),
      message: `The bots can't act on ESPN until the session cookies are refreshed.\n${reason}`,
      priority: PRIORITY_URGENT,
      tags: ["warning"],
      path: "/settings",
      actionLabel: "Settings",
      dedupeKey: "espn_session",
      dedupeTtlMs: RUN_FAILURE_DEDUPE_TTL_MS,
    };
  }
  return {
    title: titled(`${botName} failed`),
    message: error?.permanent ? `${reason}\nPermanent error: retrying won't help.` : reason,
    priority: PRIORITY_HIGH,
    tags: ["rotating_light"],
    path: runId ? `/activity/runs/${encodeURIComponent(runId)}` : "/activity",
    actionLabel: "View run",
    dedupeKey: `run_failed:${botName}:${truncate(reason, MAX_ERROR_KEY_CHARS)}`,
    dedupeTtlMs: RUN_FAILURE_DEDUPE_TTL_MS,
  };
}

const playerList = (ids) => (ids && ids.length > 0 ? ids.join(", ") : "nothing");

function tradeAwaitingApproval({ offerKey, offer, source }) {
  const what = source === "counter_offer" ? "Counter-offer" : "Trade offer";
  return {
    title: tradeTitled(`${what} ready for approval`),
    message:
      `To team ${offer.toTeamId}: receive ${playerList(offer.incomingPlayerIds)}; ` +
      `send ${playerList(offer.outgoingPlayerIds)}.`,
    priority: PRIORITY_HIGH,
    tags: ["handshake"],
    path: `/trades?offer=${encodeURIComponent(offerKey)}`,
    actionLabel: "Review",
    dedupeKey: `trade_approval:${offerKey}`,
    dedupeTtlMs: TRADE_DEDUPE_TTL_MS,
  };
}

function incomingTradeOffer(entry) {
  const names = (ids) => playerList((ids || []).map((id) => entry.player_names?.[id] || id));
  const score = entry.score?.final_score;
  const lines = [
    `You receive ${names(entry.receive_espn_ids)}; you send ${names(entry.send_espn_ids)}.`,
    ...(typeof score === "number" ? [`Score: ${score}`] : []),
    ...(entry.comment ? [`"${truncate(entry.comment, MAX_ERROR_CHARS)}"`] : []),
  ];
  const id = entry.espn_transaction_id;
  return {
    title: titled(`New trade offer from team ${entry.proposing_team_id}`),
    message: lines.join("\n"),
    priority: PRIORITY_HIGH,
    tags: ["inbox_tray"],
    path: `/inbox?offer=${encodeURIComponent(id)}`,
    actionLabel: "Review",
    dedupeKey: `trade_incoming:${id}`,
    dedupeTtlMs: TRADE_DEDUPE_TTL_MS,
  };
}

module.exports = {
  runFailed,
  tradeAwaitingApproval,
  incomingTradeOffer,
  RUN_FAILURE_DEDUPE_TTL_MS,
  TRADE_DEDUPE_TTL_MS,
};
