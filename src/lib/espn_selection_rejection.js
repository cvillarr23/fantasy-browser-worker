const { PermanentError } = require("../errors");
const { logger } = require("../telemetry/logger");

const SELECTION_REJECTED = "espn_selection_rejected";
const UNKNOWN_REASON = "unknown";
// Enough of the row to see its markup and attributes, small enough for a log line and a DB row.
const MAX_ROW_HTML_CHARS = 2000;
const MAX_SIGNAL_CHARS = 300;
const MAX_VISIBLE_TEXT_CHARS = 500;
// Playwright's wording when the click went through but aria-checked never flipped.
const NOT_TOGGLED_PATTERN = /did not change its state/i;

/**
 * Raised when ESPN's trade builder ignores a click on a player's checkbox. It is permanent (the
 * same page refuses the same way again) and carries what the page showed so the run summary, the
 * log and the execution_log row can say why.
 */
class SelectionRejectedError extends PermanentError {
  constructor(playerId, { reason, rowHtml, visibleText }) {
    super(
      `[Trade Builder] ESPN would not let player ${playerId} be selected: ${reason}`,
    );
    this.name = "SelectionRejectedError";
    this.classification = SELECTION_REJECTED;
    this.playerId = playerId;
    this.reason = reason;
    this.capture = { playerId, reason, rowHtml, visibleText };
  }
}

function isNotToggled(error) {
  return NOT_TOGGLED_PATTERN.test(error?.message || "");
}

// Runs in the browser. Only generic signals are read, because the refusal UI has not been
// recorded yet: disabled/locked state on the row or its checkbox, title and tooltip attributes,
// and any alert, toast or error text on the page. The row's own text is returned separately as
// context, never as the reason, since it is mostly the player's name and stats.
// It must stay self-contained: Playwright serializes it into the page.
function readRowSignals(el, { maxSignalChars, maxHtmlChars, maxVisibleChars }) {
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim().slice(0, maxSignalChars);
  const signals = [];
  const add = (label, text) => {
    const value = clean(text);
    if (value && !signals.includes(`${label}: ${value}`)) signals.push(`${label}: ${value}`);
  };
  const box = el.querySelector('[role="checkbox"]');
  for (const node of [el, box].filter(Boolean)) {
    if (node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")) {
      add("disabled", node === box ? "checkbox is disabled" : "row is disabled");
    }
    add("title", node.getAttribute("title"));
    add("tooltip", node.getAttribute("data-tooltip") || node.getAttribute("data-original-title"));
    if (/disabled|locked/i.test(node.getAttribute("class") || "")) {
      add("state class", node.getAttribute("class"));
    }
  }
  // Only disabled controls count here. Every stat cell in the row carries a title ("Quarterback",
  // "Position Rank"...), which is column labelling, not a refusal, and buried the real signals.
  for (const node of el.querySelectorAll("[aria-disabled='true']")) {
    if (node === box) continue;
    add("disabled", node.textContent || "disabled control");
  }
  const doc = el.ownerDocument;
  const alertSelector = '[role="alert"], [role="status"], [role="tooltip"], [class*="toast" i], [class*="Toast"], [class*="error" i], [class*="tooltip" i]';
  const visible = [];
  for (const node of doc.querySelectorAll(alertSelector)) {
    const rect = node.getBoundingClientRect();
    const text = clean(node.textContent);
    if (text && rect.width > 0 && rect.height > 0) {
      add("page message", text);
      visible.push(text);
    }
  }
  return {
    signals,
    rowHtml: el.outerHTML.slice(0, maxHtmlChars),
    visibleText: visible.join(" | ").slice(0, maxVisibleChars),
  };
}

async function collectRejectionSignals(row) {
  try {
    return await row.first().evaluate(readRowSignals, {
      maxSignalChars: MAX_SIGNAL_CHARS,
      maxHtmlChars: MAX_ROW_HTML_CHARS,
      maxVisibleChars: MAX_VISIBLE_TEXT_CHARS,
    });
  } catch (error) {
    logger.warn("[Trade Builder] Could not read ESPN's reason from the row", { err: error });
    return { signals: [], rowHtml: "", visibleText: "" };
  }
}

/**
 * Builds the classified error for a checkbox that did not toggle, and logs the evidence at error
 * level so it survives in the pod logs even though captures written to disk do not.
 */
async function buildSelectionRejection(playerId, row) {
  const { signals, rowHtml, visibleText } = await collectRejectionSignals(row);
  const reason = signals.length ? signals.join("; ") : UNKNOWN_REASON;
  logger.error("[Trade Builder] ESPN did not toggle a player's checkbox", {
    classification: SELECTION_REJECTED,
    playerId,
    reason,
    visibleText,
    rowHtml,
  });
  return new SelectionRejectedError(playerId, { reason, rowHtml, visibleText });
}

module.exports = {
  readRowSignals,
  SELECTION_REJECTED,
  UNKNOWN_REASON,
  SelectionRejectedError,
  isNotToggled,
  buildSelectionRejection,
};
