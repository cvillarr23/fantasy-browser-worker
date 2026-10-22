jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/espn_api");
jest.mock("../../src/bots/debug_capture");
jest.mock("../../src/db/execution_log");
jest.mock("../../src/lib/notify", () => ({
  ...jest.requireActual("../../src/lib/notify"),
  notify: jest.fn(async () => "sent"),
}));
const { notify } = require("../../src/lib/notify");
const { logger } = require("../../src/telemetry/logger");

const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("../../src/bots/auth");
const {
  readRosters,
  readPendingTrades,
  buildTradeProposalBody,
  captureWriteArtifact,
} = require("../../src/bots/espn_api");
const { captureDebugSnapshot } = require("../../src/bots/debug_capture");
const {
  findTradeSubmission,
  claimTradeSubmission,
  finalizeTradeSubmission,
  recordTradeOfferFill,
} = require("../../src/db/execution_log");
const SELECTORS = require("../../src/selectors/espn_selectors.json");
const {
  computeOfferKey,
  normalizeTradeOffer,
  buildTradeBuilderUrl,
  installWriteGuard,
  isTradeProposalResponse,
  fillTradeBuilder,
  submitTradeOffer,
  executeTradeSubmission,
  TRADE_SUBMIT_SELECTOR_KEYS,
} = require("../../src/bots/trade_builder");

const ENV_KEYS = [
  "DRY_RUN",
  "TRADE_DRY_RUN",
  "TRADE_SUBMIT_ENABLED",
  "ESPN_LEAGUE_ID",
  "ESPN_TEAM_ID",
];
let savedEnv;
let savedVerifiedKeys;

// Their team (3) and ours (8). The D/ST row has no headshot id: ESPN renders a team logo there,
// so it can only be resolved by name, which is exactly the negative-id path (#117) that has to
// keep working.
const THEIR_ROWS = [
  { team: "3", id: "4259545", headshotId: "4259545", name: "Alpha Back" },
  // Live recon (#123): the builder shows a D/ST as just its team name ("Eagles", position D/ST),
  // while readRoster's fullName is "Eagles D/ST".
  { team: "3", id: "-16021", headshotId: null, name: "Eagles", rosterName: "Eagles D/ST" },
  { team: "3", id: "3054211", headshotId: "3054211", name: "Bravo Receiver" },
];
const OUR_ROWS = [
  { team: "8", id: "3139477", headshotId: "3139477", name: "Charlie End" },
  { team: "8", id: "4362628", headshotId: "4362628", name: "Delta Wideout" },
  { team: "8", id: "15847", headshotId: "15847", name: "Echo Kicker" },
  { team: "8", id: "2976499", headshotId: "2976499", name: "Foxtrot Back" },
];

function offerFixture(overrides = {}) {
  return {
    leagueId: "1234567890",
    seasonId: "2026",
    fromTeamId: "8",
    toTeamId: "3",
    incomingPlayerIds: ["4259545", "-16021"],
    outgoingPlayerIds: ["3139477", "4362628", "15847"],
    ...overrides,
  };
}

function rosterFor(rows) {
  return {
    slotByPlayerId: new Map(rows.map((r) => [r.id, 20])),
    nameByPlayerId: new Map(rows.map((r) => [r.id, r.rosterName ?? r.name])),
  };
}

/**
 * Fake Playwright page over an in-memory model of the trade-builder's two roster tables. Only the
 * locator surface trade_builder.js actually uses is modeled; anything else throws, so a change to a
 * selector the fake doesn't know about fails loudly instead of silently matching nothing.
 *
 * `state.clicks` records every check() and button click in order. The dry-run/approval tests assert
 * on it, so "never clicked submit" is checked directly rather than inferred from return values.
 */
// What ESPN's client would POST for offerFixture() (docs/espn/trades.md, #124).
function proposalPostData(offer = offerFixture(), overrides = {}) {
  return JSON.stringify({
    ...jest.requireActual("../../src/bots/espn_api").buildTradeProposalBody({
      teamId: offer.fromTeamId,
      toTeamId: offer.toTeamId,
      memberId: "{SWID}",
      scoringPeriodId: 4,
      incomingPlayerIds: offer.incomingPlayerIds,
      outgoingPlayerIds: offer.outgoingPlayerIds,
      expirationDate: new Date(Date.now() + 2 * 86400000),
      comment: offer.message ?? "",
    }),
    ...overrides,
  });
}

// A pending TRADE_PROPOSAL for offerFixture() as espn_api's readPendingTrades returns it.
function pendingProposal(offer = offerFixture(), overrides = {}) {
  const item = (id, from, to) => ({
    playerId: String(id),
    playerName: null,
    type: "TRADE",
    fromTeamId: String(from),
    toTeamId: String(to),
  });
  return {
    id: "tx-1",
    type: "TRADE_PROPOSAL",
    status: "PENDING",
    proposingTeamId: String(offer.fromTeamId),
    // Proposed a moment after the claim, as a real submit would be.
    proposedDate: Date.now() + 1000,
    items: [
      ...offer.incomingPlayerIds.map((id) => item(id, offer.toTeamId, offer.fromTeamId)),
      ...offer.outgoingPlayerIds.map((id) => item(id, offer.fromTeamId, offer.toTeamId)),
    ],
    ...overrides,
  };
}

function pendingRead(trades) {
  return { trades, teamIdByMemberId: new Map() };
}

function makeBuilderPage(
  rows,
  {
    submitResponse = { status: 200, body: "{}" },
    submitClickThrows = false,
    submitPostData = proposalPostData(),
  } = {},
) {
  const state = {
    rows: rows.map((r) => ({ checked: false, ...r })),
    clicks: [],
    routeHandlers: [],
    gotoUrls: [],
    // Page loads so far; a row with ignoreUntilLoad: n swallows clicks until the nth load.
    loads: 0,
    filledMessage: null,
    // Stands in for running the in-page reader against the refused row.
    evaluate: async () => ({ signals: [], rowHtml: "", visibleText: "" }),
  };
  let pendingResponse = null;

  const checkboxLocator = (set) => ({
    first: () => checkboxLocator(set),
    check: async () => {
      if (set.length !== 1) {
        throw new Error(`strict mode violation: ${set.length} elements`);
      }
      if (set[0].failFirstChecks > 0) {
        set[0].failFirstChecks -= 1;
        set[0].checkAttempts = (set[0].checkAttempts || 0) + 1;
        throw new Error("locator.check: Clicking the checkbox did not change its state");
      }
      if (set[0].checkError) throw new Error(set[0].checkError);
      if (set[0].ignoreUntilLoad > state.loads) {
        throw new Error("locator.check: Clicking the checkbox did not change its state");
      }
      if (set[0].refuses) throw new Error("locator.check: Clicking the checkbox did not change its state");
      set[0].checked = true;
      state.clicks.push(`check:${set[0].id}`);
    },
    isChecked: async () => set.length === 1 && set[0].checked,
  });

  const rowsLocator = (set) => ({
    filter: ({ has, hasText }) => {
      if (has && has.__headshotId !== undefined) {
        return rowsLocator(
          set.filter((r) => r.headshotId !== null && r.headshotId === has.__headshotId),
        );
      }
      // getByText(name, {exact: true}) matches the name element, not the row's run-together text.
      if (has && has.__exactText !== undefined) {
        return rowsLocator(set.filter((r) => r.name === has.__exactText));
      }
      if (has && has.__checked) return rowsLocator(set.filter((r) => r.checked));
      throw new Error(`fake rows.filter: unsupported ${JSON.stringify({ has, hasText })}`);
    },
    count: async () => set.length,
    first: () => ({ evaluate: async (fn, options) => state.evaluate(set[0], fn, options) }),
    locator: (sel) => {
      if (sel !== SELECTORS.trade_player_checkbox) {
        throw new Error(`fake row locator: unexpected selector ${sel}`);
      }
      return checkboxLocator(set);
    },
  });

  const button = (name) => {
    const self = {
      click: async () => {
        state.clicks.push(name);
        if (name === "submit" && submitClickThrows) {
          throw new Error("element is detached from the DOM");
        }
        if (name === "submit" && pendingResponse) {
          const { resolve, reject, predicate } = pendingResponse;
          pendingResponse = null;
          const timeout = () =>
            reject(new Error("Timeout 30000ms exceeded while waiting for event \"response\""));
          if (submitResponse === null) {
            timeout();
          } else {
            const response = {
              url: () =>
                "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1234567890/transactions/?platformVersion=35f16ade",
              status: () => submitResponse.status,
              ok: () => submitResponse.status >= 200 && submitResponse.status < 300,
              text: async () => submitResponse.body,
              request: () => ({ method: () => "POST", postData: () => submitPostData }),
            };
            // Apply the module's real predicate: a response it wouldn't match is never seen.
            if (predicate(response)) resolve(response);
            else timeout();
          }
        }
      },
      waitFor: async () => {},
      count: async () => 1,
      first: () => self,
      fill: async (text) => {
        state.filledMessage = text;
      },
    };
    return self;
  };

  const headshotPattern = /players\/full\/(-?\d+)\./;
  const page = {
    goto: jest.fn(async (url) => {
      state.gotoUrls.push(url);
      state.loads += 1;
      // A reload is a fresh page: every tick is gone.
      if (state.loads > 1) for (const r of state.rows) r.checked = false;
    }),
    waitForSelector: jest.fn(async () => {}),
    waitForLoadState: jest.fn(async () => {}),
    route: jest.fn(async (_pattern, handler) => {
      state.routeHandlers.push(handler);
    }),
    getByText: jest.fn((text, { exact } = {}) => {
      if (!exact) throw new Error("fake page: getByText must be exact");
      return { __exactText: text };
    }),
    waitForResponse: jest.fn(
      (predicate) =>
        new Promise((resolve, reject) => {
          pendingResponse = { resolve, reject, predicate };
        }),
    ),
    locator: jest.fn((sel) => {
      if (sel === SELECTORS.trade_player_row) return rowsLocator(state.rows);
      if (sel === SELECTORS.trade_checked_checkbox) return { __checked: true };
      if (sel === SELECTORS.trade_continue_button) return button("continue");
      if (sel === SELECTORS.trade_submit_button) return button("submit");
      if (sel === SELECTORS.trade_cancel_button) return button("cancel");
      if (sel === SELECTORS.trade_message_input) return button("message");
      const match = sel.match(headshotPattern);
      if (match) return { __headshotId: match[1] };
      throw new Error(`fake page: unexpected selector ${sel}`);
    }),
  };
  return { page, state };
}

// Lets fake-timer backoffs elapse while a fill that is expected to reject is in flight, then hands
// back the (rejected) promise for the usual expect(...).rejects.
function drain(promise) {
  promise.catch(() => {});
  return jest.runAllTimersAsync().then(() => promise);
}

function fakeRoute(method, url) {
  return {
    request: () => ({ method: () => method, url: () => url, postData: () => null }),
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  };
}

// The write guard goes on the BrowserContext; the fake context shares the page's route log so
// tests can drive the installed handler either way.
function fakeContext(page) {
  return { route: page.route };
}

function useSession(page) {
  const browser = { close: jest.fn(async () => {}) };
  createSessionFromStoredState.mockResolvedValue(null);
  createAuthenticatedSession.mockResolvedValue({ page, context: fakeContext(page), browser });
  return browser;
}

function mockRosters() {
  readRosters.mockImplementation(
    async (_context, { teamIds }) =>
      new Map(teamIds.map((id) => [id, rosterFor(id === "3" ? THEIR_ROWS : OUR_ROWS)])),
  );
}

function armForLiveSubmit() {
  process.env.DRY_RUN = "false";
  process.env.TRADE_SUBMIT_ENABLED = "true";
  SELECTORS._verified.keys = [
    ...savedVerifiedKeys,
    ...TRADE_SUBMIT_SELECTOR_KEYS,
  ];
}

function approvalFor(offer) {
  return { offer_key: computeOfferKey(offer), approved_by: "conor" };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedVerifiedKeys = SELECTORS._verified.keys;
  delete process.env.DRY_RUN;
  delete process.env.TRADE_DRY_RUN;
  delete process.env.TRADE_SUBMIT_ENABLED;
  process.env.ESPN_LEAGUE_ID = "1234567890";
  process.env.ESPN_TEAM_ID = "8";

  mockRosters();
  findTradeSubmission.mockResolvedValue(null);
  claimTradeSubmission.mockResolvedValue({ claimed: true, id: 42 });
  finalizeTradeSubmission.mockResolvedValue(undefined);
  recordTradeOfferFill.mockResolvedValue(undefined);
  readPendingTrades.mockResolvedValue(pendingRead([]));
  buildTradeProposalBody.mockImplementation(
    jest.requireActual("../../src/bots/espn_api").buildTradeProposalBody,
  );
});

afterEach(() => {
  SELECTORS._verified.keys = savedVerifiedKeys;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("computeOfferKey", () => {
  it("is stable regardless of id order on either side", () => {
    const a = computeOfferKey(offerFixture());
    const b = computeOfferKey(
      offerFixture({
        incomingPlayerIds: ["-16021", "4259545"],
        outgoingPlayerIds: ["15847", "3139477", "4362628"],
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the target team or any player changes", () => {
    const base = computeOfferKey(offerFixture());
    expect(computeOfferKey(offerFixture({ toTeamId: "4" }))).not.toBe(base);
    expect(
      computeOfferKey(offerFixture({ outgoingPlayerIds: ["3139477", "4362628"] })),
    ).not.toBe(base);
    expect(computeOfferKey(offerFixture({ message: "hi" }))).not.toBe(base);
    // Swapping sides is a different trade, not the same one.
    expect(
      computeOfferKey(
        offerFixture({
          incomingPlayerIds: offerFixture().outgoingPlayerIds,
          outgoingPlayerIds: offerFixture().incomingPlayerIds,
        }),
      ),
    ).not.toBe(base);
  });
});

describe("computeOfferKey: counter linkage", () => {
  it("leaves an unlinked offer's key as the original eight-field form core recomputes", () => {
    const offer = offerFixture();
    const original = require("crypto")
      .createHash("sha256")
      .update(
        JSON.stringify([
          "trade-offer-v1",
          offer.leagueId,
          offer.seasonId,
          offer.fromTeamId,
          offer.toTeamId,
          [...offer.incomingPlayerIds].sort(),
          [...offer.outgoingPlayerIds].sort(),
          null,
        ]),
      )
      .digest("hex");
    expect(computeOfferKey(normalizeTradeOffer(offer))).toBe(original);
  });

  it("binds the countered offer but not the thread root", () => {
    const linked = (overrides) => computeOfferKey(normalizeTradeOffer(offerFixture(overrides)));
    const base = linked({ relatedTransactionId: "tx-3", threadRootId: "tx-1" });
    expect(base).not.toBe(linked({}));
    expect(base).not.toBe(linked({ relatedTransactionId: "tx-4", threadRootId: "tx-1" }));
    expect(base).toBe(linked({ relatedTransactionId: "tx-3", threadRootId: "tx-0" }));
  });
});

describe("normalizeTradeOffer", () => {
  it("defaults a counter's thread root to the offer it answers, and leaves a proposal unlinked", () => {
    expect(normalizeTradeOffer(offerFixture({ relatedTransactionId: "tx-3" }))).toMatchObject({
      relatedTransactionId: "tx-3",
      threadRootId: "tx-3",
    });
    expect(normalizeTradeOffer(offerFixture({ threadRootId: null }))).toMatchObject({
      relatedTransactionId: null,
      threadRootId: null,
    });
  });

  it.each([
    [{ relatedTransactionId: "" }, /relatedTransactionId/],
    [{ relatedTransactionId: 7 }, /relatedTransactionId/],
    [{ relatedTransactionId: "tx-3", threadRootId: " tx-1" }, /threadRootId/],
    [{ threadRootId: "tx-1" }, /needs the relatedTransactionId/],
  ])("rejects malformed linkage %j as permanent", (overrides, message) => {
    expect(() => normalizeTradeOffer(offerFixture(overrides))).toThrow(message);
  });

  it("accepts negative D/ST ids and numeric ids, normalizing to strings", () => {
    const offer = normalizeTradeOffer(
      offerFixture({ incomingPlayerIds: [4259545, -16021] }),
    );
    expect(offer.incomingPlayerIds).toEqual(["4259545", "-16021"]);
  });

  it.each([
    ["an empty side", { incomingPlayerIds: [] }, /incomingPlayerIds/],
    ["a non-numeric id", { outgoingPlayerIds: ["abc"] }, /not a valid numeric ESPN player id/],
    ["-0", { outgoingPlayerIds: ["-0"] }, /not a valid numeric ESPN player id/],
    ["an id on both sides", { outgoingPlayerIds: ["4259545"] }, /both sides/],
    ["a duplicate id on one side", { outgoingPlayerIds: ["15847", "15847"] }, /more than once/],
    ["trading with ourselves", { toTeamId: "8" }, /own team/],
    ["a missing toTeamId", { toTeamId: "" }, /toTeamId/],
  ])("rejects %s as a PermanentError", (_label, overrides, message) => {
    expect(() => normalizeTradeOffer(offerFixture(overrides))).toThrow(message);
    try {
      normalizeTradeOffer(offerFixture(overrides));
    } catch (error) {
      expect(error.permanent).toBe(true);
    }
  });
});

describe("buildTradeBuilderUrl", () => {
  it("puts the other manager in teamId and us in fromTeamId", () => {
    expect(buildTradeBuilderUrl(offerFixture())).toBe(
      "https://fantasy.espn.com/football/team/trade?leagueId=1234567890&teamId=3&fromTeamId=8&seasonId=2026",
    );
  });
});

describe("installWriteGuard", () => {
  it("aborts non-GET ESPN requests until allowWrites() and lets everything else through", async () => {
    const { page, state } = makeBuilderPage([]);
    const guard = await installWriteGuard(page);
    const [handler] = state.routeHandlers;

    const post = fakeRoute(
      "POST",
      "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1/transactions/",
    );
    await handler(post);
    expect(post.abort).toHaveBeenCalled();
    expect(post.continue).not.toHaveBeenCalled();

    const get = fakeRoute("GET", "https://lm-api-reads.fantasy.espn.com/x");
    await handler(get);
    expect(get.continue).toHaveBeenCalled();

    const preflight = fakeRoute("OPTIONS", "https://lm-api-writes.fantasy.espn.com/x");
    await handler(preflight);
    expect(preflight.continue).toHaveBeenCalled();

    const thirdParty = fakeRoute("POST", "https://analytics.example.com/collect");
    await handler(thirdParty);
    expect(thirdParty.continue).toHaveBeenCalled();

    expect(guard.blocked).toHaveLength(1);

    guard.allowWrites();
    const later = fakeRoute("POST", "https://lm-api-writes.fantasy.espn.com/x");
    await handler(later);
    expect(later.continue).toHaveBeenCalled();
    expect(guard.allowed).toHaveLength(1);
  });
});

describe("isTradeProposalResponse", () => {
  const WRITES =
    "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1234567890/transactions/";
  const response = (url, method, postData) => ({
    url: () => url,
    request: () => ({ method: () => method, postData: () => postData }),
  });
  const offer = normalizeTradeOffer(offerFixture());

  it("matches our TRADE_PROPOSAL POST, with or without ESPN's platformVersion query", () => {
    expect(isTradeProposalResponse(response(WRITES, "POST", proposalPostData()), offer)).toBe(true);
    expect(
      isTradeProposalResponse(response(`${WRITES}?platformVersion=35f16ade`, "POST", proposalPostData()), offer),
    ).toBe(true);
  });

  it("ignores other transactions, other teams' proposals, other methods/hosts and unreadable bodies", () => {
    const cases = [
      response(WRITES, "POST", proposalPostData(offerFixture(), { type: "ROSTER" })),
      response(WRITES, "POST", proposalPostData(offerFixture(), { teamId: 3 })),
      response(WRITES, "GET", proposalPostData()),
      response(WRITES.replace("lm-api-writes", "lm-api-reads"), "POST", proposalPostData()),
      response(`${WRITES}123`, "POST", proposalPostData()),
      response(WRITES, "POST", "not json"),
      response(WRITES, "POST", null),
    ];
    for (const c of cases) expect(isTradeProposalResponse(c, offer)).toBe(false);
  });
});

describe("fillTradeBuilder", () => {
  const names = {
    incoming: rosterFor(THEIR_ROWS).nameByPlayerId,
    outgoing: rosterFor(OUR_ROWS).nameByPlayerId,
  };

  it("checks exactly the requested players on both sides, multi-player both ways", async () => {
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    const result = await fillTradeBuilder(page, offerFixture(), names);

    expect(state.gotoUrls).toEqual([buildTradeBuilderUrl(offerFixture())]);
    const checked = state.rows.filter((r) => r.checked).map((r) => r.id).sort();
    expect(checked).toEqual(["-16021", "15847", "3139477", "4259545", "4362628"].sort());
    expect(result.resolvedBy).toMatchObject({ "-16021": "name", "4259545": "headshot" });
    expect(state.clicks.every((c) => c.startsWith("check:"))).toBe(true);
  });

  it("fills anyway when the page never goes network-idle", async () => {
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    const idleTimeout = Object.assign(new Error("Timeout 20000ms exceeded."), { name: "TimeoutError" });
    page.waitForLoadState.mockRejectedValue(idleTimeout);

    await fillTradeBuilder(page, offerFixture(), names);

    expect(page.goto).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ waitUntil: "domcontentloaded" }));
    expect(state.rows.filter((r) => r.checked)).toHaveLength(5);
    expect(logger.warn).toHaveBeenCalledWith(
      "[Trade Builder] Trade builder never went network-idle; continuing once rows load",
    );
  });

  it("still raises a non-timeout load-state error", async () => {
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    page.waitForLoadState.mockRejectedValue(new Error("Target page has been closed"));

    await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toThrow("Target page has been closed");
    expect(state.rows.some((r) => r.checked)).toBe(false);
  });

  describe("when the first click is swallowed", () => {
    const withRow = (id, patch) =>
      [...THEIR_ROWS, ...OUR_ROWS].map((r) => (r.id === id ? { ...r, ...patch } : r));

    it("retries the check, warns, and succeeds", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { failFirstChecks: 1 }));
      await fillTradeBuilder(page, offerFixture(), names);
      expect(state.rows.find((r) => r.id === "4259545").checked).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        "[Trade Builder] Checkbox click was ignored; retrying",
        expect.objectContaining({ playerId: "4259545", attempt: 1 }),
      );
    });


    it("does not retry other errors", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { checkError: "element is detached" }));
      await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toThrow("element is detached");
      expect(logger.warn).not.toHaveBeenCalledWith(
        "[Trade Builder] Checkbox click was ignored; retrying",
        expect.anything(),
      );
      expect(state.rows.some((r) => r.checked)).toBe(false);
    });
  });

  describe("when a fresh session ignores every click for a while", () => {
    const withRow = (id, patch) =>
      [...THEIR_ROWS, ...OUR_ROWS].map((r) => (r.id === id ? { ...r, ...patch } : r));
    // Runs the fill under fake timers, letting every backoff elapse instantly.
    async function settle(promise) {
      const outcome = promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await jest.runAllTimersAsync();
      return outcome;
    }
    const reloadWarnings = () =>
      logger.warn.mock.calls.filter(([msg]) => /reloading the trade builder/.test(msg));

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("reloads and re-fills from scratch, then succeeds", async () => {
      // Ignored on the first load, fine from the second.
      const { page, state } = makeBuilderPage(withRow("4259545", { ignoreUntilLoad: 2 }));
      const startedAt = Date.now();
      const { value, error } = await settle(
        fillTradeBuilder(page, offerFixture(), names, { sessionStartedAt: startedAt }),
      );
      expect(error).toBeUndefined();
      expect(value.resolvedBy).toBeDefined();
      expect(state.gotoUrls).toEqual(Array(2).fill(buildTradeBuilderUrl(offerFixture())));
      expect(state.rows.filter((r) => r.checked)).toHaveLength(5);
      expect(reloadWarnings()).toHaveLength(1);
      expect(reloadWarnings()[0][1]).toMatchObject({
        playerId: "4259545",
        attempt: 1,
        waitMs: 5000,
        sessionAgeMs: expect.any(Number),
      });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("raises a selection rejection once every full attempt is ignored", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { failFirstChecks: 999 }));
      const { error } = await settle(fillTradeBuilder(page, offerFixture(), names));
      expect(error).toMatchObject({
        permanent: true,
        classification: "espn_selection_rejected",
        playerId: "4259545",
      });
      // 1 initial fill + one per backoff, each with the quick 3 tries per box.
      expect(state.gotoUrls).toHaveLength(4);
      expect(state.rows.find((r) => r.id === "4259545").checkAttempts).toBe(12);
      expect(reloadWarnings().map(([, ctx]) => ctx.waitMs)).toEqual([5000, 10000, 15000]);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("does not back off once the session is too old for warm-up to be the cause", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { failFirstChecks: 999 }));
      const { error } = await settle(
        fillTradeBuilder(page, offerFixture(), names, { sessionStartedAt: Date.now() - 60000 }),
      );
      expect(error).toMatchObject({ classification: "espn_selection_rejected" });
      expect(state.gotoUrls).toHaveLength(1);
      expect(reloadWarnings()).toHaveLength(0);
    });

    it("does not reload for other errors", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { checkError: "element is detached" }));
      const { error } = await settle(fillTradeBuilder(page, offerFixture(), names));
      expect(error.message).toMatch(/element is detached/);
      expect(state.gotoUrls).toHaveLength(1);
      expect(reloadWarnings()).toHaveLength(0);
    });

    it("does not reload when a row cannot be resolved", async () => {
      const { page, state } = makeBuilderPage(OUR_ROWS);
      const { error } = await settle(fillTradeBuilder(page, offerFixture(), names));
      expect(error).toMatchObject({ permanent: true });
      expect(state.gotoUrls).toHaveLength(1);
    });

    it("never lifts the write guard or clicks anything while retrying", async () => {
      const { page, state } = makeBuilderPage(withRow("4259545", { ignoreUntilLoad: 3 }));
      const guard = await installWriteGuard(fakeContext(page));
      const allow = jest.spyOn(guard, "allowWrites");
      const { error } = await settle(fillTradeBuilder(page, offerFixture(), names));
      expect(error).toBeUndefined();
      expect(allow).not.toHaveBeenCalled();
      expect(guard.writesAllowed).toBe(false);
      expect(state.clicks.every((c) => c.startsWith("check:"))).toBe(true);
    });

    it("a live submit still claims and sends once after a retried fill", async () => {
      armForLiveSubmit();
      const { page, state } = makeBuilderPage(withRow("4259545", { ignoreUntilLoad: 2 }));
      const browser = useSession(page);
      const offer = offerFixture();
      const { value, error } = await settle(
        submitTradeOffer(offer, { approval: approvalFor(offer), trackingId: "t-warm" }),
      );
      expect(error).toBeUndefined();
      expect(value).toMatchObject({ status: "submitted" });
      expect(state.gotoUrls).toHaveLength(2);
      expect(state.clicks.filter((c) => c === "submit")).toHaveLength(1);
      expect(claimTradeSubmission).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalled();
    });
  });

  describe("when ESPN refuses a selection", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    const refusing = (id) => [...THEIR_ROWS, ...OUR_ROWS].map((r) => (r.id === id ? { ...r, refuses: true } : r));

    it("classifies it, keeps ESPN's reason and logs the row at error level", async () => {
      const { page, state } = makeBuilderPage(refusing("4259545"));
      state.evaluate = async () => ({
        signals: ["title: Player is locked", "page message: Trade not allowed"],
        rowHtml: '<tr class="Table__TR"><span role="checkbox" aria-checked="false"></span></tr>',
        visibleText: "Trade not allowed",
      });
      await expect(drain(fillTradeBuilder(page, offerFixture(), names))).rejects.toMatchObject({
        permanent: true,
        classification: "espn_selection_rejected",
        playerId: "4259545",
        reason: "title: Player is locked; page message: Trade not allowed",
        capture: { rowHtml: expect.stringContaining('role="checkbox"'), visibleText: "Trade not allowed" },
      });
      expect(logger.error).toHaveBeenCalledWith(
        "[Trade Builder] ESPN did not toggle a player's checkbox",
        expect.objectContaining({
          playerId: "4259545",
          rowHtml: expect.stringContaining("Table__TR"),
          visibleText: "Trade not allowed",
        }),
      );
    });

    it("reports unknown when the page shows nothing, and still logs", async () => {
      const { page } = makeBuilderPage(refusing("4259545"));
      await expect(drain(fillTradeBuilder(page, offerFixture(), names))).rejects.toMatchObject({
        classification: "espn_selection_rejected",
        reason: "unknown",
      });
      expect(logger.error).toHaveBeenCalled();
    });

    it("still classifies it when reading the row fails", async () => {
      const { page, state } = makeBuilderPage(refusing("4259545"));
      state.evaluate = async () => {
        throw new Error("Element is not attached to the DOM");
      };
      await expect(drain(fillTradeBuilder(page, offerFixture(), names))).rejects.toMatchObject({
        classification: "espn_selection_rejected",
        reason: "unknown",
      });
    });
  });

  it("fails closed when a player's row cannot be found", async () => {
    const { page, state } = makeBuilderPage(OUR_ROWS); // their table never rendered
    await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/4259545/),
    });
    expect(state.clicks).toEqual([]);
  });

  it("fails closed when a name fallback matches more than one row", async () => {
    const rows = [
      ...THEIR_ROWS,
      ...OUR_ROWS,
      { team: "8", id: "999", headshotId: "999", name: "Eagles" },
    ];
    const { page } = makeBuilderPage(rows);
    await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/2 rows/),
    });
  });

  it("fails when more boxes end up checked than were requested", async () => {
    const rows = [...THEIR_ROWS, ...OUR_ROWS].map((r) =>
      r.id === "2976499" ? { ...r, checked: true } : r,
    );
    const { page } = makeBuilderPage(rows);
    await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/6 checked, expected 5/),
    });
  });
});

describe("submitTradeOffer: dry run", () => {
  it.each([
    ["DRY_RUN unset", () => {}],
    ["TRADE_SUBMIT_ENABLED unset", () => {
      process.env.DRY_RUN = "false";
    }],
    ["selectors unverified", () => {
      process.env.DRY_RUN = "false";
      process.env.TRADE_SUBMIT_ENABLED = "true";
      // The real file has them verified since #123; simulate a key being demoted again.
      SELECTORS._verified.keys = savedVerifiedKeys.filter((k) => k !== "trade_submit_button");
    }],
  ])("with %s, fills and screenshots but never clicks Continue or submit", async (_label, setup) => {
    setup();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    const browser = useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, {
      approval: approvalFor(offer),
      source: "proposal",
      trackingId: "t-1",
    });

    expect(result).toMatchObject({ status: "submit_blocked", dryRun: true });
    expect(state.clicks).not.toContain("continue");
    expect(state.clicks).not.toContain("submit");
    expect(page.route).toHaveBeenCalled();
    expect(captureDebugSnapshot).toHaveBeenCalledWith(
      page,
      `trade-offer-${computeOfferKey(offer)}`,
    );
    expect(claimTradeSubmission).not.toHaveBeenCalled();
    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({ status: "submit_blocked", dryRun: true }),
    );
    // Already approved: nothing for the phone to ask about.
    expect(notify).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it("without an approval, records awaiting_approval even when fully armed", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);

    const result = await submitTradeOffer(offerFixture(), { source: "counter_offer" });

    expect(result).toMatchObject({ status: "awaiting_approval", dryRun: true });
    expect(state.clicks).not.toContain("submit");
    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({ status: "awaiting_approval", offerKey: computeOfferKey(offerFixture()) }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Counter-offer ready for approval",
        path: `/trades?offer=${computeOfferKey(offerFixture())}`,
      }),
    );
  });

  it("persists a proposal's evaluation on the staged row without changing its offer_key", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const evaluation = { version: "proposal-evaluation-v1", score: { score: { final_score: null } } };

    const result = await submitTradeOffer(offerFixture(), { source: "proposal", evaluation });

    expect(result).toMatchObject({
      status: "awaiting_approval",
      dryRun: true,
      offerKey: computeOfferKey(offerFixture()),
    });
    expect(state.clicks).not.toContain("submit");
    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({ status: "awaiting_approval", source: "proposal", evaluation }),
    );
  });

  it("ignores an evaluation on anything but a generated proposal", async () => {
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);

    await submitTradeOffer(offerFixture(), { source: "counter_offer", evaluation: { version: "x" } });

    expect(recordTradeOfferFill.mock.calls[0][0]).not.toHaveProperty("evaluation");
  });

  it("rejects ids that aren't on the expected rosters before opening the builder", async () => {
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);

    await expect(
      submitTradeOffer(offerFixture({ incomingPlayerIds: ["3139477"], outgoingPlayerIds: ["15847"] }), {}),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/3139477.*team 3/) });
    expect(state.gotoUrls).toEqual([]);
  });

  it("reuses a caller-provided session without closing it", async () => {
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    const browser = { close: jest.fn() };

    await submitTradeOffer(offerFixture(), {
      session: { page, context: fakeContext(page), browser },
    });

    expect(createAuthenticatedSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
  });
});

describe("submitTradeOffer: TRADE_DRY_RUN", () => {
  function armWithTradeDryRun() {
    armForLiveSubmit();
    delete process.env.DRY_RUN;
    process.env.TRADE_DRY_RUN = "false";
  }

  it("goes live with TRADE_DRY_RUN=false and TRADE_SUBMIT_ENABLED=true while DRY_RUN is unset", async () => {
    armWithTradeDryRun();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer), source: "proposal" });

    expect(result).toMatchObject({ dryRun: false });
    expect(result.closedLocks).toEqual([]);
    expect(state.clicks).toContain("submit");
  });

  it("stays dry with TRADE_DRY_RUN=false when TRADE_SUBMIT_ENABLED is not true", async () => {
    armWithTradeDryRun();
    delete process.env.TRADE_SUBMIT_ENABLED;
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer), source: "proposal" });

    expect(result).toMatchObject({ status: "submit_blocked", dryRun: true });
    expect(result.closedLocks).toEqual(["TRADE_SUBMIT_ENABLED is not true"]);
    expect(state.clicks).not.toContain("submit");
  });

  it("lets TRADE_DRY_RUN=true override DRY_RUN=false", async () => {
    armForLiveSubmit();
    process.env.TRADE_DRY_RUN = "true";
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer), source: "proposal" });

    expect(result).toMatchObject({ status: "submit_blocked", dryRun: true });
    expect(result.closedLocks).toEqual(["TRADE_DRY_RUN is not explicitly false"]);
    expect(state.clicks).not.toContain("submit");
  });

  it("does a dry fill when both are unset and names both variables", async () => {
    armForLiveSubmit();
    delete process.env.DRY_RUN;
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer), source: "proposal" });

    expect(result).toMatchObject({ status: "submit_blocked", dryRun: true });
    expect(result.closedLocks).toEqual(["TRADE_DRY_RUN and DRY_RUN are unset (dry run by default)"]);
    expect(state.clicks).not.toContain("submit");
  });

  it("names DRY_RUN when it decided the lock", async () => {
    armForLiveSubmit();
    process.env.DRY_RUN = "true";
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer), source: "proposal" });

    expect(result.closedLocks).toEqual(["DRY_RUN is not explicitly false (TRADE_DRY_RUN unset)"]);
  });
});

describe("submitTradeOffer: approval gate", () => {
  it("rejects an approval whose offer_key doesn't match the offer, clicking nothing", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const approvedOffer = offerFixture();
    const changedOffer = offerFixture({ outgoingPlayerIds: ["3139477", "4362628"] });

    await expect(
      submitTradeOffer(changedOffer, { approval: approvalFor(approvedOffer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/offer_key/) });
    expect(state.clicks).toEqual([]);
    expect(createAuthenticatedSession).not.toHaveBeenCalled();
  });

  it("rejects an approval with no approved_by", async () => {
    armForLiveSubmit();
    const offer = offerFixture();
    await expect(
      submitTradeOffer(offer, { approval: { offer_key: computeOfferKey(offer) } }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/approved_by/) });
  });

  it("with all locks open, clicks submit exactly once and finalizes submitted", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, {
      approval: approvalFor(offer),
      source: "counter_offer",
      trackingId: "t-2",
    });

    expect(result).toMatchObject({ status: "submitted", dryRun: false });
    expect(state.clicks.filter((c) => c === "submit")).toHaveLength(1);
    expect(state.clicks.indexOf("continue")).toBeLessThan(state.clicks.indexOf("submit"));
    expect(claimTradeSubmission).toHaveBeenCalledWith(
      computeOfferKey(offer),
      expect.objectContaining({ approvedBy: "conor", source: "counter_offer" }),
    );
    // The claim must be durable before the irreversible click.
    expect(claimTradeSubmission.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeTradeSubmission.mock.invocationCallOrder[0],
    );
    expect(finalizeTradeSubmission).toHaveBeenCalledWith(42, "submitted", undefined);
    // The click path's real body is checked against the inferred REST body (#124).
    expect(captureWriteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "trade_proposal", bodyMismatches: [] }),
    );
  });

  it("records, without failing the submit, where ESPN's real body differs from the inferred one", async () => {
    armForLiveSubmit();
    const offer = offerFixture();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], {
      submitPostData: proposalPostData(offer, { executionType: "PROPOSE", comment: undefined }),
    });
    useSession(page);

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(result.status).toBe("submitted");
    const [artifact] = captureWriteArtifact.mock.calls.at(-1);
    expect(artifact.bodyMismatches).toEqual(
      expect.arrayContaining([expect.stringMatching(/executionType/), expect.stringMatching(/comment/)]),
    );
  });

  it("attaches a message when the review screen has a note field", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture({ message: "Let's deal" });

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(state.filledMessage).toBe("Let's deal");
    expect(result.messageAttached).toBe(true);
  });

  it("rejects an approval for the same trade carrying a different note", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const reviewed = offerFixture();

    await expect(
      submitTradeOffer(offerFixture({ message: "unreviewed text" }), {
        approval: approvalFor(reviewed),
      }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/offer_key/) });
    expect(state.clicks).toEqual([]);
  });

  it("ignores blocked analytics beacons but refuses if a trade write fired before submit", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();
    // Fire requests through the installed guard as the page loads.
    page.goto.mockImplementation(async () => {
      const [handler] = state.routeHandlers;
      // Adobe beacons name the trade page in their query string.
      await handler(
        fakeRoute(
          "POST",
          "https://sw88.espn.com/b/ss/wdgespcom,wdgespge/1/JS-2.27.0/s1?pageName=fantasy%3Afootball%3Aleague%3Ateamtrade" +
            "&pageUrl=https%3A%2F%2Ffantasy.espn.com%2Ffootball%2Fteam%2Ftrade%3FleagueId%3D1",
        ),
      );
      await handler(fakeRoute("POST", "https://go.web.plus.espn.com/xur/9070"));
    });

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).resolves.toMatchObject({ status: "submitted" });

    const second = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(second.page);
    second.page.goto.mockImplementation(async () => {
      const [handler] = second.state.routeHandlers;
      await handler(
        fakeRoute("POST", "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/x/transactions/"),
      );
    });
    findTradeSubmission.mockResolvedValue(null);

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/trade write/) });
    expect(second.state.clicks).not.toContain("submit");
  });

  it("treats a throwing submit click as an unknown outcome, not a retry", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitClickThrows: true });
    useSession(page);
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/outcome unknown/i) });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("finalizes failure and throws permanent on a 4xx rejection from ESPN", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], {
      submitResponse: { status: 409, body: "TRADE_DEADLINE_PASSED" },
    });
    useSession(page);
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/409/) });
    expect(finalizeTradeSubmission).toHaveBeenCalledWith(42, "failure", expect.stringMatching(/409/));
  });

  it("leaves the claim as submitting and fails closed when the outcome is unknown", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitResponse: null });
    useSession(page);
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/not among ESPN's pending trades.*outcome unknown/i),
    });
    expect(readPendingTrades).toHaveBeenCalledTimes(1);
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it.each([
    ["no response was seen", { submitResponse: null }],
    ["ESPN answered 5xx", { submitResponse: { status: 503, body: "busy" } }],
    ["the click threw", { submitClickThrows: true }],
  ])("confirms an unknown outcome (%s) by finding the offer among pending trades", async (_label, opts) => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], opts);
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockResolvedValue(pendingRead([
      pendingProposal(offer, { id: "other", proposingTeamId: "3" }),
      pendingProposal(offer),
    ]));

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(result).toMatchObject({
      status: "submitted",
      confirmedBy: "pending_read",
      transactionId: "tx-1",
    });
    expect(readPendingTrades).toHaveBeenCalledWith(expect.anything(), {
      leagueId: "1234567890",
      seasonId: "2026",
      teamId: "8",
    });
    expect(finalizeTradeSubmission).toHaveBeenCalledWith(42, "submitted", undefined);
    expect(state.clicks.filter((c) => c === "submit")).toHaveLength(1);
  });

  it("does not count a pending trade with a different set of players as ours", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitResponse: null });
    useSession(page);
    const offer = offerFixture();
    const partial = pendingProposal(offer);
    partial.items = partial.items.slice(1);
    const reversed = pendingProposal(offerFixture({
      incomingPlayerIds: offer.outgoingPlayerIds,
      outgoingPlayerIds: offer.incomingPlayerIds,
    }));
    const otherTeam = pendingProposal(offerFixture({ toTeamId: "5" }));
    readPendingTrades.mockResolvedValue(pendingRead([partial, reversed, otherTeam]));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/outcome unknown/i) });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  // Code review on #127: a different offer for the same players (an older send, or another note,
  // which is another offer_key) must never confirm this one.
  it.each([
    ["was proposed before this attempt's claim", { proposedDate: Date.now() - 10 * 60000 }],
    ["has no proposedDate", { proposedDate: undefined }],
    ["carries a different note", { comment: "an older note" }],
  ])("does not confirm with a matching trade that %s", async (_label, overrides) => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitResponse: null });
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockResolvedValue(pendingRead([pendingProposal(offer, overrides)]));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/outcome unknown/i) });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("confirms when ESPN's listed comment is the note that was attached", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitResponse: null });
    useSession(page);
    const offer = offerFixture({ message: "Let's deal" });
    readPendingTrades.mockResolvedValue(pendingRead([pendingProposal(offer, { comment: "Let's deal" })]));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).resolves.toMatchObject({ status: "submitted", confirmedBy: "pending_read" });
  });

  it("still fails closed when the confirming pending-trades read itself fails", async () => {
    armForLiveSubmit();
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS], { submitResponse: null });
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockRejectedValue(new Error("HTTP 500"));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/read also failed.*HTTP 500.*outcome unknown/i),
    });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("never clicks submit when the DB claim itself fails", async () => {
    armForLiveSubmit();
    claimTradeSubmission.mockRejectedValue(new Error("connection refused"));
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    await expect(submitTradeOffer(offer, { approval: approvalFor(offer) })).rejects.toThrow(
      /connection refused/,
    );
    expect(state.clicks).not.toContain("submit");
  });
});

describe("submitTradeOffer: redelivery", () => {
  it("is a no-op once the offer is recorded as submitted", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({ id: 7, status: "submitted" });
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(result).toMatchObject({ status: "already_submitted" });
    expect(createAuthenticatedSession).not.toHaveBeenCalled();
    expect(claimTradeSubmission).not.toHaveBeenCalled();
  });

  it("fails closed without clicking when a previous attempt's outcome is unknown", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({ id: 7, status: "submitting" });
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    const browser = useSession(page);
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/verify in ESPN/i) });
    expect(state.gotoUrls).toEqual([]);
    expect(state.clicks).toEqual([]);
    expect(claimTradeSubmission).not.toHaveBeenCalled();
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it("settles a stuck 'submitting' row as submitted when ESPN lists the offer as pending", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({
      id: 7,
      status: "submitting",
      executed_at: new Date(Date.now() - 60000),
    });
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockResolvedValue(pendingRead([pendingProposal(offer)]));

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(result).toMatchObject({ status: "already_submitted", confirmedBy: "pending_read" });
    expect(finalizeTradeSubmission).toHaveBeenCalledWith(7, "submitted", undefined);
    expect(state.gotoUrls).toEqual([]);
    expect(state.clicks).toEqual([]);
  });

  it("does not settle a stuck row with a matching trade proposed before that row's claim", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({ id: 7, status: "submitting", executed_at: new Date() });
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockResolvedValue(pendingRead([
      pendingProposal(offer, { proposedDate: Date.now() - 10 * 60000 }),
    ]));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/verify in ESPN/i) });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("does not settle a stuck row whose claim time is unknown", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({ id: 7, status: "submitting", executed_at: null });
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();
    readPendingTrades.mockResolvedValue(pendingRead([pendingProposal(offer)]));

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/verify in ESPN/i) });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("fails closed on a stuck row when the pending-trades read fails", async () => {
    armForLiveSubmit();
    findTradeSubmission.mockResolvedValue({ id: 7, status: "submitting" });
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    readPendingTrades.mockRejectedValue(new Error("HTTP 500"));
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/HTTP 500/) });
    expect(state.clicks).toEqual([]);
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();
  });

  it("does not click when the atomic claim finds another attempt got there first", async () => {
    armForLiveSubmit();
    claimTradeSubmission.mockResolvedValue({ claimed: false, existing: "submitted" });
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, { approval: approvalFor(offer) });

    expect(result.status).toBe("already_submitted");
    expect(state.clicks).not.toContain("submit");
  });

  it("delivering the same approved message twice submits exactly once", async () => {
    armForLiveSubmit();
    const offer = offerFixture();
    const rows = [...THEIR_ROWS, ...OUR_ROWS];
    const first = makeBuilderPage(rows);
    const second = makeBuilderPage(rows);
    createSessionFromStoredState.mockResolvedValue(null);
    createAuthenticatedSession
      .mockResolvedValueOnce({ page: first.page, context: fakeContext(first.page), browser: { close: jest.fn() } })
      .mockResolvedValueOnce({ page: second.page, context: fakeContext(second.page), browser: { close: jest.fn() } });

    // Stand-in for execution_log: the first run's claim/finalize is what the second run reads.
    const ledger = new Map();
    findTradeSubmission.mockImplementation(async (key) => ledger.get(key) ?? null);
    claimTradeSubmission.mockImplementation(async (key) => {
      if (ledger.has(key)) return { claimed: false, existing: ledger.get(key).status };
      ledger.set(key, { id: 1, status: "submitting" });
      return { claimed: true, id: 1 };
    });
    finalizeTradeSubmission.mockImplementation(async (_id, status) => {
      ledger.set(computeOfferKey(offer), { id: 1, status });
    });

    const payload = {
      tracking_id: "t-3",
      season: 2026,
      to_team_id: "3",
      incoming_player_ids: offer.incomingPlayerIds,
      outgoing_player_ids: offer.outgoingPlayerIds,
      approval: approvalFor(offer),
    };
    await expect(executeTradeSubmission(payload)).resolves.toMatchObject({ status: "submitted" });
    await expect(executeTradeSubmission(payload)).resolves.toMatchObject({
      status: "already_submitted",
    });

    expect(first.state.clicks.filter((c) => c === "submit")).toHaveLength(1);
    expect(second.state.clicks).toEqual([]);
  });
});

describe("submitTradeOffer: counter linkage", () => {
  afterEach(() => jest.useRealTimers());

  const espnApi = require("../../src/bots/espn_api");
  const linked = (overrides) =>
    offerFixture({ relatedTransactionId: "tx-3", threadRootId: "tx-1", ...overrides });

  afterEach(() => {
    espnApi.COUNTER_LINKAGE_VERIFIED = false;
  });

  it("stages a counter with its link recorded, and nothing sent", async () => {
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);

    const result = await submitTradeOffer(linked(), { source: "counter_offer" });

    expect(result).toMatchObject({ status: "awaiting_approval", dryRun: true });
    expect(state.clicks).not.toContain("submit");
    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({ relatedTransactionId: "tx-3", threadRootId: "tx-1" }),
    );
  });

  it("keeps a refused selection's evidence in the failure row, since disk captures vanish with the pod", async () => {
    jest.useFakeTimers();
    const rows = [...THEIR_ROWS, ...OUR_ROWS].map((r) => (r.id === "4259545" ? { ...r, refuses: true } : r));
    const { page, state } = makeBuilderPage(rows);
    state.evaluate = async () => ({ signals: ["title: Locked"], rowHtml: "<tr>row</tr>", visibleText: "" });
    useSession(page);

    await expect(drain(submitTradeOffer(offerFixture(), { source: "proposal" }))).rejects.toMatchObject({
      classification: "espn_selection_rejected",
    });

    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        failure: expect.objectContaining({
          classification: "espn_selection_rejected",
          reason: "title: Locked",
          rowHtml: "<tr>row</tr>",
        }),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[Trade Builder] ESPN did not toggle a player's checkbox",
      expect.objectContaining({ rowHtml: "<tr>row</tr>" }),
    );
  });

  it("keeps an approved counter blocked until ESPN's counter linkage is verified", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = linked();

    const result = await submitTradeOffer(offer, { approval: approvalFor(normalizeTradeOffer(offer)) });

    expect(result).toMatchObject({ status: "submit_blocked", dryRun: true });
    expect(result.closedLocks).toEqual([expect.stringMatching(/counter linkage/)]);
    expect(state.clicks).not.toContain("continue");
    expect(claimTradeSubmission).not.toHaveBeenCalled();
  });

  it("rejects an approval for the same players that countered a different offer", async () => {
    armForLiveSubmit();
    const reviewed = normalizeTradeOffer(linked({ relatedTransactionId: "tx-2" }));

    await expect(submitTradeOffer(linked(), { approval: approvalFor(reviewed) })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(/offer_key/),
    });
  });

  it("settles a stuck counter only from a pending offer ESPN links to the countered one", async () => {
    armForLiveSubmit();
    espnApi.COUNTER_LINKAGE_VERIFIED = true;
    findTradeSubmission.mockResolvedValue({
      id: 7,
      status: "submitting",
      executed_at: new Date(Date.now() - 60000),
    });
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = linked();
    const approval = approvalFor(normalizeTradeOffer(offer));

    readPendingTrades.mockResolvedValue(pendingRead([pendingProposal(offer)]));
    await expect(submitTradeOffer(offer, { approval })).rejects.toMatchObject({ permanent: true });
    expect(finalizeTradeSubmission).not.toHaveBeenCalled();

    readPendingTrades.mockResolvedValue(
      pendingRead([pendingProposal(offer, { id: "tx-9", relatedTransactionId: "tx-3" })]),
    );
    await expect(submitTradeOffer(offer, { approval })).resolves.toMatchObject({
      status: "already_submitted",
      transactionId: "tx-9",
    });
    expect(finalizeTradeSubmission).toHaveBeenCalledWith(7, "submitted", undefined);
  });

  it("passes a trade_submissions payload's linkage into the offer", async () => {
    const { page } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);

    await executeTradeSubmission({
      season: 2026,
      to_team_id: "3",
      incoming_player_ids: ["4259545"],
      outgoing_player_ids: ["3139477"],
      source: "counter_offer",
      related_transaction_id: "tx-3",
      thread_root_id: "tx-1",
    });

    expect(recordTradeOfferFill).toHaveBeenCalledWith(
      expect.objectContaining({ relatedTransactionId: "tx-3", threadRootId: "tx-1" }),
    );
  });
});

describe("executeTradeSubmission payload validation", () => {
  it.each([
    ["null", null, /JSON object/],
    ["a missing to_team_id", { season: 2026, incoming_player_ids: ["1"], outgoing_player_ids: ["2"] }, /to_team_id/],
    ["a non-integer season", { season: "2026", to_team_id: "3", incoming_player_ids: ["1"], outgoing_player_ids: ["2"] }, /season/],
    ["a non-object approval", { season: 2026, to_team_id: "3", incoming_player_ids: ["1"], outgoing_player_ids: ["2"], approval: "yes" }, /approval/],
  ])("rejects %s as permanent", async (_label, payload, message) => {
    await expect(executeTradeSubmission(payload)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(message),
    });
  });

  it("requires ESPN_LEAGUE_ID and ESPN_TEAM_ID", async () => {
    delete process.env.ESPN_TEAM_ID;
    await expect(
      executeTradeSubmission({ season: 2026, to_team_id: "3", incoming_player_ids: ["1"], outgoing_player_ids: ["2"] }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/ESPN_TEAM_ID/) });
  });
});
