const { PermanentError } = require("../errors");

/**
 * ESPN player ids are integers; anything else would serialize to a null playerId in a request. A
 * team defense (D/ST) has a NEGATIVE id, one per NFL team (Team 8's Eagles D/ST is -16021), and
 * readRoster keys it by that signed id as a string, so a leading minus is allowed (#116/#117).
 * "-0" and other zero-padded negatives are rejected: Number("-0") would go out as playerId 0.
 *
 * Same rule lineup_bot.js and waiver_sniper.js each carry inline; new code should use this one.
 */
const PLAYER_ID_PATTERN = /^(?:\d+|-[1-9]\d*)$/;

function requirePlayerId(raw, label) {
  const id = String(raw ?? "").trim();
  if (!PLAYER_ID_PATTERN.test(id)) {
    throw new PermanentError(
      `${label} "${raw}" is not a valid numeric ESPN player id.`,
    );
  }
  return id;
}

module.exports = { PLAYER_ID_PATTERN, requirePlayerId };
