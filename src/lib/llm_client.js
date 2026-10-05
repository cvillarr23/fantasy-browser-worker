const activityHistory = require("../db/activity");
const { execFileSync } = require("child_process");
const http = require("node:http");
const https = require("node:https");
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
  // Every attempt awaits its metrics insert before falling back or returning -- without finite
  // timeouts here, a stalled/unreachable Postgres would block the actual LLM call indefinitely
  // despite this being a "best-effort" path (recordLlmCallMetric's catch can't restore service
  // if the query it's awaiting never settles).
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});

pool.on("error", (err) => {
  logger.error("[LLM Client] Idle client error on metrics connection pool", {
    err,
  });
});

const DEFAULT_PROVIDER_PRIORITY =
  "groq:openai/gpt-oss-120b,gemini:gemini-3.1-flash-lite,ollama:llama3.1:8b";

// Conservative free-tier request-per-minute budgets. Only used for providers with no
// per-provider *_RPM_LIMIT env override -- ollama has no entry here because it's a local
// last-resort tier with no external quota to protect.
const DEFAULT_RPM_LIMITS = { groq: 30, gemini: 15 };

const DEFAULT_TIMEOUT_MS = 15000;
// Ollama gets a much longer default timeout than the cloud providers: requests now go through
// the KEDA HTTP Add-on interceptor (see base/ollama/http-scaled-object.yaml), which itself
// scales the Deployment 0->1 and holds the request until it's ready -- a cold model load can
// genuinely take well past 30s, and this is the last-resort tier anyway, so a slower response
// beats none. Keep this at or above the interceptor's own request-wait-timeout configuration so
// the interceptor times out first with a clearer error, rather than this client aborting mid-scale-up.
const DEFAULT_OLLAMA_TIMEOUT_MS = 100000;
// Points at the KEDA HTTP Add-on interceptor's proxy Service, NOT the `ollama` Service directly
// -- the interceptor is what actually triggers Ollama's on-demand scale-up (and, symmetrically,
// scales it back to 0 after an idle period, see http-scaled-object.yaml's scaledownPeriod). A
// direct-to-Service URL here would bypass that entirely and race a cold pod.
const DEFAULT_OLLAMA_URL = "http://keda-add-ons-http-interceptor-proxy.keda.svc.cluster.local:8080";
// Host header the interceptor uses to look up which HTTPScaledObject (and therefore which
// Deployment/Service) a request is for -- must match a `hosts` entry in
// base/ollama/http-scaled-object.yaml exactly. This is deliberately the same hostname
// DEFAULT_OLLAMA_URL used to point at directly, before routing through the interceptor.
const DEFAULT_OLLAMA_HOST_HEADER = "ollama.default.svc.cluster.local";
// Short warm-up timeout for startOllama(): it only needs the request to *reach* the interceptor
// (which starts scaling immediately), not to wait out a full cold-start round trip.
const DEFAULT_OLLAMA_WARMUP_TIMEOUT_MS = 5000;
// isOllamaReady() bypasses the interceptor entirely (see below) and talks to the real Ollama
// Service directly -- a short timeout here just guards against a half-open/blackholed connection.
const DEFAULT_OLLAMA_READY_TIMEOUT_MS = 1500;
// The real Ollama Service, not the interceptor -- going through the interceptor to check
// readiness would itself trigger/extend scale-up, defeating a passive "is it already warm" check.
const DEFAULT_OLLAMA_DIRECT_URL = "http://ollama.default.svc.cluster.local:11434";

// provider -> array of request timestamps (ms), used for the in-memory sliding-window rate
// limiter below. Process-local by design: each pod/job instance guards its own budget slice
// rather than coordinating a shared counter, which is good enough for a proactive guard whose
// job is just to avoid *earning* a real 429 most of the time, not to be a precise global limiter.
const requestLog = new Map();

function isWithinLocalBudget(provider) {
  const configuredLimit = Number(process.env[`${provider.toUpperCase()}_RPM_LIMIT`]);
  const limit = configuredLimit > 0 ? configuredLimit : DEFAULT_RPM_LIMITS[provider];
  if (!limit) return true; // no budget configured for this provider (e.g. ollama) -- unlimited

  const windowStart = Date.now() - 60000;
  const timestamps = (requestLog.get(provider) || []).filter((t) => t > windowStart);
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
    process.env[`OPENBAO_${provider.toUpperCase()}_SECRET_PATH`] || `secret/fantasy/${provider}`;
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
    logger.error(`[LLM Client] OpenBao lookup failed for "${provider}": ${err.message}`, { err });
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
    logger.error(`[LLM Client] OpenBao secret at "${secretPath}" is missing field "${fieldName}".`);
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
    return Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS) || DEFAULT_OLLAMA_TIMEOUT_MS;
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
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
        { role: "user", content: prompt },
      ],
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: AbortSignal.timeout(requestTimeoutMs("groq")),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw classifyHttpError(response.status, errorBody);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq response missing choices[0].message.content");
  return text;
}

async function callGemini(model, prompt, opts, apiKey) {
  // The API key goes in the x-goog-api-key header, not the ?key= query string -- a query
  // string is far more likely to end up captured in proxy/request logs and telemetry than a
  // header, and Gemini accepts either.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      generationConfig: {
        // Unconditional: every caller wants strict JSON and previously had only prompt
        // wording to enforce it. Gemini constrains this server-side, unlike groq's
        // prompt-only json_mode.
        response_mime_type: "application/json",
        ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
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
    throw new Error("Gemini response missing candidates[0].content.parts[0].text");
  }
  return text;
}

// The WHATWG Fetch spec (and therefore Node's global `fetch`/undici) treats `Host` as a
// forbidden request header and silently drops it instead of sending it -- confirmed empirically
// against this exact Node version, not just from the spec text. That makes `fetch` unusable for
// routing through the KEDA HTTP Add-on interceptor, which dispatches purely on the request's
// Host header (see http-scaled-object.yaml in fantasy-infra). Node's lower-level `http`/`https`
// modules have no such restriction, so callOllama/startOllama/isOllamaReady all use this instead.
function requestWithHostHeader(url, { method = "POST", body, hostHeader, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;

    let settled = false;
    const timeoutError = () => {
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError"; // matches AbortSignal.timeout's error shape, which the
      // errorType classification in completeWithFallback keys off of.
      return err;
    };
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      fn(arg);
    };

    // `timeout` in the request options below is a socket-inactivity timeout: it's only armed
    // once a socket connects, so a hung DNS lookup or a TCP handshake that never completes (e.g.
    // the interceptor Service having no ready endpoint) would leave this Promise pending forever
    // without it. This wall-clock timer covers the whole request lifecycle -- connect included --
    // and is the one that actually bounds worst-case latency.
    const wallClockTimer = setTimeout(() => {
      req.destroy(timeoutError());
    }, timeoutMs);

    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...(hostHeader ? { Host: hostHeader } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", (err) => settle(reject, err));
        res.on("end", () => {
          settle(resolve, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("timeout", () => req.destroy(timeoutError()));
    req.on("error", (err) => settle(reject, err));
    if (payload) req.write(payload);
    req.end();
  });
}

// Only default the Host header when OLLAMA_URL is also at its default -- a manually configured
// OLLAMA_URL (e.g. local dev) shouldn't get a stale interceptor Host header unless
// OLLAMA_HOST_HEADER asks for it explicitly. Shared by callOllama and startOllama.
function resolveInterceptorTarget() {
  const baseUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
  const hostHeader =
    process.env.OLLAMA_HOST_HEADER ||
    (process.env.OLLAMA_URL ? undefined : DEFAULT_OLLAMA_HOST_HEADER);
  return { baseUrl, hostHeader };
}

async function callOllama(model, prompt, opts) {
  const { baseUrl, hostHeader } = resolveInterceptorTarget();

  // No manual scale-up call here anymore: the KEDA HTTP Add-on interceptor (see
  // base/ollama/http-scaled-object.yaml) does this itself on any request that reaches it,
  // queuing this request until the Ollama pod is ready instead of us polling readiness
  // beforehand. The Host header is what tells the interceptor which HTTPScaledObject (and
  // therefore which Deployment/Service) this request is for -- it has nothing to do with
  // baseUrl's own hostname.
  const response = await requestWithHostHeader(`${baseUrl}/api/generate`, {
    method: "POST",
    body: {
      model,
      prompt: opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt,
      stream: false,
      options: {
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
      },
    },
    hostHeader,
    timeoutMs: requestTimeoutMs("ollama"),
  });

  if (!response.ok) {
    throw classifyHttpError(response.status, response.text);
  }

  const data = JSON.parse(response.text);
  if (!data?.response) throw new Error("Ollama response missing 'response' field");
  return data.response;
}

/**
 * Fires a cheap GET through the interceptor to trigger Ollama's 0->1 scale-up ahead of a known
 * usage window, without waiting out a full cold-start round trip -- use isOllamaReady() to check
 * whether that scale-up has actually finished. Never throws; `triggered: false` only when the
 * interceptor Service itself couldn't be reached (a real request-level failure), not when Ollama
 * is merely still cold (that shows up as a TimeoutError, which still counts as triggered).
 */
async function startOllama() {
  const { baseUrl, hostHeader } = resolveInterceptorTarget();
  try {
    await requestWithHostHeader(`${baseUrl}/api/tags`, {
      method: "GET",
      hostHeader,
      timeoutMs: DEFAULT_OLLAMA_WARMUP_TIMEOUT_MS,
    });
    return { triggered: true };
  } catch (err) {
    logger.info(`[LLM Client] startOllama warm-up request settled: ${err.message}`);
    return { triggered: err.name === "TimeoutError" };
  }
}

/**
 * Passive readiness probe: hits the real Ollama Service directly (bypassing the interceptor,
 * which would itself trigger/extend scale-up) with a short timeout. Never throws -- `true` only
 * on an HTTP 200 from /api/tags, `false` on anything else (refused, timed out, non-2xx).
 */
async function isOllamaReady() {
  const directUrl = process.env.OLLAMA_DIRECT_URL || DEFAULT_OLLAMA_DIRECT_URL;
  try {
    const response = await requestWithHostHeader(`${directUrl}/api/tags`, {
      method: "GET",
      timeoutMs: DEFAULT_OLLAMA_READY_TIMEOUT_MS,
    });
    return response.ok;
  } catch {
    return false;
  }
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
      // Split on the first ":" only -- Ollama model tags contain their own ":" (e.g.
      // "llama3.1:8b"), so a naive entry.split(":") would truncate the model to "llama3.1".
      const separatorIdx = entry.indexOf(":");
      if (separatorIdx === -1) return { provider: entry.trim(), model: "" };
      return {
        provider: entry.slice(0, separatorIdx).trim(),
        model: entry.slice(separatorIdx + 1).trim(),
      };
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
  const sessionId = await activityHistory.startSession(opts.callSite || "LLM run");
  await activityHistory.sessionEvent(sessionId, "prompt", {
    system: opts.systemPrompt,
    user: prompt,
  });
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
            logger.warn(`[LLM Client] No API key resolved for "${provider}", skipping.`);
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
          await activityHistory.sessionEvent(sessionId, "provider_attempt", {
            provider,
            model,
            attemptNumber,
          });
          const text = await tracer.startActiveSpan(
            `llm.attempt.${provider}`,
            async (attemptSpan) => {
              attemptSpan.setAttributes({
                "llm.provider": provider,
                "llm.model": model,
              });
              try {
                const result = await adapter.call(model, prompt, opts, apiKey);
                attemptSpan.setStatus({ code: SpanStatusCode.OK });
                return result;
              } catch (error) {
                // Without this, a failed attempt's span ends UNSET (not ERROR) once the outer
                // fallback loop's later success marks the parent span OK -- per-attempt OTel
                // instrumentation would then report every failed provider as a non-error.
                attemptSpan.recordException(error);
                attemptSpan.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error.message,
                });
                throw error;
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
          await activityHistory.sessionEvent(
            sessionId,
            "response",
            { text, provider, model, attempt: attemptNumber, latencyMs },
            "completed",
          );
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
          await activityHistory.sessionEvent(sessionId, "provider_error", {
            provider,
            model,
            attemptNumber,
            error: error.message,
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
      await activityHistory.sessionEvent(sessionId, "error", finalError.message, "failed");
      throw finalError;
    } finally {
      span.end();
    }
  });
}

module.exports = { completeWithFallback, startOllama, isOllamaReady };
