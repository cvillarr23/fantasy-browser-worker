/**
 * Parse DRY_RUN with an explicit caller-owned default. Only 0, false, and no opt into live
 * writes; any other nonblank value keeps the safety gate closed.
 */
function resolveDryRun(defaultDryRun) {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return { dryRun: defaultDryRun, defaulted: true };
  return { dryRun: !/^(0|false|no)$/i.test(raw), defaulted: false };
}

module.exports = { resolveDryRun };
