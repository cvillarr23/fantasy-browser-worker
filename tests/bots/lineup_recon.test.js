const fs = require("fs");
const { EventEmitter } = require("events");
const { recordApiTraffic, summarizeRoster } = require("../../src/bots/lineup_recon");

const TRANSACTIONS_URL =
  "https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/1/transactions/";

function fakeRequest({ method = "POST", url = TRANSACTIONS_URL, resourceType = "fetch" } = {}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    headers: () => ({ "content-type": "application/json" }),
    postData: () => '{"type":"ROSTER"}',
  };
}

function fakeResponse(request, status, body) {
  return {
    request: () => request,
    url: () => request.url(),
    status: () => status,
    text: async () => body,
  };
}

function capturedRecords(spy) {
  return spy.mock.calls.map(([, line]) => JSON.parse(line));
}

describe("recordApiTraffic", () => {
  let appendSpy;
  beforeEach(() => {
    appendSpy = jest.spyOn(fs, "appendFileSync").mockImplementation(() => {});
  });
  afterEach(() => appendSpy.mockRestore());

  it("records an espn.com write's response status and body, not just the request", async () => {
    const page = new EventEmitter();
    recordApiTraffic(page);

    const request = fakeRequest();
    page.emit("request", request);
    page.emit(
      "response",
      fakeResponse(request, 409, '{"details":[{"type":"TRAN_ROSTER_INELIGIBLE_IR_NOT_INJURED"}]}'),
    );
    await new Promise(setImmediate);

    const records = capturedRecords(appendSpy);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      event: "response",
      method: "POST",
      url: TRANSACTIONS_URL,
      status: 409,
      body: '{"details":[{"type":"TRAN_ROSTER_INELIGIBLE_IR_NOT_INJURED"}]}',
    });
  });

  it("ignores GET responses and non-espn hosts", async () => {
    const page = new EventEmitter();
    recordApiTraffic(page);

    page.emit("response", fakeResponse(fakeRequest({ method: "GET" }), 200, "{}"));
    page.emit("response", fakeResponse(fakeRequest({ url: "https://example.com/x" }), 200, "{}"));
    await new Promise(setImmediate);

    expect(appendSpy).not.toHaveBeenCalled();
  });
});

describe("summarizeRoster", () => {
  it("includes each player's slot and ESPN injuryStatus, so an IR candidate can be picked", () => {
    const summary = summarizeRoster({
      entryCount: 2,
      scoringPeriodId: 5,
      slotCounts: { 21: 1 },
      lineupLocked: false,
      rosterLocked: false,
      slotByPlayerId: new Map([
        ["100", 20],
        ["200", 2],
      ]),
      nameByPlayerId: new Map([
        ["100", "A"],
        ["200", "B"],
      ]),
      injuryStatusByPlayerId: new Map([
        ["100", "OUT"],
        ["200", null],
      ]),
    });

    expect(summary.players).toEqual([
      { playerId: "100", name: "A", lineupSlotId: 20, injuryStatus: "OUT" },
      { playerId: "200", name: "B", lineupSlotId: 2, injuryStatus: null },
    ]);
    expect(summary.slotByPlayerId).toEqual({ 100: 20, 200: 2 });
  });
});
