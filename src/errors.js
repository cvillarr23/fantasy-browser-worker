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

/**
 * Raised by session_health.js when the stored espn_s2/SWID cookies (or, for the rendered-page
 * tier, the fuller BAM SDK session) no longer authenticate. Deliberately NOT a PermanentError: a
 * redelivered pick isn't doomed once the session is refreshed (e.g. OpenBao's secret is updated
 * with fresh cookies) — this is an infra/config condition, not a payload problem, so it should
 * requeue-with-backoff like any other transient Error rather than being dropped outright. Kept as
 * its own class (not a plain Error) so callers can still pattern-match it distinctly — e.g. to
 * skip a doomed DOM fallback the same way a WS PermanentError already does (see draft_clicker.js).
 */
class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

module.exports = { PermanentError, SessionExpiredError };
