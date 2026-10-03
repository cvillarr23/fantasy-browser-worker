const crypto = require("crypto");
const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("./auth");
const { readRosters, captureWriteArtifact } = require("./espn_api");
const { captureDebugSnapshot } = require("./debug_capture");
const {
  findTradeSubmission,
  claimTradeSubmission,
  finalizeTradeSubmission,
  recordTradeOfferFill,
} = require("../db/execution_log");
const { PermanentError, requirePlainObjectPayload } = require("../errors");
const { requirePlayerId } = require("../lib/espn_ids");
const SELECTORS = require("../selectors/espn_selectors.json");
const { logger } = require("../telemetry/logger");
const { withInstrumentation } = require("../telemetry/instrument");

/**
 * ESPN trade-builder automation (#90): fills, and only when explicitly approved submits, the
 * "Propose Trade" form for {incoming players, outgoing players, target team}. Used for
 * trade_bot.js's counter-offers and, later, #93's generated proposals.
 *
 * THIS SENDS REAL TRADE OFFERS TO OTHER MANAGERS. A real submit needs all four of:
 *   1. DRY_RUN explicitly false   — unset means TRUE (waiver_sniper.js/draft_clicker.js convention).
 *   2. TRADE_SUBMIT_ENABLED=true  — trade-specific arming switch, default off, so DRY_RUN=false for
 *                                   lineup/waiver work on the same pod doesn't also arm this.
 *   3. a per-offer approval       — {offer_key, approved_by}; offer_key must equal
 *                                   computeOfferKey(offer), so an approval can't be replayed onto a
 *                                   different offer (an LLM re-roll, swapped ids, another team, or
 *                                   a different note to the manager: the message is in the key).
 *   4. verified selectors         — every TRADE_SUBMIT_SELECTOR_KEYS entry must be listed under
 *                                   espn_selectors.json's `_verified`. They start out unverified.
 * With any lock closed the run is a dry fill: tick the boxes, verify them, screenshot, and stop on
 * the first screen without clicking Continue. A BrowserContext-wide write guard (covering popups
 * too) aborts every non-GET ESPN request until the instant before the final click, so a
 * mis-identified button still can't send.
 *
 * Idempotency: a real submit is claimed in execution_log (advisory-locked, keyed on offer_key)
 * BEFORE the click. A redelivery of an offer already `submitted` is a no-op. One stuck at
 * `submitting` (the click happened, the outcome was never confirmed) fails closed as a
 * PermanentError for a human to check in ESPN. It is never re-clicked on a guess.
 *
 * DOM keying: ESPN's roster tables carry no per-player id (espn_selectors.json `_comment`). Rows
 * are found by the player's headshot <img> src, which embeds the ESPN id, falling back to the
 * name from readRoster, matched as the exact text of one element in the row (always the case for
 * D/ST, whose logo has no id). Anything that doesn't resolve to exactly one row fails closed, and
 * after ticking, the number of rows with a checked box must equal the requested count. All of this is UNVERIFIED against the live page until
 * trade_recon.js's safe mode confirms it; see espn_selectors.json.
 */

// Every selector the live-submit path depends on. trade_message_input is deliberately absent:
// a missing note field degrades to messageAttached=false rather than blocking a submit.
const TRADE_SUBMIT_SELECTOR_KEYS = [
  "trade_player_row",
  "trade_player_checkbox",
  "trade_checked_checkbox",
  "trade_headshot_img",
  "trade_continue_button",
  "trade_submit_button",
];

const SOURCES = new Set(["counter_offer", "proposal", "manual"]);
const SUBMIT_RESPONSE_TIMEOUT_MS = 30000;
// Same rationale and value as trade_bot.js's TRANSIENT_RETRY_DELAY_MS (a bare nack would hot-loop
// a Chromium launch under connection.js's channel-wide prefetch(1)). Not imported: trade_bot.js
// requires this module, so importing back would be circular.
const TRANSIENT_RETRY_DELAY_MS = 5000;

function withRetryDelay(error) {
  if (!error.permanent && error.retryDelayMs === undefined) {
    error.retryDelayMs = TRANSIENT_RETRY_DELAY_MS;
  }
  return error;
}

function resolveDryRun() {
  const raw = (process.env.DRY_RUN || "").trim();
  if (raw === "") return true;
  return !/^(0|false|no)$/i.test(raw);
}

function isSubmitArmed() {
  return /^(1|true|yes)$/i.test((process.env.TRADE_SUBMIT_ENABLED || "").trim());
}

function unverifiedSubmitSelectors() {
  const verified = new Set(SELECTORS._verified.keys);
  return TRADE_SUBMIT_SELECTOR_KEYS.filter((key) => !verified.has(key));
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new PermanentError(`[Trade Builder] ${label} is required.`);
  }
  return text;
}

function requireIdList(raw, label) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PermanentError(
      `[Trade Builder] ${label} must be a non-empty array of ESPN player ids.`,
    );
  }
  const ids = raw.map((id, index) =>
    requirePlayerId(id, `[Trade Builder] ${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new PermanentError(
      `[Trade Builder] ${label} lists a player more than once.`,
    );
  }
  return ids;
}

/**
 * Validates and normalizes an offer (all ids to strings). Everything rejected here is a
 * PermanentError, since no redelivery can fix a malformed offer.
 */
function normalizeTradeOffer(raw) {
  const leagueId = requireNonEmpty(raw.leagueId, "leagueId");
  const seasonId = requireNonEmpty(raw.seasonId, "seasonId");
  const fromTeamId = requireNonEmpty(raw.fromTeamId, "fromTeamId");
  const toTeamId = requireNonEmpty(raw.toTeamId, "toTeamId");
  if (toTeamId === fromTeamId) {
    throw new PermanentError(
      `[Trade Builder] toTeamId ${toTeamId} is our own team — a trade needs another manager.`,
    );
  }

  const incomingPlayerIds = requireIdList(raw.incomingPlayerIds, "incomingPlayerIds");
  const outgoingPlayerIds = requireIdList(raw.outgoingPlayerIds, "outgoingPlayerIds");
  const overlap = incomingPlayerIds.filter((id) => outgoingPlayerIds.includes(id));
  if (overlap.length > 0) {
    throw new PermanentError(
      `[Trade Builder] player id(s) ${overlap.join(", ")} cannot appear on both sides of a trade.`,
    );
  }

  if (raw.message !== undefined && raw.message !== null && typeof raw.message !== "string") {
    throw new PermanentError("[Trade Builder] message must be a string when present.");
  }
  const message = raw.message && raw.message.trim() !== "" ? raw.message : null;

  return {
    leagueId,
    seasonId,
    fromTeamId,
    toTeamId,
    incomingPlayerIds,
    outgoingPlayerIds,
    message,
  };
}

/**
 * The idempotency and approval key: sha256 over a canonical form of the offer. Ids are sorted
 * within each side, so LLM re-ordering doesn't change it, but the sides stay distinct, so a
 * mirrored trade does. The note to the other manager is included: approving an offer approves
 * exactly what they'll read, so a redelivered message with an edited note can't ride an old key.
 */
function computeOfferKey(offer) {
  const canonical = JSON.stringify([
    "trade-offer-v1",
    String(offer.leagueId),
    String(offer.seasonId),
    String(offer.fromTeamId),
    String(offer.toTeamId),
    offer.incomingPlayerIds.map(String).sort(),
    offer.outgoingPlayerIds.map(String).sort(),
    offer.message ?? null,
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Confirmed live 2026-09-22 (#90's issue notes): teamId is the OTHER manager's team, fromTeamId is
// ours, and navigating straight here works without clicking through their clubhouse.
function buildTradeBuilderUrl({ leagueId, seasonId, fromTeamId, toTeamId }) {
  return (
    `https://fantasy.espn.com/football/team/trade?leagueId=${encodeURIComponent(leagueId)}` +
    `&teamId=${encodeURIComponent(toTeamId)}&fromTeamId=${encodeURIComponent(fromTeamId)}` +
    `&seasonId=${encodeURIComponent(seasonId)}`
  );
}

function requireApproval(approval, offerKey) {
  if (approval === null || typeof approval !== "object" || Array.isArray(approval)) {
    throw new PermanentError("[Trade Builder] approval must be an object.");
  }
  if (typeof approval.approved_by !== "string" || approval.approved_by.trim() === "") {
    throw new PermanentError("[Trade Builder] approval.approved_by must be a non-empty string.");
  }
  if (approval.offer_key !== offerKey) {
    throw new PermanentError(
      `[Trade Builder] approval.offer_key ${approval.offer_key} does not match this offer ` +
        `(${offerKey}). The approval was for a different offer; nothing sent.`,
    );
  }
}

/**
 * Aborts every non-GET request to an ESPN host until allowWrites() is called, recording what it
 * blocked. `target` is a BrowserContext (covers popups/new tabs, which a Page route misses) or a
 * Page. Installed for every run, dry or live; on a live run it is lifted only immediately before
 * the final click, so nothing earlier in the flow (a tick, Continue) can send. OPTIONS is let
 * through: a CORS preflight writes nothing, and blocking it could break the page's own reads.
 */
async function installWriteGuard(target) {
  const guard = {
    blocked: [],
    allowed: [],
    writesAllowed: false,
    allowWrites() {
      guard.writesAllowed = true;
    },
  };

  await target.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method();
    let host = "";
    try {
      host = new URL(request.url()).hostname;
    } catch {
      // Unparseable URL: not an ESPN write, let it through.
    }
    const isEspnWrite =
      !["GET", "HEAD", "OPTIONS"].includes(method) && /(^|\.)espn\.com$/i.test(host);
    if (!isEspnWrite) return route.continue();

    const record = { method, url: request.url(), postData: request.postData() };
    if (!guard.writesAllowed) {
      guard.blocked.push(record);
      logger.warn(`[Trade Builder] Write guard blocked ${method} ${record.url}`);
      return route.abort("blockedbyclient");
    }
    guard.allowed.push(record);
    return route.continue();
  });

  return guard;
}

/**
 * A blocked write that looks like it belongs to the trade flow itself, as opposed to an analytics
 * beacon that also happens to POST to an espn.com host. Only these make a live submit refuse.
 */
function isTradeFlowWrite({ url }) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // can't tell, so treat it as the flow's
  }
  return /^lm-api-writes\./i.test(host) || /trade|transaction/i.test(url);
}

/**
 * Navigates to the trade builder and ticks exactly the offer's players. `names` holds the
 * playerId -> name maps from readRoster for each side. Every row is resolved before any box is
 * ticked, so an unresolvable player fails with nothing checked. Returns {resolvedBy}.
 */
async function fillTradeBuilder(page, offer, names) {
  await page.goto(buildTradeBuilderUrl(offer), { waitUntil: "networkidle", timeout: 20000 });
  try {
    await page.waitForSelector(SELECTORS.trade_player_row, { timeout: 10000 });
  } catch (waitError) {
    // Permanent: trade_player_row is unverified, and a selector that doesn't match will keep not
    // matching. A plain Error would requeue forever under connection.js's prefetch(1).
    throw new PermanentError(
      `[Trade Builder] No trade-builder rows (${SELECTORS.trade_player_row}) appeared: ` +
        `${waitError.message}. Re-run trade_recon.js to check the selectors.`,
    );
  }
  const rows = page.locator(SELECTORS.trade_player_row);

  const targets = [
    ...offer.incomingPlayerIds.map((id) => ({ id, name: names.incoming.get(id) })),
    ...offer.outgoingPlayerIds.map((id) => ({ id, name: names.outgoing.get(id) })),
  ];

  const resolved = [];
  const resolvedBy = {};
  for (const target of targets) {
    let row = null;
    // D/ST rows render a team logo, not an id-bearing headshot, so negative ids go by name.
    if (!target.id.startsWith("-")) {
      const byHeadshot = rows.filter({
        has: page.locator(SELECTORS.trade_headshot_img.replace("{id}", target.id)),
      });
      const count = await byHeadshot.count();
      if (count > 1) {
        throw new PermanentError(
          `[Trade Builder] Player ${target.id}'s headshot matched ${count} rows on the trade builder; refusing to guess.`,
        );
      }
      if (count === 1) {
        row = byHeadshot;
        resolvedBy[target.id] = "headshot";
      }
    }
    if (!row) {
      if (!target.name) {
        throw new PermanentError(
          `[Trade Builder] No trade-builder row shows player ${target.id}'s headshot, and ` +
            "readRoster returned no name to match on instead.",
        );
      }
      // Exact text of one element (the name link), not a substring of the row: the row's
      // textContent runs the name into the team/position spans ("Eagles D/STPhiD/ST").
      const byName = rows.filter({ has: page.getByText(target.name, { exact: true }) });
      const count = await byName.count();
      if (count !== 1) {
        throw new PermanentError(
          `[Trade Builder] Player ${target.id} ("${target.name}") matched ${count} rows on the ` +
            "trade builder; refusing to guess.",
        );
      }
      row = byName;
      resolvedBy[target.id] = "name";
    }
    resolved.push({ ...target, row });
  }

  // .first(): trade_player_checkbox is a union (native input OR ARIA widget), and a row with an
  // ARIA wrapper around a hidden input would match both, a strict-mode violation. The outer
  // element comes first in DOM order and is the clickable one.
  for (const { row } of resolved) {
    await row.locator(SELECTORS.trade_player_checkbox).first().check();
  }

  // Both checks are PermanentErrors: the same page will fail them the same way on every redelivery.
  for (const { id, row } of resolved) {
    if (!(await row.locator(SELECTORS.trade_player_checkbox).first().isChecked())) {
      throw new PermanentError(`[Trade Builder] Player ${id}'s box did not stay checked.`);
    }
  }
  // Rows with a checked box, not checked elements, so a wrapper+input pair counts once.
  const checked = await rows
    .filter({ has: page.locator(SELECTORS.trade_checked_checkbox) })
    .count();
  if (checked !== targets.length) {
    throw new PermanentError(
      `[Trade Builder] Trade builder shows ${checked} checked, expected ${targets.length}; refusing to continue.`,
    );
  }

  return { resolvedBy };
}

function requireOnRoster(ids, roster, teamId) {
  const missing = ids.filter((id) => !roster.slotByPlayerId.has(id));
  if (missing.length > 0) {
    throw new PermanentError(
      `[Trade Builder] player(s) ${missing.join(", ")} are not on team ${teamId}'s roster.`,
    );
  }
}

function unknownOutcome(label, offerKey, detail) {
  return new PermanentError(
    `${label} Clicked submit for offer ${offerKey} but ${detail}. Outcome unknown; left as ` +
      "'submitting'. Verify in ESPN before re-approving.",
  );
}

/**
 * Fills (and, with every lock open, submits) one trade offer. See the file header for the gate.
 *
 * opts.session: reuse a caller's already-open session (trade_bot.js does, to avoid a second
 * Chromium under the pod's memory limit). It's left open for the caller to close.
 *
 * Returns {status, offerKey, dryRun, screenshotPath, messageAttached, closedLocks, blockedWrites}.
 * status is one of: awaiting_approval (dry fill, no approval given), submit_blocked (approval
 * given but another lock closed), submitted, already_submitted.
 */
async function submitTradeOffer(
  rawOffer,
  { approval, source = "manual", trackingId = "no-tracking-id", session: providedSession } = {},
) {
  const offer = normalizeTradeOffer(rawOffer);
  const offerKey = computeOfferKey(offer);
  const label = `[Trade Builder][${trackingId}]`;
  if (!SOURCES.has(source)) {
    throw new PermanentError(`${label} source must be one of ${[...SOURCES].join(", ")}.`);
  }
  if (approval !== undefined && approval !== null) requireApproval(approval, offerKey);

  const closedLocks = [];
  if (resolveDryRun()) closedLocks.push("DRY_RUN is not explicitly false");
  if (!isSubmitArmed()) closedLocks.push("TRADE_SUBMIT_ENABLED is not true");
  const unverified = unverifiedSubmitSelectors();
  if (unverified.length > 0) {
    closedLocks.push(`selectors not yet verified: ${unverified.join(", ")}`);
  }
  if (!approval) closedLocks.push("no approval for this offer");
  const live = closedLocks.length === 0;

  const record = {
    leagueId: offer.leagueId,
    season: Number(offer.seasonId),
    source,
    fromTeamId: offer.fromTeamId,
    toTeamId: offer.toTeamId,
    incomingPlayerIds: offer.incomingPlayerIds,
    outgoingPlayerIds: offer.outgoingPlayerIds,
    approvedBy: approval ? approval.approved_by : null,
    message: offer.message,
  };

  logger.info(
    `${label} Offer ${offerKey} to team ${offer.toTeamId}: receive ${offer.incomingPlayerIds.join(",")} ` +
      `for ${offer.outgoingPlayerIds.join(",")} (${source})` +
      (live ? " — LIVE SUBMIT" : ` — dry fill (${closedLocks.join("; ")})`),
  );

  // Cheap redelivery check before launching Chromium. claimTradeSubmission repeats it atomically
  // right before the click, which is the check that actually guarantees once-only.
  if (live) {
    let existing;
    try {
      existing = await findTradeSubmission(offerKey);
    } catch (dbError) {
      throw withRetryDelay(
        new Error(`${label} Could not check execution_log for a prior submit: ${dbError.message}`, {
          cause: dbError,
        }),
      );
    }
    if (existing && existing.status === "submitted") {
      logger.info(`${label} Offer ${offerKey} was already submitted (row ${existing.id}). No-op.`);
      return { status: "already_submitted", offerKey, dryRun: false };
    }
    if (existing && existing.status === "submitting") {
      throw new PermanentError(
        `${label} Offer ${offerKey} has an earlier submit attempt (row ${existing.id}) whose ` +
          "outcome was never confirmed. Verify in ESPN before re-approving; not re-clicking.",
      );
    }
  }

  const ownsSession = !providedSession;
  let session = providedSession || null;
  let screenshotPath = null;
  let claim = null;
  let clicked = false;
  try {
    if (ownsSession) {
      session = (await createSessionFromStoredState()) ?? (await createAuthenticatedSession());
    }
    const { page, context } = session;

    // REST first: it's authoritative about who owns whom, and it supplies the names the DOM
    // fallback needs. A player who moved since the offer was drafted fails here, before any form.
    const rosters = await readRosters(context, {
      leagueId: offer.leagueId,
      seasonId: offer.seasonId,
      teamIds: [offer.toTeamId, offer.fromTeamId],
    });
    const theirs = rosters.get(offer.toTeamId);
    const ours = rosters.get(offer.fromTeamId);
    requireOnRoster(offer.incomingPlayerIds, theirs, offer.toTeamId);
    requireOnRoster(offer.outgoingPlayerIds, ours, offer.fromTeamId);

    const guard = await installWriteGuard(context);
    await fillTradeBuilder(page, offer, {
      incoming: theirs.nameByPlayerId,
      outgoing: ours.nameByPlayerId,
    });

    const snapshotLabel = `trade-offer-${offerKey}`;
    screenshotPath = (await captureDebugSnapshot(page, snapshotLabel)) ?? null;

    if (!live) {
      const status = approval ? "submit_blocked" : "awaiting_approval";
      logger.info(`${label} Dry fill complete — ${status}. Nothing was sent.`);
      await recordTradeOfferFill({
        ...record,
        offerKey,
        status,
        dryRun: true,
        screenshotPath,
        reasons: closedLocks,
      });
      return {
        status,
        offerKey,
        dryRun: true,
        screenshotPath,
        messageAttached: false,
        closedLocks,
        blockedWrites: guard.blocked.length,
      };
    }

    await page.locator(SELECTORS.trade_continue_button).first().click();
    const submitButton = page.locator(SELECTORS.trade_submit_button).first();
    await submitButton.waitFor({ state: "visible", timeout: 10000 });
    const flowWrites = guard.blocked.filter(isTradeFlowWrite);
    if (flowWrites.length > 0) {
      const [first] = flowWrites;
      throw new PermanentError(
        `${label} ESPN attempted ${flowWrites.length} trade write(s) before the final submit ` +
          `(first: ${first.method} ${first.url}). The flow differs from what this module expects; refusing to submit.`,
      );
    }

    let messageAttached = false;
    if (offer.message) {
      const input = page.locator(SELECTORS.trade_message_input).first();
      if ((await input.count()) > 0) {
        await input.fill(offer.message);
        messageAttached = true;
      } else {
        logger.warn(`${label} No note field on the review screen; message not attached.`);
      }
    }

    claim = await claimTradeSubmission(offerKey, { ...record, screenshotPath });
    if (!claim.claimed) {
      if (claim.existing === "submitted") {
        logger.info(`${label} Offer ${offerKey} was submitted by a concurrent attempt. No-op.`);
        return { status: "already_submitted", offerKey, dryRun: false, screenshotPath };
      }
      throw new PermanentError(
        `${label} Offer ${offerKey} is already mid-submit elsewhere, outcome unconfirmed. ` +
          "Verify in ESPN before re-approving; not re-clicking.",
      );
    }

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /lm-api-writes\.fantasy\.espn\.com\/.*\/transactions\/?(\?|$)/.test(response.url()),
      { timeout: SUBMIT_RESPONSE_TIMEOUT_MS },
    );
    // If the click itself throws, this promise is never awaited below; without a handler it would
    // reject later (timeout, or browser.close() in finally) as an unhandled rejection.
    responsePromise.catch(() => {});
    guard.allowWrites();
    clicked = true;
    try {
      await submitButton.click();
    } catch (clickError) {
      // The click may or may not have registered, so this is an unknown outcome, not a retry.
      throw unknownOutcome(label, offerKey, `the click itself failed (${clickError.message})`);
    }

    let response;
    try {
      response = await responsePromise;
    } catch (waitError) {
      throw unknownOutcome(label, offerKey, `saw no ESPN transactions response (${waitError.message})`);
    }

    const text = await response.text().catch(() => "");
    // Every write seen after the guard lifted, alongside the transactions call itself, is the raw
    // material for replacing these clicks with a REST submit later (as submitLineup did).
    captureWriteArtifact({
      kind: "trade_proposal",
      trackingId,
      leagueId: offer.leagueId,
      teamId: offer.fromTeamId,
      url: response.url(),
      requestBody: response.request().postData(),
      responseStatus: response.status(),
      responseOk: response.ok(),
      responseBodySnippet: text.slice(0, 500),
      otherWrites: guard.allowed,
    });

    if (!response.ok()) {
      const status = response.status();
      const detail = `ESPN answered HTTP ${status}: ${text.slice(0, 300)}`;
      // Only a 4xx (not 429) is a definite rejection. A 5xx or 429 might still have landed.
      if (status >= 400 && status < 500 && status !== 429) {
        const rejection = `${label} ESPN rejected offer ${offerKey}. ${detail}`;
        await finalizeTradeSubmission(claim.id, "failure", rejection);
        throw new PermanentError(rejection);
      }
      throw unknownOutcome(label, offerKey, detail);
    }

    await finalizeTradeSubmission(claim.id, "submitted", undefined);
    await captureDebugSnapshot(page, `${snapshotLabel}-submitted`);
    logger.info(`${label} Offer ${offerKey} submitted to team ${offer.toTeamId}.`);
    return {
      status: "submitted",
      offerKey,
      dryRun: false,
      screenshotPath,
      messageAttached,
      closedLocks: [],
      blockedWrites: 0,
    };
  } catch (error) {
    logger.error(
      `${label} Trade offer ${offerKey} failed${error.permanent ? " (permanent)" : ""}: ${error.message}`,
      { err: error, permanent: error.permanent === true },
    );
    if (session && session.page) {
      await captureDebugSnapshot(session.page, "trade-offer-failure");
    }
    if (claim && claim.claimed && !clicked) {
      // Claimed but never clicked: definitely nothing sent, so free the key for a retry.
      await finalizeTradeSubmission(claim.id, "failure", error.message);
    } else if (!claim) {
      await recordTradeOfferFill({
        ...record,
        offerKey,
        status: "failure",
        dryRun: !live,
        errorMessage: error.message,
      });
    }
    throw withRetryDelay(error);
  } finally {
    if (ownsSession && session && session.browser) {
      await session.browser.close();
    }
  }
}

/**
 * "trade_submissions" queue entrypoint. The payload names the other team and both player lists.
 * League and our team come from ESPN_LEAGUE_ID / ESPN_TEAM_ID like every other bot:
 *
 *   { "tracking_id": "...", "season": 2026, "to_team_id": "3",
 *     "incoming_player_ids": ["4259545", "-16021"], "outgoing_player_ids": ["3139477"],
 *     "source": "counter_offer" | "proposal" | "manual", "message": "optional note",
 *     "approval": { "offer_key": "<computeOfferKey(offer)>", "approved_by": "conor" } }
 *
 * Without `approval` this is a dry fill. Use it to stage an offer and get its offer_key and a
 * screenshot to review.
 */
async function executeTradeSubmission(payload) {
  requirePlainObjectPayload(payload, "[Trade Builder]");
  const leagueId = process.env.ESPN_LEAGUE_ID;
  const teamId = process.env.ESPN_TEAM_ID;
  if (!leagueId) throw new PermanentError("[Trade Builder] ESPN_LEAGUE_ID is not set.");
  if (!teamId) throw new PermanentError("[Trade Builder] ESPN_TEAM_ID is not set.");

  const { season, to_team_id: toTeamId, approval, message } = payload;
  if (!Number.isInteger(season)) {
    throw new PermanentError("[Trade Builder] season must be an integer.");
  }
  if (
    (typeof toTeamId !== "string" && typeof toTeamId !== "number") ||
    String(toTeamId).trim() === ""
  ) {
    throw new PermanentError("[Trade Builder] to_team_id must be a non-empty team id.");
  }
  if (approval !== undefined && (approval === null || typeof approval !== "object" || Array.isArray(approval))) {
    throw new PermanentError("[Trade Builder] approval must be an object when present.");
  }
  if (message !== undefined && typeof message !== "string") {
    throw new PermanentError("[Trade Builder] message must be a string when present.");
  }

  return submitTradeOffer(
    {
      leagueId,
      seasonId: String(season),
      fromTeamId: teamId,
      toTeamId: String(toTeamId),
      incomingPlayerIds: payload.incoming_player_ids,
      outgoingPlayerIds: payload.outgoing_player_ids,
      message,
    },
    {
      approval,
      source: payload.source ?? "manual",
      trackingId: payload.tracking_id ?? "no-tracking-id",
    },
  );
}

// Local/manual runs: node src/bots/trade_builder.js '<trade_submissions JSON payload>'
if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    logger.error(
      "Usage: node src/bots/trade_builder.js '<trade_submissions JSON payload>'\n" +
        "Dry fill (DRY_RUN unset = no submit): ESPN_LEAGUE_ID=1248158344 ESPN_TEAM_ID=8 \\\n" +
        "  node src/bots/trade_builder.js \\\n" +
        `  '{"season":2026,"to_team_id":"3","incoming_player_ids":["4259545"],"outgoing_player_ids":["3139477"]}'`,
    );
    process.exit(1);
  }

  const payload = JSON.parse(raw);
  withInstrumentation(
    "trade_builder",
    { trackingId: payload.tracking_id || crypto.randomUUID() },
    () => executeTradeSubmission(payload),
  )
    .then((result) => logger.info(`[Trade Builder] Result: ${JSON.stringify(result)}`))
    .catch(async (error) => {
      logger.error(`[Trade Builder] Run failed: ${error.message}`, { err: error });
      const { shutdownTelemetry } = require("../telemetry/init");
      try {
        await shutdownTelemetry();
      } finally {
        process.exit(1);
      }
    });
}

module.exports = {
  TRADE_SUBMIT_SELECTOR_KEYS,
  normalizeTradeOffer,
  computeOfferKey,
  buildTradeBuilderUrl,
  installWriteGuard,
  fillTradeBuilder,
  submitTradeOffer,
  executeTradeSubmission,
};
