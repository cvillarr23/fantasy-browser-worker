jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  })),
}));

const { Pool } = require("pg");
const {
  AUTOMATION_SOURCES,
  fetchNewRawSignals,
} = require("../../src/db/rumor_signals");

// Captured at file-evaluation time: Pool is constructed once at module load, and clearMocks would
// wipe Pool.mock.results before any beforeEach could read it.
const pool = Pool.mock.results[0].value;

// Stands in for Postgres: applies the query's WHERE clause to in-memory raw_signals rows, using
// the parameters fetchNewRawSignals actually sent.
function serveRawSignals(table) {
  pool.query.mockImplementation(async (sql, [sinceId, sources]) => {
    expect(sql).toMatch(/source = ANY\(\$2::text\[\]\)/);
    return {
      rows: table.filter(
        (row) =>
          row.id > sinceId &&
          row.player_id !== null &&
          sources.includes(row.source),
      ),
    };
  });
}

const TABLE = [
  { id: 1, player_id: "4046", source: "rotowire_rss", raw_text: "a" },
  { id: 2, player_id: "4046", source: "espn_news", raw_text: "b" },
  { id: 3, player_id: "4046", source: "bluesky", raw_text: "c" },
  { id: 4, player_id: "6904", source: "reddit_fantasyfootball", raw_text: "d" },
  { id: 5, player_id: null, source: "rotowire_rss", raw_text: "e" },
  { id: 6, player_id: "6904", source: "some_future_source", raw_text: "f" },
];

describe("fetchNewRawSignals", () => {
  test("never returns espn_news or bluesky rows", async () => {
    serveRawSignals(TABLE);

    const rows = await fetchNewRawSignals(null);

    expect(rows.map((row) => row.id)).toEqual([1, 4]);
    expect(rows.map((row) => row.source)).not.toContain("espn_news");
    expect(rows.map((row) => row.source)).not.toContain("bluesky");
  });

  test("leaves out a source nobody has allowlisted", async () => {
    serveRawSignals(TABLE);

    const rows = await fetchNewRawSignals(0);

    expect(rows.map((row) => row.source)).not.toContain("some_future_source");
  });

  test("sends only the allowlisted sources, above the watermark", async () => {
    serveRawSignals(TABLE);

    await fetchNewRawSignals(3);

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [
      3,
      ["rotowire_rss", "reddit_fantasyfootball"],
    ]);
  });

  test("the allowlist is exactly RotoWire and Reddit", () => {
    expect(AUTOMATION_SOURCES).toEqual([
      "rotowire_rss",
      "reddit_fantasyfootball",
    ]);
    expect(Object.isFrozen(AUTOMATION_SOURCES)).toBe(true);
  });
});
