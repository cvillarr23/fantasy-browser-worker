const { fetchTradeCandidates, selectCandidatePackages } = require("../../src/lib/trade_candidates");

const now = Date.parse("2026-10-20T18:00:00Z");
const args = { leagueId: "123", season: 2026, week: 7, now };
const candidate = (id, score = 10, extra = {}) => ({
  candidate_key: `key-${id}`, counterparty: { team_id: id, name: `Team ${id}` },
  receive: [{ espn_id: `${id}00`, player_id: "internal" }], send: [{ espn_id: "100" }],
  status: "proposable", final_score: score, ...extra,
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

test("reads proposable candidates in final-score order, including later pages", async () => {
  global.fetch.mockResolvedValueOnce(response(list({ total: 2 })))
    .mockResolvedValueOnce(response(list({ total: 2, items: [candidate("3")] })));
  const result = await fetchTradeCandidates(args);
  expect(result).toMatchObject({ status: "available", items: [candidate("2"), candidate("3")] });
  const urls = global.fetch.mock.calls.map(([url]) => new URL(url));
  expect(Object.fromEntries(urls[0].searchParams)).toEqual({
    league_id: "123", season: "2026", week: "7", status: "proposable", sort: "final_score", limit: "200", offset: "0",
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
