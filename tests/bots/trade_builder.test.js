jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/espn_api");
jest.mock("../../src/bots/debug_capture");
jest.mock("../../src/db/execution_log");

const {
  createAuthenticatedSession,
  createSessionFromStoredState,
} = require("../../src/bots/auth");
const { readRoster } = require("../../src/bots/espn_api");
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
  fillTradeBuilder,
  submitTradeOffer,
  executeTradeSubmission,
  TRADE_SUBMIT_SELECTOR_KEYS,
} = require("../../src/bots/trade_builder");

const ENV_KEYS = [
  "DRY_RUN",
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
  { team: "3", id: "-16021", headshotId: null, name: "Eagles D/ST" },
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
    leagueId: "1248158344",
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
    nameByPlayerId: new Map(rows.map((r) => [r.id, r.name])),
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
function makeBuilderPage(rows, { submitResponse = { status: 200, body: "{}" } } = {}) {
  const state = {
    rows: rows.map((r) => ({ checked: false, ...r })),
    clicks: [],
    routeHandlers: [],
    gotoUrls: [],
    filledMessage: null,
  };
  let pendingResponse = null;

  const checkboxLocator = (set) => ({
    check: async () => {
      if (set.length !== 1) {
        throw new Error(`strict mode violation: ${set.length} elements`);
      }
      set[0].checked = true;
      state.clicks.push(`check:${set[0].id}`);
    },
    isChecked: async () => set.length === 1 && set[0].checked,
  });

  const rowsLocator = (set) => ({
    filter: ({ has, hasText }) => {
      if (has) {
        return rowsLocator(
          set.filter((r) => r.headshotId !== null && r.headshotId === has.__headshotId),
        );
      }
      return rowsLocator(set.filter((r) => hasText.test(r.name)));
    },
    count: async () => set.length,
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
        if (name === "submit" && pendingResponse) {
          const { resolve, reject } = pendingResponse;
          pendingResponse = null;
          if (submitResponse === null) {
            reject(new Error("Timeout 30000ms exceeded while waiting for event \"response\""));
          } else {
            resolve({
              url: () =>
                "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1248158344/transactions/",
              status: () => submitResponse.status,
              ok: () => submitResponse.status >= 200 && submitResponse.status < 300,
              text: async () => submitResponse.body,
              request: () => ({ method: () => "POST", postData: () => '{"type":"TRADE_PROPOSAL"}' }),
            });
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
    }),
    waitForSelector: jest.fn(async () => {}),
    route: jest.fn(async (_pattern, handler) => {
      state.routeHandlers.push(handler);
    }),
    waitForResponse: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          pendingResponse = { resolve, reject };
        }),
    ),
    locator: jest.fn((sel) => {
      if (sel === SELECTORS.trade_player_row) return rowsLocator(state.rows);
      if (sel === SELECTORS.trade_checked_checkbox) {
        return { count: async () => state.rows.filter((r) => r.checked).length };
      }
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

function fakeRoute(method, url) {
  return {
    request: () => ({ method: () => method, url: () => url, postData: () => null }),
    abort: jest.fn(async () => {}),
    continue: jest.fn(async () => {}),
  };
}

function useSession(page) {
  const browser = { close: jest.fn(async () => {}) };
  createSessionFromStoredState.mockResolvedValue(null);
  createAuthenticatedSession.mockResolvedValue({ page, context: {}, browser });
  return browser;
}

function mockRosters() {
  readRoster.mockImplementation(async (_context, { teamId }) =>
    rosterFor(teamId === "3" ? THEIR_ROWS : OUR_ROWS),
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
  delete process.env.TRADE_SUBMIT_ENABLED;
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.ESPN_TEAM_ID = "8";

  mockRosters();
  findTradeSubmission.mockResolvedValue(null);
  claimTradeSubmission.mockResolvedValue({ claimed: true, id: 42 });
  finalizeTradeSubmission.mockResolvedValue(undefined);
  recordTradeOfferFill.mockResolvedValue(undefined);
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

describe("normalizeTradeOffer", () => {
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
      "https://fantasy.espn.com/football/team/trade?leagueId=1248158344&teamId=3&fromTeamId=8&seasonId=2026",
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
      { team: "8", id: "999", headshotId: "999", name: "Eagles D/ST" },
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
    await expect(fillTradeBuilder(page, offerFixture(), names)).rejects.toThrow(
      /6 checked, expected 5/,
    );
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

    await submitTradeOffer(offerFixture(), { session: { page, context: {}, browser } });

    expect(createAuthenticatedSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
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
  });

  it("attaches a message when the review screen has a note field", async () => {
    armForLiveSubmit();
    const { page, state } = makeBuilderPage([...THEIR_ROWS, ...OUR_ROWS]);
    useSession(page);
    const offer = offerFixture();

    const result = await submitTradeOffer(offer, {
      approval: approvalFor(offer),
      message: "Let's deal",
    });

    expect(state.filledMessage).toBe("Let's deal");
    expect(result.messageAttached).toBe(true);
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
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/outcome unknown/i) });
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
    const offer = offerFixture();

    await expect(
      submitTradeOffer(offer, { approval: approvalFor(offer) }),
    ).rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/verify in ESPN/i) });
    expect(createAuthenticatedSession).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ page: first.page, context: {}, browser: { close: jest.fn() } })
      .mockResolvedValueOnce({ page: second.page, context: {}, browser: { close: jest.fn() } });

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
