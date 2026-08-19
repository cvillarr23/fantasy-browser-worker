const { completeWithFallback } = require("../src/lib/llm_client");

/**
 * Manual smoke test for llm_client.js (WORKER-12) — this repo has no automated test suite yet
 * (WORKER-14 is still open), so this is a real call against whatever providers are actually
 * configured, not a mock.
 *
 * Requires at least one of GROQ_API_KEY / GEMINI_API_KEY set (directly, or resolvable from
 * OpenBao via `eval "$(scripts/openbao-connect.sh)"` in the same shell), and/or a reachable
 * OLLAMA_URL. Also requires DB_HOST/DB_NAME/DB_USER/DB_PASSWORD pointed at a real Postgres so
 * the llm_call_metrics row-per-attempt writes can be verified afterward.
 *
 * Usage:
 *   node scripts/test-llm-client.js ["<prompt>"]
 *
 * To confirm fallback actually triggers, force the first provider in LLM_PROVIDER_PRIORITY to
 * fail (e.g. temporarily export an invalid GROQ_API_KEY) and confirm the response still comes
 * back from the next provider in the chain.
 */

const prompt =
  process.argv[2] ||
  "Reply with a single short sentence confirming you received this.";

console.log(`[Test LLM Client] Sending prompt: "${prompt}"`);

completeWithFallback(prompt, { callSite: "manual_test" })
  .then(({ text, provider, model, attempt, latencyMs }) => {
    console.log(
      `[Test LLM Client] Served by ${provider}:${model} on attempt ${attempt} (${latencyMs}ms)`,
    );
    console.log(`[Test LLM Client] Response: ${text}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[Test LLM Client] Failed: ${err.message}`);
    process.exit(1);
  });
