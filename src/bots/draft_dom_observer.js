const { logger } = require("../telemetry/logger");

// Two functions in this file (scanInPage, and the observer-install evaluate below) are serialized
// and executed inside the BROWSER, not in Node — so the DOM globals they reference are legitimate
// there and simply don't exist in this module's own scope. Declared here so eslint checks the
// Node-side code normally instead of reporting every in-page reference as undefined.
/* global document, window, location, MutationObserver */

/**
 * DOM observer + polling ingest tier for the live draft board (issue #52).
 *
 * WHY THIS EXISTS ALONGSIDE THE WEBSOCKET
 * ---------------------------------------
 * The draft room WebSocket is the fastest and most precise pick signal we have (~250ms, exact
 * numeric player/team ids — see docs/espn/draft-room.md), and it stays the primary
 * source. But it is NOT continuously reliable in this deployment, for a confirmed reason:
 * ESPN's draft room is SINGLE-SESSION per league/team/member (confirmed 2026-08-17). Any second
 * connection for the same identity — the user opening their own browser tab, draft_clicker.js
 * briefly connecting to submit a pick — silently EVICTS the existing one. The evicted side just
 * sees its socket close, with no distinguishing close code. Every pick broadcast during that gap
 * is gone: the WS protocol has no history/replay query, so a reconnecting client only ever sees
 * broadcasts made after it rejoins.
 *
 * The usual answer to a gap like that is "backfill from REST," and draft_sync.js does try — but
 * `mDraftDetail` is confirmed to return ZERO picks for the entire duration of a practice/mock
 * draft (espn_api.js's readDraftPicks header documents this in full). So for exactly the scenario
 * issue #52 is about, the WS gap and the REST gap overlap perfectly, and picks made by other
 * participants — or manually by the user in the UI — never reach the feed at all.
 *
 * The rendered draft board does not have that problem. It is the one surface that always shows
 * the FULL history of what has been drafted, independent of when we connected, and it reflects
 * picks from every participant regardless of who made them or how. That makes it the right
 * recovery tier, which is why this module exists rather than leaning harder on REST.
 *
 * TWO MECHANISMS, ON PURPOSE
 * --------------------------
 *   1. MutationObserver — pushes a rescan the moment the board mutates. Low latency, but it can
 *      miss things: it stops firing if its observed root is replaced wholesale by a re-render,
 *      and it never fires for content that was already on the page before it attached.
 *   2. Interval poll — a full rescan every DRAFT_DOM_POLL_INTERVAL_MS regardless. Slower, but it
 *      is immune to both of the above and re-establishes the observer if its root went away.
 *
 * The poll is the safety net for the observer, the observer is the low-latency path, and the
 * ledger (draft_pick_ledger.js) dedups their overlap — a full rescan re-reports every pick it can
 * see every time, so overlap is the normal case, not an error.
 *
 * SELECTOR STATUS: UNVERIFIED — READ THIS BEFORE TRUSTING IT
 * ---------------------------------------------------------
 * Unlike the Draft/Queue buttons (`button.Button--draft[data-player-id]`), which were captured
 * from a real draft room and are verified, the draft BOARD/pick-history markup has never been
 * captured while picks were on it. Rather than hardcode a guess and fail silently — the exact
 * failure mode issue #52 was opened about — this scans a PRIORITIZED LIST of candidate strategies
 * and reports, every scan, which one matched and how many nodes each candidate saw. A scan that
 * finds nothing is logged as an explicit selector miss with a DOM sample attached
 * (`sample_html`), so one look at the pod logs from a real draft is enough to fix the selector,
 * instead of another live-testing round trip to discover it's broken at all.
 *
 * The generic `[data-player-id][data-team-id]` strategy is last and intentionally structure-free:
 * it doesn't care what the board's class names are, so it keeps working across a markup redesign
 * that breaks every named selector above it.
 */

// Scan cadence for the polling tier. 5s is well inside a 60-90s pick clock (so a recovered pick is
// still timely) while being cheap: a scan is one page.evaluate over a bounded set of selectors,
// not a network call.
const DEFAULT_POLL_INTERVAL_MS = Number(
  process.env.DRAFT_DOM_POLL_INTERVAL_MS || 5000,
);

// Coalesces mutation bursts — a single pick can fire dozens of mutations as the board, the player
// pool and the roster panel all re-render. Without this, each one would trigger its own full
// rescan for no added information.
const MUTATION_DEBOUNCE_MS = 400;

// Truncated DOM sample attached to a selector-miss log. Big enough to identify the real markup,
// small enough not to flood pod logs every poll interval.
const SAMPLE_HTML_CHARS = 2000;

const BINDING_NAME = "__fantasyDraftBoardMutated";

/**
 * Candidate extraction strategies, tried in order; the first one that yields any record wins.
 * Ordered most-specific/most-trustworthy first, ending with a structure-free attribute scan that
 * should survive a redesign. Every candidate's match count is reported per scan for telemetry, not
 * just the winner's — that's what makes a selector going stale visible in the logs.
 */
const PICK_STRATEGIES = [
  {
    name: "draft-board-pick-cell",
    selector:
      ".DraftBoard [data-player-id], .draft-board [data-player-id], [class*='PickCell'][data-player-id]",
  },
  {
    name: "pick-history-row",
    selector:
      "[class*='pick-history'] [data-player-id], [class*='PickHistory'] [data-player-id], [class*='DraftedPlayer'][data-player-id]",
  },
  {
    name: "generic-player-team-pair",
    selector: "[data-player-id][data-team-id]",
  },
];

/**
 * Best-effort classifier for ESPN's Disney/BAM-SDK "Log in Required" gate on the rendered draft
 * room — a full identity-SDK login wall this cookie-only bot cannot pass, documented in
 * session_health.js's assertRenderedSessionValid. A selector miss with ZERO player-id nodes
 * anywhere on the page (not just within a strategy's own selector) is otherwise indistinguishable
 * in the logs from a genuinely stale CSS selector; this turns "which failure mode was this?" from
 * a guess into a fact the next incident's logs can show directly. Not a verified selector of its
 * own — ESPN's login-gate markup has never been captured any more than the board's has — but it
 * costs nothing extra (same scan, same page).
 *
 * Pure (no DOM access) so it's directly unit-testable — scanInPage itself only runs inside a
 * browser page and has no jsdom coverage in this project (see dedupeScanRecords's header comment
 * for why). scanInPage below duplicates this exact one-line check inline, because a serialized
 * page.evaluate function can't close over anything defined in this module — the two MUST be kept
 * in sync if this logic ever changes.
 */
function detectLoginGate(playerIdNodeCount, bodyText) {
  return (
    playerIdNodeCount === 0 && /log\s*in\s*required/i.test(bodyText || "")
  );
}

/**
 * Runs INSIDE the browser page. Must be fully self-contained — it's serialized and evaluated in
 * the page context, so it can close over nothing from this module.
 *
 * Returns both the extracted records AND per-candidate diagnostics, so a caller can tell the
 * difference between "the board is empty" and "our selectors no longer match the board" — two
 * situations that look identical if you only return records.
 */
/* istanbul ignore next -- executes in the browser, not under jest */
function scanInPage({ strategies, sampleChars }) {

  const toNumber = (raw) => {
    if (raw == null) return null;
    const cleaned = String(raw).trim();
    if (!/^-?\d+$/.test(cleaned)) return null;
    return Number(cleaned);
  };

  // Pulls a value from the node or the nearest ancestor carrying it — board markup commonly puts
  // the player id on a cell and the team id on the row/column wrapping it.
  const attrFromSelfOrAncestor = (node, names) => {
    for (const name of names) {
      const owner = node.closest(`[${name}]`);
      if (owner) {
        const value = owner.getAttribute(name);
        if (value != null && value !== "") return value;
      }
    }
    return null;
  };

  // Board pick labels render as "1.04" (round.pickInRound) or a bare overall number.
  const parsePickLabel = (text) => {
    if (!text) return { round: null, round_pick_number: null };
    const dotted = text.match(/\b(\d{1,2})\.(\d{1,2})\b/);
    if (dotted) {
      return {
        round: Number(dotted[1]),
        round_pick_number: Number(dotted[2]),
      };
    }
    return { round: null, round_pick_number: null };
  };

  const diagnostics = [];
  let records = [];
  let matchedStrategy = null;

  for (const strategy of strategies) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(strategy.selector));
    } catch {
      // A malformed/unsupported selector must not abort the whole scan — report and continue.
      diagnostics.push({
        name: strategy.name,
        matched: 0,
        error: "bad selector",
      });
      continue;
    }
    diagnostics.push({ name: strategy.name, matched: nodes.length });

    if (nodes.length === 0 || matchedStrategy) continue;

    const extracted = nodes
      .map((node) => {
        const playerId = toNumber(
          attrFromSelfOrAncestor(node, ["data-player-id", "data-playerid"]),
        );
        if (playerId == null) return null;

        const teamId = toNumber(
          attrFromSelfOrAncestor(node, ["data-team-id", "data-teamid"]),
        );
        const label = parsePickLabel(
          (node.closest("[class*='Pick'], tr, li") || node).textContent || "",
        );

        return {
          player_id: playerId,
          team_id: teamId,
          round: label.round,
          round_pick_number: label.round_pick_number,
        };
      })
      .filter(Boolean);

    if (extracted.length > 0) {
      matchedStrategy = strategy.name;
      records = extracted;
    }
  }

  // Only collected when nothing matched — this is the payload that makes a stale selector
  // diagnosable straight from pod logs, and it's pointless (and noisy) when extraction worked.
  let sampleHtml = null;
  if (!matchedStrategy) {
    const candidateRoot =
      document.querySelector(
        "[class*='DraftBoard'], [class*='draft-board'], main",
      ) || document.body;
    sampleHtml = candidateRoot
      ? candidateRoot.innerHTML.slice(0, sampleChars)
      : null;
  }

  return {
    records,
    matched_strategy: matchedStrategy,
    diagnostics,
    sample_html: sampleHtml,
    player_id_nodes: document.querySelectorAll("[data-player-id]").length,
    // Duplicated inline (not called from detectLoginGate above) — see that function's header
    // comment for why. Keep these two checks in sync.
    page_gated:
      document.querySelectorAll("[data-player-id]").length === 0 &&
      /log\s*in\s*required/i.test(
        document.body
          ? document.body.innerText || document.body.textContent || ""
          : "",
      ),
    url: location.href,
  };
}

/**
 * De-duplicates records within a SINGLE scan.
 *
 * A full board scan legitimately sees the same player more than once — the same pick can appear in
 * the board grid, a recent-picks ticker, and a team roster panel at the same time. Collapsing here
 * keeps the ledger's cross-scan duplicate counter meaningful: it should measure "we saw this pick
 * again on a later scan," not "the page renders this pick in three places."
 *
 * Exported for direct unit testing — it's pure.
 */
function dedupeScanRecords(records) {
  const byPlayer = new Map();
  for (const record of records) {
    const key = String(record.player_id);
    const existing = byPlayer.get(key);
    if (!existing) {
      byPlayer.set(key, record);
      continue;
    }
    // Prefer the copy carrying the most information — a ticker entry with a team id beats a bare
    // grid cell without one.
    byPlayer.set(key, {
      ...existing,
      team_id: existing.team_id ?? record.team_id,
      round: existing.round ?? record.round,
      round_pick_number: existing.round_pick_number ?? record.round_pick_number,
    });
  }
  return Array.from(byPlayer.values());
}

/**
 * Attaches the observer + poller to a page.
 *
 * Returns a handle: { scanNow(), stop(), getHealth() }. The caller owns the lifecycle and MUST
 * call stop() — the interval and the in-page observer both outlive a navigation otherwise.
 *
 * Every failure path here is non-fatal by design. This is a RECOVERY tier: if the page is gated
 * behind ESPN's "Log in Required" overlay, or the selectors have gone stale, the correct behavior
 * is to log loudly and let the WebSocket keep carrying the feed alone — never to take down an
 * otherwise-working draft sync.
 */
async function attachDraftDomObserver(
  page,
  { onRecords, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, log = logger } = {},
) {
  const health = {
    attached: false,
    scans: 0,
    failed_scans: 0,
    last_scan_at: null,
    last_matched_strategy: null,
    last_record_count: 0,
    selector_miss_streak: 0,
    login_gate_detected: false,
    observer_installed: false,
  };

  let stopped = false;
  let debounceTimer = null;
  let scanning = false;

  async function scanNow(trigger) {
    if (stopped || page.isClosed()) return null;
    // Serializes scans: a mutation burst arriving mid-scan would otherwise stack overlapping
    // page.evaluate calls against the same board for identical results.
    if (scanning) return null;
    scanning = true;
    try {
      const result = await page.evaluate(scanInPage, {
        strategies: PICK_STRATEGIES,
        sampleChars: SAMPLE_HTML_CHARS,
      });
      health.scans += 1;
      health.last_scan_at = new Date().toISOString();
      health.last_matched_strategy = result.matched_strategy;

      const records = dedupeScanRecords(result.records || []);
      health.last_record_count = records.length;

      if (!result.matched_strategy) {
        health.selector_miss_streak += 1;
        if (result.page_gated) health.login_gate_detected = true;
        // Escalating cadence: the first miss is worth seeing immediately, but a board that simply
        // has no picks yet (an empty board before pick 1) would otherwise log a warning every
        // poll for the whole pre-draft window. After the first, only every 12th (~1/min at the
        // default 5s cadence) is logged.
        if (
          health.selector_miss_streak === 1 ||
          health.selector_miss_streak % 12 === 0
        ) {
          log.warn(
            `[Draft DOM] Selector miss (streak ${health.selector_miss_streak}): no pick records ` +
              `extracted from the draft board. WS remains the only live source until this is fixed.` +
              (result.page_gated
                ? " Page appears gated behind ESPN's login-required overlay — this is likely NOT " +
                  "a stale selector; see session_health.js's assertRenderedSessionValid."
                : ""),
            {
              component: "draft_dom_observer",
              trigger,
              diagnostics: result.diagnostics,
              player_id_nodes: result.player_id_nodes,
              page_gated: result.page_gated,
              url: result.url,
              sample_html: result.sample_html,
            },
          );
        }
      } else {
        if (health.selector_miss_streak > 0) {
          log.info(
            `[Draft DOM] Selector recovered after ${health.selector_miss_streak} miss(es) via ` +
              `strategy "${result.matched_strategy}".`,
            { component: "draft_dom_observer", trigger },
          );
        }
        health.selector_miss_streak = 0;
        health.login_gate_detected = false;
      }

      if (records.length > 0 && onRecords) {
        await onRecords(records, {
          trigger,
          matched_strategy: result.matched_strategy,
        });
      }
      // Full-page DOM capture - LOG_LEVEL=debug only, same gate/reasoning as draft_sync.js's
      // WS/REST capture (#108 follow-up): raw evidence for anything the existing PICK_STRATEGIES
      // scanner isn't looking for (e.g. an autodraft-toggle control), automatic on every
      // practice run instead of a one-off draft_recon.js session. First scan always (captures
      // the room's starting state) then every 12th (~1/min at the default 5s poll interval) -
      // every scan would be redundant log volume for a page that's mostly re-rendering the same
      // board. A capture failure here must never take down the scan itself - it's purely
      // observational, on top of everything above that already succeeded or failed on its own.
      if (health.scans === 1 || health.scans % 12 === 0) {
        try {
          const html = await page.content();
          log.debug(
            `[Draft DOM] Full-page capture (scan #${health.scans}, ${html.length} chars, trigger=${trigger})`,
            { component: "draft_dom_capture", trigger, scan_number: health.scans, url: page.url(), html },
          );
        } catch (err) {
          log.debug(`[Draft DOM] Full-page capture failed: ${err.message}`, {
            component: "draft_dom_capture", trigger, err,
          });
        }
      }
      return records;
    } catch (err) {
      health.failed_scans += 1;
      // Navigation/teardown races are expected and routine (the page can navigate mid-scan) — not
      // worth an error-level line, unlike a genuine evaluation failure.
      const benign =
        /Execution context was destroyed|Target closed|has been closed|Navigation/i.test(
          err.message,
        );
      log[benign ? "warn" : "error"](
        `[Draft DOM] Board scan failed (${trigger}): ${err.message}`,
        { component: "draft_dom_observer", trigger, err },
      );
      return null;
    } finally {
      scanning = false;
    }
  }

  // The in-page MutationObserver calls this binding; the debounce lives on the Node side so a
  // page re-render storm collapses into one scan.
  try {
    await page.exposeBinding(BINDING_NAME, () => {
      if (stopped) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        scanNow("mutation").catch(() => {});
      }, MUTATION_DEBOUNCE_MS);
    });
  } catch (err) {
    // Re-attaching to a page that already has the binding (a reconnect reusing the same page)
    // throws rather than replacing it. That's recoverable: the existing binding still points at
    // the still-valid closure, and the poller below covers this tier regardless.
    log.warn(
      `[Draft DOM] Could not expose mutation binding (continuing with polling only): ${err.message}`,
      { component: "draft_dom_observer", err },
    );
  }

  try {
    await page.evaluate(
      ({ bindingName }) => {
        // Idempotent: a re-navigation re-runs this, and two observers on one document would
        // double every notification.
        if (window.__fantasyDraftObserver) {
          window.__fantasyDraftObserver.disconnect();
        }
        const observer = new MutationObserver(() => {
          const notify = window[bindingName];
          if (typeof notify === "function") notify();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-player-id", "data-team-id"],
        });
        window.__fantasyDraftObserver = observer;
      },
      { bindingName: BINDING_NAME },
    );
    health.observer_installed = true;
  } catch (err) {
    log.warn(
      `[Draft DOM] Could not install MutationObserver (continuing with polling only): ${err.message}`,
      { component: "draft_dom_observer", err },
    );
  }

  const pollTimer = setInterval(() => {
    scanNow("poll").catch(() => {});
  }, pollIntervalMs);
  // Never let this timer be the only thing keeping the process alive at shutdown.
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  health.attached = true;
  log.info(
    `[Draft DOM] Observer attached (observer=${health.observer_installed}, poll=${pollIntervalMs}ms).`,
    { component: "draft_dom_observer" },
  );

  // Seed immediately: the board already holds every pick made before we attached, which is exactly
  // the eviction-gap history the WS can never replay.
  await scanNow("initial");

  return {
    scanNow,
    getHealth: () => ({ ...health }),
    /**
     * Async because it also tears down the in-page MutationObserver, not just the Node-side
     * timers. Leaving that observer connected means every DOM mutation keeps firing a
     * cross-process binding call into Node for a scanner that will never run again — pure
     * overhead, and it makes the "caller MUST call stop()" contract only half true. Best-effort:
     * the page is usually being closed right after this, and a teardown race there is expected,
     * not an error.
     */
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        if (!page.isClosed()) {
          await page.evaluate(() => {
            if (window.__fantasyDraftObserver) {
              window.__fantasyDraftObserver.disconnect();
              delete window.__fantasyDraftObserver;
            }
          });
        }
      } catch {
        // Page already gone/navigating — the observer died with it either way.
      }
      health.observer_installed = false;
    },
  };
}

module.exports = {
  attachDraftDomObserver,
  dedupeScanRecords,
  scanInPage,
  detectLoginGate,
  PICK_STRATEGIES,
  DEFAULT_POLL_INTERVAL_MS,
};
