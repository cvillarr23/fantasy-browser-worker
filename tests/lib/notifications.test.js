const {
  runFailed,
  tradeAwaitingApproval,
  incomingTradeOffer,
  RUN_FAILURE_DEDUPE_TTL_MS,
  TRADE_DEDUPE_TTL_MS,
} = require("../../src/lib/notifications");
const { PRIORITY_HIGH, PRIORITY_URGENT } = require("../../src/lib/notify");

let savedDryRun;
beforeEach(() => {
  savedDryRun = process.env.DRY_RUN;
  delete process.env.DRY_RUN;
});
afterEach(() => {
  if (savedDryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = savedDryRun;
});

describe("runFailed", () => {
  it("links a failed run to its audit page and dedupes on bot + error", () => {
    const note = runFailed({ botName: "lineup_bot", runId: "run-1", error: new Error("boom") });
    expect(note).toMatchObject({
      title: "lineup_bot failed",
      message: "boom",
      priority: PRIORITY_HIGH,
      path: "/activity/runs/run-1",
      dedupeKey: "run_failed:lineup_bot:boom",
      dedupeTtlMs: RUN_FAILURE_DEDUPE_TTL_MS,
    });
  });

  it("says when retrying won't help", () => {
    const error = Object.assign(new Error("bad payload"), { permanent: true });
    expect(runFailed({ botName: "waiver_sniper", runId: "r", error }).message).toMatch(/Permanent error/);
  });

  it("falls back to the activity list without a run id", () => {
    expect(runFailed({ botName: "b", runId: null, error: new Error("x") }).path).toBe("/activity");
  });

  it("turns a failed ESPN session check into an urgent session alert", () => {
    const note = runFailed({ botName: "check_espn_session", runId: "r", error: new Error("roster missing") });
    expect(note).toMatchObject({
      title: "ESPN session expired",
      priority: PRIORITY_URGENT,
      path: "/settings",
      dedupeKey: "espn_session",
    });
  });

  it("marks titles during an explicit dry run", () => {
    process.env.DRY_RUN = "true";
    expect(runFailed({ botName: "b", runId: "r", error: new Error("x") }).title).toBe("[dry run] b failed");
  });
});

describe("tradeAwaitingApproval", () => {
  afterEach(() => {
    delete process.env.TRADE_DRY_RUN;
  });

  it("follows TRADE_DRY_RUN over the shared DRY_RUN for the dry-run marker", () => {
    const offer = { toTeamId: "3", incomingPlayerIds: ["1"], outgoingPlayerIds: ["9"] };
    process.env.DRY_RUN = "true";
    process.env.TRADE_DRY_RUN = "false";
    expect(tradeAwaitingApproval({ offerKey: "abc", offer, source: "proposal" }).title).toBe(
      "Trade offer ready for approval",
    );
    process.env.DRY_RUN = "false";
    process.env.TRADE_DRY_RUN = "true";
    expect(tradeAwaitingApproval({ offerKey: "abc", offer, source: "proposal" }).title).toBe(
      "[dry run] Trade offer ready for approval",
    );
  });

  const offer = { toTeamId: "3", incomingPlayerIds: ["1", "2"], outgoingPlayerIds: ["9"] };

  it("deep-links to the staged offer", () => {
    expect(tradeAwaitingApproval({ offerKey: "abc", offer, source: "proposal" })).toMatchObject({
      title: "Trade offer ready for approval",
      message: "To team 3: receive 1, 2; send 9.",
      path: "/trades?offer=abc",
      actionLabel: "Review",
      dedupeKey: "trade_approval:abc",
      dedupeTtlMs: TRADE_DEDUPE_TTL_MS,
    });
  });

  it("names counter-offers", () => {
    expect(tradeAwaitingApproval({ offerKey: "abc", offer, source: "counter_offer" }).title).toBe(
      "Counter-offer ready for approval",
    );
  });
});

describe("incomingTradeOffer", () => {
  const entry = {
    espn_transaction_id: "tx-1",
    proposing_team_id: "3",
    receive_espn_ids: ["-16021"],
    send_espn_ids: ["4429795"],
    player_names: { "-16021": "Eagles D/ST", 4429795: "Bijan Robinson" },
    comment: "Need a RB",
    score: null,
  };

  it("summarizes the offer by player name and links to the inbox", () => {
    expect(incomingTradeOffer(entry)).toMatchObject({
      title: "New trade offer from team 3",
      message: 'You receive Eagles D/ST; you send Bijan Robinson.\n"Need a RB"',
      path: "/inbox?offer=tx-1",
      dedupeKey: "trade_incoming:tx-1",
      dedupeTtlMs: TRADE_DEDUPE_TTL_MS,
    });
  });

  it("includes core's score once there is one", () => {
    const note = incomingTradeOffer({ ...entry, comment: null, score: { final_score: 3.5 } });
    expect(note.message).toBe("You receive Eagles D/ST; you send Bijan Robinson.\nScore: 3.5");
  });
});
