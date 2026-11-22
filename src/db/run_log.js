// Run audit log, shared with fantasy-core-pipeline's run_log_service (which owns the schema):
// one run_log row per bot run, and run_links rows for what the run read and wrote. Every write
// is best-effort -- an unavailable audit log must never fail or retry a bot.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { getContext } = require("../telemetry/context");
const { logger } = require("../telemetry/logger");
const { measureRunUsage } = require("./run_usage");

const RUN_LOG_POOL_LIMIT = 2;
const DATABASE_TIMEOUT_MS = 5000;
const MAX_ERROR_CHARS = 4000;
const adoptedParentRunIds = new Map();
const adoptedAttempts = new Map();
// Adopted runs, which own their pod (or, inline, their process) and so record its usage.
const adoptedRuns = new Set();

const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: RUN_LOG_POOL_LIMIT,
  connectionTimeoutMillis: DATABASE_TIMEOUT_MS,
  statement_timeout: DATABASE_TIMEOUT_MS,
  query_timeout: DATABASE_TIMEOUT_MS,
});
pool.on("error", (err) => logger.error("Run log database error", { err }));

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The job launcher sets RUN_TRIGGER, which wins. Otherwise scheduled vs manual comes from the
 * Job name: a CronJob names its Jobs `<cronjob>-<minutes>`, while
 * `kubectl create job --from=cronjob/...` picks any name. */
function triggerFromEnv(env = process.env) {
  if (env.RUN_TRIGGER) return { triggerType: env.RUN_TRIGGER, trigger: {} };
  const cronjob = env.RUN_CRONJOB;
  const k8sJob = env.RUN_K8S_JOB || env.HOSTNAME;
  if (cronjob) {
    const scheduled = Boolean(k8sJob && new RegExp(`^${escapeRegExp(cronjob)}-\\d+$`).test(k8sJob));
    return { triggerType: scheduled ? "schedule" : "manual", trigger: { cronjob, k8s_job: k8sJob } };
  }
  return { triggerType: "manual", trigger: k8sJob ? { host: k8sJob } : {} };
}

/** The run that queued this action, so a worker run shows up as its child. */
async function parentForAction(trackingId) {
  if (!trackingId) return null;
  try {
    const { rows } = await pool.query(
      "SELECT run_id FROM run_links WHERE ref_type='activity_action' AND ref_id=$1 AND role='output' LIMIT 1",
      [String(trackingId)],
    );
    return rows[0]?.run_id || null;
  } catch (err) {
    logger.error("Could not look up the run that queued this action", { err });
    return null;
  }
}

function restoreParentRunId(id) {
  if (!adoptedParentRunIds.has(id)) return;
  const previousParentId = adoptedParentRunIds.get(id);
  adoptedParentRunIds.delete(id);
  if (previousParentId === undefined) delete process.env.RUN_PARENT_ID;
  else process.env.RUN_PARENT_ID = previousParentId;
}

/** Records the run, or adopts the launcher's row when RUN_ID is set. The launcher retries a run
 * on the same row with the next RUN_ATTEMPT, so adoption only claims the row while it is still
 * running at this attempt; otherwise this process is a stale attempt and must not run, so this
 * throws. A database error stays best-effort and still returns the adopted id. */
async function startRun({ jobName, triggerType, trigger, parentRunId, traceId = null }) {
  const adoptedId = process.env.RUN_ID || null;
  const attempt = adoptedId && process.env.RUN_ATTEMPT ? Number(process.env.RUN_ATTEMPT) : null;
  if (attempt !== null && !Number.isInteger(attempt)) {
    throw new Error(`Run ${adoptedId} has an invalid RUN_ATTEMPT: ${process.env.RUN_ATTEMPT}`);
  }
  const id = adoptedId || randomUUID();
  const parent = parentRunId || process.env.RUN_PARENT_ID || null;
  const resolved = triggerType ? { triggerType, trigger: trigger || {} } : triggerFromEnv();
  const resolvedTrigger = { ...resolved.trigger, ...(trigger || {}) };
  if (adoptedId) {
    adoptedParentRunIds.set(adoptedId, process.env.RUN_PARENT_ID);
    adoptedAttempts.set(adoptedId, attempt);
    adoptedRuns.add(adoptedId);
    delete process.env.RUN_ID;
    process.env.RUN_PARENT_ID = adoptedId;
  }
  let adopted;
  try {
    if (adoptedId) {
      const { rowCount } = await pool.query(
        "UPDATE run_log SET status='running',trigger_type=$1,summary=summary || jsonb_build_object('entrypoint',$2::text),parent_run_id=COALESCE(parent_run_id,$3),started_at=now(),finished_at=NULL,error=NULL WHERE id=$4 AND status='running' AND attempt=COALESCE($5,attempt)",
        [resolved.triggerType, jobName, parent, id, attempt],
      );
      adopted = rowCount === 1;
    } else {
      await pool.query(
        "INSERT INTO run_log(id,job_name,trigger_type,trigger,parent_run_id,trace_id) VALUES($1,$2,$3,$4,$5,$6)",
        [id, jobName, resolved.triggerType, JSON.stringify(resolvedTrigger), parent, traceId],
      );
    }
  } catch (err) {
    logger.error(adoptedId ? "Could not adopt run" : "Could not record run", { err, jobName });
    return adoptedId;
  }
  if (adoptedId && !adopted) {
    restoreParentRunId(adoptedId);
    adoptedAttempts.delete(adoptedId);
    adoptedRuns.delete(adoptedId);
    throw new Error(`Run ${adoptedId} attempt ${attempt} is no longer current`);
  }
  return id;
}

/** Never overwrites a cancelled row, nor a newer attempt's when this run was adopted. */
async function finishRun(id, status, { error = null, summary = {} } = {}) {
  if (!id) return;
  try {
    await pool.query(
      "UPDATE run_log SET status=$2,finished_at=now(),error=$3,summary=summary || $4::jsonb WHERE id=$1 AND status<>'cancelled' AND attempt=COALESCE($5,attempt)",
      [
        id,
        status,
        error ? String(error).slice(0, MAX_ERROR_CHARS) : null,
        JSON.stringify({ ...(summary || {}), ...launcherRunUsage(id) }),
        adoptedAttempts.get(id) ?? null,
      ],
    );
  } catch (err) {
    logger.error("Could not record run outcome", { err, runId: id });
  } finally {
    adoptedAttempts.delete(id);
    adoptedRuns.delete(id);
    restoreParentRunId(id);
  }
}

/** Links rows to the given run, else the run active in this async context; a no-op outside one. */
/** { resources } for a launcher-adopted run, which owns its pod (or, inline, its process). A
 * run this process started itself shares the process, so it records nothing. */
function launcherRunUsage(id) {
  if (!adoptedRuns.has(id)) return {};
  // The CPU counters include node's start-up and requires, so the wall time is the process's
  // whole lifetime, not just the time since startRun.
  const usage = measureRunUsage(adoptedAttempts.get(id) ?? 1, process.uptime());
  return usage ? { resources: usage } : {};
}

async function link(refType, ids, role, runId = getContext().runId) {
  const refIds = (ids || []).filter((id) => id !== null && id !== undefined).map(String);
  if (!runId || refIds.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO run_links(run_id,ref_type,ref_id,role)
       SELECT $1,$2,unnest($3::text[]),$4 ON CONFLICT DO NOTHING`,
      [runId, refType, refIds, role],
    );
  } catch (err) {
    logger.error("Could not record run links", { err, runId });
  }
}

/** Adds counters to the active run's summary, saved when the run finishes. */
function addSummary(fields) {
  const summary = getContext().runSummary;
  if (summary) Object.assign(summary, fields);
}

/** Whether `id` is a launcher run this process adopted (RUN_ID), not one it recorded itself. */
function isLauncherRun(id) {
  return adoptedRuns.has(id);
}

// --- Trade-offer approval runs ---------------------------------------------------------------
//
// An approval run waits for a person: a run_log row with executor 'approval' and status 'waiting'.
// Core owns them (approval_service; Runs.insert_approval names this file as a second writer). The
// trade scan opens one per staged offer here, because worker pods have no API key for core's
// POST /v1/runs/{run_id}/approvals, and only ever moves one waiting -> superseded. Core does every
// other transition: approve, dismiss, expiry and starting `then`. core's
// tests/test_trade_approval_postgres.py pins these statements.

const OPEN_APPROVAL_SQL = `INSERT INTO run_log(id,job_name,trigger_type,trigger,parent_run_id,status,
    executor,dedupe_key,scheduled_for,expires_at)
  VALUES ($1,'approval','approval',$2::jsonb,$3,'waiting','approval',$4,now(),$5)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`;

// Only trade-offer approvals opened before `before` (an earlier scan's): this scan's own, for an
// offer it staged again, stays waiting.
const SUPERSEDE_APPROVALS_SQL = `UPDATE run_log SET status='skipped', end_reason='superseded',
    requested_by='trade_scan', finished_at=now()
  WHERE executor='approval' AND status='waiting' AND trigger->'then'->>'job'='trade-submit'
    AND trigger->>'key'=$1 AND started_at<$2
  RETURNING id`;

/** core's approval_service.approval_dedupe_key. */
function approvalDedupeKey(runId, key) {
  return `approval@${runId}#${key}`;
}

/**
 * Opens a waiting approval run for `key`, parented to the run that asks for it. Returns
 * { id, opened } -- `opened: false` when that run already opened one for `key` (the dedupe key),
 * which counts as success -- or null when the write failed. Best-effort, like every write here.
 */
async function openApproval({ runId, key, title, link, then, expiresAt }) {
  const trigger = { key, title, ...(link ? { link } : {}), ...(then ? { then } : {}) };
  const dedupeKey = approvalDedupeKey(runId, key);
  try {
    const { rows } = await pool.query(OPEN_APPROVAL_SQL, [
      randomUUID(),
      JSON.stringify(trigger),
      runId,
      dedupeKey,
      expiresAt,
    ]);
    if (rows.length > 0) return { id: rows[0].id, opened: true };
    const existing = await pool.query("SELECT id FROM run_log WHERE dedupe_key=$1", [dedupeKey]);
    return { id: existing.rows[0]?.id || null, opened: false };
  } catch (err) {
    logger.error("Could not open approval run", { err, runId, key });
    return null;
  }
}

/** Supersedes the waiting approvals earlier runs opened for `key`, on the caller's client so it
 * commits with the offer's retirement. Throws, unlike the best-effort writes above. */
async function supersedeApprovals(client, key, before) {
  const { rowCount } = await client.query(SUPERSEDE_APPROVALS_SQL, [key, before]);
  return rowCount;
}

module.exports = {
  triggerFromEnv,
  parentForAction,
  startRun,
  finishRun,
  link,
  addSummary,
  isLauncherRun,
  approvalDedupeKey,
  openApproval,
  supersedeApprovals,
  OPEN_APPROVAL_SQL,
  SUPERSEDE_APPROVALS_SQL,
};
