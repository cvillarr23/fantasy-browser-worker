const crypto = require("crypto");
const { logger } = require("../telemetry/logger");

/**
 * Session registry + delegation (issue #70)
 *
 * ROOT CAUSE this exists to fix: ESPN's draft room is confirmed single-session per
 * league/team/member (see draft_room_socket.js's header) — a new JOIN for the same identity
 * silently evicts any existing connection for it. draft_sync.js holds a long-lived observer
 * session on the draft room for the life of a draft; draft_clicker.js used to open its own,
 * separate JOIN (same identity) just to submit a pick, evicting draft_sync.js's socket every
 * single time a pick was clicked. Confirmed live 2026-08-27: `sockets_closed` incremented the
 * same second a pick was confirmed, and none of draft_sync.js's three recovery tiers (WS
 * reconnect, REST poll, DOM scan) resynced for 3+ minutes.
 *
 * Fix shape (deliberately a small shared library, not a service — a dedicated session-manager
 * microservice/sidecar was considered and rejected: it would solve a collision problem that only
 * exists for one resource, the live draft-room WS, by adding a new deployable component every
 * other bot would have to route through for no matching benefit):
 *
 *   1. Ownership lease — folded into the *existing* `draft:{leagueId}:health` key draft_sync.js
 *      already writes/heartbeats (not a new parallel key): `owner_pod`/`owner_session_id`/
 *      `lease_expires_at` fields. `lease_expires_at` is intentionally a much shorter horizon than
 *      that key's own `EX 3600` — a crashed draft_sync.js pod must stop looking like a live owner
 *      within a couple of missed heartbeats, not for up to an hour.
 *   2. Command channel — a new per-league Redis Stream, `draft_commands:{leagueId}`, written with
 *      the same `XADD ... {payload: JSON}` shape `draft_picks:{leagueId}` already uses (draft_sync.js),
 *      just in the reverse direction: a bot wanting a live-session action performed (submit a pick)
 *      publishes a command here; the owning session consumes it and executes it on its own
 *      already-open socket. Results flow back over a companion pub/sub channel,
 *      `draft_commands:{leagueId}:results` — request/response, not another durable log, and safe
 *      here specifically because every requester subscribes before it publishes its command.
 *   3. The check-first rule: `decideOwnership()` is the one call site every bot needing this
 *      resource should use — owner exists (and its lease hasn't lapsed) -> delegate via the
 *      command channel; no live owner -> the bot may become the owner itself.
 */

// Multiple heartbeat cycles' worth of grace before an owner is treated as gone — long enough
// that one delayed/dropped heartbeat write doesn't flap ownership, short enough that a genuinely
// crashed/evicted draft_sync.js pod stops looking like a live owner within tens of seconds, not
// the health key's own 1hr EX.
const DEFAULT_LEASE_GRACE_MULTIPLIER = 3;

/** Builds the `draft:{leagueId}:health` key draft_sync.js already reads/writes. */
function healthKey(leagueId) {
  return `draft:${leagueId}:health`;
}

/** Builds the per-league command stream key. */
function commandStreamKey(leagueId) {
  return `draft_commands:${leagueId}`;
}

/** Builds the per-league command *result* pub/sub channel. */
function commandResultChannel(leagueId) {
  return `draft_commands:${leagueId}:results`;
}

/**
 * Computes the ownership fields draft_sync.js's emitHealthHeartbeat merges into its existing
 * health snapshot before its existing `redisClient.set(key, ..., {EX: 3600})` write. Kept as a
 * pure function (no Redis access) so it's trivially unit-testable and so draft_sync.js's own
 * heartbeat function stays the single place anything is actually written to Redis.
 */
function buildOwnershipFields({
  podName,
  sessionId,
  leaseTtlMs,
  now = Date.now(),
}) {
  return {
    owner_pod: podName,
    owner_session_id: sessionId,
    lease_expires_at: new Date(now + leaseTtlMs).toISOString(),
  };
}

/**
 * Generates a fresh per-process identity for a draft_sync.js run: a random session id (so two
 * back-to-back pods, or a restart, never look like the same owner) and the pod name from the
 * environment (falls back to "unknown" for a local/manual run with no Kubernetes downward API).
 */
function generateOwnerIdentity() {
  return {
    podName: process.env.HOSTNAME || process.env.POD_NAME || "unknown",
    sessionId: crypto.randomUUID(),
  };
}

/**
 * Reads the current ownership lease out of the existing health blob. Returns nulled-out fields
 * (never throws, never returns a stale/expired lease as live) for: no health key yet, a health
 * value that doesn't parse, a health snapshot with no ownership fields (pre-#70 draft_sync.js, or
 * a fresh draft with no heartbeat yet), and a lease whose `lease_expires_at` has already passed.
 */
async function readOwnership(redisClient, leagueId) {
  const empty = {
    ownerPod: null,
    ownerSessionId: null,
    leaseExpiresAt: null,
    live: false,
  };
  if (!leagueId) return empty;

  let raw;
  try {
    raw = await redisClient.get(healthKey(leagueId));
  } catch (err) {
    logger.warn(
      `[Session Registry] Could not read ownership lease for league ${leagueId}: ${err.message}`,
      { component: "session_registry", err },
    );
    return empty;
  }
  if (!raw) return empty;

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[Session Registry] Ownership lease for league ${leagueId} is not valid JSON — treating as no owner.`,
      { component: "session_registry", err },
    );
    return empty;
  }

  const {
    owner_pod: ownerPod,
    owner_session_id: ownerSessionId,
    lease_expires_at: leaseExpiresAt,
  } = snapshot;
  if (!ownerPod || !ownerSessionId || !leaseExpiresAt) return empty;

  const expiresAtMs = Date.parse(leaseExpiresAt);
  const live = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  return { ownerPod, ownerSessionId, leaseExpiresAt, live };
}

/**
 * The check-first entry point: any bot about to open a session for a resource that could collide
 * (today, only the live draft-room WS) calls this before doing so.
 *
 * Returns `{ action: "delegate", ownerPod, ownerSessionId }` when a live owner already holds the
 * lease, or `{ action: "become_owner" }` when none does (missing, expired, or unparseable — a
 * degraded Redis read fails toward "become_owner", i.e. the pre-#70 behavior, rather than wedging
 * every caller when the registry itself is unavailable).
 */
async function decideOwnership(redisClient, leagueId) {
  const ownership = await readOwnership(redisClient, leagueId);
  if (ownership.live) {
    return {
      action: "delegate",
      ownerPod: ownership.ownerPod,
      ownerSessionId: ownership.ownerSessionId,
    };
  }
  return { action: "become_owner" };
}

/**
 * Publishes a command for the owning session to execute on its own already-open socket. Mirrors
 * draft_picks:{leagueId}'s existing `XADD ... {payload: JSON}` shape, just in the opposite
 * direction. Returns the generated command_id the caller correlates a result to.
 */
async function publishCommand(redisClient, leagueId, command) {
  const commandId = crypto.randomUUID();
  const payload = JSON.stringify({
    command_id: commandId,
    requested_at: new Date().toISOString(),
    ...command,
  });
  await redisClient.xAdd(commandStreamKey(leagueId), "*", { payload });
  return commandId;
}

/**
 * Non-blocking poll for new entries on the command stream, starting after `lastIdRef.current`
 * (a plain `{ current: string }` box the caller owns, so the cursor survives across polls without
 * this module holding any state of its own). Defaults to "$" (only commands published after this
 * call started polling) so a fresh consumer doesn't replay a whole draft's worth of already-handled
 * commands on its first poll.
 *
 * Deliberately non-blocking (a bounded XREAD with no BLOCK option) rather than a blocking XREAD:
 * draft_sync.js's event loop is already juggling several setInterval-driven tasks (REST reconcile,
 * health heartbeat) in one process, not a dedicated worker thread — a blocking read would stall
 * all of them.
 */
async function consumeCommandsOnce(
  redisClient,
  leagueId,
  lastIdRef,
  { count = 10 } = {},
) {
  if (!lastIdRef.current) lastIdRef.current = "$";

  let entries;
  try {
    entries = await redisClient.xRead(
      { key: commandStreamKey(leagueId), id: lastIdRef.current },
      { COUNT: count },
    );
  } catch (err) {
    logger.warn(
      `[Session Registry] Could not poll draft_commands:${leagueId}: ${err.message}`,
      { component: "session_registry", err },
    );
    return [];
  }
  if (!entries || entries.length === 0) return [];

  const messages = entries[0].messages || [];
  const commands = [];
  for (const message of messages) {
    lastIdRef.current = message.id;
    try {
      commands.push(JSON.parse(message.message.payload));
    } catch (err) {
      logger.warn(
        `[Session Registry] Dropping unparseable draft_commands:${leagueId} entry ${message.id}: ${err.message}`,
        { component: "session_registry", err },
      );
    }
  }
  return commands;
}

/** Publishes a command's outcome back to its result channel — called by the owning session. */
async function publishCommandResult(redisClient, leagueId, commandId, result) {
  const payload = JSON.stringify({ command_id: commandId, ...result });
  await redisClient.publish(commandResultChannel(leagueId), payload);
}

/**
 * Subscribes to the result channel and resolves with the matching command's result, or `null` if
 * nothing matching arrives within `timeoutMs`. Uses a dedicated duplicate connection for the
 * subscribe (node-redis's pub/sub puts a client into subscriber mode, so it can't share a
 * connection already issuing other commands like the XADD above) and always tears it down, on
 * every exit path, so a delegated-pick timeout can never leak a Redis connection.
 */
async function awaitCommandResult(redisClient, leagueId, commandId, timeoutMs) {
  const subscriber = redisClient.duplicate();
  try {
    try {
      await subscriber.connect();
    } catch (err) {
      logger.warn(
        `[Session Registry] Could not open a result subscriber connection for ` +
          `draft_commands:${leagueId}:results: ${err.message}`,
        { component: "session_registry", err },
      );
      return null;
    }
    return await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);

      subscriber
        .subscribe(commandResultChannel(leagueId), (message) => {
          if (settled) return;
          let parsed;
          try {
            parsed = JSON.parse(message);
          } catch (err) {
            logger.warn(
              `[Session Registry] Unparseable draft_commands:${leagueId}:results message: ${err.message}`,
              { component: "session_registry", err },
            );
            return;
          }
          if (parsed.command_id !== commandId) return;
          settled = true;
          clearTimeout(timer);
          resolve(parsed);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          logger.warn(
            `[Session Registry] Could not subscribe to draft_commands:${leagueId}:results: ${err.message}`,
            { component: "session_registry", err },
          );
          resolve(null);
        });
    });
  } finally {
    try {
      await subscriber.quit();
    } catch (err) {
      logger.warn(
        `[Session Registry] Could not close result subscriber cleanly: ${err.message}`,
        { component: "session_registry", err },
      );
    }
  }
}

module.exports = {
  DEFAULT_LEASE_GRACE_MULTIPLIER,
  healthKey,
  commandStreamKey,
  commandResultChannel,
  buildOwnershipFields,
  generateOwnerIdentity,
  readOwnership,
  decideOwnership,
  publishCommand,
  consumeCommandsOnce,
  publishCommandResult,
  awaitCommandResult,
};
