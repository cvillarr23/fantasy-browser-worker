const { execFileSync } = require("child_process");
const { Pool } = require("pg");
const { trace, SpanStatusCode } = require("@opentelemetry/api");
const { logger } = require("../telemetry/logger");

const tracer = trace.getTracer("fantasy-browser-worker");

// Same pool shape as src/db/execution_log.js -- small, dedicated, best-effort. A metrics-write
// failure must never fail the LLM call itself or the calling bot's transaction.
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 2,
});

pool.on("error", (err) => {
  logger.error("[LLM Client] Idle client error on metrics connection pool", {
    err,
  });
});

const DEFAULT_PROVIDER_PRIORITY =
  "groq:llama-3.1-70b-versatile,gemini:gemini-1.5-flash,ollama:llama3.1:8b";

// Conservative free-tier request-per-minute budgets. Only used for providers with no
// per-provider *_RPM_LIMIT env override -- ollama has no entry here because it's a local
// last-resort tier with no external quota to protect.
const DEFAULT_RPM_LIMITS = { groq: 30, gemini: 15 };

const DEFAULT_TIMEOUT_MS = 15000;
// Ollama gets a longer default timeout than the cloud providers -- a cold local model load can
// take well past 15s, and this is the last-resort tier anyway, so a slower response beats none.
const DEFAULT_OLLAMA_TIMEOUT_MS = 30000;
const DEFAULT_OLLAMA_URL = "http://ollama.default.svc.cluster.local:11434";

// provider -> array of request timestamps (ms), used for the in-memory sliding-window rate
// limiter below. Process-local by design: each pod/job instance guards its own budget slice
// rather than coordinating a shared counter, which is good enough for a proactive guard whose
// job is just to avoid *earning* a real 429 most of the time, not to be a precise global limiter.
const requestLog = new Map();

function isWithinLocalBudget(provider) {
  const configuredLimit = Number(
    process.env[`${provider.toUpperCase()}_RPM_LIMIT`],
  );
  const limit =
    configuredLimit > 0 ? configuredLimit : DEFAULT_RPM_LIMITS[provider];
  if (!limit) return true; // no budget configured for this provider (e.g. ollama) -- unlimited

  const windowStart = Date.now() - 60000;
  const timestamps = (requestLog.get(provider) || []).filter(
    (t) => t > windowStart,
  );
  requestLog.set(provider, timestamps);
  return timestamps.length < limit;
}

function recordLocalRequest(provider) {
  const timestamps = requestLog.get(provider) || [];
  timestamps.push(Date.now());
  requestLog.set(provider, timestamps);
}

// Cache resolved (or confirmed-missing) OpenBao lookups for the life of the process --
// shelling out to `bao` on every single call would be wasteful, and a missing key isn't going
// to appear mid-process without a restart anyway.
const apiKeyCache = new Map();

// Same env-first / OpenBao-fallback shape as src/bots/auth.js's resolveEspnCookies /
// fetchEspnCookiesFromOpenBao, generalized across providers. Matches the secret path
// fantasy-infra's README already documents (`bao kv put secret/fantasy/groq groq_api_key=...`).
function fetchApiKeyFromOpenBao(provider) {
  const secretPath =
    process.env[`OPENBAO_${provider.toUpperCase()}_SECRET_PATH`] ||
    `secret/fantasy/${provider}`;
  const fieldName = `${provider}_api_key`;

  logger.info(
    `[LLM Client] ${provider} API key not set in environment, checking OpenBao at "${secretPath}"...`,
  );

  let raw;
  try {
    raw = execFileSync("bao", ["kv", "get", "-format=json", secretPath], {
      encoding: "utf8",
    });
  } catch (err) {
    logger.error(
      `[LLM Client] OpenBao lookup failed for "${provider}": ${err.message}`,
      { err },
    );
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `[LLM Client] Could not parse OpenBao response for "${provider}": ${err.message}`,
      { err },
    );
    return null;
  }

  const key = parsed?.data?.data?.[fieldName];
  if (!key) {
    logger.error(
      `[LLM Client] OpenBao secret at "${secretPath}" is missing field "${fieldName}".`,
    );
    return null;
  }

  logger.info(`[LLM Client] Loaded ${provider} API key from OpenBao.`);
  return key;
}

function resolveApiKey(provider) {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  if (process.env[envVar]) return process.env[envVar];

  if (apiKeyCache.has(provider)) return apiKeyCache.get(provider);
  const key = fetchApiKeyFromOpenBao(provider);
  apiKeyCache.set(provider, key);
  return key;
}

function requestTimeoutMs(provider) {
  if (provider === "ollama") {
    return (
      Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS) || DEFAULT_OLLAMA_TIMEOUT_MS
    );
  }
  return Number(process.env.LLM_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

// Marks an HTTP failure as rate-limit-shaped (real 429, or a provider quota message embedded
// in a 4xx/5xx body) so the caller can tag it distinctly from an ordinary request failure --
// CORE-14's dashboard wants to chart these separately.
function classifyHttpError(status, body) {
  const err = new Error(`HTTP ${status}: ${body.slice(0, 300)}`);
  err.httpStatus = status;
  err.rateLimited = status === 429 || /quota|rate.?limit/i.test(body);
  return err;
}

async function callGroq(model, prompt, opts, apiKey) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(opts.systemPrompt
            ? [{ role: "system", content: opts.systemPrompt }]
            : []),
          { role: "user", content: prompt },
        ],
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
      }),
      signal: AbortSignal.timeout(requestTimeoutMs("groq")),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw classifyHttpError(response.status, errorBody);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text)
    throw new Error("Groq response missing choices[0].message.content");
  return text;
}

async function callGemini(model, prompt, opts, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(opts.systemPrompt
        ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } }
        : {}),
      generationConfig: {
        ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
      },
    }),
    signal: AbortSignal.timeout(requestTimeoutMs("gemini")),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw classifyHttpError(response.status, errorBody);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      "Gemini response missing candidates[0].content.parts[0].text",
    );
  }
  return text;
}

async function callOllama(model, prompt, opts) {
  const baseUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt,
      stream: false,
      options: {
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
      },
    }),
    signal: AbortSignal.timeout(requestTimeoutMs("ollama")),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw classifyHttpError(response.status, errorBody);
  }

  const data = await response.json();
  if (!data?.response)
    throw new Error("Ollama response missing 'response' field");
  return data.response;
}

// needsApiKey=false for ollama -- it's an unauthenticated in-cluster endpoint, not a cloud API.
const PROVIDERS = {
  groq: { needsApiKey: true, call: callGroq },
  gemini: { needsApiKey: true, call: callGemini },
  ollama: { needsApiKey: false, call: callOllama },
};

function parsePriorityChain() {
  const raw = process.env.LLM_PROVIDER_PRIORITY || DEFAULT_PROVIDER_PRIORITY;
  return raw
    .split(",")
    .map((entry) => {
      const [provider, model] = entry.split(":").map((s) => s && s.trim());
      return { provider, model };
    })
    .filter((entry) => entry.provider && entry.model);
}

// Best-effort write, modeled directly on src/db/execution_log.js's recordExecution -- never
// throws, since a metrics hiccup must not fail the actual LLM call. Writes one row per attempt
// (not just the final winner) so CORE-14's per-provider success/failure and fallback-frequency
// panels have real data instead of only ever seeing winners.
async function recordLlmCallMetric({
  provider,
  model,
  callSite,
  attemptNumber,
  success,
  latencyMs,
  errorType,
  fallbackTriggered,
  traceId,
}) {
  try {
    await pool.query(
      `INSERT INTO llm_call_metrics
         (provider, model, call_site, attempt_number, success, latency_ms, error_type, fallback_triggered, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        provider,
        model,
        callSite || null,
        attemptNumber,
        success,
        latencyMs,
        errorType || null,
        Boolean(fallbackTriggered),
        traceId || null,
      ],
    );
  } catch (err) {
    logger.error("[LLM Client] Failed to record LLM call metric", { err });
  }
}

/**
 * Completes `prompt` against the configured provider/model priority chain
 * (LLM_PROVIDER_PRIORITY), falling back to the next provider on a rate limit, quota exhaustion,
 * or any other request failure -- transport + fallback + rate limiting + instrumentation only,
 * no business logic. Throws a plain Error (transient/config, retryable) only once every
 * provider in the chain has been skipped or has failed.
 */
async function completeWithFallback(prompt, opts = {}) {
  const chain = parsePriorityChain();
  const { callSite } = opts;

  return tracer.startActiveSpan("llm.completeWithFallback", async (span) => {
    const traceId = span.spanContext().traceId;
    span.setAttributes({ "llm.call_site": callSite || "unknown" });

    let attemptNumber = 0;
    let lastError = null;

    try {
      for (const { provider, model } of chain) {
        const adapter = PROVIDERS[provider];
        if (!adapter) {
          logger.warn(
            `[LLM Client] Unknown provider "${provider}" in LLM_PROVIDER_PRIORITY, skipping.`,
          );
          continue;
        }

        let apiKey = null;
        if (adapter.needsApiKey) {
          apiKey = resolveApiKey(provider);
          if (!apiKey) {
            logger.warn(
              `[LLM Client] No API key resolved for "${provider}", skipping.`,
            );
            continue;
          }
        }

        if (!isWithinLocalBudget(provider)) {
          attemptNumber += 1;
          logger.warn(
            `[LLM Client] Local rate-limit budget exhausted for "${provider}", skipping to next provider.`,
          );
          await recordLlmCallMetric({
            provider,
            model,
            callSite,
            attemptNumber,
            success: false,
            latencyMs: null,
            errorType: "rate_limited_local",
            fallbackTriggered: attemptNumber > 1,
            traceId,
          });
          continue;
        }

        attemptNumber += 1;
        recordLocalRequest(provider);
        const startedAt = Date.now();

        try {
          // eslint-disable-next-line no-loop-func -- provider/model are captured per-iteration
          // and this closure is awaited immediately, so there's no stale-variable risk here.
          const text = await tracer.startActiveSpan(
            `llm.attempt.${provider}`,
            async (attemptSpan) => {
              attemptSpan.setAttributes({
                "llm.provider": provider,
                "llm.model": model,
              });
              try {
                return await adapter.call(model, prompt, opts, apiKey);
              } finally {
                attemptSpan.end();
              }
            },
          );

          const latencyMs = Date.now() - startedAt;
          logger.info(
            `[LLM Client] "${provider}:${model}" served the request successfully (attempt ${attemptNumber}).`,
          );
          await recordLlmCallMetric({
            provider,
            model,
            callSite,
            attemptNumber,
            success: true,
            latencyMs,
            errorType: null,
            fallbackTriggered: attemptNumber > 1,
            traceId,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return { text, provider, model, attempt: attemptNumber, latencyMs };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const errorType = error.rateLimited
            ? "rate_limited"
            : error.name === "TimeoutError"
              ? "timeout"
              : "request_failed";

          logger.error(
            `[LLM Client] "${provider}:${model}" attempt ${attemptNumber} failed: ${error.message}`,
            { err: error },
          );
          await recordLlmCallMetric({
            provider,
            model,
            callSite,
            attemptNumber,
            success: false,
            latencyMs,
            errorType,
            fallbackTriggered: attemptNumber > 1,
            traceId,
          });
          lastError = error;
        }
      }

      const finalError = new Error(
        `All configured LLM providers exhausted or unavailable (${attemptNumber} attempt(s)).` +
          (lastError ? ` Last error: ${lastError.message}` : ""),
      );
      span.recordException(finalError);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: finalError.message,
      });
      throw finalError;
    } finally {
      span.end();
    }
  });
}

module.exports = { completeWithFallback };
