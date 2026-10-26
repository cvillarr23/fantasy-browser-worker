const { CORE_PIPELINE_URL } = require("./core_pipeline");
const { logger } = require("../telemetry/logger");

const OFFERS_TIMEOUT_MS = 30_000;
const OFFERS_PAGE_SIZE = 200;
const RECENT_PITCH_WINDOW_DAYS = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
// Offers a person is still deciding on, or that are already on their way to the other manager.
const OPEN_OFFER_STATUSES = ["awaiting_approval", "approval_pending", "approved", "submitting", "submitted"];
// Once a person has approved an offer its outgoing players are spoken for. An offer that is only
// awaiting approval commits nothing: the same player may still be offered to another team.
const COMMITTED_OFFER_STATUSES = new Set(["approval_pending", "approved", "submitting", "submitted"]);
const PITCH_STATUSES = new Set(["awaiting_approval", "approval_pending"]);
const ALREADY_STAGED = "already_staged";
const PLAYER_COMMITTED = "player_committed";

async function fetchStatusPage(query) {
  const response = await fetch(`${CORE_PIPELINE_URL}/v1/trade/offers?${query}`, {
    signal: AbortSignal.timeout(OFFERS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`offers HTTP ${response.status}`);
  const page = await response.json();
  if (!Array.isArray(page?.offers)) throw new Error("offers response is malformed");
  return page.offers;
}

/**
 * Our open outgoing offers, read from core. Best-effort: when core can't answer, the scan still
 * runs without the duplicate check (a duplicate still needs a person's approval), so this returns
 * an empty list instead of throwing.
 */
async function fetchOpenOutgoingOffers({ leagueId, season, fromTeamId }) {
  const offers = [];
  try {
    for (const status of OPEN_OFFER_STATUSES) {
      let offset = 0;
      let pageOffers;
      do {
        const query = new URLSearchParams({
          status,
          league_id: leagueId,
          season: String(season),
          limit: String(OFFERS_PAGE_SIZE),
          offset: String(offset),
        });
        pageOffers = await fetchStatusPage(query);
        offers.push(...pageOffers.filter((offer) => String(offer.from_team_id) === String(fromTeamId)));
        offset += pageOffers.length;
      } while (pageOffers.length === OFFERS_PAGE_SIZE);
    }
  } catch (error) {
    logger.warn("[Trade Offers] Could not read open offers; scanning without the duplicate check", { err: error });
    return [];
  }
  return offers;
}

const idSet = (ids) => [...new Set(ids || [])].sort().join(",");

/**
 * Why a package must not be staged, or null. `already_staged` is the same counterparty and the same
 * players in each direction as an open offer, whatever its message (the LLM rewrites the pitch on
 * every scan, so the offer key differs). `player_committed` is a player we send who is already in
 * an approved or sent outgoing offer.
 */
function pendingOfferConflict(openOffers, { toTeamId, incomingPlayerIds, outgoingPlayerIds }) {
  const incoming = idSet(incomingPlayerIds);
  const outgoing = idSet(outgoingPlayerIds);
  const same = openOffers.some((offer) =>
    String(offer.to_team_id) === String(toTeamId) &&
    idSet(offer.incoming_player_ids) === incoming && idSet(offer.outgoing_player_ids) === outgoing);
  if (same) return ALREADY_STAGED;
  const committed = new Set(openOffers
    .filter((offer) => COMMITTED_OFFER_STATUSES.has(offer.status))
    .flatMap((offer) => offer.outgoing_player_ids || []));
  return (outgoingPlayerIds || []).some((id) => committed.has(id)) ? PLAYER_COMMITTED : null;
}

function recentPitchTeamIds(openOffers, now = new Date()) {
  const cutoff = now.getTime() - RECENT_PITCH_WINDOW_DAYS * MILLISECONDS_PER_DAY;
  return [...new Set(openOffers
    .filter((offer) => {
      if (!PITCH_STATUSES.has(offer.status)) return false;
      const executedAt = Date.parse(offer.executed_at || "");
      return Number.isFinite(executedAt) && executedAt >= cutoff && executedAt <= now.getTime();
    })
    .map((offer) => String(offer.to_team_id))
    .filter((teamId) => teamId !== "undefined" && teamId !== "null"))];
}

module.exports = { fetchOpenOutgoingOffers, pendingOfferConflict, recentPitchTeamIds, ALREADY_STAGED, PLAYER_COMMITTED };
