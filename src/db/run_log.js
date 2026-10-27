// Run audit log, shared with fantasy-core-pipeline's run_log_service (which owns the schema):
// one run_log row per bot run, and run_links rows for what the run read and wrote. Every write
// is best-effort -- an unavailable audit log must never fail or retry a bot.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { getContext } = require("../telemetry/context");
const { logger } = require("../telemetry/logger");

const RUN_LOG_POOL_LIMIT = 2;
const DATABASE_TIMEOUT_MS = 5000;
const MAX_ERROR_CHARS = 4000;
const adoptedParentRunIds = new Map();
const adoptedAttempts = new Map();

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
        JSON.stringify(summary || {}),
        adoptedAttempts.get(id) ?? null,
      ],
    );
  } catch (err) {
    logger.error("Could not record run outcome", { err, runId: id });
  } finally {
    adoptedAttempts.delete(id);
    restoreParentRunId(id);
  }
}

/** Links rows to the given run, else the run active in this async context; a no-op outside one. */
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

module.exports = { triggerFromEnv, parentForAction, startRun, finishRun, link, addSummary };
