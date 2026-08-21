jest.mock("../../src/bots/auth", () => ({
  resolveEspnCookies: jest.fn(() => ({ espnS2: "s2-value", swid: "{SWID}" })),
}));
jest.mock("../../src/bots/draft_room_socket", () => ({
  connectToDraftRoom: jest.fn(),
}));

const { connectToDraftRoom } = require("../../src/bots/draft_room_socket");
const {
  computePickDurationMs,
  hasStalled,
  watchOnce,
  STALL_WARN_MS,
} = require("../../scripts/draft-watch");

describe("computePickDurationMs", () => {
  it("returns the elapsed ms between SELECTING and SELECTED", () => {
    expect(computePickDurationMs(1000, 4500)).toBe(3500);
  });

  it("returns null when there was no matching SELECTING timestamp", () => {
    expect(computePickDurationMs(null, 4500)).toBeNull();
    expect(computePickDurationMs(undefined, 4500)).toBeNull();
  });
});

describe("hasStalled", () => {
  it("is false when under the threshold", () => {
    expect(hasStalled(1000, 1000 + 44000, 45000)).toBe(false);
  });

  it("is true at/after the threshold", () => {
    expect(hasStalled(1000, 1000 + 45000, 45000)).toBe(true);
    expect(hasStalled(1000, 1000 + 90000, 45000)).toBe(true);
  });

  it("is false when there is no matching SELECTING timestamp (nothing to stall on)", () => {
    expect(hasStalled(null, 1000000, 45000)).toBe(false);
  });
});

/**
 * Fake socket matching draft_room_socket.js's handle shape closely enough for watchOnce: exposes
 * the three registration methods it calls (onSelected/onMessage/onClose) and captures each
 * callback so the test can invoke them directly, plus a no-op close().
 */
function makeFakeSocket() {
  const handlers = {};
  return {
    handlers,
    onSelected: (cb) => {
      handlers.onSelected = cb;
    },
    onMessage: (cb) => {
      handlers.onMessage = cb;
    },
    onClose: (cb) => {
      handlers.onClose = cb;
    },
    close: jest.fn(),
  };
}

/** Lets any already-scheduled microtasks (the mocked connectToDraftRoom's resolution, the sync
 * handler-registration code that follows it in watchOnce) run before the test starts driving
 * socket events. */
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watchOnce stall warning (PR #42 review: exercise the actual arm/warn/clear behavior, not just the pure hasStalled helper)", () => {
  let warnSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("warns once our team has been on the clock past STALL_WARN_MS with no pick", async () => {
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);

    const watchPromise = watchOnce({ leagueId: "1", teamId: "8" });
    await flushMicrotasks();

    socket.handlers.onMessage("SELECTING 8 60000");

    jest.advanceTimersByTime(STALL_WARN_MS - 1);
    expect(warnSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STALL WARNING"),
    );

    socket.handlers.onClose();
    await watchPromise;
  });

  it("does not warn when our team's pick lands before the stall threshold", async () => {
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);

    const watchPromise = watchOnce({ leagueId: "1", teamId: "8" });
    await flushMicrotasks();

    socket.handlers.onMessage("SELECTING 8 60000");
    socket.handlers.onSelected({ team_id: "8", player_id: "4360438", round: 1 });

    jest.advanceTimersByTime(STALL_WARN_MS + 5000);
    expect(warnSpy).not.toHaveBeenCalled();

    socket.handlers.onClose();
    await watchPromise;
  });

  it("does not arm a stall timer for another team's turn", async () => {
    const socket = makeFakeSocket();
    connectToDraftRoom.mockResolvedValue(socket);

    const watchPromise = watchOnce({ leagueId: "1", teamId: "8" });
    await flushMicrotasks();

    socket.handlers.onMessage("SELECTING 3 60000");

    jest.advanceTimersByTime(STALL_WARN_MS + 5000);
    expect(warnSpy).not.toHaveBeenCalled();

    socket.handlers.onClose();
    await watchPromise;
  });
});
