const { PLAYER_ID_PATTERN } = require("./espn_ids");
const { CORE_PIPELINE_URL } = require("./core_pipeline");

const CANDIDATE_TIMEOUT_MS = 30_000;
const MAX_CANDIDATE_AGE_MS = 36 * 60 * 60 * 1000;
const CANDIDATE_PAGE_SIZE = 200;
const MIN_CANDIDATE_COUNT = 0;
const FIRST_CHOICE_INDEX = 0;
const SELECTED_CHOICE_COUNT = 1;
const HTTP_NOT_FOUND = 404;
const MAX_SELECTED_CANDIDATES = 3;
const CLOSE_SCORE_RATIO = 0.05;

function validCandidate(item) {
  const validPlayers = (players) => Array.isArray(players) && players.length &&
    players.every((player) => typeof player?.espn_id === "string" && PLAYER_ID_PATTERN.test(player.espn_id));
  return item && typeof item.counterparty?.team_id === "string" && /^[1-9]\d*$/.test(item.counterparty.team_id) &&
    validPlayers(item.receive) && validPlayers(item.send) && item.status === "proposable" &&
    (item.final_score === null || Number.isFinite(item.final_score));
}

// A list is a snapshot. Never combine pages from different job runs.
async function fetchTradeCandidates({ leagueId, season, week, now = Date.now() }) {
  const fallback = (reason) => ({ status: "fallback", reason });
  const items = [];
  let snapshot;
  try {
    do {
      const query = new URLSearchParams({
        league_id: leagueId,
        season: String(season),
        week: String(week),
        status: "proposable",
        sort: "final_score",
        limit: String(CANDIDATE_PAGE_SIZE),
        offset: String(items.length),
      });
      const response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/candidates?${query}`, {
        signal: AbortSignal.timeout(CANDIDATE_TIMEOUT_MS),
      });
      if (!response.ok) return fallback(response.status === HTTP_NOT_FOUND ? "never_run" : "unavailable");
      const page = await response.json();
      if (
        !page || !Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < MIN_CANDIDATE_COUNT ||
        typeof page.computed_at !== "string" || !Number.isFinite(Date.parse(page.computed_at)) ||
        page.league_id !== leagueId || page.season !== season || page.week !== week ||
        !page.items.every(validCandidate)
      ) return fallback("invalid");
      if (now - Date.parse(page.computed_at) > MAX_CANDIDATE_AGE_MS) return fallback("stale");
      if (snapshot && (snapshot.run_id !== page.run_id || snapshot.computed_at !== page.computed_at || snapshot.total !== page.total))
        return fallback("invalid");
      snapshot = page;
      if (!page.items.length) return fallback(items.length ? "invalid" : "empty");
      items.push(...page.items);
    } while (items.length < snapshot.total);
    return { status: "available", items, computedAt: snapshot.computed_at };
  } catch {
    return fallback("unavailable");
  }
}

function selectCandidatePackages(items, { fromTeamId, excluded, context }) {
  const ourCrunch = context?.teams?.[fromTeamId]?.bye_outlook?.crunch_weeks || [];
  const seen = new Set([fromTeamId, ...excluded]);
  const choices = [];
  // The API sorts descending by final_score, with nulls last and a stable key tie-break.
  for (const item of items) {
    const teamId = item.counterparty?.team_id;
    if (item.status !== "proposable" || !teamId || seen.has(teamId)) continue;
    seen.add(teamId);
    const theirCrunch = context?.teams?.[teamId]?.bye_outlook?.crunch_weeks;
    const byePartner = Boolean(ourCrunch.length && Array.isArray(theirCrunch) &&
      !theirCrunch.some((week) => ourCrunch.includes(week)));
    choices.push({
      package: {
        to_team_id: teamId,
        incoming_player_ids: item.receive.map((player) => player.espn_id),
        outgoing_player_ids: item.send.map((player) => player.espn_id),
      },
      target: { team_id: teamId, ...(byePartner ? { bye_partner: true } : {}) },
      storedScore: item.final_score,
    });
  }
  const picks = [];
  while (choices.length && picks.length < MAX_SELECTED_CANDIDATES) {
    const [best] = choices;
    // Compare to a fixed best score, rather than a non-transitive pairwise comparator.
    const partnerIndex = choices.findIndex((entry) => entry.target.bye_partner &&
      (best.storedScore === null ? entry.storedScore === null :
        entry.storedScore !== null && best.storedScore - entry.storedScore <= Math.abs(best.storedScore) * CLOSE_SCORE_RATIO));
    const index = Math.max(FIRST_CHOICE_INDEX, partnerIndex);
    picks.push(...choices.splice(index, SELECTED_CHOICE_COUNT));
  }
  return picks;
}

module.exports = { fetchTradeCandidates, selectCandidatePackages };
