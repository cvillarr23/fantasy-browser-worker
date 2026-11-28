jest.mock("../../src/telemetry/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { logger } = require("../../src/telemetry/logger");

const OFFER_KEY = "a".repeat(64);

describe("postOfferResolution", () => {
  let core;
  beforeEach(() => {
    jest.isolateModules(() => {
      core = require("../../src/lib/core_pipeline");
    });
    process.env.TRIGGER_API_KEY = "test-key";
  });
  afterEach(() => {
    delete global.fetch;
    delete process.env.TRIGGER_API_KEY;
  });

  const reply = (status, body = {}) => jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

  it("posts the outcome and ESPN transaction id with the API key", async () => {
    global.fetch = reply(200, { duplicate: false });
    const result = await core.postOfferResolution(OFFER_KEY, { outcome: "accepted", espnTransactionId: 1234 });
    expect(result).toEqual({ result: core.RESOLUTION_RESULT.OK, duplicate: false });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(`${core.CORE_PIPELINE_URL}/v1/trade/offers/${OFFER_KEY}/resolution`);
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("test-key");
    expect(JSON.parse(init.body)).toEqual({ outcome: "accepted", espn_transaction_id: "1234" });
  });

  it("sends resolved_at only when given", async () => {
    global.fetch = reply(200);
    await core.postOfferResolution(OFFER_KEY, { outcome: "declined", resolvedAt: "2026-11-28T00:00:00.000Z" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ outcome: "declined", resolved_at: "2026-11-28T00:00:00.000Z" });
  });

  it("treats a duplicate response as success", async () => {
    global.fetch = reply(200, { duplicate: true });
    expect(await core.postOfferResolution(OFFER_KEY, { outcome: "expired" })).toEqual({
      result: core.RESOLUTION_RESULT.OK,
      duplicate: true,
    });
  });

  it("logs a 409 and reports it as a conflict without throwing", async () => {
    global.fetch = reply(409);
    expect(await core.postOfferResolution(OFFER_KEY, { outcome: "declined" })).toEqual({ result: core.RESOLUTION_RESULT.CONFLICT });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("different resolution"));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[500], [503]])("reports HTTP %s as a failure to retry next refresh", async (status) => {
    global.fetch = reply(status);
    expect(await core.postOfferResolution(OFFER_KEY, { outcome: "accepted" })).toEqual({ result: core.RESOLUTION_RESULT.FAILED });
  });

  it("reports a network error as a failure instead of throwing", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await core.postOfferResolution(OFFER_KEY, { outcome: "accepted" })).toEqual({ result: core.RESOLUTION_RESULT.FAILED });
  });

  it("sends nothing without an API key", async () => {
    delete process.env.TRIGGER_API_KEY;
    global.fetch = reply(200);
    expect(await core.postOfferResolution(OFFER_KEY, { outcome: "accepted" })).toEqual({ result: core.RESOLUTION_RESULT.SKIPPED });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
