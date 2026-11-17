const fs = require("fs");
const os = require("os");
const path = require("path");
jest.mock("../../src/telemetry/logger", () => ({ logger: { warn: jest.fn() } }));
const { measureRunUsage } = require("../../src/db/run_usage");

function cgroup({ cpuMax = "50000 100000", memoryMax = "536870912", peak = "104857600" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgroup-"));
  fs.writeFileSync(
    path.join(root, "cpu.stat"),
    "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\nnr_throttled 3\nthrottled_usec 125000\n",
  );
  fs.writeFileSync(path.join(root, "memory.peak"), `${peak}\n`);
  fs.writeFileSync(path.join(root, "cpu.max"), `${cpuMax}\n`);
  fs.writeFileSync(path.join(root, "memory.max"), `${memoryMax}\n`);
  return root;
}

it("reads a pod run's container cgroup, in core's record shape", () => {
  expect(measureRunUsage(2, 4.56789, { cgroupRoot: cgroup(), env: {} })).toEqual({
    source: "cgroup",
    cpu_seconds: 2.5,
    cpu_throttled_seconds: 0.125,
    peak_memory_bytes: 104857600,
    limits: { cpu_cores: 0.5, memory_bytes: 536870912 },
    attempt: 2,
    wall_seconds: 4.568,
  });
});

it("reports unlimited cgroup limits as null", () => {
  const usage = measureRunUsage(1, 1, { cgroupRoot: cgroup({ cpuMax: "max 100000", memoryMax: "max" }), env: {} });
  expect(usage.limits).toEqual({ cpu_cores: null, memory_bytes: null });
});

it("falls back to the process's own usage without cgroup v2 files", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cgroup-"));
  const usage = measureRunUsage(1, 1, { cgroupRoot: empty, env: {} });
  expect(usage.source).toBe("rusage");
  expect(usage.cpu_seconds).toBeGreaterThan(0);
  expect(usage.peak_memory_bytes).toBeGreaterThan(1024 * 1024);
  expect(usage).not.toHaveProperty("limits");
});

it("ignores the launcher's cgroup for an inline run", () => {
  expect(measureRunUsage(1, 1, { cgroupRoot: cgroup(), env: { RUN_EXECUTOR: "inline" } }).source).toBe("rusage");
});

it("returns null when the cgroup can't be read", () => {
  expect(measureRunUsage(1, 1, { cgroupRoot: cgroup({ peak: "garbage" }), env: {} })).toBeNull();
});
