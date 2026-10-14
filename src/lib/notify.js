/**
 * Phone notifications through a self-hosted ntfy server.
 *
 * A notification is a short summary plus one "view" button; tapping either opens a page of the
 * web UI (WEB_UI_BASE_URL + path), which is where anything is actually approved. Nothing here
 * calls back into core.
 *
 * Best-effort, like the run audit log: notify() never throws and never fails a bot. With
 * NTFY_URL or NTFY_TOKEN unset (local dev, tests) it does nothing.
 *
 * A dedupeKey suppresses repeats for dedupeTtlMs via a Redis SET NX, so queue/KEDA retries of the
 * same failure don't flood the phone. If Redis can't be reached the notification is sent anyway:
 * a duplicate is better than a missed alert.
 */
const redis = require("redis");
const { logger } = require("../telemetry/logger");

const NOTIFY_TIMEOUT_MS = 5000;
const REDIS_CONNECT_TIMEOUT_MS = 2000;
// ntfy's 1-5 scale: 4 makes a sound and pops up, 5 also overrides Do Not Disturb on Android.
const PRIORITY_DEFAULT = 3;
const PRIORITY_HIGH = 4;
const PRIORITY_URGENT = 5;
// ntfy rejects message bodies over 4096 bytes; stay well clear of it.
const MAX_MESSAGE_CHARS = 1000;
const MAX_TITLE_CHARS = 120;
const DEDUPE_KEY_PREFIX = "notify:";

const REDIS_HOST = process.env.REDIS_HOST || "fantasy-cache.default.svc.cluster.local";
const REDIS_PORT = process.env.REDIS_PORT || 6379;

function truncate(text, max = MAX_MESSAGE_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function linkFor(path) {
  const base = (process.env.WEB_UI_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !path) return null;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The JSON body ntfy's publish endpoint takes (POST to the server root, topic in the body). */
function buildPayload({ title, message, priority = PRIORITY_DEFAULT, tags = [], path, actionLabel = "Open" }) {
  const url = linkFor(path);
  return {
    topic: process.env.NTFY_TOPIC || "fantasy",
    title: truncate(title, MAX_TITLE_CHARS),
    message: truncate(message),
    priority,
    tags,
    ...(url && { click: url, actions: [{ action: "view", label: actionLabel, url, clear: true }] }),
  };
}

async function withRedis(createClient, use) {
  const client = createClient({
    url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
    socket: { connectTimeout: REDIS_CONNECT_TIMEOUT_MS, reconnectStrategy: false },
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return await use(client);
  } finally {
    await client.quit().catch(() => {});
  }
}

/** Claims the key for its window; false when it was already claimed. A Redis problem claims nothing. */
async function claim(dedupeKey, dedupeTtlMs, createClient) {
  try {
    return await withRedis(createClient, async (client) => {
      const set = await client.set(`${DEDUPE_KEY_PREFIX}${dedupeKey}`, "1", { NX: true, PX: dedupeTtlMs });
      return set !== null;
    });
  } catch (error) {
    logger.warn(`[Notify] Dedupe check failed; sending anyway: ${error.message}`);
    return true;
  }
}

/** A send that failed shouldn't suppress the retry that follows it. */
async function release(dedupeKey, createClient) {
  await withRedis(createClient, (client) => client.del(`${DEDUPE_KEY_PREFIX}${dedupeKey}`)).catch(() => {});
}

/**
 * Send one notification. Resolves to "sent", "skipped" (not configured), "duplicate", or
 * "failed"; never rejects.
 */
async function notify(notification, { fetchImpl = globalThis.fetch, createClient = redis.createClient } = {}) {
  const url = process.env.NTFY_URL;
  const token = process.env.NTFY_TOKEN;
  if (!url || !token || !notification) return "skipped";
  const dedupeKey = notification.dedupeTtlMs ? notification.dedupeKey : null;
  try {
    if (dedupeKey && !(await claim(dedupeKey, notification.dedupeTtlMs, createClient))) {
      logger.info(`[Notify] Suppressed duplicate ${dedupeKey}`);
      return "duplicate";
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(notification)),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (response.ok) return "sent";
    logger.warn(`[Notify] ntfy answered ${response.status} for "${notification.title}"`);
  } catch (error) {
    logger.warn(`[Notify] Could not send "${notification.title}": ${error.message}`);
  }
  if (dedupeKey) await release(dedupeKey, createClient);
  return "failed";
}

module.exports = {
  notify,
  buildPayload,
  linkFor,
  truncate,
  PRIORITY_DEFAULT,
  PRIORITY_HIGH,
  PRIORITY_URGENT,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
};
