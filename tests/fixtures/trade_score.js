// A POST /v1/trade/score response shaped like fantasy-core-pipeline's TradeScore
// (src/schemas/trade_score.py, scoring_version trade-score-v1). Defaults describe the common
// production case: one scored week, later weeks without metrics, no opponent strength.
function lineupWeek(week, delta, startersAfter = []) {
  return {
    week,
    before: 100,
    after: 100 + delta,
    delta,
    starters_before: [],
    starters_after: startersAfter,
    held_slots: [],
    excluded_players: [],
  };
}

function makeScore({
  counterpartyTeamId = "2",
  send = [{ espn_id: "100", player_id: "p100", name: "Player 100", position: "RB", nfl_team: "CIN" }],
  receive = [{ espn_id: "200", player_id: "p200", name: "Player 200", position: "WR", nfl_team: "DET" }],
  ourWeeks = [lineupWeek(5, 3.1)],
  theirWeeks = [lineupWeek(5, 0.4, [{ espn_id: "100", player_id: "p100", name: "Player 100", position: "RB", vorp_score: 7.2 }])],
  unscoredWeeks = [
    { week: 6, reasons: ["no_week_metrics"] },
    { week: 7, reasons: ["no_week_metrics"] },
    { week: 8, reasons: ["no_week_metrics"] },
  ],
  score = {},
  exceeds = { us: false, counterparty: false },
  unmappedTraded = [],
  deltaVorp = 9.9,
} = {}) {
  const sum = (weeks) => (weeks.length ? weeks.reduce((total, w) => total + w.delta, 0) : null);
  const scoredWeeks = ourWeeks.map((w) => w.week);
  return {
    scoring_version: "trade-score-v1",
    league_id: "123",
    season: 2026,
    as_of_week: 5,
    our_team: { team_id: "1", name: "Us" },
    counterparty_team: { team_id: counterpartyTeamId, name: `Team ${counterpartyTeamId}` },
    send,
    receive,
    raw_vorp: {
      week: 5,
      incoming_total: 20,
      outgoing_total: 20 - deltaVorp,
      delta_vorp: deltaVorp,
      missing_player_ids: [],
      unmapped_espn_ids: [],
    },
    horizon: {
      start_week: 5,
      end_week: 8,
      scored_weeks: scoredWeeks,
      unscored_weeks: unscoredWeeks,
      complete_horizon: scoredWeeks.length > 0 && unscoredWeeks.length === 0,
    },
    weights: { strength_weight: 0.25, z_clamp: 2, indirect_factor: 0.25 },
    roster_impact: {
      us: {
        total_delta: sum(ourWeeks),
        roster_size_before: 16,
        roster_size_after: 16,
        roster_limit: 16,
        exceeds_roster_limit: exceeds.us,
        weeks: ourWeeks,
      },
      counterparty: {
        total_delta: sum(theirWeeks),
        roster_size_before: 16,
        roster_size_after: 16,
        roster_limit: 16,
        exceeds_roster_limit: exceeds.counterparty,
        weeks: theirWeeks,
      },
    },
    schedule: {
      weeks: scoredWeeks.map((week) => ({
        week,
        matchup_period: week,
        head_to_head: false,
        our_status: "scheduled",
        our_opponent_team_id: "3",
        our_opponent_z: null,
        our_multiplier: null,
        counterparty_status: "scheduled",
        counterparty_opponent_team_id: "4",
        counterparty_opponent_z: null,
        counterparty_weight: null,
      })),
    },
    score: {
      our_lineup_gain: sum(ourWeeks),
      counterparty_lineup_change: sum(theirWeeks),
      our_weighted_gain: null,
      our_schedule_adjustment: null,
      counterparty_weighted_benefit: null,
      final_score: null,
      final_score_unavailable_reasons: ["unknown_our_opponent_strength"],
      ...score,
    },
    coverage: {
      unmapped_traded_espn_ids: unmappedTraded,
      partial_roster_weeks: [],
      nfl_schedule_unavailable_weeks: [],
    },
    roster_snapshot: {
      kind: "current",
      source: "ESPN mRoster",
      fetched_at: "2026-10-07T12:00:00Z",
      observed_week: 5,
      matches_as_of_week: true,
    },
    strength_metric: {
      name: "completed_fantasy_points_per_week_z",
      source: "stored ESPN score history",
      league_mean: null,
      league_stddev: null,
      teams_with_strength: 0,
    },
  };
}

module.exports = { makeScore, lineupWeek };
