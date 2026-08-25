/**
 * Pure dedup/ordering decision layer for draft pick ingestion (WORKER issue #52).
 *
 * draft_sync.js now ingests the same draft from THREE independent sources — the draft room
 * WebSocket (`SELECTED` frames), a DOM observer/poller over the rendered draft board, and the
 * REST `mDraftDetail` snapshot. Each can see the same pick, see it at a different time, and
 * disagree about its metadata. Every one of them funnels through this module so there is exactly
 * one place that decides "publish / correct / drop," instead of three call sites each
 * reimplementing it slightly differently.
 *
 * WHY THE DEDUP KEY IS player_id, NOT pick_number
 * -----------------------------------------------
 * Issue #52 proposes a stable identity of `league_id + pick_number + player_id + team_id`. That
 * composite is used verbatim below as `pickIdentity()` — it's what gets logged and what
 * equality/correction checks compare against — but it is deliberately NOT the map key, because
 * `pick_number` is not trustworthy across sources:
 *
 *   - WS `SELECTED <teamId> <playerId> <lineupSlotId>` carries NO overall pick number at all. draft_sync
 *     derives one from a local running counter, so a single missed frame permanently offsets every
 *     subsequent WS pick number.
 *   - The DOM board may render pick numbers per round ("1.04") or not at all.
 *   - REST is the only source with a true `overallPickNumber`, and it's confirmed unreliable for
 *     practice/mock drafts (returns zero picks all draft long — see espn_api.js's readDraftPicks).
 *
 * Keying on pick_number would therefore let the SAME pick publish two or three times under two or
 * three different numbers, which is precisely the duplicate-emission failure #52 asks to prevent.
 * `player_id` is the one field that is genuinely stable and unique per draft: a player can be
 * drafted exactly once, every source agrees on ESPN's numeric player id, and it needs no local
 * derivation. So player_id is the identity; pick_number is treated as correctable metadata
 * ATTACHED to that identity.
 */

/**
 * Which source wins when two sources disagree about the same player's pick metadata.
 *
 * Higher number wins. REST outranks everything because it's the only source carrying a true
 * `overallPickNumber` (when it has data at all). DOM outranks WS because the rendered board shows
 * an actual pick position rather than WS's locally-counted guess. WS is lowest — it's the fastest
 * (~250ms) and so almost always publishes FIRST, it's just the least authoritative about the pick
 * NUMBER specifically. Being lowest precedence does not make it less important: it's what makes
 * the feed low-latency, and a later source only ever refines what it already published.
 */
const SOURCE_PRECEDENCE = {
  ws: 1,
  init: 2,
  dom: 3,
  rest: 4,
};

function precedenceOf(source) {
  return SOURCE_PRECEDENCE[source] ?? 0;
}

/**
 * Issue #52's stable pick identity, as specified. Used for equality comparison and for logging a
 * human-readable handle on a specific pick — NOT as the ledger's map key (see this file's header
 * for why that's player_id instead).
 */
function pickIdentity(event) {
  return [
    event.league_id,
    event.pick_number,
    event.player_id,
    event.team_id,
  ].join(":");
}

/** Null-safe numeric compare that treats null/undefined as "no opinion," never as 0. */
function sameValue(a, b) {
  if (a == null || b == null) return true;
  return String(a) === String(b);
}

/**
 * Whether a record carries a usable ESPN player id. Shared so the pick-number minter and the
 * ledger agree on exactly what counts as valid — otherwise an unusable record could consume a
 * locally-minted pick number on its way to being rejected.
 */
function isUsablePlayerId(playerId) {
  return !(
    playerId == null ||
    playerId === "" ||
    Number.isNaN(Number(playerId))
  );
}

/** Fresh per-draft counters — shared by the constructor and reset() so they can't drift apart. */
function createStats() {
  return {
    published: 0,
    corrected: 0,
    duplicate: 0,
    stale: 0,
    out_of_order: 0,
    invalid: 0,
  };
}

/**
 * True when the two events agree on everything that matters. pick_number/round are compared
 * null-tolerantly: a DOM record with no visible pick number shouldn't be treated as CONTRADICTING
 * a WS record that has one — it simply has nothing to say about it.
 */
function agreesWith(existing, incoming) {
  return (
    sameValue(existing.team_id, incoming.team_id) &&
    sameValue(existing.pick_number, incoming.pick_number) &&
    sameValue(existing.round, incoming.round)
  );
}

/**
 * Tracks every pick seen this draft and decides what to do with each new observation.
 *
 * In-memory, but NOT the only record: Redis holds the durable pick hash (`draft:{leagueId}:picks`),
 * and draft_sync.js rehydrates this ledger from it via seed() before ingest starts. That
 * rehydration is load-bearing rather than an optimization — a worker restart mid-draft would
 * otherwise begin with an empty ledger, and the DOM observer's first full-board scan would
 * re-publish the entire draft as new picks. REST cannot cover for that, since it returns nothing
 * at all for practice drafts.
 *
 * Keeping this a plain Map with no I/O is what makes the whole decision layer synchronous and
 * directly unit-testable; the durable read happens once, outside it.
 */
class DraftPickLedger {
  constructor() {
    /** @type {Map<string, object>} player_id -> the currently-published event for that player. */
    this.byPlayer = new Map();
    /** Highest pick_number published so far — used to flag ordering regressions. */
    this.highestPickNumber = null;
    this.stats = createStats();
  }

  /** Rebuilt-from-scratch reset, for when the league itself changes (a fresh practice draft). */
  reset() {
    this.byPlayer.clear();
    this.highestPickNumber = null;
    // Stats are per-draft too: draft_sync.js exports them in the health heartbeat alongside
    // picks_known, so carrying a previous league's counters over would make the two mutually
    // inconsistent and the new draft's metrics unreadable.
    this.stats = createStats();
  }

  size() {
    return this.byPlayer.size;
  }

  /** Every player_id already recorded — lets a caller skip re-processing known picks cheaply. */
  hasPlayer(playerId) {
    return this.byPlayer.has(String(playerId));
  }

  /**
   * Loads an already-durable pick into the ledger WITHOUT counting it as a new publish.
   *
   * Used to rehydrate from Redis (`draft:{leagueId}:picks`) on startup. Without this, a worker
   * restarting mid-draft would start with an empty ledger, and the DOM observer's very first
   * board scan — which reports the entire visible board at once — would look like N brand-new
   * picks and re-emit the whole draft downstream, minting fresh pick numbers in DOM scan order
   * and overwriting the board hash's correct pick->player mapping in the process.
   */
  seed(event) {
    if (event == null || event.player_id == null) return false;
    this.byPlayer.set(String(event.player_id), event);
    if (
      event.pick_number != null &&
      (this.highestPickNumber == null ||
        event.pick_number > this.highestPickNumber)
    ) {
      this.highestPickNumber = event.pick_number;
    }
    return true;
  }

  /**
   * Decides what should happen with an observed pick. PURE — it mutates nothing except the
   * drop-side stat counters (which are terminal: a dropped event has no follow-up), performs no
   * I/O, and returns the decision rather than acting on it.
   *
   * A "publish"/"correct" decision is NOT recorded here. The caller must call commit() once the
   * durable write has actually succeeded. That split matters: this ledger is the only dedup gate
   * in the pipeline, so recording a pick before its Redis write lands would mean a failed write
   * leaves the pick permanently marked as published — every later observation of it (WS
   * re-delivery, the DOM poller re-reporting the board, the next REST pass) would be dropped as a
   * duplicate, silently losing that pick for the rest of the draft. Which is precisely the
   * failure mode this whole change exists to eliminate.
   *
   * Returns { action, event, previous, reason }:
   *   - "publish"      first time this player has been seen; emit it, then commit().
   *   - "correct"      already published, but a higher-precedence source disagrees; re-emit with
   *                    corrected metadata, then commit().
   *   - "duplicate"    same pick, same details, already emitted; drop silently.
   *   - "stale"        a lower-or-equal-precedence source disagrees with what's already published;
   *                    drop (this is the out-of-order regression guard: a late WS frame can never
   *                    overwrite a REST-corrected pick).
   *   - "invalid"      unusable record (no player id); drop and count.
   */
  evaluate(rawEvent) {
    const playerId = rawEvent.player_id;
    if (!isUsablePlayerId(playerId)) {
      this.stats.invalid += 1;
      return {
        action: "invalid",
        event: rawEvent,
        previous: null,
        reason: "missing or non-numeric player_id",
      };
    }

    const key = String(playerId);
    const existing = this.byPlayer.get(key);

    if (!existing) {
      // An event whose pick_number is at or below one already published is NOT rejected — for a
      // genuinely new player this is a legitimate backfill (a REST snapshot filling in a pick the
      // WS never delivered, say). It's only flagged, so the gap is visible in the metrics rather
      // than silently smoothed over.
      const outOfOrder =
        rawEvent.pick_number != null &&
        this.highestPickNumber != null &&
        rawEvent.pick_number <= this.highestPickNumber;
      if (outOfOrder) this.stats.out_of_order += 1;

      return {
        action: "publish",
        event: rawEvent,
        previous: null,
        reason: outOfOrder ? "backfill (out-of-order pick number)" : "new pick",
      };
    }

    if (agreesWith(existing, rawEvent)) {
      this.stats.duplicate += 1;
      return {
        action: "duplicate",
        event: rawEvent,
        previous: existing,
        reason: `already published from "${existing.source}"`,
      };
    }

    if (precedenceOf(rawEvent.source) > precedenceOf(existing.source)) {
      // Merge rather than replace: a higher-precedence source that simply doesn't carry a field
      // (a DOM row with no round, say) must not blank out a value a lower-precedence source
      // already got right.
      const merged = {
        ...existing,
        ...rawEvent,
        pick_number: rawEvent.pick_number ?? existing.pick_number,
        round: rawEvent.round ?? existing.round,
        team_id: rawEvent.team_id ?? existing.team_id,
        member_id: rawEvent.member_id ?? existing.member_id,
        pick_origin: rawEvent.pick_origin ?? existing.pick_origin,
        corrected_from: existing.source,
      };
      return {
        action: "correct",
        event: merged,
        previous: existing,
        reason: `"${rawEvent.source}" outranks "${existing.source}"`,
      };
    }

    this.stats.stale += 1;
    return {
      action: "stale",
      event: rawEvent,
      previous: existing,
      reason: `"${rawEvent.source}" does not outrank already-published "${existing.source}"`,
    };
  }

  /**
   * Records a decision as durably published. Call ONLY after the write succeeded — see evaluate()
   * for why the two are deliberately separate. A no-op for drop decisions, so a caller can pass
   * any decision through without branching.
   */
  commit(decision) {
    if (
      !decision ||
      (decision.action !== "publish" && decision.action !== "correct")
    ) {
      return false;
    }

    const event = decision.event;
    this.byPlayer.set(String(event.player_id), event);
    if (
      event.pick_number != null &&
      (this.highestPickNumber == null ||
        event.pick_number > this.highestPickNumber)
    ) {
      this.highestPickNumber = event.pick_number;
    }
    this.stats[decision.action === "correct" ? "corrected" : "published"] += 1;
    return true;
  }
}

module.exports = {
  DraftPickLedger,
  SOURCE_PRECEDENCE,
  pickIdentity,
  agreesWith,
  isUsablePlayerId,
};
