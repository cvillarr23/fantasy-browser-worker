jest.mock("../../src/db/rumor_signals");
jest.mock("../../src/lib/llm_client");
jest.mock("../../src/db/run_log");

const {
  fetchWatermark,
  fetchNewRawSignals,
  persistRumorSignals,
} = require("../../src/db/rumor_signals");
const { completeWithFallback } = require("../../src/lib/llm_client");
const runLog = require("../../src/db/run_log");
const {
  runRumorDigest,
  buildDigestSystemPrompt,
  parseDigestResponse,
  chunkRawSignalsByPlayer,
} = require("../../src/bots/rumor_digest_bot");

function rawSignal(overrides = {}) {
  return {
    id: 1,
    player_id: "500",
    source: "rotowire",
    raw_text: "Player X is questionable for Sunday.",
    published_at: "2026-09-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildDigestSystemPrompt", () => {
  it("instructs the model to return a strict JSON array with one entry per player", () => {
    const prompt = buildDigestSystemPrompt([rawSignal()]);
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toMatch(/player_id/);
    expect(prompt).toMatch(/sentiment/);
    expect(prompt).toMatch(/confidence/);
    expect(prompt).toMatch(/suggested_action/);
    expect(prompt).toMatch(/EVERY distinct player_id/);
  });

  it("includes the raw item text and player ids so the model has grounding", () => {
    const prompt = buildDigestSystemPrompt([
      rawSignal({ player_id: "500", raw_text: "Questionable for Sunday." }),
    ]);
    expect(prompt).toContain("500");
    expect(prompt).toContain("Questionable for Sunday.");
  });
});

describe("parseDigestResponse", () => {
  const validPlayerIds = new Set(["500", "600"]);

  it("parses a plain JSON array response", () => {
    const text = JSON.stringify([
      { player_id: "500", sentiment: "positive", confidence: 0.8, suggested_action: "boost_waiver_priority" },
      { player_id: "600", sentiment: "neutral", confidence: 0.2, suggested_action: "no_op" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([
      { playerId: "500", sentiment: "positive", confidence: 0.8, suggestedAction: "boost_waiver_priority" },
      { playerId: "600", sentiment: "neutral", confidence: 0.2, suggestedAction: "no_op" },
    ]);
  });

  it("strips a ```json fenced code block before parsing", () => {
    const text = [
      "```json",
      JSON.stringify([
        { player_id: "500", sentiment: "negative", confidence: 0.6, suggested_action: "bench_watch" },
      ]),
      "```",
    ].join("\n");
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([
      { playerId: "500", sentiment: "negative", confidence: 0.6, suggestedAction: "bench_watch" },
    ]);
  });

  it("extracts the JSON array from surrounding prose the model added despite instructions", () => {
    const array = JSON.stringify([
      { player_id: "500", sentiment: "positive", confidence: 0.7, suggested_action: "boost_waiver_priority" },
    ]);
    const text = `Based on the items above, here is my analysis:\n${array}\nLet me know if you need anything else.`;
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([
      { playerId: "500", sentiment: "positive", confidence: 0.7, suggestedAction: "boost_waiver_priority" },
    ]);
  });

  it("throws a non-permanent error on malformed JSON", () => {
    let caught;
    try {
      parseDigestResponse("not json at all", validPlayerIds);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.permanent).not.toBe(true);
    expect(caught.message).toMatch(/JSON/);
  });

  it("throws a non-permanent error when the response is not an array", () => {
    expect(() =>
      parseDigestResponse(JSON.stringify({ player_id: "500" }), validPlayerIds),
    ).toThrow(/array/);
  });

  it("drops an entry whose player_id is not in this batch (hallucinated/wrong-namespace id)", () => {
    const text = JSON.stringify([
      { player_id: "999", sentiment: "positive", confidence: 0.9, suggested_action: "boost_waiver_priority" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([]);
  });

  it("drops an entry with an invalid sentiment", () => {
    const text = JSON.stringify([
      { player_id: "500", sentiment: "excited", confidence: 0.5, suggested_action: "no_op" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([]);
  });

  it("drops an entry with an invalid suggested_action", () => {
    const text = JSON.stringify([
      { player_id: "500", sentiment: "positive", confidence: 0.5, suggested_action: "drop_immediately" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([]);
  });

  it("drops an entry with an out-of-range confidence", () => {
    const text = JSON.stringify([
      { player_id: "500", sentiment: "positive", confidence: 1.5, suggested_action: "no_op" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([]);
  });

  it("keeps the first entry and drops a duplicate for the same player_id", () => {
    const text = JSON.stringify([
      { player_id: "500", sentiment: "positive", confidence: 0.9, suggested_action: "boost_waiver_priority" },
      { player_id: "500", sentiment: "negative", confidence: 0.1, suggested_action: "no_op" },
    ]);
    expect(parseDigestResponse(text, validPlayerIds)).toEqual([
      { playerId: "500", sentiment: "positive", confidence: 0.9, suggestedAction: "boost_waiver_priority" },
    ]);
  });
});

describe("chunkRawSignalsByPlayer", () => {
  const NO_TOKEN_LIMIT = Infinity;

  it("keeps a small batch in a single chunk", () => {
    const signals = [
      rawSignal({ id: 1, player_id: "500" }),
      rawSignal({ id: 2, player_id: "600" }),
    ];
    expect(
      chunkRawSignalsByPlayer(signals, { maxPlayers: 20, maxEstimatedTokens: NO_TOKEN_LIMIT }),
    ).toEqual([signals]);
  });

  it("splits players (not raw signals) across chunks once the player count exceeds maxPlayers", () => {
    const signals = [
      rawSignal({ id: 1, player_id: "500" }),
      rawSignal({ id: 2, player_id: "600" }),
      rawSignal({ id: 3, player_id: "700" }),
    ];
    const chunks = chunkRawSignalsByPlayer(signals, { maxPlayers: 2, maxEstimatedTokens: NO_TOKEN_LIMIT });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].map((r) => r.player_id)).toEqual(["500", "600"]);
    expect(chunks[1].map((r) => r.player_id)).toEqual(["700"]);
  });

  it("never splits one player's raw signals across two chunks", () => {
    const signals = [
      rawSignal({ id: 1, player_id: "500" }),
      rawSignal({ id: 2, player_id: "500" }),
      rawSignal({ id: 3, player_id: "600" }),
    ];
    const chunks = chunkRawSignalsByPlayer(signals, { maxPlayers: 1, maxEstimatedTokens: NO_TOKEN_LIMIT });
    expect(chunks).toEqual([
      [signals[0], signals[1]],
      [signals[2]],
    ]);
  });

  it("splits on token budget even when the player count is under maxPlayers", () => {
    const signals = [
      rawSignal({ id: 1, player_id: "500", raw_text: "x".repeat(400) }),
      rawSignal({ id: 2, player_id: "600", raw_text: "x".repeat(400) }),
    ];
    // Each player's own prompt is well under a generous budget, but the pair together isn't -
    // forces a split despite both fitting maxPlayers: 20.
    const soloTokens = Math.ceil(buildDigestSystemPrompt([signals[0]]).length / 4);
    const chunks = chunkRawSignalsByPlayer(signals, {
      maxPlayers: 20,
      maxEstimatedTokens: soloTokens + 5,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].map((r) => r.player_id)).toEqual(["500"]);
    expect(chunks[1].map((r) => r.player_id)).toEqual(["600"]);
  });

  it("still gives an oversized single player its own chunk rather than dropping data", () => {
    const signals = [rawSignal({ id: 1, player_id: "500", raw_text: "x".repeat(10_000) })];
    const chunks = chunkRawSignalsByPlayer(signals, { maxPlayers: 20, maxEstimatedTokens: 10 });
    expect(chunks).toEqual([signals]);
  });
});

describe("runRumorDigest", () => {
  it("skips the LLM call entirely when there are no new raw signals", async () => {
    fetchWatermark.mockResolvedValue(42);
    fetchNewRawSignals.mockResolvedValue([]);

    const result = await runRumorDigest();

    expect(result).toEqual({ processed: 0, written: 0 });
    expect(completeWithFallback).not.toHaveBeenCalled();
    expect(persistRumorSignals).not.toHaveBeenCalled();
  });

  it("batches new raw signals into a single completeWithFallback call and persists verdicts", async () => {
    fetchWatermark.mockResolvedValue(null);
    fetchNewRawSignals.mockResolvedValue([
      rawSignal({ id: 10, player_id: "500" }),
      rawSignal({ id: 11, player_id: "500" }),
      rawSignal({ id: 12, player_id: "600" }),
    ]);
    completeWithFallback.mockResolvedValue({
      text: JSON.stringify([
        { player_id: "500", sentiment: "negative", confidence: 0.9, suggested_action: "bench_watch" },
        { player_id: "600", sentiment: "neutral", confidence: 0.1, suggested_action: "no_op" },
      ]),
    });
    persistRumorSignals.mockResolvedValue();

    const result = await runRumorDigest();

    expect(completeWithFallback).toHaveBeenCalledTimes(1);
    expect(completeWithFallback).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ callSite: "rumor_digest" }),
    );
    expect(persistRumorSignals).toHaveBeenCalledWith([
      {
        playerId: "500",
        sentiment: "negative",
        confidence: 0.9,
        suggestedAction: "bench_watch",
        sourceRawSignalIds: [10, 11],
        maxRawSignalId: 12,
      },
      {
        playerId: "600",
        sentiment: "neutral",
        confidence: 0.1,
        suggestedAction: "no_op",
        sourceRawSignalIds: [12],
        maxRawSignalId: 12,
      },
    ]);
    expect(result).toEqual({ processed: 3, written: 2 });
  });

  it("propagates a plain Error when the LLM response is entirely unparseable", async () => {
    fetchWatermark.mockResolvedValue(null);
    fetchNewRawSignals.mockResolvedValue([rawSignal()]);
    completeWithFallback.mockResolvedValue({ text: "not json at all" });

    await expect(runRumorDigest()).rejects.toThrow(/JSON/);
    // The first call plus two strict-JSON retries, then the run fails.
    expect(completeWithFallback).toHaveBeenCalledTimes(3);
    expect(persistRumorSignals).not.toHaveBeenCalled();
  });

  it("re-asks once for a malformed response and persists the retry's verdicts", async () => {
    fetchWatermark.mockResolvedValue(null);
    fetchNewRawSignals.mockResolvedValue([rawSignal({ id: 10, player_id: "500" })]);
    completeWithFallback
      .mockResolvedValueOnce({ text: '[{"player_id": "500" "sentiment": "negative"}]' })
      .mockResolvedValueOnce({
        text: JSON.stringify([
          { player_id: "500", sentiment: "negative", confidence: 0.9, suggested_action: "bench_watch" },
        ]),
      });
    persistRumorSignals.mockResolvedValue([77]);

    const result = await runRumorDigest();

    expect(completeWithFallback).toHaveBeenCalledTimes(2);
    expect(completeWithFallback.mock.calls[1][0]).toMatch(/not a valid JSON array/);
    expect(result).toEqual({ processed: 1, written: 1 });
    expect(runLog.link).toHaveBeenCalledWith("raw_signal", [10], "input");
    expect(runLog.link).toHaveBeenCalledWith("rumor_signal", [77], "output");
    expect(runLog.addSummary).toHaveBeenCalledWith(expect.objectContaining({ parse_retries: 1 }));
  });

  it("makes one completeWithFallback call per chunk and stamps every row with the run's overall maxRawSignalId, not the chunk's own max", async () => {
    const originalChunkSize = process.env.RUMOR_DIGEST_CHUNK_SIZE;
    const originalChunkDelay = process.env.RUMOR_DIGEST_CHUNK_DELAY_MS;
    process.env.RUMOR_DIGEST_CHUNK_SIZE = "1";
    process.env.RUMOR_DIGEST_CHUNK_DELAY_MS = "0";
    try {
      fetchWatermark.mockResolvedValue(null);
      fetchNewRawSignals.mockResolvedValue([
        rawSignal({ id: 10, player_id: "500" }),
        rawSignal({ id: 20, player_id: "600" }),
      ]);
      completeWithFallback
        .mockResolvedValueOnce({
          text: JSON.stringify([
            { player_id: "500", sentiment: "negative", confidence: 0.9, suggested_action: "bench_watch" },
          ]),
        })
        .mockResolvedValueOnce({
          text: JSON.stringify([
            { player_id: "600", sentiment: "neutral", confidence: 0.1, suggested_action: "no_op" },
          ]),
        });
      persistRumorSignals.mockResolvedValue();

      const result = await runRumorDigest();

      expect(completeWithFallback).toHaveBeenCalledTimes(2);
      expect(persistRumorSignals).toHaveBeenCalledWith([
        {
          playerId: "500",
          sentiment: "negative",
          confidence: 0.9,
          suggestedAction: "bench_watch",
          sourceRawSignalIds: [10],
          maxRawSignalId: 20,
        },
        {
          playerId: "600",
          sentiment: "neutral",
          confidence: 0.1,
          suggestedAction: "no_op",
          sourceRawSignalIds: [20],
          maxRawSignalId: 20,
        },
      ]);
      expect(result).toEqual({ processed: 2, written: 2 });
    } finally {
      if (originalChunkSize === undefined) delete process.env.RUMOR_DIGEST_CHUNK_SIZE;
      else process.env.RUMOR_DIGEST_CHUNK_SIZE = originalChunkSize;
      if (originalChunkDelay === undefined) delete process.env.RUMOR_DIGEST_CHUNK_DELAY_MS;
      else process.env.RUMOR_DIGEST_CHUNK_DELAY_MS = originalChunkDelay;
    }
  });
});
