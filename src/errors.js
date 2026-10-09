/**
 * Error raised when a message can never succeed on redelivery.
 *
 * This matters because src/queue/connection.js nacks with requeue=true on any handler failure, and
 * uses a channel-wide prefetch(1). A permanent failure thrown as an ordinary Error therefore gets
 * redelivered immediately, forever, with no backoff — relaunching Chromium each time and starving
 * *both* consumers (lineup_updates and waiver_actions share the channel-wide prefetch), until
 * someone purges the queue by hand.
 *
 * connection.js already treats unparseable JSON this way (drop, don't requeue). This class extends
 * that same reasoning to the semantic cases: a bad payload, a stale player id, a slot the league
 * doesn't field, missing configuration — none of which a retry can fix.
 *
 * Use a plain Error for genuinely transient failures (network blips, ESPN 5xx), which should requeue.
 */
class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
    this.permanent = true;
  }
}

// How long connection.js pauses before requeuing a SessionExpiredError-caused failure. Without
// this, connection.js's plain "nack(msg, false, true)" requeues instantly with no delay (PR #42
// review) -- since prefetch(1) is channel-wide, an expired session would otherwise hot-loop
// relaunching Chromium and block BOTH consumers (lineup_updates and waiver_actions share the
// channel) until someone manually refreshes OpenBao's secret. 30s is long enough to stop that
// hot-loop from burning resources while still recovering within one interval of a credential fix,
// without needing its own out-of-band alerting/backoff mechanism.
const SESSION_EXPIRED_RETRY_DELAY_MS = 30000;

/**
 * Raised by session_health.js when the stored espn_s2/SWID cookies (or, for the rendered-page
 * tier, the fuller BAM SDK session) no longer authenticate. Deliberately NOT a PermanentError: a
 * redelivered pick isn't doomed once the session is refreshed (e.g. OpenBao's secret is updated
 * with fresh cookies) — this is an infra/config condition, not a payload problem, so it should
 * requeue-with-backoff like any other transient Error rather than being dropped outright. Kept as
 * its own class (not a plain Error) so callers can still pattern-match it distinctly — e.g. to
 * skip a doomed DOM fallback the same way a WS PermanentError already does (see draft_clicker.js).
 *
 * `retryDelayMs` is read (duck-typed, no import of this class needed) by connection.js before it
 * requeues a failure — see the constant above for why a delay matters here specifically.
 */
class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
    this.retryDelayMs = SESSION_EXPIRED_RETRY_DELAY_MS;
  }
}

/**
 * Guards against a syntactically valid queue message that parses to null, an array, or a bare
 * scalar. Dereferencing a field on any of those throws a plain TypeError before any
 * PermanentError classification exists, which connection.js treats as transient and requeues
 * forever under its channel-wide prefetch(1), starving every consumer — so this must be the
 * first thing a payload-shaped queue handler checks. Shared by waiver_sniper.js,
 * draft_clicker.js, and trade_bot.js, which each need the identical check on their own payload.
 */
function requirePlainObjectPayload(payload, label) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PermanentError(
      `${label} payload must be a JSON object, got ${
        payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload
      }.`,
    );
  }
  return payload;
}

/**
 * Coarse HTTP-status-only retry classification, shared by every bot that submits a request to a
 * REST API and wants the same rule: a 4xx (except 429, a rate limit) means this exact request is
 * doomed and retrying it is pointless, so it's a PermanentError connection.js drops instead of
 * hot-looping forever under its channel-wide prefetch(1). 429/5xx/network failures stay ordinary
 * Errors so connection.js retries them. Originated in espn_api.js's submitWaiverClaim; kept here
 * so a future change to the threshold (e.g. carving out 408/409) only needs to happen once.
 */
function classifyHttpStatusError(status, message) {
  if (status >= 400 && status < 500 && status !== 429) {
    return new PermanentError(message);
  }
  return new Error(message);
}

// A bare nack requeues instantly under channel-wide prefetch, so a degraded dependency can
// otherwise hot-loop retries and block every consumer. Credential failures keep their longer
// SessionExpiredError delay unless the caller explicitly requests an overwrite.
const TRANSIENT_RETRY_DELAY_MS = 5000;

function withRetryDelay(error, { overwriteExisting = false } = {}) {
  if (!error.permanent && (overwriteExisting || error.retryDelayMs === undefined)) {
    error.retryDelayMs = TRANSIENT_RETRY_DELAY_MS;
  }
  return error;
}

module.exports = {
  PermanentError,
  SessionExpiredError,
  requirePlainObjectPayload,
  classifyHttpStatusError,
  withRetryDelay,
};
