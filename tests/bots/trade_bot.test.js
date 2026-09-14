const {
  requireEvaluationPayload,
  classifyEvaluateError,
  executeTradeEvaluation,
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
