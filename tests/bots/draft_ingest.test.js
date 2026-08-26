const {
  ingestPickEvent,
  assignPickNumber,
  handleSelectedFrame,
  parseAutosuggestFrame,
  handleAutosuggestFrame,
  classifyPickOrigin,
  handleDomRecords,
  seedLedgerFromBoard,
  createIngestHealth,
  emitHealthHeartbeat,
} = require("../../src/bots/draft_sync");
const { DraftPickLedger } = require("../../src/bots/draft_pick_ledger");

/**
 * Covers the multi-source ingest wiring (issue #52) — the layer between the three tiers and Redis.
 * The ledger's own decision rules are tested in draft_pick_ledger.test.js; these tests are about
 * what actually gets WRITTEN and PUBLISHED as a result.
 */

function fakeRedis() {
  const calls = { xAdd: [], hSet: [], hDel: [], publish: [], set: [] };
  const multi = {
    xAdd: (...args) => {
      calls.xAdd.push(args);
      return multi;
    },
    hSet: (...args) => {
      calls.hSet.push(args);
      return multi;
    },
    hDel: (...args) => {
      calls.hDel.push(args);
      return multi;
    },
    exec: async () => [],
  };
  return {
    calls,
    multi: () => multi,
    publish: async (...args) => {
      calls.publish.push(args);
    },
    set: async (...args) => {
      calls.set.push(args);
    },
  };
}

function freshState() {
  return {
    leagueId: "123",
    seasonId: "2026",
    teamId: "8",
    lastPickNumber: null,
    pickCounter: 0,
    ready: true,
    pendingFrames: [],
    ledger: new DraftPickLedger(),
    health: createIngestHealth(),
    ingestChain: Promise.resolve(),
    playerPool: null,
  };
}

const pick = (overrides = {}) => ({
  league_id: "123",
  player_id: 4360438,
  team_id: 8,
  pick_number: null,
  round: 1,
  source: "ws",
  ...overrides,
});

describe("assignPickNumber", () => {
  it("leaves an existing pick number alone (REST's is authoritative)", () => {
    const state = freshState();
    expect(assignPickNumber(state, pick({ pick_number: 42 })).pick_number).toBe(
      42,
    );
    expect(state.pickCounter).toBe(0);
  });

  it("mints sequential numbers for sources that carry none", () => {
    const state = freshState();
    expect(assignPickNumber(state, pick({ player_id: 1 })).pick_number).toBe(1);
    state.ledger.seed({ ...pick({ player_id: 1 }), pick_number: 1 });
    expect(assignPickNumber(state, pick({ player_id: 2 })).pick_number).toBe(2);
  });

  it("REUSES an already-known player's number instead of minting a new one", () => {
    // This is what stops the DOM tier from becoming a duplicate generator: a full board rescan
    // re-reports every visible pick, and minting a fresh number each time would publish each of
    // them as a brand-new pick on every scan.
    const state = freshState();
    const first = assignPickNumber(state, pick());
    state.ledger.seed(first);

    const second = assignPickNumber(state, pick({ source: "dom" }));

    expect(second.pick_number).toBe(first.pick_number);
    expect(state.pickCounter).toBe(1);
  });

  it("does not consume a pick number for an unusable record", () => {
    // A malformed WS frame (player_id NaN/null) is rejected by the ledger moments later. Minting
    // a number for it first would permanently skew every subsequent WS/DOM pick number by one.
    const state = freshState();

    expect(assignPickNumber(state, pick({ player_id: null })).pick_number).toBe(
      null,
    );
    expect(
      assignPickNumber(state, pick({ player_id: "abc" })).pick_number,
    ).toBe(null);
    expect(state.pickCounter).toBe(0);

    expect(assignPickNumber(state, pick()).pick_number).toBe(1);
  });
});

describe("ingestPickEvent", () => {
  it("writes to the stream + board and publishes on a new pick", async () => {
    const redis = fakeRedis();
    const state = freshState();

    const decision = await ingestPickEvent(redis, pick(), state);

    expect(decision.action).toBe("publish");
    expect(redis.calls.xAdd).toHaveLength(1);
    expect(redis.calls.hSet).toHaveLength(1);
    expect(redis.calls.publish).toHaveLength(1);
    expect(state.health.published_by_source.ws).toBe(1);
    expect(state.health.last_pick_seen_at).not.toBeNull();
  });

  it("writes nothing for a duplicate", async () => {
    const redis = fakeRedis();
    const state = freshState();
    await ingestPickEvent(redis, pick(), state);

    const decision = await ingestPickEvent(
      redis,
      pick({ source: "dom" }),
      state,
    );

    expect(decision.action).toBe("duplicate");
    expect(redis.calls.publish).toHaveLength(1);
    expect(state.health.dropped.duplicate).toBe(1);
  });

  it("clears the stale board slot when a correction changes the pick number", async () => {
    // Otherwise the old (WS-guessed) pick number is left behind pointing at the same player, so
    // the board shows the pick twice under two different numbers.
    const redis = fakeRedis();
    const state = freshState();
    await ingestPickEvent(redis, pick(), state); // WS -> pick_number 1

    const decision = await ingestPickEvent(
      redis,
      pick({ pick_number: 17, source: "rest" }),
      state,
    );

    expect(decision.action).toBe("correct");
    expect(redis.calls.hDel).toEqual([["draft:123:picks", "1"]]);
    expect(redis.calls.hSet[1]).toEqual([
      "draft:123:picks",
      "17",
      expect.any(String),
    ]);
  });

  it("advances lastPickNumber only forwards", async () => {
    const redis = fakeRedis();
    const state = freshState();

    await ingestPickEvent(
      redis,
      pick({ player_id: 1, pick_number: 20 }),
      state,
    );
    await ingestPickEvent(redis, pick({ player_id: 2, pick_number: 4 }), state);

    expect(state.lastPickNumber).toBe(20);
  });

  it("does NOT mark a pick as published when the Redis write fails", async () => {
    // Regression: the ledger is the only dedup gate, so recording a pick before its write lands
    // would make a transient Redis failure lose that pick permanently — every later observation
    // (WS re-delivery, the DOM poller, the next REST pass) would be dropped as a duplicate.
    const redis = fakeRedis();
    let failNext = true;
    redis.multi = () => ({
      xAdd() {
        return this;
      },
      hSet() {
        return this;
      },
      hDel() {
        return this;
      },
      exec: async () => {
        if (failNext) throw new Error("redis unavailable");
        return [];
      },
    });
    const state = freshState();

    await expect(ingestPickEvent(redis, pick(), state)).rejects.toThrow(
      "redis unavailable",
    );
    expect(state.ledger.hasPlayer(4360438)).toBe(false);

    // The very next observation of the same pick must publish, not be swallowed as a duplicate.
    failNext = false;
    const retry = await ingestPickEvent(redis, pick({ source: "dom" }), state);

    expect(retry.action).toBe("publish");
    expect(redis.calls.publish).toHaveLength(1);
  });

  it("publishes a pick once when two tiers report it concurrently", async () => {
    // The WS frame handler and the DOM scan are both async and can interleave. Without
    // serialization both could evaluate to "publish" before either committed, and both would
    // write — the duplicate emission this change exists to prevent.
    const redis = fakeRedis();
    const state = freshState();

    await Promise.all([
      ingestPickEvent(redis, pick({ source: "ws" }), state),
      ingestPickEvent(redis, pick({ source: "dom" }), state),
    ]);

    expect(redis.calls.publish).toHaveLength(1);
    expect(state.ledger.size()).toBe(1);
  });
});

describe("handleSelectedFrame", () => {
  // Regression (PR #63 review): our SWID reaches us from an env var or OpenBao, so it may
  // arrive without braces or in different casing, while the WS frame always carries braces.
  // Comparing the two raw reported every one of OUR OWN picks as `other` — the precise
  // misattribution this classification exists to prevent, and silent when it happens.
  it.each([
    ["both braced", "{OUR-SWID}", "{OUR-SWID}"],
    ["ours unbraced", "{OUR-SWID}", "OUR-SWID"],
    ["frame unbraced", "OUR-SWID", "{OUR-SWID}"],
    ["mixed casing", "{our-swid}", "{OUR-SWID}"],
    ["surrounding whitespace", "{OUR-SWID}", " {OUR-SWID} "],
  ])("classifies a pick as ours with %s", (_label, frameSwid, ourSwid) => {
    expect(classifyPickOrigin(frameSwid, ourSwid)).toBe("us");
  });

  it("classifies an absent member as autodraft and a different member as other", () => {
    expect(classifyPickOrigin(null, "{OUR-SWID}")).toBe("autodraft");
    expect(classifyPickOrigin(undefined, "{OUR-SWID}")).toBe("autodraft");
    expect(classifyPickOrigin("{OTHER-SWID}", "{OUR-SWID}")).toBe("other");
  });

  it("does not claim a pick as ours when our own SWID is unknown", () => {
    // Guard against normalizeSwid(null) stringifying to "{null}" and matching a frame that
    // also failed to carry a member id.
    expect(classifyPickOrigin("{OTHER-SWID}", null)).toBe("other");
  });

  it("classifies autodraft, our bot, and other human picks", async () => {
    const redis = fakeRedis();
    const state = freshState();
    state.memberId = "{OUR-SWID}";

    await handleSelectedFrame(
      {
        team_id: 8,
        player_id: 1,
        lineup_slot_id: 1,
        member_id: null,
      },
      redis,
      state,
    );
    await handleSelectedFrame(
      {
        team_id: 8,
        player_id: 2,
        lineup_slot_id: 2,
        member_id: "{OUR-SWID}",
      },
      redis,
      state,
    );
    await handleSelectedFrame(
      {
        team_id: 3,
        player_id: 3,
        lineup_slot_id: 4,
        member_id: "{OTHER-SWID}",
      },
      redis,
      state,
    );

    const events = redis.calls.xAdd.map(([, , fields]) =>
      JSON.parse(fields.payload),
    );
    expect(
      events.map(({ member_id, pick_origin }) => ({ member_id, pick_origin })),
    ).toEqual([
      { member_id: null, pick_origin: "autodraft" },
      { member_id: "{OUR-SWID}", pick_origin: "us" },
      { member_id: "{OTHER-SWID}", pick_origin: "other" },
    ]);
  });
});

describe("parseAutosuggestFrame", () => {
  it("parses a real captured frame (recon-output/websockets.jsonl, 2026-08-25)", () => {
    expect(parseAutosuggestFrame("AUTOSUGGEST 4426515")).toEqual({
      player_id: 4426515,
    });
  });

  it("ignores frames that are not AUTOSUGGEST", () => {
    expect(parseAutosuggestFrame("SELECTED 8 4360438 6")).toBeNull();
  });

  it("returns null for a truncated frame rather than inventing an id", () => {
    expect(parseAutosuggestFrame("AUTOSUGGEST")).toBeNull();
  });

  it("returns null for a non-numeric id rather than NaN (PR #65 review)", () => {
    // Number("abc") is NaN, which JSON.stringify silently renders as null — publishing that would
    // overwrite the last valid suggestion in Redis with a garbage status.
    expect(parseAutosuggestFrame("AUTOSUGGEST abc")).toBeNull();
  });
});

describe("handleAutosuggestFrame", () => {
  it("resolves the player id against the pool and publishes name/position/team", async () => {
    const redis = fakeRedis();
    const state = freshState();
    state.playerPool = new Map([
      [
        "4426515",
        { id: 4426515, name: "Test Player", positionId: 2, proTeamId: 14 },
      ],
    ]);

    await handleAutosuggestFrame({ player_id: 4426515 }, redis, state);

    expect(redis.calls.set).toHaveLength(1);
    const [key, payload] = redis.calls.set[0];
    expect(key).toBe("draft:123:suggested");
    expect(JSON.parse(payload)).toMatchObject({
      league_id: "123",
      player_id: 4426515,
      name: "Test Player",
      position_id: 2,
      pro_team_id: 14,
    });
  });

  it("degrades to a bare player_id when the pool is missing or doesn't have the id", async () => {
    const redis = fakeRedis();
    const state = freshState(); // playerPool: null

    await handleAutosuggestFrame({ player_id: 999 }, redis, state);

    const [, payload] = redis.calls.set[0];
    expect(JSON.parse(payload)).toMatchObject({
      player_id: 999,
      name: null,
      position_id: null,
      pro_team_id: null,
    });
  });

  it("never throws when the Redis write fails", async () => {
    const state = freshState();
    const redis = {
      set: async () => {
        throw new Error("redis down");
      },
    };

    await expect(
      handleAutosuggestFrame({ player_id: 1 }, redis, state),
    ).resolves.toBeUndefined();
  });
});

describe("seedLedgerFromBoard", () => {
  it("rehydrates the ledger so a restart doesn't re-publish the existing board", async () => {
    // Regression: on a mid-draft restart Redis still holds every published pick. With a cold
    // ledger, the DOM observer's first full-board scan re-emits the whole draft as new picks and
    // overwrites the board hash's pick->player mapping with numbers minted in DOM scan order.
    const redis = fakeRedis();
    redis.hGetAll = async () => ({
      1: JSON.stringify({
        league_id: "123",
        player_id: 4360438,
        team_id: 8,
        pick_number: 1,
        round: 1,
        source: "ws",
      }),
      2: JSON.stringify({
        league_id: "123",
        player_id: 999,
        team_id: 3,
        pick_number: 2,
        round: 1,
        source: "ws",
      }),
    });
    const state = freshState();

    const seeded = await seedLedgerFromBoard(redis, state);

    expect(seeded).toBe(2);
    expect(state.lastPickNumber).toBe(2);

    await handleDomRecords(
      [
        { player_id: 4360438, team_id: 8 },
        { player_id: 999, team_id: 3 },
      ],
      redis,
      state,
      { trigger: "initial", matched_strategy: "generic-player-team-pair" },
    );

    expect(redis.calls.publish).toHaveLength(0);
  });

  it("skips unparseable board entries without losing the rest", async () => {
    const redis = fakeRedis();
    redis.hGetAll = async () => ({
      1: "{not json",
      2: JSON.stringify({ player_id: 999, pick_number: 2, source: "ws" }),
    });
    const state = freshState();

    expect(await seedLedgerFromBoard(redis, state)).toBe(1);
    expect(state.health.seed_parse_errors).toBe(1);
  });

  it("starts cold rather than throwing when Redis is unreachable", async () => {
    const redis = fakeRedis();
    redis.hGetAll = async () => {
      throw new Error("redis down");
    };
    const state = freshState();

    await expect(seedLedgerFromBoard(redis, state)).resolves.toBe(0);
  });
});

describe("handleDomRecords", () => {
  it("publishes a pick the WebSocket never delivered", async () => {
    // The eviction-gap recovery #52 exists for: the board shows a pick nothing else reported.
    const redis = fakeRedis();
    const state = freshState();

    await handleDomRecords(
      [{ player_id: 999, team_id: 3, round: 2 }],
      redis,
      state,
      { trigger: "poll", matched_strategy: "generic-player-team-pair" },
    );

    expect(redis.calls.publish).toHaveLength(1);
    expect(state.health.dom.recovered_picks).toBe(1);
  });

  it("does not re-publish picks the WebSocket already delivered", async () => {
    const redis = fakeRedis();
    const state = freshState();
    await ingestPickEvent(redis, pick({ player_id: 999, team_id: 3 }), state);

    await handleDomRecords(
      [{ player_id: 999, team_id: 3, round: 1 }],
      redis,
      state,
      { trigger: "poll", matched_strategy: "generic-player-team-pair" },
    );

    expect(redis.calls.publish).toHaveLength(1);
    expect(state.health.dom.recovered_picks).toBe(0);
  });

  it("skips records with no team attribution", async () => {
    // Publishing a pick with an unknown owner is useless downstream AND would burn the player's
    // ledger entry, suppressing the correct copy when a better source reports it.
    const redis = fakeRedis();
    const state = freshState();

    await handleDomRecords([{ player_id: 999, team_id: null }], redis, state, {
      trigger: "poll",
      matched_strategy: "draft-board-pick-cell",
    });

    expect(redis.calls.publish).toHaveLength(0);
    expect(state.health.dom.records_without_team).toBe(1);
    expect(state.ledger.hasPlayer(999)).toBe(false);
  });

  it("ignores records that arrive before the league context is seeded", async () => {
    const redis = fakeRedis();
    const state = freshState();
    state.ready = false;

    await handleDomRecords([{ player_id: 999, team_id: 3 }], redis, state, {
      trigger: "initial",
      matched_strategy: "draft-board-pick-cell",
    });

    expect(redis.calls.publish).toHaveLength(0);
  });
});

describe("emitHealthHeartbeat", () => {
  it("writes a snapshot with per-tier counters to Redis", async () => {
    const redis = fakeRedis();
    const state = freshState();
    await ingestPickEvent(redis, pick(), state);

    const snapshot = await emitHealthHeartbeat(redis, state, {
      wsConnected: true,
      dom: { attached: true, scans: 3 },
    });

    expect(snapshot.picks_known).toBe(1);
    expect(snapshot.ws_connected).toBe(true);
    expect(snapshot.dom_observer).toEqual({ attached: true, scans: 3 });
    expect(redis.calls.set[0][0]).toBe("draft:123:health");
  });

  it("reports pick silence so a dead feed is distinguishable from a slow drafter", async () => {
    const redis = fakeRedis();
    const state = freshState();
    state.health.last_pick_seen_at = new Date(Date.now() - 60000).toISOString();

    const snapshot = await emitHealthHeartbeat(redis, state, {
      wsConnected: true,
      dom: null,
    });

    expect(snapshot.pick_silence_ms).toBeGreaterThanOrEqual(59000);
  });

  it("never throws when Redis is unavailable", async () => {
    // A heartbeat must not be the thing that takes down a working draft sync.
    const redis = fakeRedis();
    redis.set = async () => {
      throw new Error("redis down");
    };
    const state = freshState();

    await expect(
      emitHealthHeartbeat(redis, state, { wsConnected: false, dom: null }),
    ).resolves.toBeDefined();
  });
});
