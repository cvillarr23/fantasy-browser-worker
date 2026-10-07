/** Pure ranking layer over fantasy-core-pipeline's GET /v1/roster/deficits response
 * (src/bots/trade_bot.js's fetchRosterDeficits). Identifies OTHER teams' exploitable positional
 * weaknesses as targeting input for an outgoing trade proposal. No I/O, no LLM call. */

// Every team in the response, ours included, sets the bar: it is the league's average at the
// position, not a target list.
function leagueMeanNetVorp(teams) {
  const totals = {};
  for (const positions of Object.values(teams)) {
    for (const [position, stats] of Object.entries(positions)) {
      if (!Number.isFinite(stats.net_vorp)) continue;
      totals[position] ??= { sum: 0, count: 0 };
      totals[position].sum += stats.net_vorp;
      totals[position].count += 1;
    }
  }
  return Object.fromEntries(
    Object.entries(totals).map(([position, { sum, count }]) => [position, sum / count]),
  );
}

// deficit counts starters a team is short. Once rosters fill (most of the season) it is 0
// everywhere, so weakness then shows only as net_vorp below the league average. Severity adds
// the two so a real shortage still ranks first among comparable gaps.
function findTradeTargets(deficitsResponse, ownTeamId) {
  const teams = deficitsResponse?.teams ?? {};
  const means = leagueMeanNetVorp(teams);

  return Object.entries(teams)
    .filter(([teamId]) => teamId !== ownTeamId)
    .flatMap(([teamId, positions]) =>
      Object.entries(positions).flatMap(([position, stats]) => {
        const gap = Number.isFinite(stats.net_vorp) ? means[position] - stats.net_vorp : null;
        if (!(stats.deficit > 0) && !(gap > 0)) return [];
        return [{ team_id: teamId, position, deficit: stats.deficit, severity: stats.deficit + (gap ?? 0) }];
      }),
    )
    .sort((a, b) => b.severity - a.severity);
}

module.exports = { findTradeTargets };
