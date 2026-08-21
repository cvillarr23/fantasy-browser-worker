const { computePickDurationMs, hasStalled } = require("../../scripts/draft-watch");

describe("computePickDurationMs", () => {
  it("returns the elapsed ms between SELECTING and SELECTED", () => {
    expect(computePickDurationMs(1000, 4500)).toBe(3500);
  });

  it("returns null when there was no matching SELECTING timestamp", () => {
    expect(computePickDurationMs(null, 4500)).toBeNull();
    expect(computePickDurationMs(undefined, 4500)).toBeNull();
  });
});

describe("hasStalled", () => {
  it("is false when under the threshold", () => {
    expect(hasStalled(1000, 1000 + 44000, 45000)).toBe(false);
  });

  it("is true at/after the threshold", () => {
    expect(hasStalled(1000, 1000 + 45000, 45000)).toBe(true);
    expect(hasStalled(1000, 1000 + 90000, 45000)).toBe(true);
  });

  it("is false when there is no matching SELECTING timestamp (nothing to stall on)", () => {
    expect(hasStalled(null, 1000000, 45000)).toBe(false);
  });
});
