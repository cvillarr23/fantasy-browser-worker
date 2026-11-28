const { fetchTradeCandidates, selectCandidatePackages } = require("../../src/lib/trade_candidates");

const now = Date.parse("2026-10-20T18:00:00Z");
const args = { leagueId: "123", season: 2026, week: 7, now };
const candidate = (id, score = 10, extra = {}) => ({
  candidate_key: `key-${id}`, counterparty: { team_id: id, name: `Team ${id}` },
  receive: [{ espn_id: `${id}00`, player_id: "internal" }], send: [{ espn_id: "100" }],
  status: "proposable", final_score: score, expected_score: score, ...extra,
});
const list = (extra = {}) => ({
  league_id: "123", season: 2026, week: 7, horizon: 4,
  run_id: "run", computed_at: "2026-10-20T17:00:00Z", total: 1,
  items: [candidate("2")], ...extra,
});
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
let savedFetch;
beforeEach(() => { savedFetch = global.fetch; global.fetch = jest.fn(); });
afterEach(() => { global.fetch = savedFetch; });

test("reads proposable candidates in expected-score order, including later pages", async () => {
  global.fetch.mockResolvedValueOnce(response(list({ total: 2 })))
    .mockResolvedValueOnce(response(list({ total: 2, items: [candidate("3")] })));
  const result = await fetchTradeCandidates(args);
  expect(result).toMatchObject({ status: "available", items: [candidate("2"), candidate("3")] });
  const urls = global.fetch.mock.calls.map(([url]) => new URL(url));
  expect(Object.fromEntries(urls[0].searchParams)).toEqual({
    league_id: "123", season: "2026", week: "7", status: "proposable", sort: "expected_score", limit: "200", offset: "0",
  });
  expect(urls[1].searchParams.get("offset")).toBe("1");
  expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
});

test.each([
  ["never_run", () => response({}, 404)],
  ["unavailable", () => response({}, 503)],
  ["empty", () => response(list({ total: 0, items: [] }))],
  ["stale", () => response(list({ computed_at: "2026-10-19T05:59:59.999Z" }))],
  ["invalid", () => response(list({ computed_at: null }))],
  ["invalid", () => response({})],
])("falls back for %s", async (reason, makeResponse) => {
  global.fetch.mockResolvedValue(makeResponse());
  await expect(fetchTradeCandidates(args)).resolves.toMatchObject({ status: "fallback", reason });
});

test("exactly 36 hours old is still available", async () => {
  global.fetch.mockResolvedValue(response(list({ computed_at: "2026-10-19T06:00:00Z" })));
  expect((await fetchTradeCandidates(args)).status).toBe("available");
});

test.each(["network", "json"])("falls back after %s failure", async (kind) => {
  if (kind === "network") global.fetch.mockRejectedValue(new Error("timeout"));
  else global.fetch.mockResolvedValue({ ok: true, json: async () => { throw new Error("bad JSON"); } });
  await expect(fetchTradeCandidates(args)).resolves.toMatchObject({ status: "fallback", reason: "unavailable" });
});

test("a changed run between pages falls back rather than mixing snapshots", async () => {
  global.fetch.mockResolvedValueOnce(response(list({ total: 2 })))
    .mockResolvedValueOnce(response(list({ total: 2, run_id: "new-run" })));
  await expect(fetchTradeCandidates(args)).resolves.toMatchObject({ status: "fallback", reason: "invalid" });
});

test("takes the best per counterparty, excludes open offers and caps live scoring at three", () => {
  const items = [candidate("1", 20), candidate("2", 15), candidate("2", 14), candidate("3", 13), candidate("4", 12), candidate("5", 11), candidate("6", 10)];
  const picked = selectCandidatePackages(items, { fromTeamId: "1", excluded: new Set(["3"]) });
  expect(picked.map((entry) => entry.package)).toEqual([
    { to_team_id: "2", incoming_player_ids: ["200"], outgoing_player_ids: ["100"] },
    { to_team_id: "4", incoming_player_ids: ["400"], outgoing_player_ids: ["100"] },
    { to_team_id: "5", incoming_player_ids: ["500"], outgoing_player_ids: ["100"] },
  ]);
});

test("keeps at most two stored runner-ups per counterparty, in stored order", () => {
  const withReceive = (id, score, espnId) => candidate(id, score, { receive: [{ espn_id: espnId }] });
  const items = [
    withReceive("2", 20, "201"), withReceive("2", 19, "202"), withReceive("2", 18, "203"),
    withReceive("2", 17, "204"), candidate("3", 10),
  ];
  const picked = selectCandidatePackages(items, { fromTeamId: "1", excluded: new Set() });
  expect(picked).toHaveLength(2);
  expect(picked[0]).toMatchObject({ candidateRank: 1, package: { incoming_player_ids: ["201"] } });
  expect(picked[0].runnerUps.map((entry) => [entry.candidateRank, entry.package.incoming_player_ids[0]]))
    .toEqual([[2, "202"], [3, "203"]]);
  expect(picked[1].runnerUps).toEqual([]);
});

test("prefers a bye partner within 5% while keeping a clearly better candidate ahead", () => {
  const context = { teams: {
    1: { bye_outlook: { crunch_weeks: [8] } },
    2: { bye_outlook: { crunch_weeks: [8] } },
    3: { bye_outlook: { crunch_weeks: [8] } },
    4: { bye_outlook: { crunch_weeks: [9] } },
    5: { bye_outlook: { crunch_weeks: [8] } },
  } };
  const picked = selectCandidatePackages([
    candidate("2", 20), candidate("3", 10), candidate("5", 9.9), candidate("4", 9.5),
  ], { fromTeamId: "1", excluded: new Set(), context });
  expect(picked.map((entry) => entry.package.to_team_id)).toEqual(["2", "4", "3"]);
});

test.each([
  { items: [candidate("2", 10, { send: null })] },
  { items: [candidate("2", 10, { receive: [{ espn_id: 200 }] })] },
  { items: [candidate("2", 10, { counterparty: { team_id: 2 } })] },
  { league_id: "wrong-league" },
  { items: [candidate("2", 10, { status: "unknown" })] },
])("malformed candidate data falls back: %j", async (change) => {
  global.fetch.mockResolvedValue(response(list(change)));
  await expect(fetchTradeCandidates(args)).resolves.toMatchObject({ status: "fallback", reason: "invalid" });
});

test.each([
  { items: [candidate("2", 10, { expected_score: undefined })] },
  { items: [candidate("2", 10, { expected_score: "4" })] },
  { items: [candidate("2", 10, { expected_score: Infinity })] },
])("a missing or non-finite expected_score falls back: %j", async (change) => {
  global.fetch.mockResolvedValue(response(list(change)));
  await expect(fetchTradeCandidates(args)).resolves.toMatchObject({ status: "fallback", reason: "invalid" });
});

test("accepts a null expected_score", async () => {
  global.fetch.mockResolvedValue(response(list({ items: [candidate("2", 10, { expected_score: null })] })));
  expect((await fetchTradeCandidates(args)).status).toBe("available");
});

test("ranks the best package and runner-ups by stored expected_score, not final_score", () => {
  const withReceive = (score, expected, espnId) =>
    candidate("2", score, { expected_score: expected, receive: [{ espn_id: espnId }] });
  const picked = selectCandidatePackages([
    withReceive(10, 8, "201"), withReceive(20, 6, "202"), withReceive(30, 1, "203"),
  ], { fromTeamId: "1", excluded: new Set() });
  expect(picked[0]).toMatchObject({ storedScore: 8, package: { incoming_player_ids: ["201"] } });
  expect(picked[0].runnerUps.map((entry) => entry.package.incoming_player_ids[0])).toEqual(["202", "203"]);
});

test("bye-partner closeness compares expected_score", () => {
  const context = { teams: {
    1: { bye_outlook: { crunch_weeks: [8] } },
    2: { bye_outlook: { crunch_weeks: [8] } },
    3: { bye_outlook: { crunch_weeks: [9] } },
  } };
  const withExpected = (id, final, expected) => candidate(id, final, { expected_score: expected });
  // final_scores are far apart, expected_scores are within 5%.
  const close = selectCandidatePackages([withExpected("2", 30, 10), withExpected("3", 12, 9.8)],
    { fromTeamId: "1", excluded: new Set(), context });
  expect(close.map((entry) => entry.package.to_team_id)).toEqual(["3", "2"]);
  // final_scores are within 5%, expected_scores are not.
  const far = selectCandidatePackages([withExpected("2", 10, 10), withExpected("3", 9.9, 5)],
    { fromTeamId: "1", excluded: new Set(), context });
  expect(far.map((entry) => entry.package.to_team_id)).toEqual(["2", "3"]);
});

test("a low-likelihood proposable candidate is still selected", () => {
  const picked = selectCandidatePackages([candidate("2", 10, { expected_score: 0, acceptance_likelihood: 0 })],
    { fromTeamId: "1", excluded: new Set() });
  expect(picked).toHaveLength(1);
});
