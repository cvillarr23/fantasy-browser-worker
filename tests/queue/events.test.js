jest.mock("../../src/telemetry/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("amqplib", () => ({ connect: jest.fn() }));

const amqp = require("amqplib");
const { runWithContext } = require("../../src/telemetry/context");
const { publishJobEvent, JOB_EVENTS_EXCHANGE } = require("../../src/queue/events");

const KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

let channel;
let connection;

beforeEach(() => {
  channel = {
    checkExchange: jest.fn().mockResolvedValue({}),
    publish: jest.fn((_ex, _key, _content, _opts, cb) => {
      cb(null);
      return true;
    }),
  };
  connection = { createConfirmChannel: jest.fn().mockResolvedValue(channel), close: jest.fn().mockResolvedValue() };
  amqp.connect.mockReset().mockResolvedValue(connection);
});

const event = { key: "trade.offer_received", subject: "trade_offer:tx-1", payload: { espn_transaction_id: "tx-1" } };

describe("publishJobEvent", () => {
  it("publishes the six-field JobEvent to the topic exchange with the key as routing key", async () => {
    const eventId = await runWithContext({ runId: "run-1" }, () => publishJobEvent(event));
    const [exchange, routingKey, content, options] = channel.publish.mock.calls[0];
    const body = JSON.parse(content.toString());
    expect(exchange).toBe(JOB_EVENTS_EXCHANGE);
    expect(routingKey).toBe("trade.offer_received");
    expect(Object.keys(body).sort()).toEqual(["at", "emitted_by_run_id", "event_id", "key", "payload", "subject"]);
    expect(body).toMatchObject({ ...event, emitted_by_run_id: "run-1", event_id: eventId });
    expect(body.key).toMatch(KEY_PATTERN);
    expect(new Date(body.at).toISOString()).toBe(body.at);
    expect(options).toMatchObject({ persistent: true, contentType: "application/json" });
    expect(Object.keys(body)).not.toContain("traceparent");
  });

  it("sends a null run id outside a run", async () => {
    await publishJobEvent(event);
    expect(JSON.parse(channel.publish.mock.calls[0][2].toString()).emitted_by_run_id).toBeNull();
  });

  it("checks the exchange instead of declaring it", async () => {
    await publishJobEvent(event);
    expect(channel.checkExchange).toHaveBeenCalledWith(JOB_EVENTS_EXCHANGE);
    expect(connection.close).toHaveBeenCalled();
  });

  it("returns null instead of throwing when the broker is unreachable", async () => {
    amqp.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(publishJobEvent(event)).resolves.toBeNull();
  });

  it("returns null when the exchange is missing or the publish is nacked", async () => {
    channel.checkExchange.mockRejectedValue(new Error("NOT_FOUND"));
    await expect(publishJobEvent(event)).resolves.toBeNull();
    channel.checkExchange.mockResolvedValue({});
    channel.publish.mockImplementation((_a, _b, _c, _d, cb) => cb(new Error("nack")));
    await expect(publishJobEvent(event)).resolves.toBeNull();
    expect(connection.close).toHaveBeenCalledTimes(2);
  });
});
