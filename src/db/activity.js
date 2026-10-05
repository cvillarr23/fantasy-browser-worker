// Durable action ownership is required before external writes. Observation writes after a
// submission are best-effort: an unavailable ledger must never cause a second external write.
const { Pool } = require("pg");
const { randomUUID, createHash } = require("crypto");
const { PermanentError, requirePlainObjectPayload } = require("../errors");
const { getContext } = require("../telemetry/context");
const { logger } = require("../telemetry/logger");
const ACTIVITY_POOL_LIMIT = 2;
const DATABASE_CONNECT_TIMEOUT_MS = 5000;
const MIN_REDACTED_SECRET_LENGTH = 8;
const MAX_HISTORY_EVENT_CHARS = 16000;
const historyWrites = new Map();
const MAX_ACTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1000;
const owners = new Map();
const dbOptions = {
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: ACTIVITY_POOL_LIMIT,
  connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
  statement_timeout: DATABASE_CONNECT_TIMEOUT_MS,
  query_timeout: DATABASE_CONNECT_TIMEOUT_MS,
};
const pool = new Pool(dbOptions);
const ownershipPool = new Pool(dbOptions);
ownershipPool.on("error", (err) => logger.error("Activity ownership connection failed", {err}));
pool.on("error", (err) => logger.error("Activity database error", { err }));
const secrets = Object.entries(process.env).filter(([key, secret]) => secret.length >= MIN_REDACTED_SECRET_LENGTH && /password|secret|token|api.?key|espn_s2|swid/i.test(key)).map(([, secret]) => secret);
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /password|secret|token|cookie|authorization|api.?key|espn_s2|swid/i.test(k)
          ? "[REDACTED]"
          : redact(v),
      ]),
    );
  if (typeof value === "string") {
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    return value.replace(/Bearer\s+[\w.\-/+=]+/gi, "Bearer [REDACTED]");
  }
  return value;
}
async function claim(queue, payload) {
  requirePlainObjectPayload(payload, queue);
  const id = payload.tracking_id || randomUUID();
  payload.tracking_id = id;
  const league = String(payload.league_id || process.env.ESPN_LEAGUE_ID || "");
  const client = await ownershipPool.connect();
  let owned = false;
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [id]);
    locked = lock.rows[0].acquired === true;
    if (!locked) {
      const error = new Error("Action is still owned by another worker; retry later.");
      error.retryDelayMs = RETRY_DELAY_MS;
      throw error;
    }
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO activity_actions(id,league_id,team_id,kind,title,payload,season) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        id,
        league,
        payload.team_id || process.env.ESPN_TEAM_ID,
        queue,
        `${queue.replaceAll("_", " ")} · ${payload.name || payload.team_id || "Background task"}`,
        JSON.stringify(redact(payload)),
        payload.season || payload.decision_inputs?.season || null,
      ],
    );
    const row = await client.query(
      "SELECT execution,attempts,evidence FROM activity_actions WHERE id=$1 FOR UPDATE",
      [id],
    );
    const action = row.rows[0];
    if (["finished", "submitted", "skipped"].includes(action.execution)) {
      await client.query("COMMIT");
      return false;
    }
    if (action.evidence?.external_write_started || (action.attempts || 0) >= MAX_ACTION_ATTEMPTS) {
      await client.query("UPDATE activity_actions SET execution='failed',updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO activity_events(action_id,stage) VALUES($1,'manual_verification_required')", [id]);
      await client.query("COMMIT");
      throw new PermanentError("Action needs manual verification before another external write; see Activity.");
    }
    await client.query(
      "UPDATE activity_actions SET execution='running',attempts=attempts+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await client.query("INSERT INTO activity_events(action_id,stage) VALUES($1,'running')", [id]);
    await client.query("COMMIT");
    owners.set(id, client);
    owned = true;
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (!owned) {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [id]).catch(() => {});
      client.release(true);
    }
  }
}
async function release(identity) {
  const client = owners.get(identity);
  if (!client) return;
  owners.delete(identity);
  try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [identity]); }
  finally { client.release(true); }
}
async function beforeExternalWrite() {
  const id = getContext().trackingId;
  if (!id || !owners.has(id)) return;
  // A pending waiver is not visible on the roster. Record uncertainty before its POST.
  await owners.get(id).query("UPDATE activity_actions SET evidence=evidence || '{\"external_write_started\":true}'::jsonb WHERE id=$1", [id]);
}
async function event(stage, detail = {}, execution = null, outcome = null, identity = null) {
  const id = identity || getContext().trackingId;
  if (!id) return;
  const client = await pool.connect().catch(() => null);
  if (!client) return;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM activity_actions WHERE id=$1 FOR UPDATE", [id]);
    await client.query("INSERT INTO activity_events(action_id,stage,detail) VALUES($1,$2,$3)", [
      id,
      stage,
      JSON.stringify(redact(detail)),
    ]);
    await client.query(
      "UPDATE activity_actions SET execution=CASE WHEN $2='finished' THEN CASE WHEN execution='running' THEN 'finished' ELSE execution END ELSE COALESCE($2,execution) END,outcome=COALESCE($3,outcome),evidence=evidence || $4::jsonb,updated_at=now() WHERE id=$1",
      [id, execution, outcome, JSON.stringify(redact(detail))],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("Activity outcome could not be recorded; reconciliation required", { err });
  } finally {
    client.release();
  }
}
async function startSession(title) {
  const id = randomUUID();
  try {
    await pool.query(
      "INSERT INTO activity_sessions(id,league_id,action_id,title) VALUES($1,$2,$3,$4)",
      [id, process.env.ESPN_LEAGUE_ID || "", getContext().trackingId || null, title],
    );
    return id;
  } catch (err) {
    logger.error("Could not record LLM session", { err });
    return null;
  }
}
function historyContent(content) {
  const encoded = JSON.stringify(redact(content));
  if (process.env.LLM_HISTORY_CAPTURE_CONTENT !== "true") return {content_sha256: createHash("sha256").update(encoded).digest("hex"), characters: encoded.length, capture: "metadata only"};
  return encoded.length > MAX_HISTORY_EVENT_CHARS ? {preview: encoded.slice(0, MAX_HISTORY_EVENT_CHARS), truncated: true, characters: encoded.length} : redact(content);
}
function sessionEvent(id, role, content, status = null) {
  if (!id) return;
  const observed = ["prompt", "response"].includes(role) ? historyContent(content) : redact(content);
  // Keep per-session ordering while provider calls continue independently of observation writes.
  const next = (historyWrites.get(id) || Promise.resolve()).then(() => pool.query(
    "UPDATE activity_sessions SET content=content || $2::jsonb,status=COALESCE($3,status),updated_at=now() WHERE id=$1",
    [id, JSON.stringify([{role, content: observed}]), status],
  )).catch(err => logger.error("Could not record LLM session event", {err}));
  historyWrites.set(id, next);
  next.finally(() => { if (historyWrites.get(id) === next) historyWrites.delete(id); });
}
// Standalone scheduled jobs are observable without changing their execution policy.
async function observe(botName, identity) {
  const id = identity || randomUUID();
  try {
    await pool.query(
      "INSERT INTO activity_actions(id,league_id,team_id,kind,title,execution,attempts) VALUES($1,$2,$3,$4,$5,'running',1) ON CONFLICT DO NOTHING",
      [
        id,
        process.env.ESPN_LEAGUE_ID || "",
        process.env.ESPN_TEAM_ID,
        botName,
        botName.replaceAll("_", " "),
      ],
    );
    return id;
  } catch (err) {
    logger.error("Could not record scheduled job", { err });
    return null;
  }
}
module.exports = { claim, event, startSession, sessionEvent, redact, observe, release, beforeExternalWrite, historyContent };
