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

/** Scheduled vs manual comes from the Job name: a CronJob names its Jobs `<cronjob>-<minutes>`,
 * while `kubectl create job --from=cronjob/...` picks any name. */
function triggerFromEnv(env = process.env) {
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

async function startRun({ jobName, triggerType, trigger, parentRunId = null, traceId = null }) {
  const id = randomUUID();
  try {
    await pool.query(
      "INSERT INTO run_log(id,job_name,trigger_type,trigger,parent_run_id,trace_id) VALUES($1,$2,$3,$4,$5,$6)",
      [id, jobName, triggerType, JSON.stringify(trigger || {}), parentRunId, traceId],
    );
    return id;
  } catch (err) {
    logger.error("Could not record run", { err, jobName });
    return null;
  }
}

async function finishRun(id, status, { error = null, summary = {} } = {}) {
  if (!id) return;
  try {
    await pool.query(
      "UPDATE run_log SET status=$2,finished_at=now(),error=$3,summary=summary || $4::jsonb WHERE id=$1",
      [id, status, error ? String(error).slice(0, MAX_ERROR_CHARS) : null, JSON.stringify(summary || {})],
    );
  } catch (err) {
    logger.error("Could not record run outcome", { err, runId: id });
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
