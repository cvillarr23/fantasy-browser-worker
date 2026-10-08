jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/db/trade_inbox", () => ({ loadInbox: jest.fn(), updateEntry: jest.fn() }));
jest.mock("../../src/db/execution_log", () => ({
  claimTradeResponse: jest.fn(),
  finalizeTradeResponse: jest.fn(),
  recordTradeResponseBlocked: jest.fn(),
}));
jest.mock("../../src/db/activity", () => ({ beforeExternalWrite: jest.fn(), event: jest.fn() }));
jest.mock("../../src/bots/auth", () => ({
  createSessionFromStoredState: jest.fn(),
  createAuthenticatedSession: jest.fn(),
}));

const { executeTradeResponse, requireResponsePayload } = require("../../src/bots/trade_response");
const { STATUS, toInboxEntry, mergeEntry, computeDecisionKey, scoreFromResponse } = require("../../src/lib/trade_inbox");
const { buildIncomingEvaluation, buildScoreRequest } = require("../../src/lib/trade_inbox");
const { makeScore } = require("../fixtures/trade_score");
const { PermanentError, SessionExpiredError } = require("../../src/errors");

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

function storedEntry(overrides = {}) {
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
  return { ...mergeEntry(null, fresh, NOW), score, ...overrides };
}

function keyFor(action, comment = null) {
  return computeDecisionKey({
    leagueId: "1248158344",
    seasonId: 2026,
    ourTeamId: "8",
    transactionId: "tx-1",
    action,
    fingerprint: toInboxEntry(trade(), "8").fingerprint,
    comment,
  });
}

function payload(action = "decline", overrides = {}) {
  return {
    tracking_id: "track-1",
    espn_transaction_id: "tx-1",
    action,
    approval: { decision_key: keyFor(action), approved_by: "conor" },
    ...overrides,
  };
}

let deps;
let order;
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.ESPN_TEAM_ID = "8";
  process.env.DRY_RUN = "false";
  process.env.TRADE_RESPONSE_ENABLED = "true";
  order = [];
  let inbox = storedEntry();
  deps = {
    now: NOW,
    readState: jest.fn().mockResolvedValue({ season_type: "regular", season: "2026", week: 5 }),
    openSession: jest.fn().mockResolvedValue({ context: {}, browser: { close: jest.fn() }, swid: "{SWID}" }),
    readPending: jest
      .fn()
      .mockResolvedValueOnce({ trades: [trade()] })
      .mockResolvedValue({ trades: [] }),
    readHistory: jest.fn().mockResolvedValue([]),
    readRoster: jest.fn().mockResolvedValue({ scoringPeriodId: 5, rosterLocked: false }),
    loadEntry: jest.fn(async () => inbox),
    updateEntry: jest.fn(async (_id, _scope, mutate) => {
      inbox = mutate(inbox) ?? inbox;
      order.push(`inbox:${inbox.status}`);
      return inbox;
    }),
    findResponse: jest.fn().mockResolvedValue(null),
    claimOffer: jest.fn(async (_id, _scope, { decision, validate }) => {
      order.push("claim");
      if (validate) validate(inbox);
      inbox = { ...inbox, status: STATUS.RESPONDING, decision };
      return { claimed: true, id: 31 };
    }),
    settleOffer: jest.fn(async (_id, _scope, { ledgerStatus, mutate }) => {
      order.push(`settle:${ledgerStatus}`);
      inbox = mutate(inbox) ?? inbox;
      return { settled: true };
    }),
    recordOutcome: jest.fn(),
    recordBlocked: jest.fn(),
    beforeExternalWrite: jest.fn(async () => order.push("before-write")),
    submit: jest.fn(async () => {
      order.push("post");
      return {};
    }),
    activityEvent: jest.fn(),
    verifiedActions: ["accept", "decline"],
    shapeVerified: true,
  };
  deps.inbox = () => inbox;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("requireResponsePayload", () => {
  it.each([
    [null, /JSON object/],
    [{ action: "decline" }, /espn_transaction_id/],
    [{ espn_transaction_id: "tx-1", action: "veto" }, /action must be accept or decline/],
    [{ espn_transaction_id: "tx-1", action: "decline", comment: 5 }, /comment must be a string/],
    [{ espn_transaction_id: "tx-1", action: "decline", approval: { decision_key: "x" } }, /approval needs/],
    [{ espn_transaction_id: "tx-1", action: "decline", retry: { of_claim_id: 0, approved_by: "conor" } }, /retry needs/],
    [{ espn_transaction_id: "tx-1", action: "decline", retry: { of_claim_id: 4, approved_by: " " } }, /retry needs/],
    [{ espn_transaction_id: "tx-1", action: "decline", retry: { of_claim_id: 4, approved_by: "conor", verified_not_answered: "yes" } }, /retry needs/],
  ])("rejects %j", (input, message) => {
    expect(() => requireResponsePayload(input)).toThrow(message);
  });
});

describe("executeTradeResponse locks", () => {
  it.each([
    ["dry_run", () => delete process.env.DRY_RUN],
    ["not_armed", () => delete process.env.TRADE_RESPONSE_ENABLED],
    ["no_approval", () => {}, { approval: undefined }],
    ["request_shape_unverified", () => (deps.verifiedActions = [])],
    ["pending_shape_unverified", () => (deps.shapeVerified = false)],
  ])("stays dry with %s and never posts", async (lock, close, overrides = {}) => {
    close();

    const result = await executeTradeResponse(payload("decline", overrides), deps);

    expect(result).toMatchObject({ status: "response_blocked", closedLocks: [lock] });
    expect(result.wouldSend).toMatchObject({ type: "TRADE_DECLINE", relatedTransactionId: "tx-1" });
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.claimOffer).not.toHaveBeenCalled();
    expect(deps.beforeExternalWrite).not.toHaveBeenCalled();
    expect(deps.recordBlocked).toHaveBeenCalledWith(expect.objectContaining({ closedLocks: [lock] }));
    expect(deps.inbox()).toMatchObject({ status: STATUS.OPEN, decision: { outcome: "blocked", closed_locks: [lock] } });
  });

  it("ships with every lock closed by default", async () => {
    delete process.env.DRY_RUN;
    delete process.env.TRADE_RESPONSE_ENABLED;
    const defaults = { ...deps };
    delete defaults.verifiedActions;
    delete defaults.shapeVerified;

    const result = await executeTradeResponse(payload("accept"), defaults);

    expect(result.closedLocks).toEqual(["dry_run", "not_armed", "request_shape_unverified", "pending_shape_unverified"]);
    expect(deps.submit).not.toHaveBeenCalled();
  });
});

describe("executeTradeResponse pre-flight", () => {
  it("refuses an approval for a different version of the offer", async () => {
    deps.readPending.mockReset().mockResolvedValue({ trades: [trade({ expirationDate: EXPIRES + 1 })] });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/approval does not match/);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("refuses an approval for a different note", async () => {
    await expect(executeTradeResponse(payload("decline", { comment: "No thanks" }), deps)).rejects.toThrow(
      /approval does not match/,
    );
  });

  it("refuses an offer that is no longer pending", async () => {
    deps.readPending.mockReset().mockResolvedValue({ trades: [] });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/no longer pending/);
  });

  it("refuses an offer about to expire", async () => {
    deps.now = new Date(EXPIRES - 1000);
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/expires/);
  });

  it("refuses an offer missing from the inbox", async () => {
    deps.loadEntry.mockResolvedValue(null);
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/not in the inbox/);
  });

  it("refuses to accept without a current score, over the roster limit, or with a locked roster", async () => {
    deps.loadEntry.mockResolvedValue(storedEntry({ score: null }));
    await expect(executeTradeResponse(payload("accept"), deps)).rejects.toThrow(/no current score/);

    deps.readPending.mockReset().mockResolvedValue({ trades: [trade()] });
    const over = storedEntry();
    over.score = { ...over.score, exceeds_roster_limit: true };
    deps.loadEntry.mockResolvedValue(over);
    await expect(executeTradeResponse(payload("accept"), deps)).rejects.toThrow(/roster limit/);

    deps.loadEntry.mockResolvedValue(storedEntry());
    deps.readRoster.mockResolvedValue({ scoringPeriodId: 5, rosterLocked: true });
    await expect(executeTradeResponse(payload("accept"), deps)).rejects.toThrow(/roster is locked/);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("refuses an approval whose existing claim is for another offer or action", async () => {
    deps.findResponse.mockResolvedValue({ id: 4, status: "responding", espn_transaction_id: "tx-2", action: "decline" });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/doesn't match/);
    deps.findResponse.mockResolvedValue({ id: 4, status: "responding", espn_transaction_id: "tx-1", action: "accept" });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/doesn't match/);
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("refuses a key whose earlier send ESPN rejected, unless a human retries it", async () => {
    deps.findResponse.mockResolvedValue({ id: 4, status: "rejected", espn_transaction_id: "tx-1", action: "decline" });
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/rejected/);
    expect(deps.claimOffer).not.toHaveBeenCalled();
  });

  it("does not let a blocked dry run overwrite a claim in progress", async () => {
    delete process.env.TRADE_RESPONSE_ENABLED;
    const responding = storedEntry({ status: STATUS.RESPONDING, decision: { decision_key: keyFor("accept"), outcome: "pending" } });
    deps.loadEntry.mockResolvedValue(responding);

    await executeTradeResponse(payload(), deps);

    const mutate = deps.updateEntry.mock.calls[0][2];
    expect(mutate(responding)).toBeNull();
    expect(mutate(storedEntry())).toMatchObject({ decision: { outcome: "blocked" } });
  });
});

describe("executeTradeResponse live path", () => {
  it.each(["missing", "valid", "invalid"])(
    "keeps fake submission arguments identical with %s advisory evidence",
    async (kind) => {
      const entry = deps.inbox();
      if (kind === "valid") {
        const { request } = buildScoreRequest(entry, {
          leagueId: "1248158344",
          season: 2026,
          week: 5,
        });
        const body = {
          ...makeScore({ counterpartyTeamId: "3", score: { final_score: 2 } }),
          league_id: request.league_id,
          our_team: { team_id: "8", name: "Us" },
          send: [
            {
              espn_id: "4429795",
              player_id: "9509",
              name: "Bijan Robinson",
              position: "RB",
              nfl_team: "ATL",
            },
          ],
          receive: [
            {
              espn_id: "-16021",
              player_id: "PHI",
              name: "Eagles D/ST",
              position: "D/ST",
              nfl_team: "PHI",
            },
          ],
        };
        entry.evaluation = buildIncomingEvaluation({
          request,
          body,
          fingerprint: entry.fingerprint,
          evaluatedAt: NOW.toISOString(),
        });
        expect(entry.evaluation).not.toBeNull();
      } else if (kind === "invalid") {
        entry.evaluation = { version: "future", score: { final_score: 99999 } };
      } else {
        delete entry.evaluation;
      }
      const evidence = entry.evaluation;
      await executeTradeResponse(payload(), deps);
      expect(deps.submit.mock.calls).toEqual([
        [
          {},
          {
            leagueId: "1248158344",
            seasonId: "2026",
            teamId: "8",
            memberId: "{SWID}",
            scoringPeriodId: 5,
            transactionId: "tx-1",
            action: "decline",
            comment: null,
            trackingId: "track-1",
          },
        ],
      ]);
      expect(deps.inbox().evaluation).toEqual(evidence);
      expect(deps.inbox().decision.decision_key).toBe(keyFor("decline"));
    },
  );

  it("claims, marks the external write, posts, then verifies a decline", async () => {
    const result = await executeTradeResponse(payload(), deps);

    expect(order).toEqual(["claim", "before-write", "post", "settle:responded"]);
    expect(deps.inbox().status).toBe(STATUS.DECLINED);
    expect(deps.submit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: "decline", transactionId: "tx-1", memberId: "{SWID}", scoringPeriodId: 5, teamId: "8" }),
    );
    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED });
    expect(deps.inbox().decision).toMatchObject({ decision_key: keyFor("decline"), approved_by: "conor", outcome: STATUS.DECLINED });
  });

  it("records an accept that ESPN is still processing", async () => {
    deps.readPending
      .mockReset()
      .mockResolvedValueOnce({ trades: [trade()] })
      .mockResolvedValue({ trades: [trade({ id: "acc", type: "TRADE_ACCEPT", proposingTeamId: "8", relatedTransactionId: "tx-1", isPending: true })] });

    const result = await executeTradeResponse(payload("accept"), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.ACCEPTED_PENDING_PROCESSING });
    expect(deps.inbox().status).toBe(STATUS.ACCEPTED_PENDING_PROCESSING);
  });

  it("does nothing for a decision already responded to, without opening ESPN", async () => {
    deps.findResponse.mockResolvedValue({ id: 4, status: "responded", espn_transaction_id: "tx-1", action: "decline" });
    await expect(executeTradeResponse(payload(), deps)).resolves.toMatchObject({ status: "duplicate" });
    expect(deps.openSession).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("reconciles a claim found responding before any fresh-offer check", async () => {
    deps.findResponse.mockResolvedValue({ id: 4, status: "responding", espn_transaction_id: "tx-1", action: "decline" });
    deps.loadEntry.mockResolvedValue(storedEntry({ status: STATUS.RESPONDING }));
    deps.readPending.mockReset().mockResolvedValue({ trades: [] });

    const result = await executeTradeResponse(payload(), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED, reconciled: true });
    expect(deps.settleOffer).toHaveBeenCalledWith("tx-1", expect.any(Object), expect.objectContaining({ claimId: 4, ledgerStatus: "responded" }));
    expect(deps.claimOffer).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("reconciles a vanished accept from ESPN's accept row instead of calling it no longer pending", async () => {
    deps.findResponse.mockResolvedValue({ id: 4, status: "responding", espn_transaction_id: "tx-1", action: "accept" });
    deps.readPending.mockReset().mockResolvedValue({ trades: [] });
    deps.readHistory.mockResolvedValue([{ id: "a", type: "TRADE_ACCEPT", status: "EXECUTED", relatedTransactionId: "tx-1" }]);

    const result = await executeTradeResponse(payload("accept"), deps);

    expect(result).toMatchObject({ status: "responded", outcome: STATUS.ACCEPTED, reconciled: true });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("reconciles a claim that another delivery took between the lookup and the claim", async () => {
    deps.claimOffer.mockResolvedValue({ claimed: false, existing: "responding", id: 4 });
    const result = await executeTradeResponse(payload(), deps);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.settleOffer).toHaveBeenCalledWith("tx-1", expect.any(Object), expect.objectContaining({ claimId: 4, ledgerStatus: "responded" }));
    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED, reconciled: true });
  });

  it("stops for manual verification when ESPN confirms but the outcome can't be saved", async () => {
    deps.settleOffer.mockRejectedValue(new Error("connection reset"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/declined.*couldn't be recorded/),
    });
    expect(deps.activityEvent).toHaveBeenCalledWith("manual_verification_required", expect.any(Object));
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it("treats a definite rejection as final, with ESPN's details, and reopens the offer", async () => {
    const rejection = Object.assign(new PermanentError("HTTP 409"), { status: 409, details: [{ type: "TRAN_X" }] });
    deps.submit.mockRejectedValue(rejection);

    await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({ permanent: true });

    expect(deps.settleOffer).toHaveBeenCalledWith(
      "tx-1",
      expect.any(Object),
      expect.objectContaining({ claimId: 31, ledgerStatus: "rejected", errorMessage: expect.stringMatching(/409/) }),
    );
    expect(deps.inbox()).toMatchObject({ status: STATUS.OPEN, decision: { outcome: "rejected", details: [{ type: "TRAN_X" }] } });
  });

  it("treats an expired session as not sent and asks for a fresh approval", async () => {
    deps.submit.mockRejectedValue(new SessionExpiredError("HTTP 401"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/session/) });
    expect(deps.settleOffer).toHaveBeenCalledWith("tx-1", expect.any(Object), expect.objectContaining({ claimId: 31, ledgerStatus: "rejected" }));
    expect(deps.inbox().status).toBe(STATUS.OPEN);
  });

  it("verifies by reading after an unknown outcome, and fails closed when it can't tell", async () => {
    deps.submit.mockRejectedValue(Object.assign(new Error("HTTP 503"), { status: 503, outcomeUnknown: true }));
    deps.readPending
      .mockReset()
      .mockResolvedValueOnce({ trades: [trade()] })
      .mockResolvedValue({ trades: [trade()] });

    await expect(executeTradeResponse(payload(), deps)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/manual verification/),
    });

    expect(deps.settleOffer).toHaveBeenCalledWith("tx-1", expect.any(Object), expect.objectContaining({ claimId: 31, ledgerStatus: "response_unknown" }));
    expect(deps.inbox()).toMatchObject({ status: STATUS.RESPONDING, decision: { outcome: "unknown" } });
    expect(deps.activityEvent).toHaveBeenCalledWith("manual_verification_required", expect.any(Object));
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it("settles an unknown outcome when the reads confirm it", async () => {
    deps.submit.mockRejectedValue(new Error("socket hang up"));
    const result = await executeTradeResponse(payload(), deps);
    expect(result).toMatchObject({ status: "responded", outcome: STATUS.DECLINED });
  });

  it("fails closed when the verification read itself fails", async () => {
    deps.readHistory.mockRejectedValue(new Error("history down"));
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/manual verification/);
    expect(deps.settleOffer).toHaveBeenCalledWith(
      "tx-1",
      expect.any(Object),
      expect.objectContaining({ ledgerStatus: "response_unknown", errorMessage: expect.stringMatching(/history down/) }),
    );
  });

  it("fails closed on evidence of a different outcome", async () => {
    deps.readHistory.mockResolvedValue([{ id: "a", type: "TRADE_ACCEPT", status: "EXECUTED", relatedTransactionId: "tx-1" }]);
    await expect(executeTradeResponse(payload(), deps)).rejects.toThrow(/manual verification/);
  });
});
