jest.mock("amqplib");
// connection.js requires this unconditionally at module load, and the real module calls
// sdk.start() at import time (spins up a real NodeSDK with a batch-span-processor timer) --
// mocking it here keeps that real module from ever loading.
jest.mock("../../src/telemetry/init", () => ({
  sdk: { shutdown: jest.fn().mockResolvedValue(undefined) },
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
}));

const amqplib = require("amqplib");
const { PermanentError } = require("../../src/errors");
const { initializeQueueConsumer } = require("../../src/queue/connection");

function makeFakeChannel() {
  const consumers = {}; // queueName -> registered consume callback
  return {
    consumers,
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    checkQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn((queue, cb) => {
      consumers[queue] = cb;
      return Promise.resolve();
    }),
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn().mockReturnValue(true),
  };
}

function makeFakeConnection(channel) {
  return {
    createChannel: jest.fn().mockResolvedValue(channel),
    // Captured but deliberately never invoked -- the real "close" handler calls process.exit(1).
    on: jest.fn(),
  };
}

function fakeMsg(payload, deliveryTag = 1) {
  return {
    content: Buffer.from(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
    fields: { deliveryTag },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("initializeQueueConsumer", () => {
  let channel;
  let connection;

  beforeEach(() => {
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    amqplib.connect.mockResolvedValue(connection);
  });

  it("declares prefetch(1) channel-wide before registering any consumer", async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor);

    expect(channel.prefetch).toHaveBeenCalledWith(1, true);
    expect(channel.prefetch.mock.invocationCallOrder[0]).toBeLessThan(
      channel.consume.mock.invocationCallOrder[0],
    );
  });

  it("registers all target queues", async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor);

    for (const queue of [
      "lineup_updates",
      "waiver_actions",
      "draft_targets",
      "trade_evaluations",
      "trade_negotiations",
      "llm_requests",
    ]) {
      if (
        ["lineup_updates", "waiver_actions", "draft_targets"].includes(queue)
      ) {
        expect(channel.checkQueue).toHaveBeenCalledWith(queue);
        expect(channel.assertQueue).not.toHaveBeenCalledWith(queue, {
          durable: true,
        });
      } else {
        expect(channel.assertQueue).toHaveBeenCalledWith(queue, {
          durable: true,
        });
      }
      expect(channel.consumers[queue]).toBeInstanceOf(Function);
    }
  });

  it("discards an unparseable message without calling the processor", async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor);

    const msg = fakeMsg("not-json{{{");
    channel.consumers.draft_targets(msg);
    await flushMicrotasks();

    expect(processor).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("acks when the processor resolves successfully", async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor);

    const payload = { tracking_id: "abc" };
    const msg = fakeMsg(payload);
    channel.consumers.waiver_actions(msg);
    await flushMicrotasks();

    expect(processor).toHaveBeenCalledWith("waiver_actions", payload);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("requeues on a transient (plain Error) processor failure", async () => {
    const processor = jest.fn().mockRejectedValue(new Error("transient blip"));
    await initializeQueueConsumer(processor);

    const msg = fakeMsg({ tracking_id: "abc" });
    channel.consumers.lineup_updates(msg);
    await flushMicrotasks();

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("delays before requeuing when the error carries retryDelayMs (e.g. SessionExpiredError)", async () => {
    jest.useFakeTimers();
    try {
      const err = new Error("cookies rejected");
      err.retryDelayMs = 30000;
      const processor = jest.fn().mockRejectedValue(err);
      await initializeQueueConsumer(processor);

      const msg = fakeMsg({ tracking_id: "abc" });
      channel.consumers.draft_targets(msg);
      await Promise.resolve(); // let the processor's rejection reach the catch block
      await Promise.resolve();

      // Not yet requeued -- still waiting out retryDelayMs.
      expect(channel.nack).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30000);

      expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("requeues immediately (no delay) for a transient error with no retryDelayMs", async () => {
    const processor = jest.fn().mockRejectedValue(new Error("transient blip"));
    await initializeQueueConsumer(processor);

    const msg = fakeMsg({ tracking_id: "abc" });
    channel.consumers.draft_targets(msg);
    await flushMicrotasks();

    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it("discards (does not requeue) a PermanentError processor failure", async () => {
    const processor = jest
      .fn()
      .mockRejectedValue(new PermanentError("doomed payload"));
    await initializeQueueConsumer(processor);

    const msg = fakeMsg({ tracking_id: "abc" });
    channel.consumers.draft_targets(msg);
    await flushMicrotasks();

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("invokes the processor with the queue name and parsed payload", async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor);

    const payload = { tracking_id: "xyz", team_id: "8" };
    channel.consumers.lineup_updates(fakeMsg(payload));
    await flushMicrotasks();

    expect(processor).toHaveBeenCalledWith("lineup_updates", payload);
  });
});

// publishToQueue lazily memoizes its own connection/channel at module scope (independent of
// initializeQueueConsumer's), so each test here reloads a fresh connection.js module instance --
// otherwise a channel opened by one test would leak into the next.
describe("publishToQueue", () => {
  function loadFreshConnectionModule() {
    jest.resetModules();
    const freshAmqplib = require("amqplib");
    const freshChannel = makeFakeChannel();
    const freshConnection = makeFakeConnection(freshChannel);
    freshAmqplib.connect.mockResolvedValue(freshConnection);
    return {
      connectionModule: require("../../src/queue/connection"),
      channel: freshChannel,
      connection: freshConnection,
    };
  }

  it("publishes a JSON-encoded payload as a persistent message", async () => {
    const { connectionModule, channel } = loadFreshConnectionModule();

    await connectionModule.publishToQueue("llm_requests", {
      request_id: "abc",
      prompt: "hi",
    });

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      "llm_requests",
      Buffer.from(JSON.stringify({ request_id: "abc", prompt: "hi" })),
      { persistent: true },
    );
  });

  it("checks a broker-owned queue before publishing", async () => {
    const { connectionModule, channel } = loadFreshConnectionModule();
    await connectionModule.publishToQueue("waiver_actions", {
      tracking_id: "abc",
    });
    expect(channel.checkQueue).toHaveBeenCalledWith("waiver_actions");
    expect(channel.assertQueue).not.toHaveBeenCalled();
  });

  it("reuses the same channel across multiple publishes instead of reconnecting", async () => {
    const { connectionModule, connection } = loadFreshConnectionModule();

    await connectionModule.publishToQueue("llm_requests", { a: 1 });
    await connectionModule.publishToQueue("llm_requests", { a: 2 });

    expect(connection.createChannel).toHaveBeenCalledTimes(1);
  });
});
