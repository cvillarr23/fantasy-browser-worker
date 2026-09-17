const {
  fetchWatermark,
  fetchNewRawSignals,
  persistRumorSignals,
} = require("../db/rumor_signals");
const { completeWithFallback } = require("../lib/llm_client");
const { logger } = require("../telemetry/logger");

/**
 * Rumor/news-driven waiver & lineup signal bot -- advisory only, no waiver/lineup execution.
 * Scheduled-job entrypoint (not a queue consumer). player_id is the internal Sleeper id space,
 * not ESPN's -- see README.md's Architecture section and CLAUDE.md's WORKER-13 notes for the
 * full design rationale (watermark strategy, id-namespace warning, scope boundaries).
 */

const VALID_SENTIMENTS = new Set(["positive", "negative", "neutral"]);
const VALID_ACTIONS = new Set([
  "boost_waiver_priority",
  "bench_watch",
  "no_op",
]);

/** Builds the system prompt for runRumorDigest's single, batched completeWithFallback call.
 * Like trade_bot.js's buildNegotiationSystemPrompt, completeWithFallback has no native JSON-mode
 * opts field, so strict-JSON output can only be enforced by instruction -- parseDigestResponse
 * below is the other half of that contract, defensively handling a model that ignores it anyway.
 *
 * Requires one verdict per DISTINCT player_id in the batch (even a no_op) rather than only for
 * players the model judges "interesting" -- this is what lets fetchWatermark's
 * MAX(max_raw_signal_id) reliably advance past every raw_signal considered each run, without a
 * separate cursor table (see rumor_signals.js and models.py's CREATE_RUMOR_SIGNALS_TABLE in
 * fantasy-core-pipeline). */
function buildDigestSystemPrompt(rawSignals) {
  const items = rawSignals.map((row) => ({
    player_id: row.player_id,
    source: row.source,
    text: row.raw_text,
    published_at: row.published_at,
  }));

  return [
    "You are a fantasy football news analyst. You will be given a batch of raw rumor/news items,",
    "each already matched to a specific player by an upstream fuzzy-matching pipeline. Multiple",
    "items may reference the same player_id -- synthesize ALL items for a given player into",
    "exactly ONE verdict for that player, weighing more recent and more specific items (a beat",
    "writer's confirmed report) over vague or older ones (a single forum post).",
    "",
    "Respond with STRICT JSON ONLY — no markdown code fences, no commentary before or after — as",
    'a JSON array, with exactly ONE object per DISTINCT player_id present below, in exactly this',
    'shape: [{"player_id": "...", "sentiment": "positive"|"negative"|"neutral", "confidence":',
    '0.0-1.0, "suggested_action": "boost_waiver_priority"|"bench_watch"|"no_op"}, ...].',
    "Include an entry for EVERY distinct player_id below, even if your verdict is a low-confidence",
    "no_op — do not omit a player just because nothing noteworthy happened.",
    "",
    `Items: ${JSON.stringify(items)}`,
  ].join("\n");
}

// Strips a ```json ... ``` or ``` ... ``` fence some models wrap JSON output in despite being
// told not to -- same helper as trade_bot.js's stripCodeFence (not exported there, so duplicated
// here rather than reaching across bot modules for a three-line regex).
function stripCodeFence(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : text;
}

/** Defensive counterpart to buildDigestSystemPrompt's strict-JSON instruction. Throws a plain
 * (non-permanent) Error only when the response is unusable as a whole -- not valid JSON, or not
 * an array -- since a different scheduled run (or a different provider in the fallback chain)
 * might produce a parseable response next time; this is a flaky-output problem, not a doomed
 * payload. An individual malformed entry, by contrast, is logged and dropped rather than failing
 * the whole batch -- one bad entry from the model shouldn't cost every other valid verdict.
 *
 * validPlayerIds (the batch's own input player_ids) is the safety rail against the model
 * hallucinating or inventing a player_id outside what it was actually given -- in particular,
 * against it "helpfully" surfacing what looks like an ESPN id instead of the internal id it was
 * fed (see this file's header). Any player_id not in that set is dropped, not trusted. */
function parseDigestResponse(text, validPlayerIds) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (parseError) {
    throw new Error(
      `[Rumor Digest] LLM response was not valid JSON: ${parseError.message}`,
      { cause: parseError },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("[Rumor Digest] LLM response must be a JSON array.");
  }

  const seen = new Set();
  const results = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      logger.warn("[Rumor Digest] Dropping non-object entry in LLM response.");
      continue;
    }
    const playerId = String(entry.player_id ?? "");
    if (!validPlayerIds.has(playerId)) {
      logger.warn(
        `[Rumor Digest] Dropping entry with unknown player_id "${playerId}" (not in this batch).`,
      );
      continue;
    }
    if (seen.has(playerId)) {
      logger.warn(
        `[Rumor Digest] Dropping duplicate entry for player_id "${playerId}" (keeping the first).`,
      );
      continue;
    }
    if (!VALID_SENTIMENTS.has(entry.sentiment)) {
      logger.warn(
        `[Rumor Digest] Dropping entry for "${playerId}" with invalid sentiment "${entry.sentiment}".`,
      );
      continue;
    }
    if (!VALID_ACTIONS.has(entry.suggested_action)) {
      logger.warn(
        `[Rumor Digest] Dropping entry for "${playerId}" with invalid suggested_action "${entry.suggested_action}".`,
      );
      continue;
    }
    const confidence = Number(entry.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      logger.warn(
        `[Rumor Digest] Dropping entry for "${playerId}" with out-of-range confidence "${entry.confidence}".`,
      );
      continue;
    }

    seen.add(playerId);
    results.push({
      playerId,
      sentiment: entry.sentiment,
      confidence,
      suggestedAction: entry.suggested_action,
    });
  }

  return results;
}

/** One digest run: read new raw_signals since the last watermark, batch them into a single
 * completeWithFallback call, persist the structured verdicts. Advisory only -- writes to
 * rumor_signals and nothing else. */
async function runRumorDigest() {
  const watermark = await fetchWatermark();
  const rawSignals = await fetchNewRawSignals(watermark);

  if (rawSignals.length === 0) {
    logger.info(
      `[Rumor Digest] No new raw signals since watermark ${watermark ?? "<none>"} — skipping LLM call.`,
    );
    return { processed: 0, written: 0 };
  }

  const validPlayerIds = new Set(rawSignals.map((row) => String(row.player_id)));
  const maxRawSignalId = Math.max(...rawSignals.map((row) => row.id));

  logger.info(
    `[Rumor Digest] Batching ${rawSignals.length} new raw signal(s) across ${validPlayerIds.size} ` +
      `distinct player(s) since watermark ${watermark ?? "<none>"} (up to raw_signals.id=${maxRawSignalId}).`,
  );

  const systemPrompt = buildDigestSystemPrompt(rawSignals);
  const { text } = await completeWithFallback(
    "Analyze the batch of rumor/news items described above and produce the structured verdict array.",
    { systemPrompt, callSite: "rumor_digest" },
  );

  const verdicts = parseDigestResponse(text, validPlayerIds);

  const sourceRawSignalIdsByPlayer = new Map();
  for (const row of rawSignals) {
    const playerId = String(row.player_id);
    if (!sourceRawSignalIdsByPlayer.has(playerId)) {
      sourceRawSignalIdsByPlayer.set(playerId, []);
    }
    sourceRawSignalIdsByPlayer.get(playerId).push(row.id);
  }

  const rows = verdicts.map((verdict) => ({
    ...verdict,
    sourceRawSignalIds: sourceRawSignalIdsByPlayer.get(verdict.playerId) || [],
    maxRawSignalId,
  }));

  await persistRumorSignals(rows);

  const counts = rows.reduce((acc, row) => {
    acc[row.suggestedAction] = (acc[row.suggestedAction] || 0) + 1;
    return acc;
  }, {});
  logger.info(
    `[Rumor Digest] Wrote ${rows.length} signal(s) (${JSON.stringify(counts)}); ` +
      `dropped ${validPlayerIds.size - rows.length} invalid/duplicate entr(ies).`,
  );

  return { processed: rawSignals.length, written: rows.length };
}

if (require.main === module) {
  const { withInstrumentation } = require("../telemetry/instrument");
  withInstrumentation(
    "rumor_digest_bot",
    { trackingId: require("crypto").randomUUID() },
    runRumorDigest,
  )
    .catch(() => {
      // Non-zero exit is the alert this CronJob relies on -- withInstrumentation's own catch has
      // already recorded the failed span/execution_log row before this runs.
      process.exitCode = 1;
    })
    .finally(async () => {
      // Flush any buffered spans before this short-lived job's event loop drains.
      const { shutdownTelemetry } = require("../telemetry/init");
      await shutdownTelemetry();
    });
}

module.exports = { runRumorDigest, buildDigestSystemPrompt, parseDigestResponse };
