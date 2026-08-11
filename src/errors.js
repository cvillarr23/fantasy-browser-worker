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

module.exports = { PermanentError };
