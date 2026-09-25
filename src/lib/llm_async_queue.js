const crypto = require("crypto");
const { Pool } = require("pg");
const { logger } = require("../telemetry/logger");
const { publishToQueue } = require("../queue/connection");
const { completeWithFallback } = require("./llm_client");
const { PermanentError, requirePlainObjectPayload } = require("../errors");

// Separate module from llm_client.js on purpose: that file is scoped to transport + fallback +
// rate limiting + instrumentation only, and this is a distinct orchestration concern (publish,
// poll, act, respond) layered on top. Own pool, same shape as llm_client.js's metrics pool.
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});

pool.on("error", (err) => {
  logger.error("[LLM Async Queue] Idle client error on connection pool", {
    err,
  });
});

const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Publishes `prompt` for async processing and returns immediately with a request_id -- never
 * waits on the LLM call itself. Inserts the row as `pending` before publishing so a poll
 * immediately after this resolves never races an empty table.
 */
async function requestLlmAsync(prompt, opts = {}) {
  const requestId = crypto.randomUUID();

  await pool.query(
    `INSERT INTO llm_async_requests (request_id, status, prompt, call_opts)
     VALUES ($1, 'pending', $2, $3)`,
    [requestId, prompt, JSON.stringify(opts)],
  );

  await publishToQueue("llm_requests", { request_id: requestId, prompt, opts });

  return { request_id: requestId };
}

/** One-shot poll of a request's row. `null` only for an unknown request_id. */
async function getLlmRequestResult(requestId) {
  const { rows } = await pool.query(
    `SELECT status, result_text, error_message, provider, model, completed_at
     FROM llm_async_requests WHERE request_id = $1`,
    [requestId],
  );
  return rows[0] || null;
}

/**
 * Sugar over repeated getLlmRequestResult polls for a caller that wants await-style ergonomics.
 * Holds no queue/channel resource while it polls, so a timeout is cheap and side-effect-free.
 */
async function waitForLlmResult(
  requestId,
  { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getLlmRequestResult(requestId);
    if (result && result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for llm request ${requestId}`,
  );
}

/**
 * The llm_requests queue consumer entry point. Calls completeWithFallback and writes the
 * outcome to the same row requestLlmAsync inserted. These UPDATEs are NOT best-effort (unlike
 * llm_client.js's metrics writes) -- this row is the actual response channel a caller polls, so a
 * swallowed write failure would silently strand a caller waiting on a result that already exists.
 */
async function processAsyncLlmRequest(payload) {
  requirePlainObjectPayload(payload, "llm_requests");
  const { request_id: requestId, prompt, opts } = payload;

  if (!requestId || typeof requestId !== "string") {
    throw new PermanentError("llm_requests payload missing request_id");
  }
  if (!prompt || typeof prompt !== "string") {
    throw new PermanentError("llm_requests payload missing prompt");
  }

  try {
    const result = await completeWithFallback(prompt, opts || {});
    await pool.query(
      `UPDATE llm_async_requests
       SET status = 'succeeded', result_text = $1, provider = $2, model = $3, completed_at = now()
       WHERE request_id = $4`,
      [result.text, result.provider, result.model, requestId],
    );
  } catch (err) {
    await pool.query(
      `UPDATE llm_async_requests
       SET status = 'failed', error_message = $1, completed_at = now()
       WHERE request_id = $2`,
      [err.message, requestId],
    );
    throw err;
  }
}

module.exports = {
  requestLlmAsync,
  getLlmRequestResult,
  waitForLlmResult,
  processAsyncLlmRequest,
};
