/** Pure ranking layer over fantasy-core-pipeline's GET /v1/roster/deficits response
 * (src/bots/trade_bot.js's fetchRosterDeficits). Identifies OTHER teams' exploitable positional
 * weaknesses as targeting input for a future outgoing trade proposal -- issue #93, not this
 * module. No I/O, no LLM call. */

// severity combines both signals from the deficits response into one sortable number: deficit
// (how many starters short) dominates, net_vorp (points-value lost to the shortage, negative
// when bad) sharpens the ranking within/across equal deficits without needing an arbitrary scale.
function severityOf({ deficit, net_vorp }) {
  return deficit - net_vorp;
}

function findTradeTargets(deficitsResponse, ownTeamId) {
  const teams = deficitsResponse?.teams ?? {};

  return Object.entries(teams)
    .filter(([teamId]) => teamId !== ownTeamId)
    .flatMap(([teamId, positions]) =>
      Object.entries(positions)
        .filter(([, stats]) => stats.deficit > 0)
        .map(([position, stats]) => ({
          team_id: teamId,
          position,
          deficit: stats.deficit,
          severity: severityOf(stats),
        })),
    )
    .sort((a, b) => b.severity - a.severity);
}

module.exports = { findTradeTargets };
