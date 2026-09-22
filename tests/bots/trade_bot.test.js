const {
  requireEvaluationPayload,
  classifyEvaluateError,
  executeTradeEvaluation,
  requireNegotiationPayload,
  fetchRosterDeficits,
  buildNegotiationSystemPrompt,
  parseNegotiationResponse,
} = require("../../src/bots/trade_bot");

function mockFetchResponse({ ok, status = 200, json, text = "" }) {
  return {
    ok,
    status,
    json: json !== undefined ? async () => json : async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    text: async () => text,
  };
}

function validPayload(overrides = {}) {
  return {
    incoming_player_ids: ["101"],
    outgoing_player_ids: ["202"],
    season: 2026,
    week: 3,
    ...overrides,
  };
}

describe("requireEvaluationPayload", () => {
  it("returns the normalized fields for a valid payload", () => {
    expect(requireEvaluationPayload(validPayload())).toEqual({
      incoming: ["101"],
      outgoing: ["202"],
      season: 2026,
      week: 3,
    });
  });

  it("throws on a null payload", () => {
    expect(() => requireEvaluationPayload(null)).toThrow(/must be a JSON object/);
  });

  it("throws on an array payload", () => {
    expect(() => requireEvaluationPayload([])).toThrow(/must be a JSON object/);
  });

  it("throws when incoming_player_ids is missing", () => {
    const payload = validPayload();
    delete payload.incoming_player_ids;
    expect(() => requireEvaluationPayload(payload)).toThrow(/incoming_player_ids/);
  });

  it("throws when incoming_player_ids is empty", () => {
    expect(() =>
      requireEvaluationPayload(validPayload({ incoming_player_ids: [] })),
    ).toThrow(/incoming_player_ids/);
  });

  it("throws when outgoing_player_ids contains a non-string id", () => {
    expect(() =>
      requireEvaluationPayload(validPayload({ outgoing_player_ids: [202] })),
    ).toThrow(/outgoing_player_ids/);
  });

  it("throws when a player id appears on both sides", () => {
    expect(() =>
      requireEvaluationPayload(
        validPayload({ incoming_player_ids: ["101", "202"] }),
      ),
    ).toThrow(/cannot appear on both sides/);
  });

  it("throws when season is not an integer", () => {
    expect(() =>
      requireEvaluationPayload(validPayload({ season: "2026" })),
    ).toThrow(/season must be an integer/);
  });

  it("throws when week is not an integer", () => {
    expect(() => requireEvaluationPayload(validPayload({ week: 3.5 }))).toThrow(
      /week must be an integer/,
    );
  });
});

function validNegotiationPayload(overrides = {}) {
  return {
    incoming_player_ids: ["101"],
    outgoing_player_ids: ["202"],
    season: 2026,
    week: 3,
    offering_team_id: "7",
    ...overrides,
  };
}

describe("requireNegotiationPayload", () => {
  it("returns the normalized fields for a valid payload", () => {
    expect(requireNegotiationPayload(validNegotiationPayload())).toEqual({
      incoming: ["101"],
      outgoing: ["202"],
      season: 2026,
      week: 3,
      offeringTeamId: "7",
    });
  });

  it("throws on a null payload", () => {
    expect(() => requireNegotiationPayload(null)).toThrow(/must be a JSON object/);
  });

  it("throws when incoming_player_ids is empty", () => {
    expect(() =>
      requireNegotiationPayload(validNegotiationPayload({ incoming_player_ids: [] })),
    ).toThrow(/incoming_player_ids/);
  });

  it("throws when a player id appears on both sides", () => {
    expect(() =>
      requireNegotiationPayload(
        validNegotiationPayload({ incoming_player_ids: ["101", "202"] }),
      ),
    ).toThrow(/cannot appear on both sides/);
  });

  it("throws when season is not an integer", () => {
    expect(() =>
      requireNegotiationPayload(validNegotiationPayload({ season: "2026" })),
    ).toThrow(/season must be an integer/);
  });

  it("throws when offering_team_id is missing", () => {
    const payload = validNegotiationPayload();
    delete payload.offering_team_id;
    expect(() => requireNegotiationPayload(payload)).toThrow(/offering_team_id/);
  });

  it("throws when offering_team_id is an empty string", () => {
    expect(() =>
      requireNegotiationPayload(validNegotiationPayload({ offering_team_id: "" })),
    ).toThrow(/offering_team_id/);
  });

  it("throws when offering_team_id is not a string", () => {
    expect(() =>
      requireNegotiationPayload(validNegotiationPayload({ offering_team_id: 7 })),
    ).toThrow(/offering_team_id/);
  });
});

describe("classifyEvaluateError", () => {
  it("treats a 422 (malformed proposal) as permanent", () => {
    const error = classifyEvaluateError(422, "duplicate player_id(s)");
    expect(error.permanent).toBe(true);
  });

  it("treats other 4xx (except 429) as permanent", () => {
    const error = classifyEvaluateError(404, "not found");
    expect(error.permanent).toBe(true);
  });

  it("treats 429 as transient", () => {
    const error = classifyEvaluateError(429, "rate limited");
    expect(error.permanent).toBeUndefined();
  });

  it("treats 5xx as transient", () => {
    const error = classifyEvaluateError(500, "internal error");
    expect(error.permanent).toBeUndefined();
  });

  it("gives a transient error a retry delay", () => {
    expect(classifyEvaluateError(500, "internal error").retryDelayMs).toBeGreaterThan(0);
  });

  it("does not give a permanent error a retry delay", () => {
    expect(classifyEvaluateError(422, "bad payload").retryDelayMs).toBeUndefined();
  });

  it("defaults to the [Trade Evaluator] label", () => {
    expect(classifyEvaluateError(500, "boom").message).toMatch(/^\[Trade Evaluator\]/);
  });

  it("uses a caller-supplied label instead of the default", () => {
    expect(classifyEvaluateError(500, "boom", "[Trade Negotiator]").message).toMatch(
      /^\[Trade Negotiator\]/,
    );
  });
});

describe("fetchRosterDeficits", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches and returns the parsed deficits", async () => {
    const body = { season: 2026, week: 3, roster_snapshot: "current", teams: {} };
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: true, json: body }));

    const result = await fetchRosterDeficits({ season: 2026, week: 3 });

    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/v1/roster/deficits"),
      expect.anything(),
    );
  });

  it("throws a permanent error on a 404", async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: false, status: 404, text: "not found" }));

    let caught;
    await fetchRosterDeficits({ season: 2026, week: 3 }).catch((e) => (caught = e));
    expect(caught.permanent).toBe(true);
  });

  it("throws a retryable error with a delay on a 500", async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: false, status: 500, text: "boom" }));

    let caught;
    await fetchRosterDeficits({ season: 2026, week: 3 }).catch((e) => (caught = e));
    expect(caught.permanent).not.toBe(true);
    expect(caught.retryDelayMs).toEqual(expect.any(Number));
  });

  it("throws a retryable error when the request itself fails", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      fetchRosterDeficits({ season: 2026, week: 3 }),
    ).rejects.toMatchObject({ retryDelayMs: expect.any(Number) });
  });

  it("throws a retryable error on a 200 with a non-JSON body", async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: true }));

    await expect(
      fetchRosterDeficits({ season: 2026, week: 3 }),
    ).rejects.toMatchObject({ retryDelayMs: expect.any(Number) });
  });
});

describe("executeTradeEvaluation", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("rejects a malformed payload without calling fetch", async () => {
    await expect(executeTradeEvaluation(null)).rejects.toMatchObject({ permanent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the evaluation request and returns the parsed result", async () => {
    const body = {
      incoming_total: 12.5,
      outgoing_total: 8.0,
      delta_vorp: 4.5,
      missing_player_ids: [],
    };
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: true, json: body }));

    const result = await executeTradeEvaluation(validPayload());

    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/v1/trade/evaluate"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          incoming_player_ids: ["101"],
          outgoing_player_ids: ["202"],
          season: 2026,
          week: 3,
        }),
      }),
    );
  });

  it("throws PermanentError on a 422 without a retry delay", async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ ok: false, status: 422, text: "duplicate player_id(s)" }),
    );

    let caught;
    await executeTradeEvaluation(validPayload()).catch((e) => (caught = e));
    expect(caught.permanent).toBe(true);
    expect(caught.retryDelayMs).toBeUndefined();
  });

  it("throws a retryable error on a 500", async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ ok: false, status: 500, text: "internal error" }),
    );

    let caught;
    await executeTradeEvaluation(validPayload()).catch((e) => (caught = e));
    expect(caught.permanent).not.toBe(true);
    expect(caught.retryDelayMs).toEqual(expect.any(Number));
  });

  it("throws a retryable error when the request itself fails", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(executeTradeEvaluation(validPayload())).rejects.toMatchObject({
      retryDelayMs: expect.any(Number),
    });
  });

  it("throws a retryable error on a 200 with a non-JSON body instead of an unhandled SyntaxError", async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse({ ok: true }));

    await expect(executeTradeEvaluation(validPayload())).rejects.toMatchObject({
      retryDelayMs: expect.any(Number),
    });
  });
});

describe("buildNegotiationSystemPrompt", () => {
  const context = {
    deficits: { deficits: [{ position: "RB", severity: "high" }] },
    evaluation: { delta_vorp: 4.5, incoming_total: 12.5, outgoing_total: 8.0 },
    proposals: "Team A offers Player X for Player Y",
    chatLog: "Team A: interested in a deal?",
  };

  it("instructs the model to return strict JSON only", () => {
    const prompt = buildNegotiationSystemPrompt(context);
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toMatch(/counter_offer/);
    expect(prompt).toMatch(/incoming_player_ids/);
    expect(prompt).toMatch(/outgoing_player_ids/);
    expect(prompt).toMatch(/message/);
  });

  it("includes the grounding data so the model has leverage context", () => {
    const prompt = buildNegotiationSystemPrompt(context);
    expect(prompt).toContain("RB");
    expect(prompt).toContain("high");
    expect(prompt).toContain("4.5");
    expect(prompt).toContain(context.proposals);
    expect(prompt).toContain(context.chatLog);
  });
});

describe("parseNegotiationResponse", () => {
  it("parses a plain JSON response", () => {
    const text = JSON.stringify({
      counter_offer: { incoming_player_ids: ["101"], outgoing_player_ids: ["202"] },
      message: "How about this instead?",
    });
    expect(parseNegotiationResponse(text)).toEqual({
      counterOffer: { incomingPlayerIds: ["101"], outgoingPlayerIds: ["202"] },
      message: "How about this instead?",
    });
  });

  it("strips a ```json fenced code block before parsing", () => {
    const text = [
      "```json",
      JSON.stringify({
        counter_offer: { incoming_player_ids: ["101"], outgoing_player_ids: ["202"] },
        message: "Deal?",
      }),
      "```",
    ].join("\n");
    expect(parseNegotiationResponse(text)).toEqual({
      counterOffer: { incomingPlayerIds: ["101"], outgoingPlayerIds: ["202"] },
      message: "Deal?",
    });
  });

  it("throws a non-permanent error on malformed JSON", () => {
    let caught;
    try {
      parseNegotiationResponse("not json at all");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.permanent).not.toBe(true);
    expect(caught.message).toMatch(/JSON/);
  });

  it("throws a non-permanent error when counter_offer is missing", () => {
    let caught;
    try {
      parseNegotiationResponse(JSON.stringify({ message: "hi" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.permanent).not.toBe(true);
    expect(caught.message).toMatch(/counter_offer/);
  });

  it("throws a non-permanent error when incoming_player_ids is empty", () => {
    const text = JSON.stringify({
      counter_offer: { incoming_player_ids: [], outgoing_player_ids: ["202"] },
      message: "hi",
    });
    let caught;
    try {
      parseNegotiationResponse(text);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.permanent).not.toBe(true);
    expect(caught.message).toMatch(/incoming_player_ids/);
  });

  it("throws a non-permanent error when message is missing", () => {
    const text = JSON.stringify({
      counter_offer: { incoming_player_ids: ["101"], outgoing_player_ids: ["202"] },
    });
    let caught;
    try {
      parseNegotiationResponse(text);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.permanent).not.toBe(true);
    expect(caught.message).toMatch(/message/);
  });
});
