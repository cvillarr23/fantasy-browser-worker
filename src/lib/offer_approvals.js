// A staged outgoing offer waits for a person as a launcher approval run (see db/run_log.js). The
// Runs tab shows it as "waiting for you" and links to the Trades page, where it is approved.
const { CORE_PIPELINE_URL } = require("./core_pipeline");
const { logger } = require("../telemetry/logger");
const runLog = require("../db/run_log");

const JOBS_TIMEOUT_MS = 10_000;
const APPROVAL_TTL_HOURS = 72;
const MILLISECONDS_PER_HOUR = 3_600_000;
const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * MILLISECONDS_PER_HOUR;
const SCAN_JOB = "trade-scan";
const SUBMIT_JOB = "trade-submit";

let nextScan = null;
let warnedNoLauncherRun = false;

/** The next scheduled trade-scan, from core's Jobs API (GET /v1/jobs needs no key), or null. */
async function fetchNextScanAt() {
  try {
    const response = await fetch(`${CORE_PIPELINE_URL}/v1/jobs`, {
      signal: AbortSignal.timeout(JOBS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`jobs HTTP ${response.status}`);
    const { jobs } = await response.json();
    const nextRunAt = (jobs || []).find(
      (job) => job.name === SCAN_JOB,
    )?.next_run_at;
    const at = nextRunAt ? new Date(nextRunAt) : null;
    return at && !Number.isNaN(at.getTime()) ? at : null;
  } catch (err) {
    logger.warn(
      "Could not read the next trade-scan slot; approvals expire after 72h",
      { err },
    );
    return null;
  }
}

/** Read once per process: one scan stages all its offers against the same next slot. */
function nextScanAt() {
  if (!nextScan) nextScan = fetchNextScanAt();
  return nextScan;
}

/** The next scheduled scan or 72h after staging, whichever is sooner: each scan's offers live
 * until the next scan, but never longer than 72h, so their scores can't go stale. */
function approvalExpiry(stagedAt, nextScan) {
  const cap = new Date(stagedAt.getTime() + APPROVAL_TTL_MS);
  return nextScan && nextScan > stagedAt && nextScan < cap ? nextScan : cap;
}

function approvalTitle(offer) {
  const give = offer.outgoingPlayerIds.length;
  const get = offer.incomingPlayerIds.length;
  return `Send trade to team ${offer.toTeamId}: give ${give}, get ${get}`;
}

/**
 * Opens the approval run for an offer the scan run `scanRunId` just staged. Approving it on the
 * Trades page starts `trade-submit` for the offer. Skipped (returns null) outside a launcher run,
 * where there is no run to parent it to: that offer is approved without one, as before approval
 * runs. Best-effort, like recording the offer.
 */
async function openOfferApproval({
  scanRunId,
  offerKey,
  offer,
  now = new Date(),
}) {
  if (!scanRunId || !runLog.isLauncherRun(scanRunId)) {
    if (!warnedNoLauncherRun) {
      warnedNoLauncherRun = true;
      logger.info(
        "Not a launcher run (no RUN_ID): staged offers get no approval run",
      );
    }
    return null;
  }
  return runLog.openApproval({
    runId: scanRunId,
    key: offerKey,
    title: approvalTitle(offer),
    link: `/trades?offer=${offerKey}`,
    then: { job: SUBMIT_JOB, params: { offer_key: offerKey } },
    expiresAt: approvalExpiry(now, await nextScanAt()),
  });
}

/** Forgets the cached slot and the one-time log; for tests. */
function resetOfferApprovals() {
  nextScan = null;
  warnedNoLauncherRun = false;
}

module.exports = {
  openOfferApproval,
  approvalExpiry,
  approvalTitle,
  resetOfferApprovals,
  APPROVAL_TTL_MS,
};
