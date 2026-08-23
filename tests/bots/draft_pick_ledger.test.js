const {
  DraftPickLedger,
  pickIdentity,
  SOURCE_PRECEDENCE,
} = require("../../src/bots/draft_pick_ledger");

/**
 * Covers the dedup/precedence rules issue #52 depends on. These are the tests that would have
 * caught the original bug class directly: three ingest tiers observing the same draft must
 * collapse into exactly one publish per pick, and a slower-but-more-authoritative source must be
 * able to correct a faster one without ever re-emitting it as a new pick.
 */

/**
 * evaluate() decides but no longer records — draft_sync.js commits only after the durable Redis
 * write lands (so a failed write can't permanently mark a pick as published). Tests that need a
 * pick to be "already published" go through both steps, the same way the real caller does.
 */
const record = (ledger, event) => {
  const decision = ledger.evaluate(event);
  ledger.commit(decision);
  return decision;
};

const wsPick = (playerId, overrides = {}) => ({
  league_id: "123",
  player_id: playerId,
  team_id: 8,
  pick_number: 1,
  round: 1,
  source: "ws",
  ...overrides,
});

describe("DraftPickLedger", () => {
  it("publishes a player's first observation, but only records it on commit", () => {
    const ledger = new DraftPickLedger();
    const decision = ledger.evaluate(wsPick(4360438));

    expect(decision.action).toBe("publish");
    // Not recorded yet: the durable write hasn't happened, so an uncommitted decision must leave
    // no trace — otherwise a failed Redis write would permanently mark the pick as published.
    expect(ledger.size()).toBe(0);

    ledger.commit(decision);

    expect(ledger.size()).toBe(1);
    expect(ledger.hasPlayer(4360438)).toBe(true);
  });

  it("ignores a commit for a dropped decision", () => {
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438));
    const duplicate = ledger.evaluate(wsPick(4360438));

    expect(ledger.commit(duplicate)).toBe(false);
    expect(ledger.stats.published).toBe(1);
  });

  it("drops an identical re-observation as a duplicate", () => {
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438));

    expect(ledger.evaluate(wsPick(4360438)).action).toBe("duplicate");
    expect(ledger.stats.published).toBe(1);
    expect(ledger.stats.duplicate).toBe(1);
  });

  it("dedups the same player across DIFFERENT sources, not just repeats of one", () => {
    // The core #52 scenario: the DOM board rescan re-reports a pick the WebSocket already
    // delivered. Without cross-source dedup this publishes the same pick twice.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438));

    const domDecision = ledger.evaluate(
      wsPick(4360438, { source: "dom", round: null }),
    );

    expect(domDecision.action).toBe("duplicate");
    expect(ledger.size()).toBe(1);
  });

  it("dedups on player_id even when sources disagree about the pick number", () => {
    // WS pick numbers are locally counted, so a single missed frame offsets them permanently.
    // Keying dedup on pick_number would let the same player publish twice under two numbers.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438, { pick_number: 7 }));

    const decision = ledger.evaluate(
      wsPick(4360438, { pick_number: 9, source: "rest" }),
    );

    expect(decision.action).toBe("correct");
    expect(ledger.size()).toBe(1);
  });

  it("lets a higher-precedence source correct a lower one", () => {
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438, { pick_number: 7, team_id: 8 }));

    const decision = ledger.evaluate(
      wsPick(4360438, { pick_number: 12, team_id: 3, source: "rest" }),
    );

    expect(decision.action).toBe("correct");
    expect(decision.event.pick_number).toBe(12);
    expect(decision.event.team_id).toBe(3);
    expect(decision.event.corrected_from).toBe("ws");
  });

  it("refuses to let a lower-precedence source overwrite a corrected pick", () => {
    // The ordering-regression guard: a late WS frame arriving after REST corrected the pick must
    // not drag it back to the wrong value.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438, { pick_number: 7 }));
    record(ledger, wsPick(4360438, { pick_number: 12, source: "rest" }));

    const late = ledger.evaluate(wsPick(4360438, { pick_number: 7 }));

    expect(late.action).toBe("stale");
    expect(ledger.byPlayer.get("4360438").pick_number).toBe(12);
  });

  it("does not blank out fields a correcting source has no opinion about", () => {
    // A DOM row often has no round; merging (not replacing) keeps the round WS already got right.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438, { round: 4, team_id: 8 }));

    const decision = ledger.evaluate(
      wsPick(4360438, { round: null, team_id: 3, source: "dom" }),
    );

    expect(decision.action).toBe("correct");
    expect(decision.event.round).toBe(4);
    expect(decision.event.team_id).toBe(3);
  });

  it("treats a null pick_number as 'no opinion' rather than a disagreement", () => {
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438, { pick_number: 5 }));

    const decision = ledger.evaluate(
      wsPick(4360438, { pick_number: null, round: null, source: "dom" }),
    );

    expect(decision.action).toBe("duplicate");
  });

  it("publishes a genuinely new player even when its pick number is out of order", () => {
    // A backfill (REST or a DOM rescan filling a gap the WS missed) legitimately arrives with a
    // lower pick number than what's already published. It must still publish — only flagged.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(111, { pick_number: 20 }));

    const decision = ledger.evaluate(
      wsPick(222, { pick_number: 4, source: "dom" }),
    );

    expect(decision.action).toBe("publish");
    expect(ledger.stats.out_of_order).toBe(1);
  });

  it("never regresses highestPickNumber on a backfill", () => {
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(111, { pick_number: 20 }));
    record(ledger, wsPick(222, { pick_number: 4 }));

    expect(ledger.highestPickNumber).toBe(20);
  });

  it("rejects records with no usable player id", () => {
    const ledger = new DraftPickLedger();

    expect(ledger.evaluate(wsPick(null)).action).toBe("invalid");
    expect(ledger.evaluate(wsPick("not-a-number")).action).toBe("invalid");
    expect(ledger.size()).toBe(0);
    expect(ledger.stats.invalid).toBe(2);
  });

  it("clears everything on reset, so a fresh practice draft starts clean", () => {
    // DRAFT_MODE=mock joins a brand-new ephemeral league per reconnect; carrying the old draft's
    // players over would make every pick of the new one look like a duplicate.
    const ledger = new DraftPickLedger();
    record(ledger, wsPick(4360438));
    ledger.reset();

    expect(ledger.size()).toBe(0);
    expect(ledger.highestPickNumber).toBeNull();
    expect(ledger.evaluate(wsPick(4360438)).action).toBe("publish");
  });

  it("ranks sources so REST outranks DOM outranks WS", () => {
    expect(SOURCE_PRECEDENCE.rest).toBeGreaterThan(SOURCE_PRECEDENCE.dom);
    expect(SOURCE_PRECEDENCE.dom).toBeGreaterThan(SOURCE_PRECEDENCE.ws);
  });
});

describe("pickIdentity", () => {
  it("builds issue #52's composite identity", () => {
    expect(pickIdentity(wsPick(4360438))).toBe("123:1:4360438:8");
  });
});
