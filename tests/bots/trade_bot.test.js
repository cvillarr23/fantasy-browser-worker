const { requireEvaluationPayload, classifyEvaluateError } = require("../../src/bots/trade_bot");

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
});
