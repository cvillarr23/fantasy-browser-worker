# Draft Sync WebSocket Liveness & Permanent-Error Handling Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed root cause of practice-draft picks silently stopping mid-draft (the sync job never notices its real ESPN draft-room socket died, never reconnects, and never reports the outage); fix a second, independently confirmed bug that makes issue #70/#71's session-registry pick delegation a complete no-op in production (so it still falls back to the exact colliding-JOIN behavior #70/#71 was built to eliminate, on every single pick); and close two related gaps this incident exposed (infinite retry against a permanently-gone room; no way to tell "stale selector" from "page never rendered content" in the DOM fallback tier).

**Answering the user's direct question ("does the #70/#71 same-session update fix picks not going through?"):** No, not on its own. Re-verifying against the incident logs found `draft_sync.js`'s command consumer (`consumeCommandsOnce` in `session_registry.js`) never processes a single delegated command in production, in any run, due to a Redis `XREAD` cursor bug — every delegated pick times out after 5s and falls back to the pre-#70 raw-JOIN path regardless. Task 2 below fixes that. Task 1 remains the highest-priority fix: it's what stops `draft_sync.js` from going permanently blind *after* any eviction, from #70/#71's fallback path or otherwise.

**Architecture:** `attachDraftListeners()` in `fantasy-browser-worker/src/bots/draft_sync.js` currently tracks WebSocket liveness (`openSockets`, `lastActivityAt`) and health counters (`state.health.ws.*`) across **every** WebSocket the Playwright page opens — but the page opens two unrelated sockets: the real ESPN draft-room feed (`wss://fantasydraft.espn.com/.../JOIN`) and Disney/BAM's identity-SDK socket (`wss://espn.connections.edge.bamgrid.com/...`), which reconnects on its own schedule regardless of draft activity. When the draft-room socket dies (an ESPN-side eviction, confirmed via a `LEFT` frame), the BAM socket's continued churn keeps `openSockets > 0` and keeps bumping `lastActivityAt`, so `isDead()` (and the health heartbeat's `ws_connected` field, and `hasOpenSocket()`) never flips to reflect reality. The reconnect loop in `connectAndStream()` / `streamLiveDraftRoom()` then waits forever on a socket that will never come back, and the health heartbeat lies to `fantasy-core-pipeline` (and, downstream, `fantasy-web-ui`) the entire time. The fix scopes liveness/health tracking to the draft-room JOIN socket specifically. Two related gaps (permanent REST/session errors retried forever; DOM fallback failures indistinguishable from a gated/unrendered page) are fixed alongside it since they were directly observed in the same incident logs.

**Tech Stack:** Node.js, Playwright, Jest (existing test runner: `npm test` in `fantasy-browser-worker`), `ws`, `redis`.

**Tracking issue:** cvillarr23/fantasy-browser-worker#72 (corrects the mis-filed cvillarr23/fantasy-core-pipeline#108, now closed).

**Spec:** This plan is derived directly from a live production-log investigation (Grafana/Loki, `service_name="draft-sync"`), not a separate written spec. The evidence trail is reproduced in each task below so an implementer with zero prior context can verify every claim independently. Two runs were analyzed:
  - Incident run: `trackingId=13ccdbab-8717-4385-8656-f38f71323980`, league `156611456`, team 8, pod `practice-draft-sync-1787859146-jpr8f` (2026-08-27, ~19:32–21:16 UTC).
  - Fresh reproduction run (requested mid-investigation, still live when captured): `trackingId=ac341959-8c62-4700-a8e0-aef1171619a5`, league `1768748895`, team 8, pod `practice-draft-sync-1787866737-6d7kv` (2026-08-27, started ~21:38 UTC) — reproduced the *identical* failure signature: 7 picks published via WS in the first ~60s, then a `LEFT` frame, the JOIN socket closes, and the job spins "Reconnect-loop tick." indefinitely afterward with the DOM tier reporting a 100% selector-miss streak the whole time.

## Global Constraints

- Do not touch `fantasy-core-pipeline` or `fantasy-web-ui` in this plan — the confirmed root cause and all fixes live entirely in `fantasy-browser-worker`. A previously-filed issue in the wrong repo (`fantasy-core-pipeline#108`) must be closed with a pointer to the corrected one (Task 5).
- Every new/changed unit of behavior must have a Jest test in `tests/bots/`, following the existing mocking patterns already used in that file (see `tests/bots/draft_sync.test.js`'s `attachDraftListeners debug instrumentation` describe block for the closest precedent).
- Do not change `WS_DEAD_GRACE_MS` (30000ms), `MAX_RECONNECT_ATTEMPTS` (10), or the backoff constants — they are not implicated by this bug.
- Preserve all existing structured-logging fields (nothing downstream should lose a field it currently reads); only add fields / narrow which sockets populate existing ones.
- Run `npm test` (Jest) and `npm run lint` (ESLint) in `fantasy-browser-worker` after each task; both must pass before moving to the next task.

---

### Task 1: Scope WebSocket liveness + health tracking to the real draft-room socket only

**Files:**
- Modify: `src/bots/draft_sync.js:869-1073` (`attachDraftListeners`)
- Test: `tests/bots/draft_sync.test.js` (extend the existing `describe("attachDraftListeners debug instrumentation", ...)` block, ~line 321)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `isDraftRoomSocketUrl(url)` — a new exported pure function `(url: string) => boolean`, used by Task 1 itself and available for Task 3's diagnostics if needed. `attachDraftListeners`'s returned handle keeps its existing shape (`{ isDead, hasOpenSocket, debugSnapshot }`) — no signature change, only internal behavior.

**Evidence this task fixes:**
- Log (incident run): `WebSocket opened: wss://fantasydraft.espn.com/game-1/league-156611456/JOIN?...` at `19:32:52.102Z` (`socket_id: 1`) — the ONLY JOIN socket opened all run.
- Log: `WebSocket closed after 38 frame(s), 7 pick(s): wss://fantasydraft.espn.com/.../JOIN...` at `19:33:25.476Z`, immediately preceded by `First-seen frame type this run: LEFT` — ESPN's own eviction signal. **No further JOIN socket was ever opened for the rest of the ~1h43m run.**
- Meanwhile `WebSocket opened`/`closed` fired 7 more times for `wss://espn.connections.edge.bamgrid.com/5d3054/connection?...` (socket_ids 2–8) — Disney/BAM's identity-SDK socket, reconnecting on its own schedule (observed reconnect events at 19:37:28, 20:08:36, 20:42:06, 21:15:50 UTC), completely unrelated to draft picks.
- Because `attachDraftListeners`'s `page.on("websocket", (ws) => {...})` handler (line 882) increments/decrements the SAME closure-scoped `openSockets` counter and bumps the SAME `lastActivityAt` for **every** socket the page opens, the BAM socket's churn kept `openSockets > 0` (or briefly 0 then immediately back to 1) and kept refreshing `lastActivityAt` for the entire session — even though the real draft-room socket had been dead since `19:33:25`.
- Confirmed via the health heartbeat itself: `[Draft Sync] Reconnect-loop tick.` logged `open_sockets: 1, idle_ms: 991073` at `21:32:24Z` — i.e., `isDead()`'s own `idle_ms` operand shows ~16.5 minutes of silence (33x past the 30000ms `WS_DEAD_GRACE_MS` threshold), yet `isDead()` returned `false` throughout because `openSockets` never sustainably reached 0. **This is why `connectAndStream()`'s `while (!handle.isDead() ...)` loop in `streamLiveDraftRoom` never exited to trigger a reconnect, and the browser session that could rejoin the draft room was never relaunched.**
- Same root cause also explains the misreported health status: `emitHealthHeartbeat` (line ~1353) is called with `wsConnected: handle.hasOpenSocket()` (line ~1660 in the `heartbeatInterval`), which is `openSockets > 0` — the exact same contaminated counter. This is why every heartbeat log line said `ws=connected` the entire outage (`[Draft Sync] Health: ws=connected picks=7 ... rest_empty=23/23`), and why the same lie was written to Redis for `fantasy-core-pipeline`'s status endpoint (and, downstream, `fantasy-web-ui`'s dashboard) to read.
- Also explains the garbled `state.health.ws.other_frames` entries: raw BAM-SDK JSON event payloads (e.g. `{"data":null,"type":"urn:dss:transport:edge:event:authenticated",...}`) were logged as if they were draft-room frame types, because the frame-type accounting at line ~1001 runs for every socket's frames indiscriminately, not just the JOIN socket's.
- Reproduced identically in the fresh run: JOIN socket (league `1768748895`) opened `21:39:00.971Z`, 7 picks published within the first ~10s, `LEFT` frame + close at `21:39:57.614Z` (`42 frame(s), 7 pick(s)`), and no further JOIN socket ever reopened — job was still spinning `Reconnect-loop tick.` when captured.

- [ ] **Step 1: Write the failing test for the new URL classifier**

Add to `tests/bots/draft_sync.test.js`, in a new top-level `describe` block placed right before `describe("attachDraftListeners debug instrumentation", ...)`:

```javascript
describe("isDraftRoomSocketUrl", () => {
  it("recognizes the real ESPN draft-room JOIN socket", () => {
    expect(
      isDraftRoomSocketUrl(
        "wss://fantasydraft.espn.com/game-1/league-156611456/JOIN?1=1&2=156611456",
      ),
    ).toBe(true);
  });

  it("rejects the unrelated BAM/Disney identity-SDK socket", () => {
    expect(
      isDraftRoomSocketUrl(
        "wss://espn.connections.edge.bamgrid.com/5d3054/connection?X-Application-Version=0.0.1",
      ),
    ).toBe(false);
  });

  it("rejects an unrecognized socket URL rather than throwing", () => {
    expect(isDraftRoomSocketUrl("wss://example.com/socket")).toBe(false);
    expect(isDraftRoomSocketUrl("")).toBe(false);
  });
});
```

Add `isDraftRoomSocketUrl` to the destructured `require("../../src/bots/draft_sync")` import at the top of the test file (alongside the existing `attachDraftListeners` import).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "isDraftRoomSocketUrl"`
Expected: FAIL — `isDraftRoomSocketUrl is not a function` (not yet exported).

- [ ] **Step 3: Implement `isDraftRoomSocketUrl` and export it**

Add this function directly above `function attachDraftListeners(page, redisClient, state, hooks = {}) {` (line 869):

```javascript
/**
 * Distinguishes the real ESPN draft-room feed socket from any other WebSocket the page happens to
 * open — critically, Disney/BAM's identity-SDK socket (wss://espn.connections.edge.bamgrid.com/...),
 * which the rendered fantasy.espn.com page opens and reconnects independently of the draft itself
 * (observed reconnecting on its own ~30min cadence throughout a session with the draft-room socket
 * long dead). page.on("websocket") fires for EVERY socket the page opens, not just the draft
 * feed — attachDraftListeners must only count this one toward liveness/health, or the BAM socket's
 * unrelated churn permanently masks a dead draft-room connection (confirmed root cause of the
 * "connector goes silent forever" incident: isDead() and the ws_connected health field never
 * reflected the real socket's death because the BAM socket kept openSockets > 0).
 */
function isDraftRoomSocketUrl(url) {
  if (!url) return false;
  return url.includes("fantasydraft.espn.com") && url.includes("/JOIN");
}
```

Then add `isDraftRoomSocketUrl` to the `module.exports` object at the bottom of the file (alongside `attachDraftListeners`, `fetchDraftDetail`, etc.).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "isDraftRoomSocketUrl"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: add isDraftRoomSocketUrl classifier for WS liveness scoping"
```

- [ ] **Step 6: Write the failing test proving the current contamination bug**

Add to the existing `describe("attachDraftListeners debug instrumentation", ...)` block (after the existing `it("logs a debug line...")` test, ~line 371):

```javascript
  it("does NOT count an unrelated (non-draft-room) socket toward openSockets/lastActivityAt/isDead", () => {
    const start = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const pageListeners = {};
      const page = {
        url: () => "https://fantasy.espn.com/football/draft?x=1",
        on: jest.fn((event, cb) => {
          pageListeners[event] = cb;
        }),
      };
      const state = createDraftState();
      const handle = attachDraftListeners(page, {}, state);

      // The real draft-room JOIN socket opens and immediately closes (an eviction) at t=0.
      const draftWsListeners = {};
      pageListeners.websocket({
        url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",
        on: jest.fn((event, cb) => {
          draftWsListeners[event] = cb;
        }),
      });
      draftWsListeners.close();
      expect(handle.debugSnapshot().openSockets).toBe(0);

      // 40 seconds later (past WS_DEAD_GRACE_MS=30000), an unrelated BAM identity-SDK socket
      // opens and receives a frame — this must NOT resurrect openSockets or lastActivityAt for
      // the purposes of isDead(), since it carries no draft picks.
      jest.setSystemTime(start + 40000);
      const bamWsListeners = {};
      pageListeners.websocket({
        url: () => "wss://espn.connections.edge.bamgrid.com/5d3054/connection?X-Application-Version=0.0.1",
        on: jest.fn((event, cb) => {
          bamWsListeners[event] = cb;
        }),
      });
      bamWsListeners.framereceived({ payload: Buffer.from("PING PING%201700000000000") });

      expect(handle.debugSnapshot().openSockets).toBe(0);
      expect(handle.isDead()).toBe(true);
      expect(handle.hasOpenSocket()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
```

- [ ] **Step 7: Run test to verify it fails against current code**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "does NOT count an unrelated"`
Expected: FAIL — `openSockets` will be `1` and `isDead()` will be `false` after the BAM socket opens/receives a frame, because the current code counts every socket.

- [ ] **Step 8: Fix `attachDraftListeners` to scope tracking to the draft-room socket**

In `src/bots/draft_sync.js`, modify the `page.on("websocket", (ws) => {` handler (line 882) to early-return for non-draft-room sockets, and move the `state.health.ws.sockets_opened` increment inside the guarded branch. Current code (lines 882-899, abbreviated):

```javascript
  page.on("websocket", (ws) => {
    const socketId = (state.health.ws.sockets_opened += 1);
    logger.info(`[Draft Sync] WebSocket opened: ${ws.url()}`, {
      component: "draft_ws",
      socket_id: socketId,
    });
    openSockets += 1;
    lastActivityAt = Date.now();
    let framesOnThisSocket = 0;
    let picksOnThisSocket = 0;

    ws.on("framereceived", async (frame) => {
      lastActivityAt = Date.now();
      framesOnThisSocket += 1;
      state.health.ws.frames_received += 1;
      const line = frame.payload ? frame.payload.toString() : "";
```

Replace with:

```javascript
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (!isDraftRoomSocketUrl(url)) {
      // Not the draft-room feed (e.g. Disney/BAM's identity-SDK socket, which the rendered page
      // opens/reconnects independently of the draft) — logged at debug for visibility, but must
      // NOT touch openSockets/lastActivityAt/state.health.ws.*, or its own reconnect churn masks
      // a genuinely dead draft-room socket forever (confirmed root cause, see this function's
      // header comment and isDraftRoomSocketUrl's).
      logger.debug(`[Draft Sync] Ignoring non-draft-room WebSocket: ${url}`, {
        component: "draft_ws",
      });
      return;
    }

    const socketId = (state.health.ws.sockets_opened += 1);
    logger.info(`[Draft Sync] WebSocket opened: ${url}`, {
      component: "draft_ws",
      socket_id: socketId,
    });
    openSockets += 1;
    lastActivityAt = Date.now();
    let framesOnThisSocket = 0;
    let picksOnThisSocket = 0;

    ws.on("framereceived", async (frame) => {
      lastActivityAt = Date.now();
      framesOnThisSocket += 1;
      state.health.ws.frames_received += 1;
      const line = frame.payload ? frame.payload.toString() : "";
```

No other changes are needed inside the handler — everything below this point (INIT/SELECTED/ERROR/AUTOSUGGEST/SELECTING/AUTODRAFT parsing, the `ws.on("close", ...)` block at line 1033) now only ever runs for the real draft-room socket, since the function returned early for anything else.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "does NOT count an unrelated"`
Expected: PASS.

- [ ] **Step 10: Run the full existing test file to check for regressions**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js`
Expected: All tests PASS, including the pre-existing `attachDraftListeners debug instrumentation` test (it only ever used a single generic `"wss://fake"` socket URL — this will now be ignored by the new filter, so update that pre-existing test's fake URL to `"wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1"` so it still exercises the real code path). Make that one-line edit to the pre-existing test (~line 335: `url: () => "wss://fake",` → `url: () => "wss://fantasydraft.espn.com/game-1/league-1/JOIN?1=1",`) if it fails after Step 8.

- [ ] **Step 11: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: scope WS liveness/health tracking to the real draft-room socket

Fixes the confirmed root cause of picks silently stopping mid-draft: the
page also opens Disney/BAM's identity-SDK socket, which reconnects on its
own schedule unrelated to the draft. Because attachDraftListeners counted
every socket the page opened toward the same openSockets/lastActivityAt
liveness clock, that socket's unrelated churn kept isDead() (and the
ws_connected health field reported to fantasy-core-pipeline/fantasy-web-ui)
permanently reporting healthy even after the real draft-room JOIN socket
was evicted and never reconnected. Confirmed via two independent incident
logs (trackingId 13ccdbab... and ac341959...)."
```

---

### Task 2: Fix `consumeCommandsOnce`'s "$" cursor bug so delegated picks are ever actually consumed

**Files:**
- Modify: `src/bots/session_registry.js` (`consumeCommandsOnce`, and its use of `redisClient.xRead`)
- Test: `tests/bots/session_registry.test.js` (extend the existing `describe("publishCommand / consumeCommandsOnce", ...)` block, ~line 254)

**Newly confirmed evidence (found while re-verifying the user's claim that issue #70/#71's session-registry delegation already fixes duplicate-session eviction — it does not, in practice, ever engage):**

- `fantasy-browser-worker` PR #71 ("Session registry + delegation to stop draft_clicker from evicting draft_sync") merged 2026-08-27 12:47:45 -05:00 — *before* both incident runs re-examined here (14:32 and 16:39 local). Its stated fix: `draft_clicker.js` (queue name `draft_targets`) checks `decideOwnership()` before submitting a pick, and if `draft_sync.js` already owns a live session, delegates the pick over `draft_commands:{leagueId}` instead of opening a second, colliding JOIN.
- In the re-examined incident run (`trackingId=13ccdbab-8717-4385-8656-f38f71323980`), the delegation path *did* engage correctly on the `worker` side:
  - `14:33:22.696` — `"Live connector found (owner practice-draft-sync-1787859146-jpr8f) for league 156611456 — delegating pick submission via draft_commands:156611456 instead of opening a new session that would evict it."`
  - `14:33:27.701` (exactly `CONFIRM_TIMEOUT_MS` = 5000ms later) — `"Delegated pick submission timed out with no result — falling back to a direct session for this attempt."`
  - `14:33:27.701` — `"Connecting to draft room socket to submit pick..."` (opens the exact second, colliding JOIN #70/#71 exists to avoid)
  - `14:33:28.338` — `"SUCCESS: Pick submitted and confirmed for Christian McCaffrey (lineup slot 2)."`
- Querying the *owning* `draft_sync.js` pod's own logs (`pod="practice-draft-sync-1787859146-jpr8f"`) for `component="draft_commands"` across the **entire job lifetime** returns **zero** results — `draft_sync.js` never once logs receiving, executing, or timing out a delegated command, despite polling every `COMMAND_POLL_INTERVAL_MS` (1000ms) with no errors logged either. The delegation feature is a complete no-op on the consuming side, in every run, not just this one.
- Root cause: `consumeCommandsOnce` (`src/bots/session_registry.js`) initializes `lastIdRef.current = "$"` and keeps reusing the literal string `"$"` across every non-blocking `redisClient.xRead({key, id: lastIdRef.current}, ...)` call whenever no entries were returned (it only advances `lastIdRef.current` to a real message ID *after* successfully consuming one — which, with this bug, can never happen). This is a well-known Redis footgun: for a **non-blocking** `XREAD ... STREAMS key $` (no `BLOCK` option), the special ID `$` is resolved to "the stream's current last ID" *at the moment the command executes*, and the command then asks for entries with an ID greater than that — which by definition can never exist yet, since the read is synchronous and non-blocking. `$` only ever "picks up new entries going forward" inside a **blocking** `XREAD ... BLOCK <ms>` call, where `$` is resolved once and the connection then waits. This code deliberately avoids `BLOCK` (see the existing comment: "draft_sync.js's event loop is already juggling several setInterval-driven tasks... a blocking read would stall all of them") but never replaces the non-blocking `$` with a real starting ID, so `consumeCommandsOnce` returns `[]` on literally every call, forever, for the life of the process.
- The existing test suite did not catch this because `tests/bots/session_registry.test.js`'s `xRead` mock returns canned messages regardless of what `id` it's called with (`makeFakeRedisClient({ xRead: jest.fn().mockResolvedValueOnce([...]) })`) — it asserts `consumeCommandsOnce` *calls* `xRead` with `id: "$"`, but never exercises real Redis's actual "always empty for `$` without `BLOCK`" semantics, so a test suite passing 100% coexisted with a completely non-functional feature in production.
- **Consequence for "does this fix picks not going through":** No — every delegated pick submission, every single time, silently times out after 5s and falls through to `draft_clicker.js`'s pre-#70 "safety net" of opening a brand-new raw JOIN via `connectToDraftRoom`. That fallback JOIN is exactly the kind of second, colliding session #70/#71 exists to prevent — it happened to succeed harmlessly in the run above only because `draft_sync.js`'s own observer JOIN had *already* been evicted by something else ~2.2s earlier (14:33:25.476, the `LEFT` frame — a separate, unattributed eviction event, still not caused by this fallback since it precedes it), so there was no live session left for the fallback JOIN to collide with in that instance. On a draft where `draft_sync.js`'s socket is still alive and healthy at pick time, this same fallback path would reproduce the original #70 collision on every single pick, not just during an already-degraded session — the delegation mechanism provides no actual protection today.

- [ ] **Step 1: Write a failing test proving `consumeCommandsOnce` can consume entries published *before* its first poll call, using a per-ID-aware fake `xRead` (not a canned-response mock)**

Add to `tests/bots/session_registry.test.js`, in the `publishCommand / consumeCommandsOnce` describe block:

```js
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
  const client = makeFakeRedisClient({ xRead });

  const lastIdRef = { current: undefined };
  const commands = await consumeCommandsOnce(client, "42", lastIdRef);

  expect(commands).toEqual([{ command_id: "a", command: "submit_pick" }]);
  expect(lastIdRef.current).toBe("1-1");
});
```

Run: `cd fantasy-browser-worker && npx jest tests/bots/session_registry.test.js`
Expected: FAILS — `consumeCommandsOnce` calls `xRead` with `id: "$"` on the fresh consumer's first poll, the fake correctly returns `null` for that (matching real Redis), so `commands` is `[]`, not the expected entry.

- [ ] **Step 2: Resolve a real starting cursor instead of reusing literal `"$"`**

In `consumeCommandsOnce`, replace the `if (!lastIdRef.current) lastIdRef.current = "$";` priming with a one-time resolution to the stream's actual current tail ID via `XREVRANGE key + - COUNT 1` (a normal, non-blocking read of the single most recent entry, if any) — a real ID from here works correctly as a non-blocking `XREAD ... id` cursor going forward, unlike the literal `"$"`:

```js
async function resolveInitialCursor(redisClient, leagueId) {
  try {
    const latest = await redisClient.xRevRange(commandStreamKey(leagueId), "+", "-", {
      COUNT: 1,
    });
    if (latest && latest.length > 0) return latest[0].id;
  } catch (err) {
    logger.warn(
      `[Session Registry] Could not resolve an initial draft_commands:${leagueId} cursor — ` +
        `defaulting to "0" (replays anything already on the stream once): ${err.message}`,
      { component: "session_registry", err },
    );
  }
  // No entries yet, or the lookup failed: "0" is a valid XREAD starting id meaning "from the
  // very start of the stream" — safe here since a fresh draft's command stream is empty anyway,
  // and on a lookup failure it trades a possible one-time replay of already-handled commands
  // (idempotent: draft_sync.js's own SELECTED-frame correlation ignores anything that isn't its
  // current state.pendingCommand) for the alternative of silently consuming nothing forever.
  return "0";
}
```

Update `consumeCommandsOnce` to call this once per fresh consumer:

```js
async function consumeCommandsOnce(
  redisClient,
  leagueId,
  lastIdRef,
  { count = 10 } = {},
) {
  if (!lastIdRef.current) {
    lastIdRef.current = await resolveInitialCursor(redisClient, leagueId);
  }
  // ...rest unchanged (xRead with lastIdRef.current, advance past consumed messages)
}
```

Export `resolveInitialCursor` alongside the module's other exports for direct unit testing.

- [ ] **Step 3: Run the failing test again**

Run: `cd fantasy-browser-worker && npx jest tests/bots/session_registry.test.js`
Expected: The Step 1 test now needs its fake `xRevRange` added (`makeFakeRedisClient` likely needs an `xRevRange` stub returning `[]` for a fresh stream, or `[{id: "0-0"}]`/similar — adjust the test's fake client setup accordingly since `resolveInitialCursor` calls it before the first `xRead`). Once wired, PASSES.

- [ ] **Step 4: Add a regression test for the exact incident: a command published *after* the consumer starts polling must still be seen on the very next poll**

```js
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
```

Run: `cd fantasy-browser-worker && npx jest tests/bots/session_registry.test.js`
Expected: All tests PASS, including the two new ones and the four pre-existing ones (the pre-existing "defaults to `$`" assertion at ~line 297 must be updated: it should now assert the *first* `xRead` call uses the ID `resolveInitialCursor` resolved to for its fake `xRevRange` response, not the literal string `"$"` — adjust that one assertion, since asserting literal `"$"` was itself testing for the bug).

- [ ] **Step 5: Run the full session_registry + draft_clicker suites together (draft_clicker.test.js mocks this module — confirm nothing there assumed the old `"$"` behavior)**

Run: `cd fantasy-browser-worker && npx jest tests/bots/session_registry.test.js tests/bots/draft_clicker.test.js tests/bots/draft_sync.test.js`
Expected: All PASS.

- [ ] **Step 6: Lint**

Run: `cd fantasy-browser-worker && npm run lint`
Expected: No new warnings/errors.

- [ ] **Step 7: Commit**

```bash
git add src/bots/session_registry.js tests/bots/session_registry.test.js
git commit -m "session_registry: fix consumeCommandsOnce never actually consuming commands

Non-blocking XREAD with the literal id \"$\" always returns empty in real
Redis (\"$\" only picks up new entries going forward inside a *blocking*
XREAD) — consumeCommandsOnce kept reusing \"$\" every poll instead of
advancing to a real message ID, so draft_sync.js never processed a single
delegated pick command in production. Confirmed via zero component=
draft_commands log lines across an entire incident job's lifetime, despite
draft_clicker.js correctly delegating and then timing out 5s later on
every attempt and falling back to the pre-#70 raw-JOIN path #70/#71 was
built to eliminate. Fixes the delegation feature added in #70/#71, which
was a complete no-op on the consuming side until now."
```

---

### Task 3: Terminate cleanly on a permanent (unrecoverable) error instead of retrying forever

**Files:**
- Modify: `src/bots/draft_sync.js` — `reconcileFromRest` (~line 609-634), `fetchDraftDetail` (~line 465-506), the periodic session-check callback inside `connectAndStream` (~line 1622-1638), the main `while` loop condition (~line 1683), `streamLiveDraftRoom`'s outer catch (~line 1840-1858)
- Test: `tests/bots/draft_sync.test.js`

**Interfaces:**
- Consumes: `PermanentError` from `../errors` (already imported elsewhere in the codebase, e.g. `espn_api.js`; `draft_sync.js` needs to add this import).
- Produces: `state.permanentError` (new field on the object returned by `createDraftState()`, parallel to the existing `state.sessionExpiredError`). Consumed by the main `while` loop guard and by `streamLiveDraftRoom`'s outer error handling.

**Evidence this task fixes:**
- Log: `[Draft Sync] Periodic session check failed: [Session Health] League 156611456 not found (HTTP 404) — the room no longer exists (ended, cancelled, or never existed for this season); retrying can't help.` — this exact message repeated every ~15s from `21:15:53Z` to at least `21:32:24Z` (17+ minutes, still going when captured) with **zero effect on the job's behavior** other than the log line.
- `session_health.js`'s `assertCookieSessionValid` (already, correctly) throws this as a `PermanentError` — but the periodic-check callback in `draft_sync.js` (~line 1622-1638) only special-cases `SessionExpiredError` (setting `state.sessionExpiredError`); every other error type (including `PermanentError`) falls into the generic `else` branch, which just logs and does nothing further. The main `while` loop (~line 1683) only checks `state.sessionExpiredError`, so a `PermanentError` here is silently swallowed forever.
- `reconcileFromRest`'s catch block (~line 627) has the identical gap: `fetchDraftDetail` throws a plain `Error` (not `PermanentError`) for its own `LEAGUE_NOT_FOUND_DELETED` case (~line 471-481) as well as for any other non-ok HTTP status (~line 484), so even a definitively-permanent REST failure just increments `state.health.rest.failed_polls` forever with no termination path — this is why `failed_polls` reached 462 in the incident run (roughly one failure per 15s REST-reconcile tick for nearly the entire ~1h55m pod lifetime).

- [ ] **Step 1: Write the failing test for `fetchDraftDetail` classifying `LEAGUE_NOT_FOUND_DELETED` as permanent**

Add to `tests/bots/draft_sync.test.js`, in the existing `describe` block that already covers `fetchDraftDetail` (search for `describe("fetchDraftDetail"` — reuse it):

```javascript
  it("throws a PermanentError (not a plain Error) for LEAGUE_NOT_FOUND_DELETED", async () => {
    const state = { leagueId: "156611456", seasonId: "2026" };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({ type: "LEAGUE_NOT_FOUND_DELETED" }),
        }),
      },
    };
    await expect(fetchDraftDetail(context, state)).rejects.toThrow(
      PermanentError,
    );
  });

  it("throws a PermanentError for any other non-ok HTTP status from mDraftDetail", async () => {
    const state = { leagueId: "156611456", seasonId: "2026" };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({}),
        }),
      },
    };
    await expect(fetchDraftDetail(context, state)).rejects.toThrow(
      PermanentError,
    );
  });
```

Add `const { PermanentError } = require("../../src/errors");` to the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "LEAGUE_NOT_FOUND_DELETED"`
Expected: FAIL — current code throws a plain `Error`, so `.rejects.toThrow(PermanentError)` fails (wrong constructor).

- [ ] **Step 3: Make `fetchDraftDetail` throw `PermanentError` for unrecoverable REST failures**

Add the import at the top of `src/bots/draft_sync.js` (alongside the existing `require("./session_health")` block):

```javascript
const { PermanentError, SessionExpiredError } = require("../errors");
```

(Note: `SessionExpiredError` is already imported at the top of the file — check the existing `require("../errors")` line and merge into one line rather than duplicating the require call.)

Replace `fetchDraftDetail`'s current error handling (~lines 465-485):

```javascript
async function fetchDraftDetail(context, state) {
  const response = await context.request.get(
    buildDraftDetailUrl(state.leagueId, state.seasonId),
  );
  if (!response.ok()) {
    try {
      const body = await response.json();
      if (body?.type === "LEAGUE_NOT_FOUND_DELETED") {
        throw new Error(
          `Draft room league ${state.leagueId} no longer exists (LEAGUE_NOT_FOUND_DELETED). ` +
            "Set DRAFT_ROOM_URL to a newly joined active mock draft room URL and retry.",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("LEAGUE_NOT_FOUND_DELETED")
      ) {
        throw error;
      }
    }
    throw new Error(`mDraftDetail fetch failed: HTTP ${response.status()}`);
  }
```

with:

```javascript
async function fetchDraftDetail(context, state) {
  const response = await context.request.get(
    buildDraftDetailUrl(state.leagueId, state.seasonId),
  );
  if (!response.ok()) {
    try {
      const body = await response.json();
      if (body?.type === "LEAGUE_NOT_FOUND_DELETED") {
        throw new PermanentError(
          `Draft room league ${state.leagueId} no longer exists (LEAGUE_NOT_FOUND_DELETED). ` +
            "Set DRAFT_ROOM_URL to a newly joined active mock draft room URL and retry.",
        );
      }
    } catch (error) {
      if (error instanceof PermanentError) {
        throw error;
      }
    }
    // Every other non-ok mDraftDetail response (404, 5xx, etc.) is treated as permanent for THIS
    // league too: confirmed live (2026-08-27) that a room's mDraftDetail keeps 404ing identically
    // on every ~15s reconcile tick once the room ends — there is no status code this endpoint
    // returns that recovers on retry once the practice room itself is gone (see this function's
    // header re: mDraftDetail's known behavior for ephemeral rooms). A transient network blip
    // would throw before reaching this line (a rejected fetch, not an ok()-false response), so
    // this branch is specifically "the server answered and said no" — which for this endpoint has
    // no observed transient case.
    throw new PermanentError(
      `mDraftDetail fetch failed: HTTP ${response.status()}`,
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "PermanentError"`
Expected: PASS (both new tests).

- [ ] **Step 5: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: classify unrecoverable mDraftDetail failures as PermanentError"
```

- [ ] **Step 6: Write the failing test for `reconcileFromRest` storing a permanent error on state**

Add a new `describe` block near the existing `reconcileFromRest`-adjacent tests (search the test file for where `reconcileFromRest` is exported/tested; if it is not currently exported, add it to `module.exports` in `draft_sync.js` first so it's directly testable):

```javascript
describe("reconcileFromRest permanent-error handling", () => {
  it("stores a PermanentError on state.permanentError instead of only counting it as a failed poll", async () => {
    const state = {
      leagueId: "156611456",
      seasonId: "2026",
      health: { rest: { polls: 0, empty_polls: 0, failed_polls: 0 } },
      permanentError: null,
    };
    const context = {
      request: {
        get: jest.fn().mockResolvedValue({
          ok: () => false,
          status: () => 404,
          json: () => Promise.resolve({}),
        }),
      },
    };
    await reconcileFromRest(context, {}, state);
    expect(state.health.rest.failed_polls).toBe(1);
    expect(state.permanentError).toBeInstanceOf(PermanentError);
  });

  it("does not touch state.permanentError for an ordinary (transient) REST failure", async () => {
    const state = {
      leagueId: "156611456",
      seasonId: "2026",
      health: { rest: { polls: 0, empty_polls: 0, failed_polls: 0 } },
      permanentError: null,
    };
    const context = {
      request: {
        get: jest.fn().mockRejectedValue(new Error("network blip")),
      },
    };
    await reconcileFromRest(context, {}, state);
    expect(state.health.rest.failed_polls).toBe(1);
    expect(state.permanentError).toBeNull();
  });
});
```

Add `reconcileFromRest` to the test file's destructured import from `../../src/bots/draft_sync`.

- [ ] **Step 7: Run test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "permanent-error handling"`
Expected: FAIL — `reconcileFromRest` is not yet exported and/or `state.permanentError` is never set.

- [ ] **Step 8: Export `reconcileFromRest`, add `permanentError` to `createDraftState`, and update the catch block**

In `createDraftState()` (~line 1238-1296), add a new field alongside the existing `sessionExpiredError: null,`:

```javascript
    sessionExpiredError: null,
    // Set when a definitively-unrecoverable error is observed from any ingest tier (REST 404s
    // that will never resolve, ESPN confirming the room is gone) — parallel to
    // sessionExpiredError, but for errors a session refresh can never fix. Checked by the same
    // reconnect-loop guard; see connectAndStream's main while loop and streamLiveDraftRoom's
    // outer catch for how the two differ in retry behavior.
    permanentError: null,
```

Update `reconcileFromRest`'s catch block (~lines 626-632) from:

```javascript
  } catch (err) {
    state.health.rest.failed_polls += 1;
    logger.error(`[Draft Sync] REST reconciliation failed: ${err.message}`, {
      component: "draft_ingest",
      source: "rest",
      err,
    });
  }
```

to:

```javascript
  } catch (err) {
    state.health.rest.failed_polls += 1;
    if (err instanceof PermanentError) {
      state.permanentError = err;
    }
    logger.error(`[Draft Sync] REST reconciliation failed: ${err.message}`, {
      component: "draft_ingest",
      source: "rest",
      err,
    });
  }
```

Add `reconcileFromRest` to the `module.exports` object at the bottom of `draft_sync.js`.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "permanent-error handling"`
Expected: PASS (both tests).

- [ ] **Step 10: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: record PermanentError from REST reconciliation on state.permanentError"
```

- [ ] **Step 11: Write the failing test for the periodic session-check callback storing `PermanentError` too**

This requires driving `connectAndStream` end-to-end, which the existing `describe("connectAndStream", ...)` block already does with full mocking (see `~line 373` onward for the established pattern: mocked `createAuthenticatedSession`, fake timers, etc.). Add a new test inside that block:

```javascript
  it("stores a PermanentError from the periodic session check on state.permanentError (not just sessionExpiredError)", async () => {
    // Reuses this describe block's existing session/page mocks — see the beforeEach above and
    // the neighboring tests in this block for the established connectAndStream test harness
    // (mocked createAuthenticatedSession, fake WS/page, fake timers). Configure
    // assertCookieSessionValid to reject with a PermanentError on its first periodic-check tick,
    // then advance fake timers past REST_RECONCILE_INTERVAL_MS and assert
    // state.permanentError is set and the connectAndStream cycle exits rather than looping
    // forever logging the same error.
    assertCookieSessionValid.mockRejectedValueOnce(
      new PermanentError("League not found (HTTP 404)"),
    );
    // ... drive connectAndStream with this module's existing harness, advance timers by
    // REST_RECONCILE_INTERVAL_MS (15000ms), then assert:
    // expect(state.permanentError).toBeInstanceOf(PermanentError);
  });
```

(Implementer note: fill in the exact harness calls by copying the setup from the immediately-preceding test in this `describe` block — the file already has a full working pattern for mocking `createAuthenticatedSession`'s page/context and advancing fake timers to trigger the `reconcileInterval` tick; do not invent a new mocking approach.)

- [ ] **Step 12: Run test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "PermanentError from the periodic session check"`
Expected: FAIL — `state.permanentError` stays `null`.

- [ ] **Step 13: Update the periodic session-check callback**

In `connectAndStream`, update the periodic check (~lines 1622-1638) from:

```javascript
      try {
        await assertCookieSessionValid(session.context, {
          leagueId: state.leagueId,
          seasonId: state.seasonId,
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          logger.error(
            `[Draft Sync] ESPN session appears to have expired mid-draft: ${err.message}`,
            { err },
          );
          state.sessionExpiredError = err;
        } else {
          logger.error(
            `[Draft Sync] Periodic session check failed: ${err.message}`,
            { err },
          );
        }
      }
```

to:

```javascript
      try {
        await assertCookieSessionValid(session.context, {
          leagueId: state.leagueId,
          seasonId: state.seasonId,
        });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          logger.error(
            `[Draft Sync] ESPN session appears to have expired mid-draft: ${err.message}`,
            { err },
          );
          state.sessionExpiredError = err;
        } else if (err instanceof PermanentError) {
          // Confirmed live 2026-08-27: without this branch, a room that has ended keeps 404ing
          // this same check every REST_RECONCILE_INTERVAL_MS (15s) forever — logged 60+ times
          // over 17+ minutes with zero effect, since only SessionExpiredError was ever escalated
          // out of this catch. A PermanentError here can never resolve on retry (the room is
          // gone), so it gets the same "stop looping, surface it" treatment.
          logger.error(
            `[Draft Sync] Periodic session check found an unrecoverable condition: ${err.message}`,
            { err },
          );
          state.permanentError = err;
        } else {
          logger.error(
            `[Draft Sync] Periodic session check failed: ${err.message}`,
            { err },
          );
        }
      }
```

Update the main `while` loop guard (~line 1683-1687) from:

```javascript
    while (!handle.isDead() && !totalPicksReached() && !state.draftCompleted) {
      // Retrying REST reconciliation forever against an expired session is pointless the same way
      // retrying a doomed pick is — throw out to streamLiveDraftRoom's reconnect-with-backoff
      // rather than spinning here until the outer WS_DEAD_GRACE_MS watchdog eventually notices.
      if (state.sessionExpiredError) {
        throw state.sessionExpiredError;
      }
```

to:

```javascript
    while (!handle.isDead() && !totalPicksReached() && !state.draftCompleted) {
      // Retrying REST reconciliation forever against an expired session is pointless the same way
      // retrying a doomed pick is — throw out to streamLiveDraftRoom's reconnect-with-backoff
      // rather than spinning here until the outer WS_DEAD_GRACE_MS watchdog eventually notices.
      if (state.sessionExpiredError) {
        throw state.sessionExpiredError;
      }
      // A permanent error (room confirmed gone, e.g. HTTP 404 "LEAGUE_NOT_FOUND_DELETED") can
      // never resolve on any retry — throw out immediately rather than waiting for isDead()'s
      // 30s grace window or looping this check every 15s. streamLiveDraftRoom's outer catch
      // recognizes PermanentError and exits without backoff/retry (see that function's changes).
      if (state.permanentError) {
        throw state.permanentError;
      }
```

- [ ] **Step 14: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js -t "PermanentError from the periodic session check"`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: escalate PermanentError from the periodic session check instead of looping forever"
```

- [ ] **Step 16: Write the failing test for `streamLiveDraftRoom` exiting immediately (no backoff/retry) on a `PermanentError`**

Search the test file for the existing `describe("streamLiveDraftRoom"` or equivalent outer-loop tests (if none exist yet, add a focused test near `decideReconnectAction`'s tests instead, since `streamLiveDraftRoom` itself is harder to unit test directly — check what's already exported/testable before deciding). If `streamLiveDraftRoom` is not currently exported/tested directly, add this test at the `decideReconnectAction` level instead, since that is the already-unit-tested pure decision function `streamLiveDraftRoom`'s outer catch should defer to for a thrown `PermanentError` too — NOT the same as its current `error path` (attempt += 1, backoff, retry). Concretely:

```javascript
describe("decideReconnectAction with a thrown PermanentError", () => {
  // streamLiveDraftRoom's outer catch (not decideReconnectAction itself, which only runs on a
  // clean connectAndStream return) must special-case a thrown PermanentError the same way
  // decideReconnectAction's terminal branch does: exit without backoff/retry. This test
  // documents the expected contract at the decision-table level; see streamLiveDraftRoom's own
  // catch block for the actual thrown-error branch this parallels.
  it("is not consulted for a thrown PermanentError — that path exits immediately in streamLiveDraftRoom's catch, never reaching decideReconnectAction", () => {
    // No-op assertion documenting intent; the real behavioral test is
    // "streamLiveDraftRoom exits without looping on PermanentError" below.
    expect(true).toBe(true);
  });
});
```

(Implementer note: if `streamLiveDraftRoom` already has a testable seam in this file — check before assuming it doesn't — write a direct behavioral test there instead of the documentation-only placeholder above. Do not ship the placeholder as final; replace it once the actual seam is confirmed.)

- [ ] **Step 17: Update `streamLiveDraftRoom`'s outer catch to exit immediately on `PermanentError`**

In `streamLiveDraftRoom` (~lines 1839-1858), change:

```javascript
      try {
        result = await connectAndStream(redisClient, state);
      } catch (error) {
        attempt += 1;
        // >= , not > — see decideReconnectAction's matching comment; keeps this path's boundary
        // consistent with it (both cap at exactly MAX_RECONNECT_ATTEMPTS connectAndStream calls).
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          throw new Error(
            "Exceeded max reconnect attempts for live draft stream.",
          );
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        logger.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${delay}ms...`,
          { err: error, attempt },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
```

to:

```javascript
      try {
        result = await connectAndStream(redisClient, state);
      } catch (error) {
        if (error instanceof PermanentError) {
          // Confirmed live 2026-08-27: retrying against a room ESPN has confirmed gone
          // (LEAGUE_NOT_FOUND_DELETED / a 404 that repeats identically) burned 17+ minutes of
          // reconnect attempts with zero chance of success. No backoff/attempt budget applies —
          // this condition cannot resolve on any retry, so exit exactly like a confirmed-complete
          // draft does (decision.action === "exit_clean"), not like a transient crash.
          logger.error(
            `[Draft Sync] Unrecoverable condition — exiting without further reconnect attempts: ` +
              `${error.message}`,
            { err: error },
          );
          return;
        }
        attempt += 1;
        // >= , not > — see decideReconnectAction's matching comment; keeps this path's boundary
        // consistent with it (both cap at exactly MAX_RECONNECT_ATTEMPTS connectAndStream calls).
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          throw new Error(
            "Exceeded max reconnect attempts for live draft stream.",
          );
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        logger.error(
          `[Draft Sync] Session crashed (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}): ` +
            `${error.message}. Reconnecting in ${delay}ms...`,
          { err: error, attempt },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
```

Add `PermanentError` to `draft_sync.js`'s existing `require("../errors")` import (it should already be added from Step 3 above — verify it's in scope in this function; `errors.js` exports are module-level so no additional import is needed within the same file).

- [ ] **Step 18: Replace the Step 16 placeholder test with a real behavioral test now that the seam exists**

Now that `streamLiveDraftRoom`'s catch has a concrete, testable branch, remove the placeholder `describe("decideReconnectAction with a thrown PermanentError", ...)` block from Step 16 and, if `streamLiveDraftRoom` is exported from `draft_sync.js` (check `module.exports` at the bottom of the file — add it if missing, mirroring how `connectAndStream` is already exported), add:

```javascript
describe("streamLiveDraftRoom PermanentError handling", () => {
  it("exits immediately without backoff/retry when connectAndStream throws a PermanentError", async () => {
    // Mirrors this file's existing redis-mocking pattern used elsewhere for streamLiveDraftRoom-
    // adjacent tests (redis.createClient mocked to return a client whose connect()/quit() resolve
    // immediately). connectAndStream itself is not re-mocked here — instead, drive it to throw by
    // making createAuthenticatedSession (already jest.mock'd at the top of this file) reject with
    // a PermanentError, since that is the shortest real path to connectAndStream throwing one.
    createAuthenticatedSession.mockRejectedValue(
      new PermanentError("League not found (HTTP 404)"),
    );
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    await streamLiveDraftRoom();
    // No reconnect delay should have been scheduled — the PermanentError branch returns
    // immediately instead of awaiting a backoff delay like the generic crash path does.
    const backoffCalls = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms >= RECONNECT_BASE_DELAY_MS,
    );
    expect(backoffCalls.length).toBe(0);
    setTimeoutSpy.mockRestore();
  });
});
```

(Implementer note: confirm `streamLiveDraftRoom`, `RECONNECT_BASE_DELAY_MS`, and `PermanentError` are all importable in the test file — add each to `module.exports`/the test's `require` calls as needed. If `streamLiveDraftRoom` currently isn't structured for this style of test in practice, adapt the assertion to whatever the working pattern for this file's existing outer-loop-adjacent tests is, but the invariant under test — "a thrown PermanentError causes an immediate return with no backoff delay" — must not be dropped.)

- [ ] **Step 19: Run the full test file to verify everything passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_sync.test.js`
Expected: All tests PASS.

- [ ] **Step 20: Commit**

```bash
git add src/bots/draft_sync.js tests/bots/draft_sync.test.js
git commit -m "draft_sync: exit streamLiveDraftRoom immediately (no backoff) on a PermanentError"
```

---

### Task 4: Distinguish "DOM selector is stale" from "the rendered page never showed draft content at all" in the DOM fallback tier's diagnostics

**Files:**
- Modify: `src/bots/draft_dom_observer.js` (the in-page `scanInPage` function, ~lines 108-190, and the diagnostics returned to `attachDraftDomObserver`, ~lines 240-290)
- Test: `tests/bots/draft_dom_observer.test.js`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: an additional `page_gated` boolean field on `scanInPage`'s return value and on the selector-miss log payload, plus a `login_gate_detected` field surfaced in `getHealth()`'s snapshot (parallel to the existing `selector_miss_streak`).

**Evidence this task addresses:**
- In the incident run, the very first selector-miss log (`streak: 1`, captured with its full `sample_html`) shows `"player_id_nodes":0` — i.e., `document.querySelectorAll("[data-player-id]").length` found **zero** matches anywhere on the entire page, not just within the 2000-char HTML sample. This was true on every single scan for the rest of the session (`selector_miss_streak` climbed to 1442 with `recovered_picks: 0` throughout).
- `draft_dom_observer.js`'s own header comment documents (see `session_health.js`'s `assertRenderedSessionValid` and its own cross-reference) that ESPN's rendered draft-room page additionally gates behind a full Disney/MyDisney BAM-SDK identity session — cookie-only auth (which is all this bot has) is "sufficient for everything [the WS/REST bots do]... but... a Playwright-rendered draft room page shows 'Log in Required' even while [the] raw socket keeps working perfectly against the exact same league/cookies."
- Given `player_id_nodes: 0` for the ENTIRE session (not just an occasional miss), the far more likely explanation for this specific incident is that the rendered page was stuck behind that login-required gate the whole time — NOT that the CSS selectors in `PICK_STRATEGIES` are stale. But the current code cannot distinguish these two failure modes from its own logs: both look identical ("selector miss, 0 records, 0 player_id_nodes"). Guessing at a "fixed" selector without being able to confirm which failure mode actually occurred would be exactly the unverifiable guess `draft_dom_observer.js`'s own header explicitly warns against.
- This task does not change `PICK_STRATEGIES` (there is no verified real captured markup to update them from — this incident's `sample_html` was truncated within static SVG icon-sprite boilerplate before reaching any real board content, and `player_id_nodes: 0` shows there was no board content to reach). It closes the diagnostic gap so the *next* incident's logs make the actual failure mode unambiguous.

- [ ] **Step 1: Write the failing test for detecting the login-required gate in-page**

Add to `tests/bots/draft_dom_observer.test.js` (check the existing test file's pattern for invoking `scanInPage` — it runs in a simulated DOM via `jsdom` or a hand-built fake `document`; follow whatever pattern the existing `describe("scanInPage"` block already uses):

```javascript
describe("scanInPage login-gate detection", () => {
  it("reports page_gated: true when the BAM/Disney 'Log in Required' overlay is present and no player-id nodes exist", () => {
    document.body.innerHTML =
      '<div class="modal"><h2>Log in Required</h2><p>You must be signed in to view this draft room.</p></div>';
    const result = scanInPage({
      strategies: PICK_STRATEGIES,
      sampleChars: 2000,
    });
    expect(result.player_id_nodes).toBe(0);
    expect(result.page_gated).toBe(true);
  });

  it("reports page_gated: false when the board has real player-id nodes, even if no strategy matches", () => {
    document.body.innerHTML =
      '<div data-player-id="4362249" data-not-team-id="x"></div>';
    const result = scanInPage({
      strategies: [{ name: "nonexistent", selector: ".no-such-class" }],
      sampleChars: 2000,
    });
    expect(result.player_id_nodes).toBe(1);
    expect(result.page_gated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_dom_observer.test.js -t "login-gate detection"`
Expected: FAIL — `result.page_gated` is `undefined`.

- [ ] **Step 3: Implement the login-gate check in `scanInPage`**

In `src/bots/draft_dom_observer.js`, inside `scanInPage` (the in-page function, ~line 108), add a gate check and include it in the return value. Find the existing return statement (~lines 185-192):

```javascript
  return {
    records,
    matched_strategy: matchedStrategy,
    diagnostics,
    sample_html: sampleHtml,
    player_id_nodes: document.querySelectorAll("[data-player-id]").length,
    url: location.href,
  };
```

Replace with:

```javascript
  const playerIdNodeCount = document.querySelectorAll("[data-player-id]").length;
  // Confirmed incident (2026-08-27, both trackingId 13ccdbab... and ac341959...): a selector miss
  // with ZERO player_id_nodes anywhere on the page — not just within a strategy's selector, the
  // WHOLE document — was indistinguishable in the logs from a genuinely stale CSS selector, when
  // the far more likely explanation (per this file's header, and session_health.js's documented
  // BAM-SDK "Log in Required" gate on rendered pages) is that the page never rendered draft
  // content at all. This is a best-effort text-based check, not a verified selector of its own —
  // ESPN's login-gate markup has not been captured any more than the board's has — but it costs
  // nothing extra (same scan, same page) and turns "which failure mode was this?" from a guess
  // into a fact the next incident's logs can show directly.
  const pageGated =
    playerIdNodeCount === 0 &&
    /log\s*in\s*required/i.test(document.body ? document.body.innerText || document.body.textContent || "" : "");

  return {
    records,
    matched_strategy: matchedStrategy,
    diagnostics,
    sample_html: sampleHtml,
    player_id_nodes: playerIdNodeCount,
    page_gated: pageGated,
    url: location.href,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_dom_observer.test.js -t "login-gate detection"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/bots/draft_dom_observer.js tests/bots/draft_dom_observer.test.js
git commit -m "draft_dom_observer: detect BAM/Disney login-required gate in scanInPage"
```

- [ ] **Step 6: Write the failing test for surfacing the gate in `attachDraftDomObserver`'s health/logs**

Add to the existing `describe` block covering `attachDraftDomObserver` in `tests/bots/draft_dom_observer.test.js` (find its current selector-miss test for the closest precedent):

```javascript
  it("surfaces page_gated in both the selector-miss log payload and getHealth()", async () => {
    const page = {
      isClosed: () => false,
      evaluate: jest.fn().mockResolvedValue({
        records: [],
        matched_strategy: null,
        diagnostics: [{ name: "generic-player-team-pair", matched: 0 }],
        sample_html: "<div>Log in Required</div>",
        player_id_nodes: 0,
        page_gated: true,
        url: "https://fantasy.espn.com/football/draft?leagueId=1",
      }),
      exposeBinding: jest.fn().mockResolvedValue(undefined),
    };
    const warnSpy = jest.spyOn(logger, "warn");
    const handle = await attachDraftDomObserver(page, { pollIntervalMs: 999999 });
    expect(
      warnSpy.mock.calls.some(([, fields]) => fields?.page_gated === true),
    ).toBe(true);
    expect(handle.getHealth().login_gate_detected).toBe(true);
    warnSpy.mockRestore();
    await handle.stop();
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_dom_observer.test.js -t "surfaces page_gated"`
Expected: FAIL — `getHealth().login_gate_detected` is `undefined`, and the warn log's `fields` doesn't carry `page_gated`.

- [ ] **Step 8: Wire `page_gated` through `attachDraftDomObserver`'s health object and selector-miss log**

In `src/bots/draft_dom_observer.js`, add `login_gate_detected: false` to the `health` object literal near the top of `attachDraftDomObserver` (alongside the existing `selector_miss_streak: 0,`):

```javascript
  const health = {
    attached: false,
    scans: 0,
    failed_scans: 0,
    last_scan_at: null,
    last_matched_strategy: null,
    last_record_count: 0,
    selector_miss_streak: 0,
    login_gate_detected: false,
    observer_installed: false,
  };
```

In `scanNow`, update the selector-miss branch (inside `if (!result.matched_strategy) { ... }`) to track and log the gate. Current code:

```javascript
      if (!result.matched_strategy) {
        health.selector_miss_streak += 1;
        // Escalating cadence: ...
        if (
          health.selector_miss_streak === 1 ||
          health.selector_miss_streak % 12 === 0
        ) {
          log.warn(
            `[Draft DOM] Selector miss (streak ${health.selector_miss_streak}): no pick records ` +
              `extracted from the draft board. WS remains the only live source until this is fixed.`,
            {
              component: "draft_dom_observer",
              trigger,
              diagnostics: result.diagnostics,
              player_id_nodes: result.player_id_nodes,
              url: result.url,
              sample_html: result.sample_html,
            },
          );
        }
      } else {
```

Update to:

```javascript
      if (!result.matched_strategy) {
        health.selector_miss_streak += 1;
        if (result.page_gated) health.login_gate_detected = true;
        // Escalating cadence: ...
        if (
          health.selector_miss_streak === 1 ||
          health.selector_miss_streak % 12 === 0
        ) {
          log.warn(
            `[Draft DOM] Selector miss (streak ${health.selector_miss_streak}): no pick records ` +
              `extracted from the draft board. WS remains the only live source until this is fixed.` +
              (result.page_gated
                ? " Page appears gated behind ESPN's login-required overlay — this is likely NOT " +
                  "a stale selector; see session_health.js's assertRenderedSessionValid."
                : ""),
            {
              component: "draft_dom_observer",
              trigger,
              diagnostics: result.diagnostics,
              player_id_nodes: result.player_id_nodes,
              page_gated: result.page_gated,
              url: result.url,
              sample_html: result.sample_html,
            },
          );
        }
      } else {
```

Also update the strategy-recovered branch immediately below to reset the gate flag (mirroring how `selector_miss_streak` is reset), so a later successful scan after a transient gate clears the stale `true`:

```javascript
      } else {
        if (health.selector_miss_streak > 0) {
          log.info(
            `[Draft DOM] Selector recovered after ${health.selector_miss_streak} miss(es) via ` +
              `strategy "${result.matched_strategy}".`,
            { component: "draft_dom_observer", trigger },
          );
        }
        health.selector_miss_streak = 0;
        health.login_gate_detected = false;
      }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_dom_observer.test.js -t "surfaces page_gated"`
Expected: PASS.

- [ ] **Step 10: Run the full DOM observer test file to check for regressions**

Run: `cd fantasy-browser-worker && npx jest tests/bots/draft_dom_observer.test.js`
Expected: All tests PASS.

- [ ] **Step 11: Commit**

```bash
git add src/bots/draft_dom_observer.js tests/bots/draft_dom_observer.test.js
git commit -m "draft_dom_observer: surface login-gate detection in health + selector-miss logs"
```

---

### Task 5: Correct the mis-filed GitHub issue and record the confirmed root cause

**Files:** none (GitHub issue housekeeping only — no repo files change in this task).

**Interfaces:** none.

- [ ] **Step 1: Close the incorrectly-filed issue in `fantasy-core-pipeline`**

```bash
gh issue comment 108 --repo cvillarr23/fantasy-core-pipeline --body "Root-caused — this was filed in the wrong repo. The actual bug lives in \`fantasy-browser-worker\` (the Playwright-driven draft_sync bot), not this API/pipeline repo. Confirmed root cause and fix tracked in fantasy-browser-worker instead; closing here. See the new issue for the full write-up: <link filled in after Step 2>."
gh issue close 108 --repo cvillarr23/fantasy-core-pipeline
```

- [ ] **Step 2: Open the corrected issue in `fantasy-browser-worker` with the confirmed root cause**

```bash
gh issue create --repo cvillarr23/fantasy-browser-worker \
  --title "draft_sync: WS liveness watchdog masked by unrelated BAM-SDK socket churn — picks silently stop mid-draft, never reconnects" \
  --body-file <(cat <<'EOF'
## Confirmed root cause

`attachDraftListeners()` in `src/bots/draft_sync.js` tracks WebSocket liveness
(`openSockets`, `lastActivityAt` — the operands `isDead()` and the health
heartbeat's `ws_connected` field are computed from) across **every** WebSocket
the Playwright page opens. The rendered fantasy.espn.com page opens two:

1. The real draft-room feed: `wss://fantasydraft.espn.com/game-1/league-{id}/JOIN?...`
2. Disney/BAM's identity-SDK socket: `wss://espn.connections.edge.bamgrid.com/...`,
   which reconnects on its own independent schedule regardless of draft activity.

When (1) dies — confirmed via an ESPN-sent `LEFT` frame, i.e. a real eviction,
not a network blip — socket (2)'s unrelated churn keeps `openSockets > 0` and
keeps bumping `lastActivityAt`, so `isDead()` never trips and the reconnect
loop in `connectAndStream()`/`streamLiveDraftRoom()` waits forever on a socket
that will never come back. The same contaminated `openSockets` counter also
backs `hasOpenSocket()`, which is reported as `ws_connected` in the health
heartbeat written to Redis for `fantasy-core-pipeline`'s status endpoint (and,
downstream, `fantasy-web-ui`'s dashboard) — so the outage was invisible
end-to-end, not just to this bot.

Reproduced identically in two independent runs:
- `trackingId=13ccdbab-8717-4385-8656-f38f71323980` (league 156611456): JOIN
  socket opens 19:32:52Z, 7 picks in ~12s, `LEFT` + close at 19:33:25Z, never
  reopens for the remaining ~1h43m of the pod's life.
- `trackingId=ac341959-8c62-4700-a8e0-aef1171619a5` (league 1768748895): JOIN
  socket opens 21:39:00Z, 7 picks in ~10s, `LEFT` + close at 21:39:57Z, never
  reopens (still stuck when captured).

Two related gaps found in the same investigation:
- The periodic session-check's `PermanentError` (room confirmed gone, e.g.
  HTTP 404 `LEAGUE_NOT_FOUND_DELETED`) was only ever escalated for
  `SessionExpiredError` — a `PermanentError` just logged and retried every
  ~15s forever (observed: 17+ minutes / 60+ repeats in one run).
- The DOM board-scraper fallback reported `player_id_nodes: 0` for 100% of
  ~1442 scans across the whole session — almost certainly ESPN's documented
  BAM-SDK "Log in Required" render gate (see `session_health.js`'s
  `assertRenderedSessionValid`), not a stale CSS selector as originally
  suspected, but the logs couldn't previously distinguish the two.

A third, separately confirmed bug found while checking whether #70/#71's
session-registry pick delegation (merged earlier the same day, specifically
to stop `draft_clicker.js` from evicting `draft_sync.js`) actually prevented
this: it doesn't. `consumeCommandsOnce()` in `session_registry.js` keeps
reusing the literal Redis stream ID `"$"` across non-blocking `XREAD` polls;
`"$"` only ever picks up new entries *going forward* inside a **blocking**
`XREAD ... BLOCK <ms>` call — for a non-blocking read (used here deliberately,
to avoid stalling `draft_sync.js`'s other `setInterval` tasks) it resolves to
"the current tail" at call time and therefore always returns nothing. Result:
`draft_sync.js` logs zero `component="draft_commands"` activity across an
entire job's life, despite `draft_clicker.js` correctly detecting the live
owner and delegating every time. Every delegated pick silently times out
after 5s and falls back to the pre-#70 raw JOIN `draft_clicker.js` opens
directly — the exact collision #70/#71 exists to prevent, still reachable on
every pick submission today.

## Fix

See `docs/superpowers/plans/2026-08-27-draft-sync-ws-liveness-fix.md` for the
full task-by-task implementation plan (WS liveness scoping, PermanentError
propagation, DOM-gate diagnostics).

Originally mis-filed as fantasy-core-pipeline#108 — that repo isn't where this
bug lives; closed in favor of this issue.
EOF
)
```

- [ ] **Step 3: Update the plan file's header (once implemented) to link the final issue**

After Step 2 creates the issue, add its URL to the top of
`docs/superpowers/plans/2026-08-27-draft-sync-ws-liveness-fix.md` (a one-line
addition under the `**Spec:**` line) so the plan and the issue cross-reference
each other. No code change — documentation only.

---

## Post-plan verification (run once all 5 tasks are complete)

- [ ] `cd fantasy-browser-worker && npm test` — full suite passes.
- [ ] `cd fantasy-browser-worker && npm run lint` — no new lint errors.
- [ ] Manually trigger (or wait for) a fresh practice draft run and confirm in Grafana that:
  - A `LEFT`/close event on the `fantasydraft.espn.com` JOIN socket is followed, within `WS_DEAD_GRACE_MS` + one reconnect-loop tick, by a new `[Draft Sync] WebSocket opened: wss://fantasydraft.espn.com/.../JOIN...` log line (i.e., it actually reconnects now).
  - The health heartbeat's `ws_connected` field flips to `false` during that gap instead of staying `true` throughout.
  - If a room ends mid-test, the job logs the new "Unrecoverable condition — exiting without further reconnect attempts" line once and exits, instead of repeating "Periodic session check failed" every 15s indefinitely.
  - When `draft_targets`/`draft_clicker.js` logs "delegating pick submission via draft_commands:{leagueId}", `draft_sync.js`'s own logs now show a matching `component="draft_commands"` `"Delegated command {id} ... resolved: success"` line within ~1s (not a 5s timeout followed by a fallback raw-JOIN connect).
