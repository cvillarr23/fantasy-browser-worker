const { resolveDryRun, resolveTradeDryRun } = require("../../src/lib/env");

const ENV_KEYS = ["DRY_RUN", "TRADE_DRY_RUN"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("resolveTradeDryRun", () => {
  it("defaults to the caller's default when both are unset", () => {
    expect(resolveTradeDryRun(true)).toEqual({ dryRun: true, defaulted: true, source: null });
  });

  it("falls back to DRY_RUN when TRADE_DRY_RUN is unset or blank", () => {
    process.env.DRY_RUN = "false";
    expect(resolveTradeDryRun(true)).toEqual({ dryRun: false, defaulted: false, source: "DRY_RUN" });
    process.env.TRADE_DRY_RUN = "  ";
    expect(resolveTradeDryRun(true).source).toBe("DRY_RUN");
  });

  it.each(["false", "0", "no", "FALSE"])("treats TRADE_DRY_RUN=%s as live", (value) => {
    process.env.TRADE_DRY_RUN = value;
    expect(resolveTradeDryRun(true)).toEqual({ dryRun: false, defaulted: false, source: "TRADE_DRY_RUN" });
  });

  it("keeps any other nonblank TRADE_DRY_RUN dry", () => {
    process.env.TRADE_DRY_RUN = "maybe";
    expect(resolveTradeDryRun(true).dryRun).toBe(true);
  });

  it("lets TRADE_DRY_RUN override DRY_RUN in both directions", () => {
    process.env.DRY_RUN = "false";
    process.env.TRADE_DRY_RUN = "true";
    expect(resolveTradeDryRun(true)).toMatchObject({ dryRun: true, source: "TRADE_DRY_RUN" });
    process.env.DRY_RUN = "true";
    process.env.TRADE_DRY_RUN = "false";
    expect(resolveTradeDryRun(true)).toMatchObject({ dryRun: false, source: "TRADE_DRY_RUN" });
  });
});

describe("resolveDryRun ignores TRADE_DRY_RUN", () => {
  it("keeps the shared DRY_RUN bots dry when only TRADE_DRY_RUN=false is set", () => {
    process.env.TRADE_DRY_RUN = "false";
    expect(resolveDryRun(true)).toEqual({ dryRun: true, defaulted: true });
  });

  it("still follows DRY_RUN when TRADE_DRY_RUN disagrees", () => {
    process.env.DRY_RUN = "false";
    process.env.TRADE_DRY_RUN = "true";
    expect(resolveDryRun(true).dryRun).toBe(false);
  });
});
