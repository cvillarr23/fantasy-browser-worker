jest.mock("amqplib");
jest.mock("../../src/telemetry/init", () => ({
  sdk: { shutdown: jest.fn().mockResolvedValue(undefined) },
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
}));

const amqplib = require("amqplib");
const {
  initializeQueueConsumer,
  redactAmqpUrl,
} = require("../../src/queue/connection");

function makeFakeChannel() {
  const consumers = {};
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
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFakeConnection(channel) {
  const handlers = {};
  return {
    handlers,
    createChannel: jest.fn().mockResolvedValue(channel),
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function fakeMsg(payload, deliveryTag = 1) {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { deliveryTag },
  };
}

// Lets the async shutdown chain (channel.close -> connection.close -> shutdownTelemetry -> exit)
// run to completion under fake timers.
async function flushAsync() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("idle exit", () => {
  let channel;
  let connection;
  let exitSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    channel = makeFakeChannel();
    connection = makeFakeConnection(channel);
    amqplib.connect.mockResolvedValue(connection);
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.useRealTimers();
  });

  it("never exits when idleExitMs is unset (draft-day warm worker)", async () => {
    await initializeQueueConsumer(jest.fn().mockResolvedValue(undefined));
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await flushAsync();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits 0 after idleExitMs with no messages, closing the channel and connection first", async () => {
    await initializeQueueConsumer(jest.fn().mockResolvedValue(undefined), {
      idleExitMs: 120000,
    });

    jest.advanceTimersByTime(119999);
    await flushAsync();
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushAsync();
    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not treat its own connection close as a broker failure (no exit(1))", async () => {
    connection.close.mockImplementation(async () => {
      await connection.handlers.close();
    });
    await initializeQueueConsumer(jest.fn().mockResolvedValue(undefined), {
      idleExitMs: 1000,
    });

    jest.advanceTimersByTime(1000);
    await flushAsync();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not exit while a message is still being processed, and restarts the idle clock after it", async () => {
    let finish;
    const processor = jest.fn(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await initializeQueueConsumer(processor, { idleExitMs: 1000 });

    jest.advanceTimersByTime(500);
    const handling = channel.consumers.waiver_actions(fakeMsg({ a: 1 }));
    await flushAsync();

    jest.advanceTimersByTime(5000);
    await flushAsync();
    expect(exitSpy).not.toHaveBeenCalled();

    finish();
    await handling;
    expect(channel.ack).toHaveBeenCalled();

    jest.advanceTimersByTime(999);
    await flushAsync();
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushAsync();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("requeues (without processing) a message delivered after draining has started", async () => {
    // channel.close never settles, freezing the shutdown mid-drain.
    channel.close.mockReturnValue(new Promise(() => {}));
    const processor = jest.fn().mockResolvedValue(undefined);
    await initializeQueueConsumer(processor, { idleExitMs: 1000 });

    jest.advanceTimersByTime(1000);
    await flushAsync();

    const msg = fakeMsg({ late: true });
    await channel.consumers.lineup_updates(msg);
    expect(processor).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });
});

describe("redactAmqpUrl", () => {
  it("masks the password but keeps user, host, port and vhost", () => {
    expect(
      redactAmqpUrl(
        "amqp://admin:s3cr3t@fantasy-broker.default.svc.cluster.local:5672/%2f",
      ),
    ).toBe(
      "amqp://admin:***@fantasy-broker.default.svc.cluster.local:5672/%2f",
    );
  });

  it("leaves a URL without credentials unchanged", () => {
    expect(redactAmqpUrl("amqp://broker:5672/")).toBe("amqp://broker:5672/");
  });

  it("masks credentials even in a URL the URL parser rejects", () => {
    expect(redactAmqpUrl("amqp://u:p@ss@host:bad")).not.toContain("p@ss");
  });
});
