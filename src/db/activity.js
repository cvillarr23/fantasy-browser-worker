// Durable action ownership is required before external writes. Observation writes after a
// submission are best-effort: an unavailable ledger must never cause a second external write.
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const { getContext } = require("../telemetry/context");
const { logger } = require("../telemetry/logger");
const ACTIVITY_POOL_LIMIT = 2;
const DATABASE_CONNECT_TIMEOUT_MS = 5000;
const MIN_REDACTED_SECRET_LENGTH = 8;
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: ACTIVITY_POOL_LIMIT,
  connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
});
pool.on("error", (err) => logger.error("Activity database error", { err }));
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
    for (const [key, secret] of Object.entries(process.env))
      if (secret.length >= MIN_REDACTED_SECRET_LENGTH && /password|secret|token|api.?key|espn_s2|swid/i.test(key))
        value = value.split(secret).join("[REDACTED]");
    return value.replace(/Bearer\s+[\w.\-/+=]+/gi, "Bearer [REDACTED]");
  }
  return value;
}
async function claim(queue, payload) {
  const id = payload.tracking_id || randomUUID();
  payload.tracking_id = id;
  const league = String(payload.league_id || process.env.ESPN_LEAGUE_ID || "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO activity_actions(id,league_id,team_id,kind,title,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        id,
        league,
        payload.team_id || process.env.ESPN_TEAM_ID,
        queue,
        `${queue.replaceAll("_", " ")} · ${payload.name || payload.team_id || "Background task"}`,
        JSON.stringify(redact(payload)),
      ],
    );
    const row = await client.query(
      "SELECT execution FROM activity_actions WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (row.rows[0].execution !== "queued") {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "UPDATE activity_actions SET execution='running',attempts=attempts+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await client.query("INSERT INTO activity_events(action_id,stage) VALUES($1,'running')", [id]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
async function sessionEvent(id, role, content, status = null) {
  if (!id) return;
  try {
    await pool.query(
      "UPDATE activity_sessions SET content=content || $2::jsonb,status=COALESCE($3,status),updated_at=now() WHERE id=$1",
      [id, JSON.stringify([{ role, content: redact(content) }]), status],
    );
  } catch (err) {
    logger.error("Could not record LLM session event", { err });
  }
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
module.exports = { claim, event, startSession, sessionEvent, redact, observe };
