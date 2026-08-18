const fs = require("fs");
const path = require("path");
const { logger } = require("../telemetry/logger");

/**
 * Cross-cutting debug capture (DOM + screenshot) for any bot that holds a Playwright `page`.
 * Always overwrites the same `debug-<label>-latest.{html,png}` files rather than accumulating one
 * per call — this answers "what did the page actually look like just now", not build a full
 * history (draft_recon.js's own numbered `dom-snapshot-N.html` files already do that for its
 * dedicated recon runs; this is for every other bot to opt into on demand without needing its own
 * recon harness).
 *
 * On by default — the cost of a page.content() + screenshot() is small next to how much time
 * blind debugging has cost this session (the "Log in Required" gate, the new-tab bug, etc. all
 * took multiple live round-trips to diagnose without a capture in hand). Set DEBUG_CAPTURE=0 (or
 * false/no) to disable for a specific run.
 *
 * `label` namespaces the output files per call site (e.g. "draft-room-dom") so different bots'
 * captures don't collide with each other.
 */
const OUTPUT_DIR = process.env.DEBUG_OUTPUT_DIR || path.join(__dirname, "..", "..", "recon-output");

function isEnabled() {
  const raw = (process.env.DEBUG_CAPTURE || "").trim();
  if (raw === "") return true;
  return !/^(0|false|no)$/i.test(raw);
}

async function captureDebugSnapshot(page, label) {
  if (!isEnabled()) return;
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const html = await page.content();
    fs.writeFileSync(path.join(OUTPUT_DIR, `debug-${label}-latest.html`), html);
    await page.screenshot({ path: path.join(OUTPUT_DIR, `debug-${label}-latest.png`) });
    logger.info(`[Debug Capture] Saved "${label}" DOM/screenshot to ${OUTPUT_DIR}`);
  } catch (err) {
    logger.error(`[Debug Capture] Failed to capture "${label}": ${err.message}`, {
      error: err.message,
    });
  }
}

module.exports = { captureDebugSnapshot };
