jest.mock("../../src/bots/auth");
jest.mock("../../src/bots/espn_api");
jest.mock("../../src/bots/draft_room_socket");
jest.mock("../../src/bots/draft_room_dom");
jest.mock("../../src/bots/session_health");
jest.mock("../../src/db/execution_log");

const { createAuthenticatedSession, resolveEspnCookies } = require("../../src/bots/auth");
const { readDraftPicks } = require("../../src/bots/espn_api");
const { connectToDraftRoom } = require("../../src/bots/draft_room_socket");
const { clickPickViaDom } = require("../../src/bots/draft_room_dom");
const { assertCookieSessionValid } = require("../../src/bots/session_health");
const { SessionExpiredError } = require("../../src/errors");
const { recordDraftPickClick } = require("../../src/db/execution_log");
const { executeAutomatedDraftSelection } = require("../../src/bots/draft_clicker");

const ENV_KEYS = ["DRY_RUN", "ESPN_LEAGUE_ID"];
let savedEnv;

function makeFakeSocket() {
  const handlers = { onSelected: null, onError: null };
  return {
    handlers,
    onSelected: jest.fn((cb) => {
      handlers.onSelected = cb;
    }),
    onError: jest.fn((cb) => {
      handlers.onError = cb;
    }),
    sendPick: jest.fn(),
    close: jest.fn(),
  };
}

const BASE_PAYLOAD = { team_id: "8", player_id: "4360438", name: "Breece Hall" };

// draft_clicker.js jitters real setTimeout delays (up to ~1s total) between setup steps that
// aren't racing the draft clock -- fake timers let tests fast-forward through those instead of
// eating a second of real wall-clock time per test.
beforeEach(() => {
  jest.useFakeTimers();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedEnv.CURRENT_YEAR = process.env.CURRENT_YEAR;
  process.env.ESPN_LEAGUE_ID = "1248158344";
  process.env.CURRENT_YEAR = "2026";

  createAuthenticatedSession.mockResolvedValue({
    context: {},
    browser: { close: jest.fn() },
    swid: "{TEST-SWID}",
  });
  resolveEspnCookies.mockReturnValue({ espnS2: "s2-value", swid: "{TEST-SWID}" });
  readDraftPicks.mockResolvedValue([]);
  assertCookieSessionValid.mockResolvedValue(undefined);
  recordDraftPickClick.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedEnv.CURRENT_YEAR === undefined) delete process.env.CURRENT_YEAR;
  else process.env.CURRENT_YEAR = savedEnv.CURRENT_YEAR;
});

describe("executeAutomatedDraftSelection", () => {
  it("rejects a non-object payload", async () => {
    await expect(executeAutomatedDraftSelection(null)).rejects.toMatchObject({
      permanent: true,
    });
    await expect(executeAutomatedDraftSelection([1])).rejects.toMatchObject({
      permanent: true,
    });
  });

  it("rejects a non-numeric team_id", async () => {
    await expect(
      executeAutomatedDraftSelection({ ...BASE_PAYLOAD, team_id: "abc" }),
    ).rejects.toMatchObject({ permanent: true, message: /team_id/ });
  });

  it("rejects a non-numeric player_id", async () => {
    await expect(
      executeAutomatedDraftSelection({ ...BASE_PAYLOAD, player_id: "abc" }),
    ).rejects.toMatchObject({ permanent: true, message: /player_id/ });
  });

  it("rejects when ESPN_LEAGUE_ID is not set", async () => {
    delete process.env.ESPN_LEAGUE_ID;
    await expect(executeAutomatedDraftSelection(BASE_PAYLOAD)).rejects.toMatchObject({
      permanent: true,
      message: /ESPN_LEAGUE_ID/,
    });
  });

  it("rejects a payload missing name", async () => {
    const rest = { ...BASE_PAYLOAD };
    delete rest.name;
    await expect(executeAutomatedDraftSelection(rest)).rejects.toMatchObject({
      permanent: true,
      message: /missing name/,
    });
  });

  it("does not connect to the draft socket when DRY_RUN defaults true, but records a visible skip", async () => {
    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    await jest.advanceTimersByTimeAsync(1000);
    await runPromise;
    expect(connectToDraftRoom).not.toHaveBeenCalled();
    // A silent skip is what made a practice-run pick look like an unexplained timeout - it has
    // to be visible via execution_log/last_clicker_action, not just a pod log line.
    expect(recordDraftPickClick).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_dry_run" }),
    );
  });

  it("submits for real when DRY_RUN is unset but the payload says mode is practice", async () => {
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);
    const runPromise = executeAutomatedDraftSelection({ ...BASE_PAYLOAD, mode: "practice" });
    await jest.advanceTimersByTimeAsync(1000);
    socket.handlers.onSelected({ player_id: "4360438", team_id: "8", lineup_slot_id: 10 });
    await runPromise;
    expect(connectToDraftRoom).toHaveBeenCalled();
    expect(recordDraftPickClick).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("an explicit DRY_RUN env var still wins over mode: practice", async () => {
    process.env.DRY_RUN = "true";
    const runPromise = executeAutomatedDraftSelection({ ...BASE_PAYLOAD, mode: "practice" });
    await jest.advanceTimersByTimeAsync(1000);
    await runPromise;
    expect(connectToDraftRoom).not.toHaveBeenCalled();
  });

  it("prefers payload.league_id over ESPN_LEAGUE_ID, so a shared worker never acts against the wrong league", async () => {
    process.env.ESPN_LEAGUE_ID = "1248158344";
    const runPromise = executeAutomatedDraftSelection({ ...BASE_PAYLOAD, league_id: "1768121792" });
    await jest.advanceTimersByTimeAsync(1000);
    await runPromise;
    expect(recordDraftPickClick).toHaveBeenCalledWith(
      expect.objectContaining({ leagueId: "1768121792" }),
    );
  });

  it("is idempotent: no-op when already drafted by our own team", async () => {
    readDraftPicks.mockResolvedValue([
      { player_id: "4360438", team_id: "8", pick_number: 12 },
    ]);
    process.env.DRY_RUN = "false";

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    await jest.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(connectToDraftRoom).not.toHaveBeenCalled();
    expect(recordDraftPickClick).not.toHaveBeenCalled();
  });

  it("rejects as a conflict when drafted by another team, without writing a click row", async () => {
    readDraftPicks.mockResolvedValue([
      { player_id: "4360438", team_id: "3", pick_number: 12 },
    ]);
    process.env.DRY_RUN = "false";

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    const assertion = expect(runPromise).rejects.toMatchObject({
      permanent: true,
      message: /already drafted by team 3/,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(connectToDraftRoom).not.toHaveBeenCalled();
    // No real submission was ever attempted for this conflict - it must not be recorded as
    // a click outcome.
    expect(recordDraftPickClick).not.toHaveBeenCalled();
  });

  it("sends the pick and resolves on a matching SELECTED confirmation", async () => {
    process.env.DRY_RUN = "false";
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    await jest.advanceTimersByTimeAsync(1000);
    socket.handlers.onSelected({ player_id: "4360438", team_id: "8", lineup_slot_id: 10, round: null });

    await runPromise;

    expect(socket.sendPick).toHaveBeenCalledWith("4360438");
    expect(socket.close).toHaveBeenCalled();
    expect(recordDraftPickClick).toHaveBeenCalledWith({
      leagueId: "1248158344",
      season: "2026",
      playerId: "4360438",
      playerName: "Breece Hall",
      roundNumber: null,
      status: "success",
    });
  });

  it("classifies a server ERROR frame as a PermanentError and still closes the socket", async () => {
    process.env.DRY_RUN = "false";
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    await jest.advanceTimersByTimeAsync(1000);
    socket.handlers.onError({ code: 1, message: "Invalid Selection." });

    await expect(runPromise).rejects.toMatchObject({
      permanent: true,
      message: /rejected by server: ERROR 1 Invalid Selection\./,
    });
    expect(socket.close).toHaveBeenCalled();
    expect(clickPickViaDom).not.toHaveBeenCalled();
    expect(recordDraftPickClick).toHaveBeenCalledWith({
      leagueId: "1248158344",
      season: "2026",
      playerId: "4360438",
      playerName: "Breece Hall",
      status: "failure",
      errorMessage: expect.stringMatching(/rejected by server/),
    });
  });

  it("falls back to the DOM click path on a non-permanent WS failure", async () => {
    process.env.DRY_RUN = "false";
    connectToDraftRoom.mockRejectedValue(new Error("connect ECONNREFUSED"));
    clickPickViaDom.mockResolvedValue(undefined);

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    await jest.advanceTimersByTimeAsync(1000);
    await runPromise;

    expect(clickPickViaDom).toHaveBeenCalledWith(
      { leagueId: "1248158344", seasonId: "2026", teamId: "8" },
      "4360438",
    );
    expect(recordDraftPickClick).toHaveBeenCalledWith({
      leagueId: "1248158344",
      season: "2026",
      playerId: "4360438",
      playerName: "Breece Hall",
      status: "success",
    });
  });

  it("rethrows the original WS error when the DOM fallback also fails", async () => {
    process.env.DRY_RUN = "false";
    connectToDraftRoom.mockRejectedValue(new Error("connect ECONNREFUSED"));
    clickPickViaDom.mockRejectedValue(new Error("dom selector not found"));

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    const assertion = expect(runPromise).rejects.toMatchObject({
      message: /ECONNREFUSED/,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(recordDraftPickClick).toHaveBeenCalledWith({
      leagueId: "1248158344",
      season: "2026",
      playerId: "4360438",
      playerName: "Breece Hall",
      status: "failure",
      errorMessage: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  // A cancelled/dead draft room times out identically on every redelivery (WS confirmation, then
  // DOM fallback), which connection.js would otherwise requeue forever with no backoff.
  async function runConfirmationTimeout(payload) {
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);
    clickPickViaDom.mockRejectedValue(new Error("locator.waitFor: Timeout 15000ms exceeded"));

    const runPromise = executeAutomatedDraftSelection(payload);
    const settled = runPromise.catch((error) => error);
    await jest.advanceTimersByTimeAsync(10000);
    return settled;
  }

  it("keeps requeuing the first confirmation timeouts, then classifies the third as permanent", async () => {
    process.env.DRY_RUN = "false";
    const payload = { ...BASE_PAYLOAD, tracking_id: "dead-room-1" };

    const first = await runConfirmationTimeout(payload);
    expect(first.permanent).toBeUndefined();
    expect(first.message).toMatch(/No SELECTED confirmation/);

    const second = await runConfirmationTimeout(payload);
    expect(second.permanent).toBeUndefined();

    const third = await runConfirmationTimeout(payload);
    expect(third).toMatchObject({
      permanent: true,
      message: /3 consecutive confirmation timeouts/,
    });
  });

  it("counts confirmation timeouts per tracking_id, not globally", async () => {
    process.env.DRY_RUN = "false";
    await runConfirmationTimeout({ ...BASE_PAYLOAD, tracking_id: "room-a" });
    await runConfirmationTimeout({ ...BASE_PAYLOAD, tracking_id: "room-a" });

    const other = await runConfirmationTimeout({ ...BASE_PAYLOAD, tracking_id: "room-b" });
    expect(other.permanent).toBeUndefined();
  });

  it("resets the timeout budget once a pick succeeds again", async () => {
    process.env.DRY_RUN = "false";
    const payload = { ...BASE_PAYLOAD, tracking_id: "flaky-room" };

    await runConfirmationTimeout(payload);
    await runConfirmationTimeout(payload);

    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);
    const runPromise = executeAutomatedDraftSelection(payload);
    await jest.advanceTimersByTimeAsync(1000);
    socket.handlers.onSelected({ player_id: "4360438", team_id: "8", lineup_slot_id: 10 });
    await runPromise;

    const afterSuccess = await runConfirmationTimeout(payload);
    expect(afterSuccess.permanent).toBeUndefined();
  });

  it("does not count an unrelated transient WS failure against the timeout budget", async () => {
    process.env.DRY_RUN = "false";
    const payload = { ...BASE_PAYLOAD, tracking_id: "econnrefused-room" };
    clickPickViaDom.mockRejectedValue(new Error("dom selector not found"));

    for (let i = 0; i < 3; i += 1) {
      connectToDraftRoom.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const runPromise = executeAutomatedDraftSelection(payload);
      const settled = runPromise.catch((error) => error);
      await jest.advanceTimersByTimeAsync(1000);
      const error = await settled;
      expect(error.permanent).toBeUndefined();
      expect(error.message).toMatch(/ECONNREFUSED/);
    }
  });

  it("short-circuits on a pre-flight SessionExpiredError before connecting to the socket", async () => {
    process.env.DRY_RUN = "false";
    assertCookieSessionValid.mockRejectedValue(
      new SessionExpiredError("cookies rejected"),
    );

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    const assertion = expect(runPromise).rejects.toMatchObject({
      name: "SessionExpiredError",
      message: /cookies rejected/,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(connectToDraftRoom).not.toHaveBeenCalled();
  });

  it("does not attempt the DOM fallback on a pre-flight SessionExpiredError", async () => {
    process.env.DRY_RUN = "false";
    assertCookieSessionValid.mockRejectedValue(
      new SessionExpiredError("cookies rejected"),
    );

    const runPromise = executeAutomatedDraftSelection(BASE_PAYLOAD);
    const assertion = expect(runPromise).rejects.toBeInstanceOf(SessionExpiredError);
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(clickPickViaDom).not.toHaveBeenCalled();
  });
});
