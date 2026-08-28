const {
  DEFAULT_LEASE_GRACE_MULTIPLIER,
  healthKey,
  commandStreamKey,
  commandResultChannel,
  pickRejectedChannel,
  buildOwnershipFields,
  generateOwnerIdentity,
  readOwnership,
  decideOwnership,
  publishCommand,
  resolveInitialCursor,
  consumeCommandsOnce,
  publishCommandResult,
  publishPickRejection,
  awaitCommandResult,
} = require("../../src/bots/session_registry");

/** Builds a fake node-redis-shaped client with jest.fn() methods, mirroring draft_clicker.test.js. */
function makeFakeRedisClient(overrides = {}) {
  return {
    get: jest.fn(),
    set: jest.fn(),
    xAdd: jest.fn(),
    xRead: jest.fn(),
    xRevRange: jest.fn().mockResolvedValue([]),
    publish: jest.fn(),
    subscribe: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn(),
    ...overrides,
  };
}

describe("session_registry", () => {
  describe("key builders", () => {
    it("builds the existing draft:{leagueId}:health key draft_sync.js already writes", () => {
      expect(healthKey("42")).toBe("draft:42:health");
    });

    it("builds the per-league command stream key", () => {
      expect(commandStreamKey("42")).toBe("draft_commands:42");
    });

    it("builds the per-league command result pub/sub channel", () => {
      expect(commandResultChannel("42")).toBe("draft_commands:42:results");
    });
  });

  describe("generateOwnerIdentity", () => {
    it("uses HOSTNAME when set, and a fresh random sessionId each call", () => {
      const prevHostname = process.env.HOSTNAME;
      const prevPodName = process.env.POD_NAME;
      process.env.HOSTNAME = "draft-sync-abc123";
      delete process.env.POD_NAME;

      const first = generateOwnerIdentity();
      const second = generateOwnerIdentity();

      expect(first.podName).toBe("draft-sync-abc123");
      expect(first.sessionId).toEqual(expect.any(String));
      expect(first.sessionId).not.toBe(second.sessionId);

      if (prevHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = prevHostname;
      if (prevPodName === undefined) delete process.env.POD_NAME;
      else process.env.POD_NAME = prevPodName;
    });

    it("falls back to POD_NAME, then \"unknown\", when HOSTNAME is unset", () => {
      const prevHostname = process.env.HOSTNAME;
      const prevPodName = process.env.POD_NAME;
      delete process.env.HOSTNAME;
      process.env.POD_NAME = "draft-sync-xyz";
      expect(generateOwnerIdentity().podName).toBe("draft-sync-xyz");

      delete process.env.POD_NAME;
      expect(generateOwnerIdentity().podName).toBe("unknown");

      if (prevHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = prevHostname;
      if (prevPodName === undefined) delete process.env.POD_NAME;
      else process.env.POD_NAME = prevPodName;
    });
  });

  describe("buildOwnershipFields", () => {
    it("computes a lease_expires_at leaseTtlMs in the future from `now`", () => {
      const now = Date.parse("2026-08-27T15:00:00.000Z");
      const fields = buildOwnershipFields({
        podName: "draft-sync-abc123",
        sessionId: "sess-1",
        leaseTtlMs: 30_000,
        now,
      });
      expect(fields).toEqual({
        owner_pod: "draft-sync-abc123",
        owner_session_id: "sess-1",
        lease_expires_at: "2026-08-27T15:00:30.000Z",
      });
    });

    it("defaults `now` to Date.now() when not provided", () => {
      const before = Date.now();
      const fields = buildOwnershipFields({
        podName: "p",
        sessionId: "s",
        leaseTtlMs: 1000,
      });
      const after = Date.now();
      const expiresAtMs = Date.parse(fields.lease_expires_at);
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(after + 1000);
    });

    it("exposes the grace multiplier draft_sync.js derives its lease TTL from", () => {
      expect(DEFAULT_LEASE_GRACE_MULTIPLIER).toBe(3);
    });
  });

  describe("readOwnership", () => {
    it("returns a live lease when the health blob has unexpired ownership fields", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const client = makeFakeRedisClient({
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            status: "connected",
            owner_pod: "draft-sync-abc123",
            owner_session_id: "sess-1",
            lease_expires_at: future,
          }),
        ),
      });

      const ownership = await readOwnership(client, "42");

      expect(client.get).toHaveBeenCalledWith("draft:42:health");
      expect(ownership).toEqual({
        ownerPod: "draft-sync-abc123",
        ownerSessionId: "sess-1",
        leaseExpiresAt: future,
        live: true,
      });
    });

    it("treats an expired lease_expires_at as not live", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const client = makeFakeRedisClient({
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            owner_pod: "draft-sync-abc123",
            owner_session_id: "sess-1",
            lease_expires_at: past,
          }),
        ),
      });

      const ownership = await readOwnership(client, "42");

      expect(ownership.live).toBe(false);
      expect(ownership.ownerPod).toBe("draft-sync-abc123");
    });

    it("returns an empty/not-live lease when the health key doesn't exist yet", async () => {
      const client = makeFakeRedisClient({ get: jest.fn().mockResolvedValue(null) });
      const ownership = await readOwnership(client, "42");
      expect(ownership).toEqual({
        ownerPod: null,
        ownerSessionId: null,
        leaseExpiresAt: null,
        live: false,
      });
    });

    it("returns an empty lease when the health blob is pre-#70 (no ownership fields)", async () => {
      const client = makeFakeRedisClient({
        get: jest.fn().mockResolvedValue(JSON.stringify({ status: "connected" })),
      });
      const ownership = await readOwnership(client, "42");
      expect(ownership.live).toBe(false);
      expect(ownership.ownerPod).toBeNull();
    });

    it("returns an empty lease, without throwing, when the health blob isn't valid JSON", async () => {
      const client = makeFakeRedisClient({ get: jest.fn().mockResolvedValue("{not json") });
      await expect(readOwnership(client, "42")).resolves.toEqual({
        ownerPod: null,
        ownerSessionId: null,
        leaseExpiresAt: null,
        live: false,
      });
    });

    it("returns an empty lease, without throwing, when the Redis read itself fails", async () => {
      const client = makeFakeRedisClient({ get: jest.fn().mockRejectedValue(new Error("ECONNRESET")) });
      await expect(readOwnership(client, "42")).resolves.toEqual({
        ownerPod: null,
        ownerSessionId: null,
        leaseExpiresAt: null,
        live: false,
      });
    });

    it("returns an empty lease when no leagueId is given, without touching Redis", async () => {
      const client = makeFakeRedisClient();
      const ownership = await readOwnership(client, undefined);
      expect(ownership.live).toBe(false);
      expect(client.get).not.toHaveBeenCalled();
    });
  });

  describe("decideOwnership", () => {
    it("delegates when a live owner holds the lease", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const client = makeFakeRedisClient({
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            owner_pod: "draft-sync-abc123",
            owner_session_id: "sess-1",
            lease_expires_at: future,
          }),
        ),
      });

      await expect(decideOwnership(client, "42")).resolves.toEqual({
        action: "delegate",
        ownerPod: "draft-sync-abc123",
        ownerSessionId: "sess-1",
      });
    });

    it("becomes the owner when no lease exists", async () => {
      const client = makeFakeRedisClient({ get: jest.fn().mockResolvedValue(null) });
      await expect(decideOwnership(client, "42")).resolves.toEqual({ action: "become_owner" });
    });

    it("becomes the owner when the lease has expired", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const client = makeFakeRedisClient({
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            owner_pod: "draft-sync-abc123",
            owner_session_id: "sess-1",
            lease_expires_at: past,
          }),
        ),
      });
      await expect(decideOwnership(client, "42")).resolves.toEqual({ action: "become_owner" });
    });

    it("fails toward become_owner (pre-#70 behavior) when the registry read itself errors", async () => {
      const client = makeFakeRedisClient({ get: jest.fn().mockRejectedValue(new Error("down")) });
      await expect(decideOwnership(client, "42")).resolves.toEqual({ action: "become_owner" });
    });
  });

  describe("publishCommand / consumeCommandsOnce", () => {
    it("XADDs a payload to draft_commands:{leagueId} and returns a generated command_id", async () => {
      const client = makeFakeRedisClient({ xAdd: jest.fn().mockResolvedValue("1-1") });

      const commandId = await publishCommand(client, "42", {
        command: "submit_pick",
        team_id: "8",
        player_id: "4360438",
      });

      expect(commandId).toEqual(expect.any(String));
      expect(client.xAdd).toHaveBeenCalledWith(
        "draft_commands:42",
        "*",
        { payload: expect.any(String) },
      );
      const payload = JSON.parse(client.xAdd.mock.calls[0][2].payload);
      expect(payload).toMatchObject({
        command_id: commandId,
        command: "submit_pick",
        team_id: "8",
        player_id: "4360438",
      });
      expect(payload.requested_at).toEqual(expect.any(String));
    });

    it("consumes new stream entries, advancing lastIdRef.current across polls", async () => {
      const lastIdRef = { current: undefined };
      const client = makeFakeRedisClient({
        xRevRange: jest.fn().mockResolvedValue([]), // empty stream at consumer start
        xRead: jest.fn().mockResolvedValueOnce([
          {
            name: "draft_commands:42",
            messages: [
              { id: "1-1", message: { payload: JSON.stringify({ command_id: "a", command: "submit_pick" }) } },
              { id: "1-2", message: { payload: JSON.stringify({ command_id: "b", command: "submit_pick" }) } },
            ],
          },
        ]),
      });

      const commands = await consumeCommandsOnce(client, "42", lastIdRef);

      // A fresh consumer resolves a real starting cursor via resolveInitialCursor (XREVRANGE)
      // rather than defaulting to the literal "$" (see resolveInitialCursor's own tests/comment
      // for why "$" is wrong for a non-blocking XREAD like this one) — an empty stream resolves
      // to "0" (from the very start, which is also "now" for a stream with nothing on it yet).
      expect(client.xRevRange).toHaveBeenCalledWith(
        "draft_commands:42",
        "+",
        "-",
        { COUNT: 1 },
      );
      expect(client.xRead).toHaveBeenCalledWith(
        { key: "draft_commands:42", id: "0" },
        { COUNT: 10 },
      );
      expect(commands).toEqual([
        { command_id: "a", command: "submit_pick" },
        { command_id: "b", command: "submit_pick" },
      ]);
      expect(lastIdRef.current).toBe("1-2");
    });

    it("uses the caller-owned lastIdRef.current as the starting id on subsequent polls", async () => {
      const lastIdRef = { current: "1-2" };
      const client = makeFakeRedisClient({ xRead: jest.fn().mockResolvedValue(null) });

      const commands = await consumeCommandsOnce(client, "42", lastIdRef);

      expect(client.xRead).toHaveBeenCalledWith(
        { key: "draft_commands:42", id: "1-2" },
        { COUNT: 10 },
      );
      expect(commands).toEqual([]);
      expect(lastIdRef.current).toBe("1-2");
    });

    it("returns an empty array, without throwing, when xRead itself fails", async () => {
      const lastIdRef = { current: "$" };
      const client = makeFakeRedisClient({ xRead: jest.fn().mockRejectedValue(new Error("down")) });
      await expect(consumeCommandsOnce(client, "42", lastIdRef)).resolves.toEqual([]);
    });

    it("drops unparseable entries but keeps advancing the cursor past them", async () => {
      const lastIdRef = { current: "$" };
      const client = makeFakeRedisClient({
        xRead: jest.fn().mockResolvedValue([
          {
            name: "draft_commands:42",
            messages: [{ id: "1-1", message: { payload: "{not json" } }],
          },
        ]),
      });

      const commands = await consumeCommandsOnce(client, "42", lastIdRef);

      expect(commands).toEqual([]);
      expect(lastIdRef.current).toBe("1-1");
    });

    it("consumes an entry that already exists in the stream on a fresh consumer's first poll (real non-blocking XREAD semantics: '$' alone would never see it)", async () => {
      // Mirrors real Redis: `$` (no BLOCK) resolves to "current tail" at call time and returns
      // nothing after it — a fake that actually respects `id` catches what the canned-response
      // mocks above cannot.
      const streamEntries = [
        { id: "1-1", message: { payload: JSON.stringify({ command_id: "a", command: "submit_pick" }) } },
      ];
      const xRead = jest.fn().mockImplementation(({ id }) => {
        if (id === "$") return Promise.resolve(null); // real Redis: always empty for non-blocking "$"
        const afterId = streamEntries.filter((e) => e.id > id);
        return afterId.length
          ? Promise.resolve([{ name: "draft_commands:42", messages: afterId }])
          : Promise.resolve(null);
      });
      const client = makeFakeRedisClient({
        xRevRange: jest.fn().mockResolvedValue([]),
        xRead,
      });

      const lastIdRef = { current: undefined };
      const commands = await consumeCommandsOnce(client, "42", lastIdRef);

      expect(commands).toEqual([{ command_id: "a", command: "submit_pick" }]);
      expect(lastIdRef.current).toBe("1-1");
    });

    it("still catches a command published after polling starts (regression: literal '$' would silently drop it forever)", async () => {
      const client = makeFakeRedisClient({
        xRevRange: jest.fn().mockResolvedValue([]), // empty stream at consumer start
        xRead: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([
          {
            name: "draft_commands:42",
            messages: [{ id: "5-1", message: { payload: JSON.stringify({ command_id: "z", command: "submit_pick" }) } }],
          },
        ]),
      });
      const lastIdRef = { current: undefined };

      const first = await consumeCommandsOnce(client, "42", lastIdRef); // primes cursor, nothing yet
      expect(first).toEqual([]);

      const second = await consumeCommandsOnce(client, "42", lastIdRef); // command arrives between polls
      expect(second).toEqual([{ command_id: "z", command: "submit_pick" }]);
      expect(lastIdRef.current).toBe("5-1");
    });
  });

  describe("resolveInitialCursor", () => {
    it("returns the most recent stream entry's id when the stream already has entries", async () => {
      const client = makeFakeRedisClient({
        xRevRange: jest.fn().mockResolvedValue([{ id: "9-3", message: {} }]),
      });
      await expect(resolveInitialCursor(client, "42")).resolves.toBe("9-3");
      expect(client.xRevRange).toHaveBeenCalledWith("draft_commands:42", "+", "-", { COUNT: 1 });
    });

    it("returns '0' when the stream is empty", async () => {
      const client = makeFakeRedisClient({ xRevRange: jest.fn().mockResolvedValue([]) });
      await expect(resolveInitialCursor(client, "42")).resolves.toBe("0");
    });

    it("returns '0', without throwing, when xRevRange itself fails", async () => {
      const client = makeFakeRedisClient({
        xRevRange: jest.fn().mockRejectedValue(new Error("down")),
      });
      await expect(resolveInitialCursor(client, "42")).resolves.toBe("0");
    });
  });

  describe("publishCommandResult / awaitCommandResult", () => {
    it("publishes a result payload including the command_id onto the results channel", async () => {
      const client = makeFakeRedisClient({ publish: jest.fn().mockResolvedValue(1) });

      await publishCommandResult(client, "42", "cmd-1", { status: "success", lineup_slot_id: 10 });

      expect(client.publish).toHaveBeenCalledWith(
        "draft_commands:42:results",
        JSON.stringify({ command_id: "cmd-1", status: "success", lineup_slot_id: 10 }),
      );
    });
  });

  describe("publishPickRejection", () => {
    it("publishes JSON with league_id and rejected_at to the per-league channel", async () => {
      const client = makeFakeRedisClient({ publish: jest.fn().mockResolvedValue(1) });

      await publishPickRejection(client, "999", {
        pick_number: 3,
        idempotency_key: "999:3:555",
        team_id: "8",
        player_id: "555",
        error_code: "1",
        error_message: "Invalid Selection.",
      });

      expect(client.publish).toHaveBeenCalledTimes(1);
      const [channel, payload] = client.publish.mock.calls[0];
      expect(channel).toBe(pickRejectedChannel("999"));
      const parsed = JSON.parse(payload);
      expect(parsed).toMatchObject({
        league_id: "999",
        pick_number: 3,
        idempotency_key: "999:3:555",
        error_code: "1",
        error_message: "Invalid Selection.",
      });
      expect(typeof parsed.rejected_at).toBe("number");
    });

    it("swallows a Redis publish error and never throws", async () => {
      const client = makeFakeRedisClient({
        publish: jest.fn().mockRejectedValue(new Error("connection reset")),
      });

      await expect(
        publishPickRejection(client, "999", { pick_number: 3 }),
      ).resolves.toBeUndefined();
    });

    it("resolves with the matching result once the subscriber callback fires", async () => {
      let capturedHandler;
      const subscriber = makeFakeRedisClient({
        subscribe: jest.fn().mockImplementation((_channel, handler) => {
          capturedHandler = handler;
          return Promise.resolve();
        }),
      });
      const client = makeFakeRedisClient({ duplicate: jest.fn().mockReturnValue(subscriber) });

      const resultPromise = awaitCommandResult(client, "42", "cmd-1", 5000);
      // Give the subscribe() microtask a tick to run before firing the message.
      await Promise.resolve();
      await Promise.resolve();
      capturedHandler(JSON.stringify({ command_id: "cmd-1", status: "success" }));

      await expect(resultPromise).resolves.toEqual({ command_id: "cmd-1", status: "success" });
      expect(subscriber.connect).toHaveBeenCalled();
      expect(subscriber.quit).toHaveBeenCalled();
    });

    it("ignores messages for a different command_id", async () => {
      let capturedHandler;
      const subscriber = makeFakeRedisClient({
        subscribe: jest.fn().mockImplementation((_channel, handler) => {
          capturedHandler = handler;
          return Promise.resolve();
        }),
      });
      const client = makeFakeRedisClient({ duplicate: jest.fn().mockReturnValue(subscriber) });

      const resultPromise = awaitCommandResult(client, "42", "cmd-1", 200);
      await Promise.resolve();
      await Promise.resolve();
      capturedHandler(JSON.stringify({ command_id: "cmd-other", status: "success" }));
      capturedHandler(JSON.stringify({ command_id: "cmd-1", status: "success" }));

      await expect(resultPromise).resolves.toEqual({ command_id: "cmd-1", status: "success" });
    });

    it("resolves null and still cleans up the subscriber when nothing arrives before timeoutMs", async () => {
      jest.useFakeTimers();
      try {
        const subscriber = makeFakeRedisClient({
          subscribe: jest.fn().mockResolvedValue(undefined),
        });
        const client = makeFakeRedisClient({ duplicate: jest.fn().mockReturnValue(subscriber) });

        const resultPromise = awaitCommandResult(client, "42", "cmd-1", 5000);
        await jest.advanceTimersByTimeAsync(5000);

        await expect(resultPromise).resolves.toBeNull();
        expect(subscriber.quit).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("resolves null and still attempts cleanup when the subscriber connection itself fails", async () => {
      const subscriber = makeFakeRedisClient({
        connect: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        subscribe: jest.fn(),
      });
      const client = makeFakeRedisClient({ duplicate: jest.fn().mockReturnValue(subscriber) });

      await expect(awaitCommandResult(client, "42", "cmd-1", 5000)).resolves.toBeNull();
      expect(subscriber.subscribe).not.toHaveBeenCalled();
      expect(subscriber.quit).toHaveBeenCalled();
    });

    it("resolves null and still cleans up when the subscribe call itself rejects", async () => {
      const subscriber = makeFakeRedisClient({
        subscribe: jest.fn().mockRejectedValue(new Error("subscribe failed")),
      });
      const client = makeFakeRedisClient({ duplicate: jest.fn().mockReturnValue(subscriber) });

      await expect(awaitCommandResult(client, "42", "cmd-1", 5000)).resolves.toBeNull();
      expect(subscriber.quit).toHaveBeenCalled();
    });
  });
});
