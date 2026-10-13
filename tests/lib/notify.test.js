jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { notify, buildPayload, MAX_MESSAGE_CHARS } = require("../../src/lib/notify");

const ENV_KEYS = ["NTFY_URL", "NTFY_TOKEN", "NTFY_TOPIC", "WEB_UI_BASE_URL"];
const saved = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.NTFY_URL = "https://ntfy.example";
  process.env.NTFY_TOKEN = "tk_test";
  process.env.NTFY_TOPIC = "fantasy";
  process.env.WEB_UI_BASE_URL = "https://fantasy.example/";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function fakeRedis({ claimed = false, failConnect = false } = {}) {
  const keys = new Set(claimed ? ["notify:k"] : []);
  const client = {
    on: jest.fn(),
    connect: jest.fn(async () => {
      if (failConnect) throw new Error("ECONNREFUSED");
    }),
    set: jest.fn(async (key) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return "OK";
    }),
    del: jest.fn(async (key) => keys.delete(key)),
    quit: jest.fn(async () => {}),
  };
  return { client, keys, createClient: jest.fn(() => client) };
}

const ok = () => jest.fn().mockResolvedValue({ ok: true, status: 200 });

const NOTE = { title: "Hi", message: "Body", priority: 4, tags: ["x"], path: "/trades?offer=a", actionLabel: "Review" };

describe("buildPayload", () => {
  it("links the click and the view action to the web UI", () => {
    expect(buildPayload(NOTE)).toEqual({
      topic: "fantasy",
      title: "Hi",
      message: "Body",
      priority: 4,
      tags: ["x"],
      click: "https://fantasy.example/trades?offer=a",
      actions: [{ action: "view", label: "Review", url: "https://fantasy.example/trades?offer=a", clear: true }],
    });
  });

  it("omits links when no web UI base is configured", () => {
    delete process.env.WEB_UI_BASE_URL;
    const payload = buildPayload(NOTE);
    expect(payload.click).toBeUndefined();
    expect(payload.actions).toBeUndefined();
  });

  it("truncates long messages", () => {
    const payload = buildPayload({ ...NOTE, message: "x".repeat(MAX_MESSAGE_CHARS * 2) });
    expect(payload.message).toHaveLength(MAX_MESSAGE_CHARS);
  });
});

describe("notify", () => {
  it("posts the payload with the bearer token", async () => {
    const fetchImpl = ok();
    await expect(notify(NOTE, { fetchImpl })).resolves.toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ntfy.example");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tk_test");
    expect(JSON.parse(init.body)).toEqual(buildPayload(NOTE));
  });

  it.each(["NTFY_URL", "NTFY_TOKEN"])("does nothing when %s is unset", async (key) => {
    delete process.env[key];
    const fetchImpl = ok();
    await expect(notify(NOTE, { fetchImpl })).resolves.toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws on an error response or a network failure", async () => {
    await expect(notify(NOTE, { fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 500 }) })).resolves.toBe(
      "failed",
    );
    await expect(notify(NOTE, { fetchImpl: jest.fn().mockRejectedValue(new Error("timeout")) })).resolves.toBe(
      "failed",
    );
  });

  it("suppresses a repeat inside the dedupe window", async () => {
    const redis = fakeRedis({ claimed: true });
    const fetchImpl = ok();
    const result = await notify({ ...NOTE, dedupeKey: "k", dedupeTtlMs: 1000 }, { fetchImpl, createClient: redis.createClient });
    expect(result).toBe("duplicate");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("claims the key with NX and the window as PX", async () => {
    const redis = fakeRedis();
    await notify({ ...NOTE, dedupeKey: "k", dedupeTtlMs: 1000 }, { fetchImpl: ok(), createClient: redis.createClient });
    expect(redis.client.set).toHaveBeenCalledWith("notify:k", "1", { NX: true, PX: 1000 });
    expect(redis.keys.has("notify:k")).toBe(true);
  });

  it("releases the key when the send fails so the retry still pings", async () => {
    const redis = fakeRedis();
    const result = await notify(
      { ...NOTE, dedupeKey: "k", dedupeTtlMs: 1000 },
      { fetchImpl: jest.fn().mockRejectedValue(new Error("down")), createClient: redis.createClient },
    );
    expect(result).toBe("failed");
    expect(redis.keys.has("notify:k")).toBe(false);
  });

  it("still sends when Redis is unreachable", async () => {
    const redis = fakeRedis({ failConnect: true });
    const fetchImpl = ok();
    const result = await notify({ ...NOTE, dedupeKey: "k", dedupeTtlMs: 1000 }, { fetchImpl, createClient: redis.createClient });
    expect(result).toBe("sent");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
