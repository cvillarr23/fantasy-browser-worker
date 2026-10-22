const DRY_RUN_VAR = "DRY_RUN";
const TRADE_DRY_RUN_VAR = "TRADE_DRY_RUN";

function parseDryRunVar(name) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return null;
  return !/^(0|false|no)$/i.test(raw);
}

/**
 * Parse DRY_RUN with an explicit caller-owned default. Only 0, false, and no opt into live
 * writes; any other nonblank value keeps the safety gate closed.
 */
function resolveDryRun(defaultDryRun) {
  const parsed = parseDryRunVar(DRY_RUN_VAR);
  if (parsed === null) return { dryRun: defaultDryRun, defaulted: true };
  return { dryRun: parsed, defaulted: false };
}

/**
 * Trade-builder variant of resolveDryRun: TRADE_DRY_RUN (same parsing) wins, so trade
 * submissions can go live without flipping the DRY_RUN every other bot shares. When it is unset
 * this falls back to DRY_RUN, then to the caller's default. `source` names the variable that
 * decided the result ("TRADE_DRY_RUN", "DRY_RUN" or null when defaulted) for gate messages.
 */
function resolveTradeDryRun(defaultDryRun) {
  const tradeParsed = parseDryRunVar(TRADE_DRY_RUN_VAR);
  if (tradeParsed !== null) {
    return { dryRun: tradeParsed, defaulted: false, source: TRADE_DRY_RUN_VAR };
  }
  const { dryRun, defaulted } = resolveDryRun(defaultDryRun);
  return { dryRun, defaulted, source: defaulted ? null : DRY_RUN_VAR };
}

module.exports = { resolveDryRun, resolveTradeDryRun };
