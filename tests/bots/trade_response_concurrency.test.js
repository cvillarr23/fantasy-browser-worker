// The response executor and its real claim/settle SQL, run against an in-memory execution_log
// with advisory locks. ESPN is a fake: nothing here reaches a network or a database.
jest.mock("pg", () => {
  const { fakeExecutionLog } = require("../helpers/fake_execution_log");
  return { Pool: function Pool() { return fakeExecutionLog.pool(); } };
});
jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/db/activity", () => ({ beforeExternalWrite: jest.fn(), event: jest.fn() }));
jest.mock("../../src/bots/auth", () => ({
  createSessionFromStoredState: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));

const { fakeExecutionLog: db } = require("../helpers/fake_execution_log");
const { executeTradeResponse } = require("../../src/bots/trade_response");
const { claimOfferResponse } = require("../../src/db/trade_inbox");
const { STATUS, toInboxEntry, mergeEntry, computeDecisionKey, scoreFromResponse } = require("../../src/lib/trade_inbox");
const { PermanentError } = require("../../src/errors");

const LEAGUE = "1234567890";
const SCOPE = { leagueId: LEAGUE, season: 2026, teamId: "8" };
const NOW = new Date("2026-10-06T18:00:00Z");
const EXPIRES = Date.parse("2026-10-07T18:00:00Z");
const ENV_KEYS = ["DRY_RUN", "TRADE_RESPONSE_ENABLED", "ESPN_LEAGUE_ID", "ESPN_TEAM_ID"];

function trade(overrides = {}) {
  return {
    id: "tx-1",
    type: "TRADE_PROPOSAL",
    status: "PENDING",
    proposingTeamId: "3",
    proposedDate: Date.parse("2026-10-06T12:00:00Z"),
    expirationDate: EXPIRES,
    items: [
      { playerId: "-16021", playerName: "Eagles D/ST", type: "TRADE", fromTeamId: "3", toTeamId: "8" },
      { playerId: "4429795", playerName: "Bijan Robinson", type: "TRADE", fromTeamId: "8", toTeamId: "3" },
    ],
    ...overrides,
  };
}

const FINGERPRINT = toInboxEntry(trade(), "8").fingerprint;

function seedInbox(overrides = {}) {
  const fresh = toInboxEntry(trade(), "8");
  const score = scoreFromResponse(
    {
      as_of_week: 5,
      score: { final_score: 2 },
      horizon: { complete_horizon: true },
      roster_impact: { us: { exceeds_roster_limit: false } },
      coverage: { unmapped_traded_espn_ids: [] },
    },
    { fingerprint: fresh.fingerprint, partialReasons: [] },
  );
  const entry = { ...mergeEntry(null, fresh, NOW), score, ...overrides };
  const { status, ...rest } = entry;
  return db.insert({
    transaction_type: "trade_inbox",
    status,
    league_id: LEAGUE,
    season: 2026,
    offering_team_id: "3",
    counter_offer: rest,
    outcome_details: { incoming_publications: { core: { kind: "decision", status: "queued" } } },
  });
}

const keyFor = (action, comment = null) =>
  computeDecisionKey({ leagueId: LEAGUE, seasonId: 2026, ourTeamId: "8", transactionId: "tx-1", action, fingerprint: FINGERPRINT, comment });

function payload(action = "decline", overrides = {}) {
  return {
    tracking_id: `track-${action}`,
    espn_transaction_id: "tx-1",
    action,
    approval: { decision_key: keyFor(action), approved_by: "conor", reviewed_note: null },
    ...overrides,
  };
}

const inbox = () => db.ofType("trade_inbox")[0];
const responses = () => db.ofType("trade_response");

let espn;
let deps;
let savedEnv;

// ESPN as one shared fake league: a POST moves the offer out of pending and into history.
function fakeEspn() {
  const state = { pending: [trade()], history: [], posts: [], reject: null };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  state.submit = jest.fn(async (_context, submission) => {
    await tick();
    state.posts.push(submission);
    if (state.reject) throw state.reject;
    state.pending = state.pending.filter((t) => String(t.id) !== submission.transactionId);
    state.history.push({
      id: `resp-${state.posts.length}`,
      type: submission.action === "accept" ? "TRADE_ACCEPT" : "TRADE_DECLINE",
      status: "EXECUTED",
      relatedTransactionId: submission.transactionId,
    });
    return {};
  });
  return state;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESPN_LEAGUE_ID = LEAGUE;
  process.env.ESPN_TEAM_ID = "8";
  process.env.DRY_RUN = "false";
  process.env.TRADE_RESPONSE_ENABLED = "true";
  db.reset();
  espn = fakeEspn();
  deps = {
    now: NOW,
    readState: jest.fn().mockResolvedValue({ season_type: "regular", season: "2026", week: 5 }),
    openSession: jest.fn(async () => ({ context: {}, browser: { close: jest.fn() }, swid: "{SWID}" })),
    readPending: jest.fn(async () => ({ trades: [...espn.pending] })),
    readHistory: jest.fn(async () => [...espn.history]),
    readRoster: jest.fn().mockResolvedValue({ scoringPeriodId: 5, rosterLocked: false }),
    beforeExternalWrite: jest.fn(),
    submit: espn.submit,
    activityEvent: jest.fn(),
    recordOutcome: jest.fn(),
    verifiedActions: ["accept", "decline"],
    shapeVerified: true,
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("claimOfferResponse under concurrency", () => {
  const row = (action) => ({ leagueId: LEAGUE, season: 2026, transactionId: "tx-1", proposingTeamId: "3", action, comment: null, approvedBy: "conor" });
  const claimFor = (action) =>
    claimOfferResponse("tx-1", SCOPE, {
      decisionKey: keyFor(action),
      expectedFingerprint: FINGERPRINT,
      row: row(action),
      decision: { decision_key: keyFor(action), action },
      now: NOW,
    });

  it("lets only one of two different actions claim the same offer", async () => {
    seedInbox();

    const results = await Promise.allSettled([claimFor("accept"), claimFor("decline")]);

    expect(results.filter((r) => r.status === "fulfilled" && r.value.claimed)).toHaveLength(1);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(PermanentError);
    expect(responses()).toHaveLength(1);
    expect(inbox().status).toBe(STATUS.RESPONDING);
    expect(inbox().counter_offer.decision.decision_key).toBe(responses()[0].counter_offer.decision_key);
    expect(db.locksHeld()).toBe(0);
  });

  it("hands a second claim of the same key the existing row instead of a new one", async () => {
    seedInbox();

    const [first, second] = await Promise.all([claimFor("decline"), claimFor("decline")]);

    expect([first, second].filter((r) => r.claimed)).toHaveLength(1);
    expect([first, second].find((r) => !r.claimed)).toMatchObject({ claimed: false, existing: "responding" });
    expect(responses()).toHaveLength(1);
  });

  it("leaves core's outcome_details untouched", async () => {
    seedInbox();
    await claimFor("decline");
    expect(inbox().outcome_details).toEqual({ incoming_publications: { core: { kind: "decision", status: "queued" } } });
    expect(inbox().counter_offer).not.toHaveProperty("outcome_details");
  });
});

describe("executeTradeResponse makes at most one external write", () => {
  it("sends only one of a concurrent accept and decline", async () => {
    seedInbox();

    const results = await Promise.allSettled([
      executeTradeResponse(payload("accept"), deps),
      executeTradeResponse(payload("decline"), deps),
    ]);

    expect(espn.submit).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({ permanent: true });
    expect(responses().map((r) => r.status)).toEqual(["responded"]);
  });

  it("sends a same-key decision once when two deliveries race", async () => {
    seedInbox();

    await Promise.allSettled([
      executeTradeResponse(payload("decline", { tracking_id: "a" }), deps),
      executeTradeResponse(payload("decline", { tracking_id: "b" }), deps),
    ]);

    expect(espn.submit).toHaveBeenCalledTimes(1);
    expect(responses()).toHaveLength(1);
  });

  it("fails closed when a refresh changes the offer between the snapshot and the claim", async () => {
    seedInbox();
    const changed = toInboxEntry(trade({ expirationDate: EXPIRES + 1 }), "8").fingerprint;
    deps.readRoster.mockImplementation(async () => {
      const row = inbox();
      row.counter_offer = { ...row.counter_offer, fingerprint: changed };
      return { scoringPeriodId: 5, rosterLocked: false };
    });

    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/changed|refresh/i);

    expect(espn.submit).not.toHaveBeenCalled();
    expect(responses()).toHaveLength(0);
  });

  it.each([STATUS.EXPIRED, STATUS.COUNTERED, STATUS.CLOSED_UNKNOWN])(
    "fails closed when a refresh retires the offer as %s before the claim",
    async (status) => {
      seedInbox();
      deps.readRoster.mockImplementation(async () => {
        inbox().status = status;
        return { scoringPeriodId: 5, rosterLocked: false };
      });

      await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({ permanent: true });
      expect(espn.submit).not.toHaveBeenCalled();
      expect(responses()).toHaveLength(0);
    },
  );

  it("fails closed for an accept whose locked score no longer matches", async () => {
    seedInbox();
    deps.readRoster.mockImplementation(async () => {
      const row = inbox();
      row.counter_offer = { ...row.counter_offer, score: { ...row.counter_offer.score, exceeds_roster_limit: true } };
      return { scoringPeriodId: 5, rosterLocked: false };
    });

    await expect(executeTradeResponse(payload("accept"), deps)).rejects.toThrow(/roster limit/);
    expect(espn.submit).not.toHaveBeenCalled();
    expect(responses()).toHaveLength(0);
  });
});

describe("executeTradeResponse after a crash never sends again", () => {
  it("reconciles a claim taken just before a crash ahead of the POST", async () => {
    seedInbox();
    deps.beforeExternalWrite.mockRejectedValueOnce(new Error("process killed"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/process killed/);
    expect(responses().map((r) => r.status)).toEqual(["responding"]);

    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/manual verification/);

    expect(espn.submit).not.toHaveBeenCalled();
    expect(responses().map((r) => r.status)).toEqual(["response_unknown"]);
    expect(inbox()).toMatchObject({ status: STATUS.RESPONDING });
    expect(inbox().counter_offer.decision).toMatchObject({ outcome: "unknown" });
  });

  it("settles a sent decline whose offer has left the pending read", async () => {
    seedInbox();
    db.failOnce(/status = ANY\(\$4\)/, new Error("connection reset"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/couldn't be recorded/);
    expect(responses().map((r) => r.status)).toEqual(["responding"]);
    expect(espn.pending).toEqual([]);

    const result = await executeTradeResponse(payload(), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED, reconciled: true });
    expect(espn.submit).toHaveBeenCalledTimes(1);
    expect(responses().map((r) => r.status)).toEqual(["responded"]);
    expect(inbox().status).toBe(STATUS.DECLINED);
  });

  it("starts over cleanly when the claim itself fails before committing", async () => {
    seedInbox();
    db.failOnce(/VALUES \(\$1, \$2, 'responding'/, new Error("disk full"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/disk full/);
    expect(responses()).toHaveLength(0);
    expect(inbox().status).toBe(STATUS.OPEN);

    await expect(executeTradeResponse(payload(), deps)).resolves.toMatchObject({ status: "responded" });
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("promotes an unknown outcome once the reads confirm it, without posting", async () => {
    seedInbox();
    espn.submit.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    // ESPN processes the decline only after our verification read.
    deps.readHistory.mockResolvedValueOnce([]);
    deps.readPending
      .mockImplementationOnce(async () => ({ trades: [trade()] }))
      .mockImplementationOnce(async () => ({ trades: [trade()] }));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/manual verification/);
    expect(responses().map((r) => r.status)).toEqual(["response_unknown"]);

    espn.pending = [];
    espn.history = [{ id: "d", type: "TRADE_DECLINE", status: "EXECUTED", relatedTransactionId: "tx-1" }];
    const result = await executeTradeResponse(payload(), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED, reconciled: true });
    expect(espn.submit).toHaveBeenCalledTimes(1);
    expect(responses().map((r) => r.status)).toEqual(["responded"]);
  });

  it("returns a duplicate for a key already responded to", async () => {
    seedInbox();
    await executeTradeResponse(payload(), deps);
    deps.readPending.mockClear();

    await expect(executeTradeResponse(payload(), deps)).resolves.toMatchObject({ status: "duplicate" });
    expect(espn.submit).toHaveBeenCalledTimes(1);
    expect(deps.readPending).not.toHaveBeenCalled();
  });
});

describe("executeTradeResponse retry", () => {
  async function rejectedOnce() {
    seedInbox();
    espn.reject = Object.assign(new PermanentError("HTTP 409"), { status: 409, details: [] });
    await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({ permanent: true });
    espn.reject = null;
    expect(responses().map((r) => r.status)).toEqual(["rejected"]);
    expect(inbox().status).toBe(STATUS.OPEN);
    return responses()[0].id;
  }

  async function unknownOnce() {
    seedInbox();
    espn.submit.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/manual verification/);
    expect(responses().map((r) => r.status)).toEqual(["response_unknown"]);
    return responses()[0].id;
  }

  const retry = (id, extra = {}) =>
    payload("decline", { tracking_id: "retry-1", retry: { of_claim_id: id, approved_by: "conor", ...extra } });

  it("refuses to resend a rejected key without a retry", async () => {
    await rejectedOnce();
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/rejected/);
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses a different action after a rejection", async () => {
    await rejectedOnce();
    await expect(executeTradeResponse(payload("accept"), deps)).rejects.toThrow(/already claimed or settled/);
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("resends a rejected decision once when a human retries it", async () => {
    const id = await rejectedOnce();

    const result = await executeTradeResponse(retry(id), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED });
    expect(espn.submit).toHaveBeenCalledTimes(2);
    expect(responses().map((r) => r.status).sort()).toEqual(["responded", "superseded"]);
    const old = responses().find((r) => r.id === id);
    expect(old.counter_offer).toMatchObject({ retried_by: "conor", superseded_by_tracking_id: "retry-1" });
    expect(inbox().counter_offer.decision).toMatchObject({ retry_of: id });
  });

  it("sends only once when the retry button is pressed twice at the same time", async () => {
    const id = await rejectedOnce();

    await Promise.allSettled([
      executeTradeResponse(retry(id), deps),
      executeTradeResponse({ ...retry(id), tracking_id: "retry-2" }, deps),
    ]);

    expect(espn.submit).toHaveBeenCalledTimes(2);
    expect(responses().filter((r) => r.status === "superseded")).toHaveLength(1);
  });

  it("refuses a retry of a stale claim id", async () => {
    const id = await rejectedOnce();
    await expect(executeTradeResponse(retry(id + 1), deps)).rejects.toThrow(/retry/i);
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry an unknown outcome without the ESPN check attestation", async () => {
    const id = await unknownOnce();
    await expect(executeTradeResponse(retry(id), deps)).rejects.toThrow(/checked ESPN/);
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry an unknown outcome when history shows a related row", async () => {
    const id = await unknownOnce();
    espn.history = [{ id: "x", type: "TRADE_UPHOLD", status: "PENDING", relatedTransactionId: "tx-1" }];
    await expect(executeTradeResponse(retry(id, { verified_not_answered: true }), deps)).rejects.toThrow(/history/);
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("settles instead of resending when the reads now confirm an unknown outcome", async () => {
    const id = await unknownOnce();
    espn.pending = [];
    const result = await executeTradeResponse(retry(id, { verified_not_answered: true }), deps);
    expect(result).toMatchObject({ status: "responded", reconciled: true });
    expect(espn.submit).toHaveBeenCalledTimes(1);
  });

  it("resends an attested unknown outcome that ESPN still shows pending", async () => {
    const id = await unknownOnce();

    const result = await executeTradeResponse(retry(id, { verified_not_answered: true }), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED });
    expect(espn.submit).toHaveBeenCalledTimes(2);
    expect(responses().map((r) => r.status).sort()).toEqual(["responded", "superseded"]);
  });

  it("never retries a claim still responding", async () => {
    seedInbox();
    deps.beforeExternalWrite.mockRejectedValueOnce(new Error("process killed"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/process killed/);
    const id = responses()[0].id;

    await expect(executeTradeResponse(retry(id, { verified_not_answered: true }), deps)).rejects.toThrow(/manual verification/);
    expect(espn.submit).not.toHaveBeenCalled();
    expect(responses().map((r) => r.status)).toEqual(["response_unknown"]);
  });
});
