const { logger } = require("../telemetry/logger");

// Same cluster-DNS-default convention as OLLAMA_URL in src/lib/llm_client.js — verified against
// fantasy-infra's charts/fantasy/templates/core-pipeline/fastapi-service.yaml (ClusterIP service
// "fantasy-core-pipeline", port 8000, default namespace).
const CORE_PIPELINE_URL =
  process.env.CORE_PIPELINE_URL ||
  "http://fantasy-core-pipeline.default.svc.cluster.local:8000";

const RESOLUTION_TIMEOUT_MS = 10_000;
const HTTP_CONFLICT = 409;
const RESOLUTION_RESULT = Object.freeze({ OK: "ok", CONFLICT: "conflict", FAILED: "failed", SKIPPED: "skipped" });

let warnedNoApiKey = false;

/**
 * Tells core how a sent offer ended: POST /v1/trade/offers/{offer_key}/resolution. Core is
 * idempotent: the same outcome again answers `duplicate: true`, which is success here. A 409 is a
 * different outcome already on record, so it is logged and not retried. Anything else is a failure
 * the caller may retry on its next pass. Never throws. Without CORE_PIPELINE_API_KEY nothing is
 * sent (SKIPPED), and core releases the players on its own clock.
 */
async function postOfferResolution(offerKey, { outcome, resolvedAt, espnTransactionId }) {
  const apiKey = process.env.CORE_PIPELINE_API_KEY;
  if (!apiKey) {
    if (!warnedNoApiKey) {
      warnedNoApiKey = true;
      logger.warn("[Core] CORE_PIPELINE_API_KEY is not set; outgoing offer resolutions are not reported");
    }
    return { result: RESOLUTION_RESULT.SKIPPED };
  }
  const body = { outcome };
  if (resolvedAt) body.resolved_at = resolvedAt;
  if (espnTransactionId) body.espn_transaction_id = String(espnTransactionId);
  try {
    const response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/offers/${encodeURIComponent(offerKey)}/resolution`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
    });
    if (response.status === HTTP_CONFLICT) {
      logger.warn(`[Core] Offer ${offerKey} already has a different resolution on record; reported ${outcome}, not retrying`);
      return { result: RESOLUTION_RESULT.CONFLICT };
    }
    if (!response.ok) throw new Error(`resolution HTTP ${response.status}`);
    const reply = await response.json().catch(() => ({}));
    return { result: RESOLUTION_RESULT.OK, duplicate: reply?.duplicate === true };
  } catch (error) {
    logger.warn(`[Core] Could not report offer ${offerKey} as ${outcome}; will retry on the next refresh: ${error.message}`);
    return { result: RESOLUTION_RESULT.FAILED };
  }
}

module.exports = { CORE_PIPELINE_URL, RESOLUTION_RESULT, postOfferResolution };
